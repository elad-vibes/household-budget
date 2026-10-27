// ארנק שוברים (feature 4): wallet card on the plan tab + "שוברים שעומדים לפוג" on the
// overview. Paying with a voucher = choosing "שובר: …" in "איך שילמת?" — the database
// records the use and lowers the balance (0014); manual uses / top-ups are added here.
import { html, type SafeHtml, $ } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { ddmm, ils2, today } from "../lib/format.ts";
import { dbMessage, sb } from "../lib/supa.ts";
import { canWrite, flash, rerender, S } from "../state.ts";
import { daysToExpiry, expiringSoon, last4, walletOrder, type Voucher, type VoucherUse } from "../domain/vouchers.ts";
import { overviewCards } from "./overview.ts";

interface VState { list: Voucher[]; uses: VoucherUse[]; at: number; open: string | null }
const V = (): VState => (S.extra.vouchers ??= { list: [], uses: [], at: 0, open: null });
const n = (v: unknown) => Number(v ?? 0);

export async function loadVouchers() {
  if (!S.hh) return;
  const hh = S.hh;
  const [v, u] = await Promise.all([
    sb.from("vouchers").select("*").eq("household_id", hh),
    sb.from("voucher_uses").select("id, voucher_id, transaction_id, amount, date, note").eq("household_id", hh).order("date", { ascending: false }).limit(500),
  ]);
  if (S.hh !== hh || v.error) return;   // table not there yet (before 0014) → the wallet just stays empty
  const s = V();
  s.list = (v.data ?? []).map((x: any) => ({ ...x, initial_amount: n(x.initial_amount), balance: n(x.balance) }));
  s.uses = (u.data ?? []).map((x: any) => ({ ...x, amount: n(x.amount) }));
  s.at = Date.now();
}
/** Balances change when an expense is paid with a voucher — refresh at most every 20 s while visible. */
function freshen() {
  if (Date.now() - V().at > 20_000) { V().at = Date.now(); loadVouchers().then(rerender).catch(() => undefined); }
}

const expiry = (v: Voucher) => {
  const d = daysToExpiry(v, today());
  if (d === null) return html`<span class="chip grey">ללא תוקף</span>`;
  if (d < 0) return html`<span class="chip miss">פג ב-${ddmm(v.expires_on!)}</span>`;
  return html`<span class="chip ${d <= 7 ? "warn" : "grey"}">${d === 0 ? "פג היום" : d === 1 ? "פג מחר" : `עוד ${d} ימים`}</span>`;
};

export function walletCard(): SafeHtml {
  freshen();
  const w = canWrite();
  const s = V();
  const list = walletOrder(s.list, today());
  return html`<div class="card"><h2>ארנק שוברים</h2>
    <p class="muted small">שובר, כרטיס מתנה או זיכוי בחנות. משלמים בו כמו בכרטיס: בהוספת הוצאה בוחרים "שובר: …" והיתרה יורדת לבד. שומרים רק 4 תווים אחרונים מהקוד, אף פעם לא קוד מלא.</p>
    ${list.length ? list.map((v) => {
      const pct = v.initial_amount ? Math.max(0, Math.min(100, (v.balance / v.initial_amount) * 100)) : 0;
      const open = s.open === v.id;
      const uses = s.uses.filter((u) => u.voucher_id === v.id);
      return html`<div class="vch${v.archived ? " off" : ""}">
        <button class="vhead" data-click="v-open" data-id="${v.id}" aria-expanded="${open ? "true" : "false"}">
          <span class="n"><b>${v.name}</b><small>${v.issuer}${v.code_last4 ? html` · <span dir="ltr">••••${v.code_last4}</span>` : ""}${v.archived ? " · בארכיון" : ""}</small></span>
          <span class="a num"><b>${ils2(v.balance)}</b><small>מתוך ${ils2(v.initial_amount)}</small></span>
        </button>
        <div class="row between small" style="gap:8px"><div class="bar ${v.balance < 0 ? "over" : ""}" style="flex:1"><span style="width:${pct}%"></span></div>${expiry(v)}</div>
        ${open ? html`<div class="vdet">
          ${v.note ? html`<p class="small muted">${v.note}</p>` : ""}
          <h3 class="small">שימושים</h3>
          ${uses.length ? uses.map((u) => html`<div class="fxrow"><div class="n">${u.note || (u.transaction_id ? "הוצאה" : "שימוש ידני")}<small>${ddmm(u.date)}${u.transaction_id ? " · מהוצאה ששולמה בשובר" : ""}</small></div>
              <div class="a num">${u.amount < 0 ? "+" + ils2(-u.amount) : "−" + ils2(u.amount)}</div>
              ${w && !u.transaction_id ? html`<button class="ghost ${isArmed("vu/" + u.id) ? "danger" : ""}" data-click="vu-del" data-id="${u.id}" aria-label="מחיקת שימוש">${isArmed("vu/" + u.id) ? "למחוק?" : "✕"}</button>` : html`<span></span>`}</div>`)
            : html`<p class="muted small">עוד לא השתמשתם בו.</p>`}
          ${w ? html`<form class="grid2" data-submit="vu-save" data-id="${v.id}">
              <label class="f">סכום (₪)<input type="number" id="vuAmt" min="0.01" step="0.01" inputmode="decimal" required></label>
              <label class="f">מה זה<select id="vuKind"><option value="use">שימוש בקופה</option><option value="top">טעינה / זיכוי</option></select></label>
              <label class="f" style="grid-column:1/-1">הערה<input type="text" id="vuNote" maxlength="120" placeholder="למשל: קנייה בסניף"></label>
              <div class="row end" style="grid-column:1/-1;gap:6px">
                <button type="button" class="ghost" data-click="v-archive" data-id="${v.id}">${v.archived ? "החזרה מהארכיון" : "לארכיון"}</button>
                <button type="button" class="ghost ${isArmed("v/" + v.id) ? "danger" : ""}" data-click="v-del" data-id="${v.id}">${isArmed("v/" + v.id) ? "למחוק את השובר?" : "מחיקה"}</button>
                <button class="primary" type="submit">הוספה</button></div></form>` : ""}
        </div>` : ""}
      </div>`;
    }) : html`<p class="muted">עוד אין שוברים בארנק.</p>`}
    ${w ? html`<h3>שובר חדש</h3><form class="grid2" data-submit="v-save">
      <label class="f">שם<input type="text" id="vName" maxlength="60" required placeholder="למשל: תו קנייה ליום הולדת"></label>
      <label class="f">איפה אפשר להשתמש<input type="text" id="vIssuer" maxlength="40" placeholder="רשת / חנות"></label>
      <label class="f">שווי (₪)<input type="number" id="vAmt" min="1" step="0.01" inputmode="decimal" required></label>
      <label class="f">בתוקף עד (לא חובה)<input type="date" id="vExp"></label>
      <label class="f">4 תווים אחרונים מהקוד (לא חובה)<input type="text" id="vCode" maxlength="40" autocomplete="off" placeholder="רק 4 האחרונים יישמרו"></label>
      <label class="f">הערה<input type="text" id="vNote" maxlength="200"></label>
      <div class="row end" style="grid-column:1/-1"><button class="primary" type="submit">הוספה לארנק</button></div></form>` : ""}
  </div>`;
}

overviewCards.push(() => {
  const soon = expiringSoon(V().list, today());
  if (!soon.length) return html``;
  freshen();
  return html`<div class="card"><div class="card-h"><h2>שוברים שעומדים לפוג</h2><button class="ghost" data-click="go" data-to="plan">לארנק</button></div>
    ${soon.slice(0, 4).map((v) => html`<div class="fxrow"><div class="n">${v.name}<small>${v.issuer}</small></div><div class="a num">${ils2(v.balance)}</div>
      <span class="chip ${v.days <= 7 ? "warn" : "grey"}">${v.days === 0 ? "היום" : v.days === 1 ? "מחר" : `עוד ${v.days} ימים`}</span></div>`)}</div>`;
});

const val = (id: string) => ($(id) as HTMLInputElement).value;
const fail = (e: unknown) => flash(dbMessage(e), "err");

/** The voucher's payment method is created / hidden / removed by the database — refresh the chips. */
async function reloadMethods() {
  const { data } = await sb.from("payment_methods").select("*").eq("household_id", S.hh!);
  if (data) S.methods = data as typeof S.methods;
}

on("click", "v-open", (el) => { V().open = V().open === el.dataset.id ? null : el.dataset.id!; rerender(); });
on("submit", "v-save", async () => {
  const name = val("vName").trim().slice(0, 60);
  const amount = Math.round(Number(val("vAmt")) * 100) / 100;
  if (!name || !(amount > 0)) return;
  const row = { household_id: S.hh, name, issuer: val("vIssuer").trim().slice(0, 40), initial_amount: amount,
    expires_on: val("vExp") || null, code_last4: last4(val("vCode")), note: val("vNote").trim().slice(0, 200) };
  const { error } = await sb.from("vouchers").insert(row);
  if (error) return fail(error);
  await Promise.all([loadVouchers(), reloadMethods()]);
  flash(`✓ נוסף לארנק: ${name}`, "ok");
  rerender();
});
on("submit", "vu-save", async (el) => {
  const amount = Math.round(Number(val("vuAmt")) * 100) / 100;
  if (!(amount > 0)) return;
  const sign = val("vuKind") === "top" ? -1 : 1;
  const { error } = await sb.from("voucher_uses").insert({ household_id: S.hh, voucher_id: el.dataset.id, amount: sign * amount,
    note: val("vuNote").trim().slice(0, 120), date: today() });
  if (error) return fail(error);
  await loadVouchers();
  flash(sign > 0 ? "✓ השימוש נרשם" : "✓ הטעינה נרשמה", "ok");
  rerender();
});
on("click", "vu-del", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("vu/" + id, rerender)) return;
  const { error } = await sb.from("voucher_uses").delete().eq("id", id);
  if (error) return fail(error);
  await loadVouchers();
  rerender();
});
on("click", "v-archive", async (el) => {
  const v = V().list.find((x) => x.id === el.dataset.id);
  if (!v) return;
  const { error } = await sb.from("vouchers").update({ archived: !v.archived }).eq("id", v.id);
  if (error) return fail(error);
  await Promise.all([loadVouchers(), reloadMethods()]);
  rerender();
});
on("click", "v-del", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("v/" + id, rerender)) return;
  const { error } = await sb.from("vouchers").delete().eq("id", id);
  if (error) return fail(error);
  V().open = null;
  await Promise.all([loadVouchers(), reloadMethods()]);
  flash("השובר נמחק. הוצאות ששולמו בו נשארות.", "info");
  rerender();
});
