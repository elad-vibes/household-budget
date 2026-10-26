// "איפה הכי זול?" on the shared shopping list (next-features.md §1): ranked chains for
// the open items (total incl. delivery, X/Y found), per-item prices, missing items and
// "פריט דומה". Data: SuperMCP via the price-compare Edge Function (DECISIONS #34).
// Prices are indicative; the comparison links stay as the fallback.
import { attr, html, safeUrl, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { fmtDateTime, ils2 } from "../lib/format.ts";
import { canWrite, flash, rerender, S } from "../state.ts";
import { fn, updateSettings } from "../data.ts";
import { dbMessage } from "../lib/supa.ts";
import { banner, linkHtml } from "./common.ts";
import { icon } from "./cat.ts";

export interface PriceStore {
  slug: string; brand: string; chain: string; total: number | null; comparable: number | null; items: number | null;
  fee: number | null; feeFloor: boolean; meetsMinimum: boolean; toMinimum: number | null; found: number; lines: number;
  url: string | null; asOf: string | null;
  rows: { i: number; name: string; qty: number; price: number | null; sub: boolean; promo: boolean; club: boolean }[];
  missing: { i: number; q: string }[];
}
export interface PriceResult {
  status: string; city: string | null; cheapest: string | null; fetchedAt: string; source: string;
  items: { i: number; q: string; name: string | null; resolved: boolean }[];
  stores: PriceStore[];
}
interface PState { busy: boolean; result: PriceResult | null; cached: boolean; error: string | null; editAddr: boolean; open: string | null; similar: Record<string, string[] | "busy"> }
const P = (): PState => (S.extra.price ??= { busy: false, result: null, cached: false, error: null, editAddr: false, open: null, similar: {} });

const SUPERMCP_SITE = "https://supermcp.co.il/";

function storeRow(s: PriceStore, best: boolean, rank: number): SafeHtml {
  const fee = s.fee === null ? "דמי משלוח לא ידועים" : s.fee === 0 ? "משלוח חינם" : `משלוח ${s.feeFloor ? "מ-" : ""}${ils2(s.fee)}`;
  const total = s.total ?? s.comparable;
  // the open store lives in state: every re-render rebuilds the DOM (a native <details> would close again)
  return html`<details class="pstore ${best ? "best" : ""}" ${attr(P().open === s.slug, "open")}>
    <summary data-click="price-open" data-slug="${s.slug}">
      <span class="rank num" aria-hidden="true">${rank}</span>
      <span class="pn"><b>${s.brand}</b><small>${s.found}/${s.lines} פריטים · ${fee}</small></span>
      <span class="pt num">${total === null ? "—" : (s.total === null ? "≈" : "") + ils2(total)}${best ? html`<span class="chip save">הכי זול</span>` : ""}${!s.meetsMinimum ? html`<span class="chip warn">${s.toMinimum ? `חסר ${ils2(s.toMinimum)} למינימום` : "מתחת למינימום"}</span>` : ""}</span>
    </summary>
    <div class="pdetail">
      ${s.rows.map((r) => html`<div class="prow"><span>${r.name}${r.qty > 1 ? ` × ${r.qty}` : ""}${r.sub ? html` <small class="muted">(מוצר מקביל)</small>` : ""}${r.promo ? html` <span class="chip ok">מבצע</span>` : ""}${r.club ? html` <span class="chip grey">מועדון</span>` : ""}</span><b class="num">${r.price === null ? "—" : ils2(r.price)}</b></div>`)}
      ${s.missing.length ? html`<div class="pmiss"><b class="small">לא נמצא ברשת הזו:</b>${s.missing.map((m) => missingItem(m.q))}</div>` : ""}
      ${s.url ? html`<a class="small" href="${safeUrl(s.url)}" target="_blank" rel="noopener noreferrer">לאתר של ${s.brand} ↗</a>` : ""}
    </div>
  </details>`;
}

function missingItem(q: string): SafeHtml {
  const sim = P().similar[q];
  return html`<div class="prow"><span>${q}</span>${sim === "busy" ? html`<span class="spin"></span>`
    : Array.isArray(sim) ? html`<small class="muted">${sim.length ? "אולי: " + sim.join(" · ") : "לא נמצא פריט דומה"}</small>`
    : html`<button class="ghost" data-click="price-similar" data-q="${q}">פריט דומה</button>`}</div>`;
}

export function priceCard(): SafeHtml {
  const p = P();
  const open = S.shop.filter((i) => !i.done).length;
  const city = S.settings?.price_city ?? "";
  const w = canWrite();
  const addrForm = html`<form class="grid2" data-submit="price-addr">
    <label class="f">עיר<input type="text" id="pcCity" maxlength="60" required value="${city}" placeholder="למשל: חיפה"></label>
    <label class="f">רחוב ומספר (לא חובה)<input type="text" id="pcStreet" maxlength="80" value="${S.settings?.price_street ?? ""}" placeholder="משפר את בדיקת המשלוח"></label>
    <div class="row end" style="grid-column:1/-1">${city ? html`<button type="button" class="ghost" data-click="price-addr-cancel">ביטול</button>` : ""}<button class="primary" type="submit">שמירה</button></div></form>`;
  const r = p.result;
  return html`<div class="card" id="priceCard">
    <div class="card-h"><h2>איפה הכי זול?</h2>${city && !p.editAddr ? html`<button class="ghost small" data-click="price-addr-edit" ${attr(!w, "disabled")}>${icon("house")} ${city}</button>` : ""}</div>
    <p class="muted small">משווה את הרשימה (${open} פריטים פתוחים) בין הסופרים שמשלוחים אליכם, כולל דמי משלוח. נשלחים רק שמות המוצרים והכתובת שבחרתם — בלי שמות ובלי פרטים אישיים.</p>
    ${!city || p.editAddr ? html`${!city ? html`<p class="small"><b>לאיזו כתובת משווים?</b> שואלים פעם אחת, ואפשר לשנות כאן בכל זמן.</p>` : ""}${w ? addrForm : banner("רק מי שיכול לערוך יכול לבחור כתובת להשוואה.", "info")}` : html`
      <button class="primary" data-click="price-run" ${attr(p.busy || !open, "disabled")}>${p.busy ? html`<span class="spin"></span> משווה מחירים…` : r ? "להשוות שוב" : "איפה הכי זול?"}</button>`}
    ${p.error ? html`${banner(p.error, "warn")}<p class="small">בינתיים אפשר להשוות כאן:</p>${linkHtml(["chp", "pricez"])}` : ""}
    ${r && !p.busy ? html`
      ${r.stores.length ? html`<div class="pstores">${r.stores.map((s, i) => storeRow(s, s.slug === r.cheapest || (!r.cheapest && i === 0 && s.meetsMinimum), i + 1))}</div>`
        : banner("לא נמצאה רשת שמשלוחה לכתובת הזו עם המוצרים ברשימה.", "info")}
      ${r.items.some((x) => !x.resolved) ? html`<p class="small muted">לא זוהו: ${r.items.filter((x) => !x.resolved).map((x) => x.q).join(" · ")} — שווה לכתוב שם מדויק יותר (למשל "חלב 3% 1 ליטר").</p>` : ""}
      <p class="muted small">מחירים מ-<a href="${SUPERMCP_SITE}" target="_blank" rel="noopener noreferrer">SuperMCP</a> (קובצי שקיפות המחירים של הרשתות) · עודכן ${fmtDateTime(r.fetchedAt)}${p.cached ? " (שמור מהבדיקה הקודמת)" : ""}. המחירים להמחשה — המחיר הקובע הוא זה שבאתר של הרשת.</p>` : ""}
    ${!r && !p.error ? html`<details class="small"><summary>השוואה ידנית באתרים אחרים</summary>${linkHtml(["chp", "pricez"])}</details>` : ""}
  </div>`;
}

on("click", "price-run", async () => {
  const p = P();
  if (p.busy) return;
  p.busy = true; p.error = null; rerender();
  try {
    const r = await fn.priceCompare();
    p.result = r.result; p.cached = r.cached; p.similar = {};
  } catch (e: any) {
    if (e?.code === "need_city") p.editAddr = true;
    p.error = e?.message ?? "השוואת המחירים לא זמינה כרגע.";
  } finally {
    p.busy = false; rerender();
  }
});
on("click", "price-open", (el, e) => {
  e.preventDefault();
  const p = P();
  p.open = p.open === el.dataset.slug ? null : el.dataset.slug ?? null;
  rerender();
});
on("click", "price-similar", async (el) => {
  const q = el.dataset.q!;
  const p = P();
  p.similar[q] = "busy"; rerender();
  try { p.similar[q] = (await fn.priceSimilar(q)).similar.map((x) => x.name); }
  catch (e: any) { delete p.similar[q]; flash(e?.message ?? "לא הצלחתי למצוא פריט דומה.", "err"); }
  rerender();
});
on("click", "price-addr-edit", () => { P().editAddr = true; rerender(); });
on("click", "price-addr-cancel", () => { P().editAddr = false; rerender(); });
on("submit", "price-addr", async () => {
  const city = (($("pcCity") as HTMLInputElement).value || "").trim();
  const street = (($("pcStreet") as HTMLInputElement).value || "").trim();
  if (city.length < 2) { flash("צריך עיר (לפחות 2 אותיות).", "err"); return; }
  try {
    await updateSettings({ price_city: city.slice(0, 60), price_street: street.length >= 2 ? street.slice(0, 80) : null });
    const p = P(); p.editAddr = false; p.error = null; p.result = null;
    flash("✓ נשמר. אפשר להשוות.", "ok");
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
