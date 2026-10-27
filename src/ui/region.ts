// אזור — the household's region (0016, DECISIONS #42): Israel (₪) or Thailand (฿). One setting that swaps the
// defaults that used to be Israeli-only: base currency, payment methods and banks, categories and rules, price
// comparison. It can be set only while the household is empty (no expenses, fixed expenses, budgets, goals,
// vouchers) — the server enforces it (settings_region_before); this card just explains why it is locked.
import { attr, html, type SafeHtml } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { dbMessage } from "../lib/supa.ts";
import { canWrite, flash, isOwner, rerender, S } from "../state.ts";
import { loadSettings, reloadMethods, updateSettings } from "../data.ts";
import { REGION_CODES, REGIONS, isRegion, regionCode } from "../lib/region.ts";
import { settingsCards } from "./home.ts";

/** Does the household already hold amounts in its current currency? (the server re-checks every table) */
function hasMoneyData(): boolean {
  const p2 = S.extra.p2;
  return S.tx.length > 0 || S.fixed.length > 0 || !!(p2 && (p2.budgets?.length || p2.annual?.length || p2.goals?.length))
    || !!S.extra.vouchers?.list?.length;
}

function regionCard(): SafeHtml {
  if (!S.settings) return html``;
  const code = regionCode();
  const locked = hasMoneyData();
  const can = (isOwner() || S.isAdmin) && !locked;
  return html`<div class="card" id="regionCard">
    <h2>אזור</h2>
    <p class="muted small">איפה משק הבית גר? הבחירה קובעת את המטבע (שקל או באט), את אמצעי התשלום והבנקים, את הקטגוריות וכללי הסיווג, ואם "איפה הכי זול?" זמין. הממשק נשאר בעברית.</p>
    <label class="f">אזור<select data-change="region-set" ${attr(!can, "disabled")}>
      ${REGION_CODES.map((c) => html`<option value="${c}" ${attr(c === code, "selected")}>${REGIONS[c].label}</option>`)}
    </select></label>
    ${locked
      ? html`<p class="muted small">אי אפשר להחליף אזור אחרי שיש במשק הבית הוצאות, תקציבים, יעדים או שוברים: כל הסכומים נשמרו במטבע הקודם. לאזור אחר פותחים משק בית חדש.</p>`
      : !can && canWrite() ? html`<p class="muted small">רק מנהל/ת משק הבית יכול/ה לבחור אזור.</p>` : ""}
  </div>`;
}
settingsCards.unshift(regionCard);

on("change", "region-set", async (el) => {
  const next = (el as HTMLSelectElement).value;
  if (!isRegion(next) || next === regionCode()) return;
  try {
    await updateSettings({ region: next });
    await Promise.all([loadSettings(), reloadMethods()]);   // the server swapped the default payment methods and the trip currency
    delete S.extra.fx;                                      // cached rates were quoted in the old base
    flash(`✓ האזור הוא עכשיו ${REGIONS[next].label}`, "ok");
  } catch (e: any) {
    await loadSettings().catch(() => {});
    flash(/region_locked/.test(String(e?.message)) ? "אי אפשר להחליף אזור אחרי שנשמרו במשק הבית סכומים." : dbMessage(e), "err");
  }
  rerender();
});
