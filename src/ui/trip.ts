// מצב טיול (feature 5): the settings card in "הבית" — on/off, the trip currency, today's rate
// (official, from fx-rates) and a manual rate that wins over it. The rates are loaded on demand
// (trip mode on, or a foreign amount on screen) and kept for an hour.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { fmtDate } from "../lib/format.ts";
import { dbMessage, sb } from "../lib/supa.ts";
import { canWrite, flash, rerender, S } from "../state.ts";
import { fn, updateSettings } from "../data.ts";
import { fmtRate, nameOf, rateOf, SOURCE_LABEL, symbolOf, travelCurrencies, type FxRates, type Rate } from "../domain/fx.ts";
import { baseCode, baseSymbol, baseWordTo } from "../lib/region.ts";
import { banner } from "./common.ts";
import { settingsCards } from "./home.ts";

interface FxState { rates: FxRates | null; at: number; loading: boolean; error: string | null }
const F = (): FxState => (S.extra.fx ??= { rates: null, at: 0, loading: false, error: null });

export const tripOn = () => !!S.settings?.trip_mode;
/** the trip currency; never the base currency (0016) — a Thailand household travels with ₪ unless it picked another */
export const tripCurrency = () => { const c = S.settings?.trip_currency; return c && c !== baseCode() ? c : baseCode() === "THB" ? "ILS" : "THB"; };

export async function loadFx() {
  const f = F();
  if (f.loading || !S.hh) return;
  f.loading = true;
  try {
    f.rates = await fn.fxRates();
    f.error = null;
  } catch (e: any) {
    f.error = e?.message ?? "השערים לא זמינים כרגע.";
  } finally {
    f.at = Date.now();
    f.loading = false;
    rerender();
  }
}
/** Loads the rates when they're needed and missing or older than an hour (never blocks rendering). */
export function ensureFx() {
  const f = F();
  if (!f.loading && Date.now() - f.at > 3_600_000) void loadFx();
}
export const currentRate = (code: string): Rate | null => rateOf(F().rates, code);

/** "1 ฿ = ₪0.0911 · שער יציג, בנק ישראל, 26.10.2026" (or the other way round for a Thailand household) */
export function rateLine(code: string): SafeHtml {
  const r = currentRate(code);
  if (!r) return F().loading ? html`<span class="muted"><span class="spin"></span> טוען שער…</span>` : html`<span class="muted">אין עדיין שער ל${nameOf(code)}</span>`;
  return html`<span class="num">${fmtRate(r.rate, code)}</span> <span class="muted">· ${SOURCE_LABEL[r.source]}, ${fmtDate(r.date)}</span>`;
}

function tripCard(): SafeHtml {
  const s = S.settings;
  if (!s) return html``;
  const w = canWrite();
  const cur = tripCurrency();
  const f = F();
  if (s.trip_mode) ensureFx();
  const manual = f.rates?.manual[cur];
  const official = f.rates?.official[cur];
  return html`<div class="card" id="tripCard">
    <h2>מצב טיול</h2>
    <p class="muted small">יוצאים לחו״ל? מדליקים כאן. מעכשיו הוספה ידנית והוספה מהירה מהאייפון יהיו במטבע של הטיול, והאפליקציה ממירה ${baseWordTo()} לפי השער של אותו יום. ליד כל הוצאה נשמר גם הסכום המקורי. קבלות ופירוטי אשראי מחו״ל נקראים במטבע שלהם בכל מקרה.</p>
    <label class="chk"><input type="checkbox" data-change="trip-on" ${attr(s.trip_mode, "checked")} ${attr(!w, "disabled")}> מצב טיול פעיל</label>
    <label class="f">המטבע בטיול<select data-change="trip-cur" ${attr(!w, "disabled")}>
      ${travelCurrencies().map((c) => html`<option value="${c.code}" ${attr(c.code === cur, "selected")}>${c.name} (${c.symbol})</option>`)}
    </select></label>
    ${s.trip_mode || manual ? html`
      <p class="small">השער שלנו: ${rateLine(cur)}</p>
      ${f.rates?.stale && !manual ? banner("השער הרשמי לא התעדכן כמה ימים (המקור לא זמין). אפשר להמשיך איתו, או להזין שער ידני.", "warn") : ""}
      ${f.error && !f.rates ? banner(f.error, "warn") : ""}
      ${w ? html`<form class="grid2" data-submit="trip-rate">
        <label class="f">שער ידני: כמה ${baseSymbol()} שווה 1 ${symbolOf(cur)}<input type="number" id="tripRate" min="0.000001" step="any" inputmode="decimal" placeholder="${official ? String(official.rate) : baseCode() === "THB" ? "למשל 9.1" : "למשל 0.095"}" value="${manual ? String(manual.rate) : ""}"></label>
        <div class="row end" style="align-self:end;gap:6px">
          ${manual ? html`<button type="button" class="ghost" data-click="trip-rate-clear">חזרה לשער הרשמי</button>` : ""}
          <button type="submit">שמירת שער</button></div>
      </form>
      <p class="muted small">שער ידני מתאים כשמחליפים כסף בצ׳יינג׳ ורוצים שהמספרים יתאימו למה ששילמתם בפועל. כשפירוט האשראי מגיע, ההוצאה מקבלת את הסכום שחויב בפועל.</p>` : ""}` : ""}
  </div>`;
}
settingsCards.push(tripCard);

const run = async (f: () => Promise<unknown>, ok?: string) => {
  try { await f(); if (ok) flash(ok, "ok"); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
};

on("change", "trip-on", (el) => {
  const onNow = (el as HTMLInputElement).checked;
  return run(async () => {
    await updateSettings({ trip_mode: onNow });
    if (onNow) void loadFx();
  }, onNow ? `✓ מצב טיול פעיל · ${nameOf(tripCurrency())}` : "✓ מצב טיול כבוי");
});
on("change", "trip-cur", (el) => run(() => updateSettings({ trip_currency: (el as HTMLSelectElement).value })));

on("submit", "trip-rate", () => {
  const rate = parseFloat(($("tripRate") as HTMLInputElement).value);
  if (!isFinite(rate) || rate <= 0 || rate >= 100000) { flash(`צריך מספר חיובי — כמה ${baseWordTo().replace(/^ל/, "")} שווה יחידה אחת.`, "err"); return; }
  const cur = tripCurrency();
  return run(async () => {
    const up = await sb.from("fx_overrides").update({ ils_per_unit: rate, updated_at: new Date().toISOString() })
      .eq("household_id", S.hh!).eq("currency", cur).select("currency");
    if (up.error) throw up.error;
    if (!up.data?.length) {
      const ins = await sb.from("fx_overrides").insert({ household_id: S.hh, currency: cur, ils_per_unit: rate });
      if (ins.error) throw ins.error;
    }
    await loadFx();
  }, "✓ השער הידני נשמר");
});

on("click", "trip-rate-clear", () => run(async () => {
  const r = await sb.from("fx_overrides").delete().eq("household_id", S.hh!).eq("currency", tripCurrency());
  if (r.error) throw r.error;
  await loadFx();
}, "✓ חוזרים לשער הרשמי"));
