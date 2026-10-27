// Micro-interactions (design-brief §5): count-up, confetti, tab transition,
// swipe-left to delete, pull-to-refresh. Everything is off under
// prefers-reduced-motion. The app re-renders with innerHTML, so effects run in
// an after-render hook and only when a value actually changed.
import { S } from "../state.ts";
import { baseSymbol, region } from "../lib/region.ts";

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

const after: (() => void)[] = [];
/** Called by main.ts after every render. */
export function runAfterRender() { for (const f of after) f(); }
export const afterRender = (f: () => void) => { after.push(f); };

// ------------------------------------------------------------ count-up
const shown = new Map<string, number>();
const fmt = (n: number) => (n < 0 ? "-" : "") + baseSymbol() + Math.abs(Math.round(n)).toLocaleString(region().locale);
afterRender(() => {
  document.querySelectorAll<HTMLElement>("[data-countup]").forEach((el) => {
    const key = el.dataset.key ?? "k";
    const to = Number(el.dataset.countup);
    const from = shown.get(key);
    shown.set(key, to);
    if (from === to || reducedMotion() || !isFinite(to)) return;
    const start = performance.now(), a = from ?? 0, dur = 650;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - k, 3);
      if (!el.isConnected) return;
      el.textContent = fmt(a + (to - a) * e);
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = fmt(a);
    requestAnimationFrame(step);
  });
});

// ------------------------------------------------------------ confetti
export function confetti() {
  if (reducedMotion()) return;
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  const colors = ["var(--accent)", "var(--var)", "var(--accent-deep)", "#E07A5F", "#7B68D9"];
  for (let i = 0; i < 48; i++) {
    const p = document.createElement("i");
    p.style.cssText = `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 0.3}s;` +
      `--dx:${(Math.random() - 0.5) * 160}px;--r:${Math.random() * 720 - 360}deg;animation-duration:${1.4 + Math.random() * 0.9}s`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 2600);
}

// ------------------------------------------------------------ tab transition
let lastTab = "";
/** "enter" class for <main> only when the tab changed (not on every re-render). */
export function tabEnterClass(): string {
  const cls = lastTab && lastTab !== S.tab && !reducedMotion() ? "enter" : "";
  lastTab = S.tab;
  return cls;
}

// ------------------------------------------------------------ gestures
let swipeHandler: ((id: string) => void) | null = null;
let refreshHandler: (() => Promise<void>) | null = null;
export const onSwipeDelete = (f: (id: string) => void) => { swipeHandler = f; };
export const onPullRefresh = (f: () => Promise<void>) => { refreshHandler = f; };

let g: null | { x: number; y: number; row: HTMLElement | null; pull: boolean; dx: number; dy: number; axis: "" | "x" | "y" } = null;
const PULL = 70, SWIPE = 90;

export function installGestures() {
  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || S.view !== "app") { g = null; return; }
    const t = e.touches[0];
    const row = (e.target as Element).closest?.<HTMLElement>("[data-swipe]") ?? null;
    const pull = S.tab === "overview" && window.scrollY <= 0 && !row && !!refreshHandler;
    g = { x: t.clientX, y: t.clientY, row, pull, dx: 0, dy: 0, axis: "" };
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!g) return;
    const t = e.touches[0];
    g.dx = t.clientX - g.x;
    g.dy = t.clientY - g.y;
    if (!g.axis && Math.hypot(g.dx, g.dy) > 8) g.axis = Math.abs(g.dx) > Math.abs(g.dy) ? "x" : "y";
    if (g.axis === "x" && g.row && g.dx < 0) {
      g.row.style.transform = `translateX(${Math.max(g.dx, -140)}px)`;
      g.row.classList.toggle("swiping", g.dx < -SWIPE);
    }
    if (g.axis === "y" && g.pull && g.dy > 0) {
      const el = document.getElementById("ptr");
      if (el) {
        const d = Math.min(g.dy * 0.5, PULL + 20);
        el.style.transform = `translateY(${d}px) rotate(${d * 4}deg)`;
        el.style.opacity = String(Math.min(1, d / PULL));
        el.classList.toggle("ready", d >= PULL);
      }
    }
  }, { passive: true });

  document.addEventListener("touchend", async () => {
    const s = g;
    g = null;
    if (!s) return;
    if (s.row) {
      const id = s.row.dataset.swipe!;
      if (s.axis === "x" && s.dx < -SWIPE && swipeHandler) { s.row.classList.add("gone"); swipeHandler(id); }
      else { s.row.style.transform = ""; s.row.classList.remove("swiping"); }
    }
    const el = document.getElementById("ptr");
    if (s.pull && el) {
      if (s.axis === "y" && s.dy * 0.5 >= PULL && refreshHandler) {
        el.classList.add("spinning");
        try { await refreshHandler(); } finally { el.classList.remove("spinning", "ready"); el.style.transform = ""; el.style.opacity = "0"; }
      } else { el.style.transform = ""; el.style.opacity = "0"; }
    }
  });
}
