// Event delegation: markup declares data-click / data-change / data-submit /
// data-input="name" and modules register handlers by name. No per-render
// re-binding, and no inline event handlers (CSP-friendly).

type H = (el: HTMLElement, e: Event) => void | Promise<void>;
const reg: Record<string, Record<string, H>> = { click: {}, change: {}, submit: {}, input: {} };

export function on(type: "click" | "change" | "submit" | "input", name: string, fn: H) {
  reg[type][name] = fn;
}

function dispatch(type: string, e: Event) {
  const attr = `data-${type}`;
  const el = (e.target as Element | null)?.closest?.(`[${attr}]`) as HTMLElement | null;
  if (!el) return;
  const fn = reg[type][el.getAttribute(attr) || ""];
  if (!fn) return;
  if (type === "submit") e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => console.error(err?.message ?? err));
}

export function installEvents(root: Document | HTMLElement = document) {
  for (const t of ["click", "change", "submit", "input"]) root.addEventListener(t, (e) => dispatch(t, e));
}

/** Two-tap confirm for destructive buttons (prototype's "למחוק?"). */
let armed: string | null = null;
let armTimer: number | undefined;
export function armed2(key: string, rerender: () => void): boolean {
  if (armed === key) {
    armed = null;
    return true;
  }
  armed = key;
  clearTimeout(armTimer);
  armTimer = window.setTimeout(() => { armed = null; rerender(); }, 4000);
  rerender();
  return false;
}
export const isArmed = (key: string) => armed === key;
