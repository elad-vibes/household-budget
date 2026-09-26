// מנהל מערכת (super-admin): usage, quotas and cost per household. Never
// transactions or amounts — the database doesn't give them to this screen.
import { html, type SafeHtml, $ } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { fmtDate } from "../lib/format.ts";
import { appUrl, dbMessage, sb } from "../lib/supa.ts";
import { S, flash, rerender } from "../state.ts";
import { banner, copyText } from "./common.ts";

interface Row {
  household_id: string; name: string; created_at: string; members: number; people: number;
  images: number; statements: number; analyses: number; usd: number;
  quota_images: number; quota_statements: number; quota_analyses: number; quota_usd: number;
}
const X = () => (S.extra.admin ??= { rows: null, totals: null, link: null }) as { rows: Row[] | null; totals: any; link: string | null; err?: string };

export async function loadAdmin() {
  const x = X();
  const [o, t] = await Promise.all([sb.rpc("admin_overview"), sb.rpc("admin_totals")]);
  if (o.error || t.error) { x.err = dbMessage(o.error ?? t.error); rerender(); return; }
  x.rows = (o.data ?? []).map((r: any) => ({ ...r, usd: Number(r.usd), quota_usd: Number(r.quota_usd) }));
  x.totals = t.data;
  x.err = undefined;
  rerender();
}

export function renderAdmin(): SafeHtml {
  const x = X();
  if (x.err) return html`<div class="card">${banner(x.err, "err")}<button data-click="go" data-to="home">חזרה</button></div>`;
  if (!x.rows) return html`<p class="muted"><span class="spin"></span> טוען…</p>`;
  const cap = Number(x.totals?.cap ?? 0), used = Number(x.totals?.usd ?? 0);
  return html`<div class="card admin">
    <div class="card-h"><h2>ניהול מערכת</h2><button class="ghost" data-click="go" data-to="home">חזרה לאפליקציה</button></div>
    <p class="muted small">כאן רואים רק שימוש, מכסות ועלות לכל משק בית. אין גישה לתנועות או לסכומים של המשפחות.</p>
    <div class="tiles">
      <div class="tile" style="background:var(--surface2)"><div class="l">עלות החודש (${x.totals?.month ?? ""})</div><div class="v num">$${used.toFixed(2)}</div><div class="muted small">מתוך תקרה של $${cap.toFixed(2)}</div></div>
      <div class="tile" style="background:var(--surface2)"><div class="l">משקי בית</div><div class="v num">${x.totals?.households ?? 0}</div></div>
    </div>
    <form class="row" data-submit="adm-cap"><label class="f" style="flex:1">תקרה חודשית לכל המערכת ($)<input type="number" id="admCap" min="0" step="1" value="${cap}"></label><button type="submit">עדכון</button></form>
  </div>
  <div class="card admin"><h2>משקי בית</h2>
    <div class="scroll"><table><thead><tr><th>שם</th><th>אנשים</th><th>קבלות</th><th>פירוטים</th><th>ניתוחים</th><th>עלות $</th><th>מכסות: קבלות / פירוטים / ניתוחים / $</th><th></th></tr></thead><tbody>
    ${x.rows.map((r) => html`<tr>
      <td>${r.name}<div class="muted small">${fmtDate(r.created_at)}</div></td>
      <td class="num">${r.members} חשבונות · ${r.people} אנשים</td>
      <td class="num">${r.images}</td><td class="num">${r.statements}</td><td class="num">${r.analyses}</td>
      <td class="num">${r.usd.toFixed(3)}</td>
      <td><form class="row" style="flex-wrap:nowrap;gap:4px" data-submit="adm-quota" data-id="${r.household_id}">
        <input type="number" name="qi" min="0" value="${r.quota_images}" aria-label="מכסת קבלות">
        <input type="number" name="qs" min="0" value="${r.quota_statements}" aria-label="מכסת פירוטים">
        <input type="number" name="qa" min="0" value="${r.quota_analyses}" aria-label="מכסת ניתוחים">
        <input type="number" name="qu" min="0" step="0.5" value="${r.quota_usd}" aria-label="תקרת דולר">
        <button type="submit">שמירה</button></form></td>
      <td>${r.members === 0 ? html`<button class="ghost" data-click="adm-owner-invite" data-id="${r.household_id}">קישור לבעלים</button>` : ""}
        <button class="ghost ${isArmed("adm-del/" + r.household_id) ? "danger" : ""}" data-click="adm-delete" data-id="${r.household_id}">${isArmed("adm-del/" + r.household_id) ? "למחוק הכול?" : "מחיקה"}</button></td>
    </tr>`)}
    </tbody></table></div>
  </div>
  <div class="card admin"><h2>משק בית חדש</h2>
    <p class="muted small">יוצר משק בית ריק וקישור הזמנה חד-פעמי לבעלים (תקף 7 ימים). שולחים את הקישור למשפחה.</p>
    <form class="row" style="flex-wrap:nowrap" data-submit="adm-create"><input type="text" id="admName" maxlength="60" required placeholder="שם משק הבית"><button class="primary" type="submit">יצירה</button></form>
    ${x.link ? html`<div class="banner ok"><div class="secret">${x.link}</div><button data-click="adm-copy">העתקת הקישור</button></div>` : ""}
  </div>`;
}

const reload = () => loadAdmin().catch(() => undefined);

on("submit", "adm-cap", async () => {
  const v = parseFloat(($("admCap") as HTMLInputElement).value);
  const { error } = await sb.rpc("admin_set_global_cap", { p_usd: v });
  flash(error ? dbMessage(error) : "✓ התקרה עודכנה", error ? "err" : "ok");
  reload();
});
on("submit", "adm-quota", async (el) => {
  const f = el as HTMLFormElement;
  const n = (k: string) => Number((f.elements.namedItem(k) as HTMLInputElement).value);
  const { error } = await sb.rpc("admin_set_quotas", { p_household: f.dataset.id, p_images: n("qi"), p_statements: n("qs"), p_analyses: n("qa"), p_usd: n("qu") });
  flash(error ? dbMessage(error) : "✓ המכסות נשמרו", error ? "err" : "ok");
  reload();
});
on("submit", "adm-create", async () => {
  const name = ($("admName") as HTMLInputElement).value.trim();
  if (!name) return;
  const { data, error } = await sb.rpc("admin_create_household", { p_name: name });
  if (error) { flash(dbMessage(error), "err"); return; }
  X().link = `${appUrl()}#/join/${(data as any).token}`;
  reload();
});
on("click", "adm-owner-invite", async (el) => {
  const { data, error } = await sb.rpc("admin_owner_invite", { p_household: el.dataset.id });
  if (error) { flash(dbMessage(error), "err"); return; }
  X().link = `${appUrl()}#/join/${data}`;
  rerender();
});
on("click", "adm-copy", async () => flash((await copyText(X().link ?? "")) ? "הקישור הועתק" : "לא הצלחתי להעתיק", "info"));
on("click", "adm-delete", async (el) => {
  const id = el.dataset.id!;
  if (!armed2("adm-del/" + id, rerender)) return;
  const { error } = await sb.rpc("admin_delete_household", { p_household: id });
  flash(error ? dbMessage(error) : "משק הבית נמחק עם כל הנתונים", error ? "err" : "ok");
  reload();
});
