// App shell: boot, auth gate, hash router, bottom navigation, rendering.
import "./styles.css";
import "./design.css";
import type { Session } from "@supabase/supabase-js";
import { html, render, type SafeHtml } from "./lib/html.ts";
import { installEvents, on } from "./lib/events.ts";
import { configured, sb } from "./lib/supa.ts";
import { addM, mLabel } from "./lib/format.ts";
import { THEMES } from "./domain/categories.ts";
import { monthsWithData, reviewTx } from "./domain/calc.ts";
import { currentBudgetMonth, rangeLabel } from "./domain/month.ts";
import { ctx, household, rerender, S, setRenderer, startDay, type Tab } from "./state.ts";
import { bootHousehold, loadHousehold, loadUsage } from "./data.ts";
import { checkJobs, loadQueue, maybeAutoSend } from "./receipts.ts";
import { renderOverview } from "./ui/overview.ts";
import { renderAdd } from "./ui/add.ts";
import { renderTx } from "./ui/tx.ts";
import { renderFixed } from "./ui/fixed.ts";
import { renderShop } from "./ui/shop.ts";
import { renderHome } from "./ui/home.ts";
import { acceptInvite, loadInvite, prepareChallenge, renderJoin, renderMfaChallenge, renderMfaEnroll, renderSignin } from "./ui/auth.ts";
import { loadAdmin, renderAdmin } from "./ui/admin.ts";
import { isStandalone, renderInstall } from "./ui/onboarding.ts";
import { banner } from "./ui/common.ts";
import { legacyData } from "./importer.ts";
import { I } from "./ui/icons.ts";
import { renderPlan } from "./ui/plan.ts";
import { renderCaptureLog } from "./ui/capture-setup.ts";
import { loadPhase2 } from "./phase2.ts";
import "./payments.ts"; // payment methods: cards + handlers register themselves
import { art, markArt, timeArt } from "./ui/art.ts";
import { icon } from "./ui/cat.ts";
import { captureFab, captureSheet } from "./ui/capture.ts";
import { installGestures, onPullRefresh, runAfterRender, tabEnterClass } from "./ui/motion.ts";
import { flash } from "./state.ts";

/** Tabs; Phase 2 adds "plan" through registerTab(). */
const TAB_RENDER: Partial<Record<Tab, () => SafeHtml>> = {
  overview: renderOverview, add: renderAdd, tx: renderTx, fixed: renderFixed, shop: renderShop, home: renderHome, plan: renderPlan, log: renderCaptureLog,
};
export function registerTab(tab: Tab, fn: () => SafeHtml) { TAB_RENDER[tab] = fn; }
const TITLES: Record<Tab, string> = { overview: "סקירה", add: "הוספה", tx: "תנועות", fixed: "קבועות", plan: "תכנון", shop: "קניות", home: "הבית", log: "מה נקלט ומתי" };

// ------------------------------------------------------------------ routing
function readHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [a, b] = h.split("/");
  if (a === "join" && /^[0-9a-f]{64}$/.test(b ?? "")) S.joinToken = b;
  if ((Object.keys(TITLES) as Tab[]).includes(a as Tab)) S.tab = a as Tab;
  return a;
}

async function onHash() {
  const a = readHash();
  S.extra.more = false;
  if (a === "install") { S.view = "install"; rerender(); return; }
  if (a === "admin") { await openAdmin(); return; }
  if (a === "join" && S.joinToken) { S.view = "join"; await loadInvite(); return; }
  if (S.user && ["install", "admin"].includes(S.view)) { await start(); return; }
  rerender();
  window.scrollTo({ top: 0 });
}

async function openAdmin() {
  if (!S.user) { S.view = "signin"; rerender(); return; }
  if (!S.isAdmin) { location.hash = "#/overview"; return; }
  if (S.aal.current !== "aal2") {
    S.extra.adminGate = true;
    if (S.hasFactor) { await prepareChallenge(); S.view = "mfa-challenge"; } else S.view = "mfa-enroll";
    rerender();
    return;
  }
  S.view = "admin";
  rerender();
  await loadAdmin();
}

on("click", "go", (el) => {
  const to = el.dataset.to!;
  S.extra.more = false;
  if (to === "admin" || to === "install") location.hash = `#/${to}`;
  else if (S.user && ["admin", "install", "nohousehold"].includes(S.view)) {
    // leaving the admin / install screens: the view must go back to the app, not just the tab
    // (bug 2026-09-27: "חזרה לאפליקציה" left the admin screen showing)
    S.tab = to as Tab;
    history.replaceState(null, "", `#/${to}`);
    start();
    window.scrollTo({ top: 0 });
  } else {
    S.tab = to as Tab;
    history.replaceState(null, "", `#/${to}`);
    rerender();
    window.scrollTo({ top: 0 });
  }
});
on("click", "more", () => { S.extra.more = !S.extra.more; rerender(); });
on("click", "prevM", () => { S.month = addM(S.month, -1); S.monthTouched = true; rerender(); });
on("click", "nextM", () => { S.month = addM(S.month, 1); S.monthTouched = true; rerender(); });
on("click", "reload", () => location.reload());
on("click", "sw-update", () => { navigator.serviceWorker.getRegistration().then((r) => r?.waiting?.postMessage("SKIP_WAITING")); });

// ------------------------------------------------------------------ boot
async function onSession(session: Session | null) {
  if (!session) {
    S.user = null;
    S.view = S.joinToken ? "join" : location.hash.startsWith("#/install") ? "install" : "signin";
    if (S.view === "join") await loadInvite();
    rerender();
    return;
  }
  S.user = { id: session.user.id, email: session.user.email ?? "" };
  if (S.joinToken || localStorage.getItem("hb2-join")) {
    if (await acceptInvite()) return;
  }
  await start();
}

async function start() {
  S.view = "loading";
  rerender();
  let r: Awaited<ReturnType<typeof bootHousehold>>;
  try {
    r = await bootHousehold();
  } catch {
    S.view = "app";
    S.extra.offline = true;
    rerender();
    return;
  }
  if (location.hash.startsWith("#/admin")) { await openAdmin(); return; }
  if (r === "none") { S.view = "nohousehold"; rerender(); return; }
  if (r === "mfa-challenge") { await prepareChallenge(); S.view = "mfa-challenge"; rerender(); return; }
  if (r === "mfa-enroll") { S.view = "mfa-enroll"; rerender(); return; }
  await loadPhase2().catch(() => undefined);
  if (!S.monthTouched) {
    const ms = monthsWithData(ctx());
    S.month = ms.length ? ms[ms.length - 1] : currentBudgetMonth(startDay());
  }
  S.view = !isStandalone() && !localStorage.getItem("hb2-onboarded") && /mobile|iphone|android/i.test(navigator.userAgent) ? "install" : "app";
  rerender();
  await loadQueue();
  await checkJobs().catch(() => undefined);
  await maybeAutoSend().catch(() => undefined);
  if (S.hasFactor) sb.rpc("recovery_codes_status").then(({ data }) => { S.extra.recovery = data; });
  rerender();
}

async function boot() {
  installEvents();
  installGestures();
  onPullRefresh(async () => {
    await loadHousehold();
    await loadPhase2().catch(() => undefined);
    rerender();
    flash("✓ עודכן", "ok");
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => rerender());
  setRenderer(renderAll);
  if (!configured) { S.view = "noconfig"; renderAll(); return; }
  readHash();
  renderAll();
  const { data } = await sb.auth.getSession();
  await onSession(data.session);
  sb.auth.onAuthStateChange((event, session) => {
    // never await Supabase calls inside this callback (auth lock); defer instead
    if (event === "SIGNED_IN" && !S.user) setTimeout(() => onSession(session), 0);
    if (event === "SIGNED_OUT" && S.user) { S.user = null; setTimeout(() => location.reload(), 0); }
  });
  addEventListener("hashchange", () => { onHash(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.view === "app") {
      checkJobs().then(() => maybeAutoSend()).then(() => loadUsage()).then(rerender).catch(() => undefined);
    }
  });
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).then((reg) => {
    const ask = () => { S.extra.swUpdate = true; rerender(); };
    if (reg.waiting && navigator.serviceWorker.controller) ask();
    reg.addEventListener("updatefound", () => {
      reg.installing?.addEventListener("statechange", () => { if (reg.waiting && navigator.serviceWorker.controller) ask(); });
    });
  }).catch(() => undefined);
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (!reloaded) { reloaded = true; location.reload(); } });
}

// ---------------------------------------------------------------- render
/** Light / dark per device ("system" follows the phone). */
export const scheme = (): "system" | "light" | "dark" => {
  try { return (localStorage.getItem("hb2-scheme") as "light" | "dark" | null) ?? "system"; } catch { return "system"; }
};
const isDark = () => scheme() === "dark" || (scheme() === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
const mix = (a: string, b: string, w: number) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const x = p(a), y = p(b);
  return "#" + x.map((v, i) => Math.round(v * w + y[i] * (1 - w)).toString(16).padStart(2, "0")).join("");
};

function applyTheme() {
  const t = THEMES[S.settings?.theme ?? "max"] ?? THEMES.max;
  const dark = isDark();
  const root = document.documentElement;
  root.dataset.dark = dark ? "1" : "0";
  const r = root.style;
  // every preset gets a dark variant: the accent stays, "deep" becomes a light tint for text on dark surfaces
  const deep = dark ? mix(t.accent, "#ffffff", 0.55) : t.deep;
  r.setProperty("--accent", t.accent);
  r.setProperty("--accent-deep", deep);
  r.setProperty("--fixed", deep);
  r.setProperty("--accent-soft", dark ? mix(t.accent, "#16201D", 0.24) : t.soft);
  r.setProperty("--accent-ink", dark ? "#0E1513" : "#FFFFFF");
  r.setProperty("--var", t.var);
  if (dark) r.removeProperty("--ground"); else r.setProperty("--ground", t.ground);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0E1513" : t.accent);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", dark ? "dark" : "light");
}

function greeting(): SafeHtml {
  const h = new Date().getHours();
  const [text, pic] = h >= 5 && h < 12 ? ["בוקר טוב", timeArt.morning()] : h >= 12 && h < 17 ? ["צהריים טובים", timeArt.noon()] : ["ערב טוב", timeArt.evening()];
  const me = S.members.find((m) => m.user_id === S.user?.id)?.display_name?.trim();
  return html`<div class="greet">${pic}<span>${text}${me ? ", " + me : ""}</span></div>`;
}

const skeleton = () => html`<div class="skel" aria-busy="true" aria-label="טוען">
  <div class="skel-card"><div class="skel-line" style="width:40%"></div><div class="skel-line big"></div><div class="skel-line" style="width:70%"></div></div>
  <div class="skel-card"><div class="skel-line" style="width:30%"></div><div class="skel-line"></div><div class="skel-line" style="width:85%"></div><div class="skel-line" style="width:60%"></div></div>
  <div class="skel-card"><div class="skel-line" style="width:35%"></div><div class="skel-line"></div></div></div>`;

function shell(): SafeHtml {
  const tab = S.tab;
  const content = (TAB_RENDER[tab] ?? renderOverview)();
  const pending = reviewTx(ctx()).length;
  const monthTabs = tab === "overview" || tab === "tx";
  const legacy = S.tab === "overview" && !S.tx.length && legacyData();
  const navBtn = (t: Tab | "more", icon: SafeHtml, label: string, badge = 0) => html`<button data-click="${t === "more" ? "more" : "go"}" data-to="${t}" aria-current="${t === tab || (t === "more" && ["fixed", "plan", "home", "log"].includes(tab)) ? "page" : "false"}" class="${t === "add" ? "add" : ""}">${icon}<span>${label}</span>${badge ? html`<span class="badge">${badge}</span>` : ""}</button>`;
  return html`
  <div class="top">
    <div><button class="hhsw" data-click="go" data-to="home">${household()?.name ?? ""} ▾</button>${tab === "overview" ? greeting() : ""}<h1>${tab === "overview" ? "הכסף של הבית" : TITLES[tab]}</h1></div>
    ${monthTabs ? html`<div class="monthsw" aria-label="בחירת חודש"><button data-click="prevM" aria-label="חודש קודם">→</button><b>${mLabel(S.month)}${startDay() > 1 ? html`<small class="mrange num">${rangeLabel(S.month, startDay())}</small>` : ""}</b><button data-click="nextM" aria-label="חודש הבא">←</button></div>` : ""}
  </div>
  ${S.extra.swUpdate ? banner(html`יש גרסה חדשה של האפליקציה. <button data-click="sw-update">עדכון</button>`, "info") : ""}
  ${legacy ? banner(html`נמצאו במכשיר הזה נתונים מהגרסה הקודמת. <button data-click="go" data-to="home">לייבוא</button>`, "info") : ""}
  ${S.extra.offline ? html`<div class="card empty">${art.offline()}<h2>אין חיבור כרגע</h2><p class="muted">לא הצלחנו להגיע לשרת. קבלות שמצלמים נשמרות בטלפון ויישלחו כשהחיבור יחזור.</p><button class="primary" data-click="reload">לנסות שוב</button></div>` : ""}
  ${tab === "overview" ? html`<div id="ptr" class="ptr" aria-hidden="true">${icon("refresh-cw")}</div>` : ""}
  <main class="wrap ${tabEnterClass()}">${content}</main>
  ${captureFab()}${captureSheet()}
  <nav class="bnav" aria-label="ניווט">
    ${navBtn("overview", I.overview, "סקירה")}
    ${navBtn("tx", I.tx, "תנועות", pending)}
    ${navBtn("add", I.add, "הוספה")}
    ${navBtn("shop", I.shop, "קניות")}
    ${navBtn("more", I.more, "עוד")}
  </nav>
  ${S.extra.more ? html`<div class="sheet-bg" data-click="more"></div><div class="sheet" role="menu">
    <button data-click="go" data-to="fixed">${I.fixed} קבועות</button>
    ${TAB_RENDER.plan ? html`<button data-click="go" data-to="plan">${I.plan} תכנון: תקציבים, שנתיות ויעדים</button>` : ""}
    <button data-click="go" data-to="log">${I.tx} מה נקלט ומתי</button>
    <button data-click="go" data-to="home">${I.home} הבית והגדרות</button>
    <button data-click="go" data-to="install">${I.install} התקנה למסך הבית</button>
    ${S.isAdmin ? html`<button data-click="go" data-to="admin">${I.admin} ניהול מערכת</button>` : ""}
  </div>` : ""}`;
}

function viewHtml(): SafeHtml {
  switch (S.view) {
    case "noconfig": return html`<div class="auth"><h1>הכסף של הבית</h1>${banner("חסרים פרטי חיבור ל-Supabase (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY).", "err")}</div>`;
    case "loading": return html`<div class="wrap" style="margin-top:4vh">${skeleton()}</div>`;
    case "signin": return renderSignin();
    case "join": return renderJoin();
    case "mfa-challenge": return renderMfaChallenge();
    case "mfa-enroll": return renderMfaEnroll();
    case "install": return renderInstall();
    case "admin": return html`<div class="wrap">${renderAdmin()}</div>`;
    case "nohousehold": return html`<div class="auth">${markArt()}<h1>עוד אין משק בית</h1>
      <p>החשבון מחובר, אבל עוד לא הצטרפת לאף משק בית. כדי להצטרף צריך קישור הזמנה ממי שמנהל את משק הבית.</p>
      ${S.isAdmin ? html`<button class="primary" data-click="go" data-to="admin">ניהול מערכת</button>` : ""}
      <button class="ghost" data-click="signout">יציאה</button></div>`;
    default: return shell();
  }
}

type Snap = { value: string; def: string; focus: boolean };
function snapshot(): Map<string, Snap> {
  const m = new Map<string, Snap>();
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("#app input[id], #app textarea[id]").forEach((el) => {
    if (el instanceof HTMLInputElement && !["text", "number", "date", "email", "search"].includes(el.type)) return;
    m.set(el.id, { value: el.value, def: el.defaultValue, focus: document.activeElement === el });
  });
  return m;
}
function restore(m: Map<string, Snap>) {
  for (const [id, s] of m) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) continue;
    if (el.defaultValue === s.def && s.value !== s.def) el.value = s.value; // keep what the user typed
    if (s.focus) el.focus();
  }
}

function renderAll() {
  const root = document.getElementById("app");
  if (!root) return;
  applyTheme();
  document.body.classList.toggle("noapp", S.view !== "app");
  const snap = snapshot();
  const undo = S.extra.undo as { text: string } | undefined;
  render(root, html`${viewHtml()}${S.flash ? html`<div class="flash banner ${S.flash.kind}" role="status">${S.flash.text}</div>`
    : undo ? html`<div class="toast" role="status"><span>${undo.text}</span><button data-click="undo">ביטול</button></div>` : ""}`);
  restore(snap);
  runAfterRender();
}

boot();
