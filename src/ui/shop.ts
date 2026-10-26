// קניות — shared shopping list (Supabase Realtime keeps every phone in sync).
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { canWrite, flash, rerender, S } from "../state.ts";
import { addShop, deleteShop, updateShop } from "../data.ts";
import { dbMessage } from "../lib/supa.ts";
import { copyText } from "./common.ts";
import { priceCard } from "./price.ts";
import { art } from "./art.ts";

/** Phase 2: price history hints and the "our prices" card plug in here. */
export const shopExtras = {
  hint: (_name: string): SafeHtml | string => "",
  cards: [] as (() => SafeHtml)[],
};

export function renderShop(): SafeHtml {
  const w = canWrite();
  const items = S.shop;
  const open = items.filter((i) => !i.done).length;
  const list = items.slice().sort((a, b) => Number(a.done) - Number(b.done) || a.sort - b.sort);
  return html`<div class="card">
    <div class="card-h"><h2>רשימת קניות</h2><span class="muted small num">${items.length ? `${open} נשארו מתוך ${items.length}` : ""}</span></div>
    ${w ? html`<form class="row" style="flex-wrap:nowrap" data-submit="shop-add">
      <input type="text" id="shopIn" maxlength="300" placeholder="מה צריך? אפשר כמה פריטים מופרדים בפסיק" aria-label="פריט חדש" enterkeyhint="done">
      <button class="primary" type="submit">הוספה</button></form>` : ""}
    <div>${list.length ? list.map((i) => html`<div class="shop ${i.done ? "done" : ""}">
        <input type="checkbox" data-change="shop-done" data-id="${i.id}" ${attr(i.done, "checked")} ${attr(!w, "disabled")} aria-label="נקנה">
        <span class="nm">${i.name}${shopExtras.hint(i.name)}</span>
        <input type="number" min="1" max="99" step="1" value="${i.qty}" data-change="shop-qty" data-id="${i.id}" ${attr(!w, "disabled")} aria-label="כמות">
        ${w ? html`<button class="ghost" data-click="shop-del" data-id="${i.id}" aria-label="הסרה">✕</button>` : html`<span></span>`}
      </div>`) : html`<div class="empty">${art.shopEmpty()}<p class="muted">הרשימה ריקה. מוסיפים פריט למעלה, וכל בני הבית רואים את אותה רשימה.</p></div>`}</div>
    ${items.length ? html`<div class="row"><button type="button" data-click="shop-copy">העתקת הרשימה</button>${w ? html`<button type="button" class="ghost" data-click="shop-clear">ניקוי מה שסומן</button>` : ""}</div>` : ""}
  </div>
  ${items.some((i) => !i.done) ? priceCard() : ""}
  ${shopExtras.cards.map((f) => f())}`;
}

on("submit", "shop-add", async () => {
  const inp = $("shopIn") as HTMLInputElement;
  const names = inp.value.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean).slice(0, 30);
  if (!names.length) return;
  inp.value = "";
  try { await addShop(names); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
  ($("shopIn") as HTMLInputElement | null)?.focus();
});
on("change", "shop-done", async (el) => {
  try { await updateShop(el.dataset.id!, { done: (el as HTMLInputElement).checked }); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("change", "shop-qty", async (el) => {
  const q = Math.min(99, Math.max(1, Math.round(+(el as HTMLInputElement).value || 1)));
  try { await updateShop(el.dataset.id!, { qty: q }); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "shop-del", async (el) => {
  try { await deleteShop([el.dataset.id!]); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "shop-clear", async () => {
  try { await deleteShop(S.shop.filter((i) => i.done).map((i) => i.id)); } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "shop-copy", async () => {
  const txt = S.shop.filter((i) => !i.done).map((i) => (i.qty > 1 ? i.qty + " × " : "") + i.name).join("\n");
  flash((await copyText(txt)) ? "הרשימה הועתקה" : "לא הצלחתי להעתיק. אפשר לסמן את הרשימה ולהעתיק ידנית.", "info");
});
