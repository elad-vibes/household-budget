// "קליטה אוטומטית באייפון" (next-features.md §2): the per-user capture token (shown once,
// rotate / revoke), a step-by-step guide for the Apple Pay (Wallet) automation and the
// Back Tap quick-add shortcut with copy buttons, and the "מה נקלט ומתי" log screen.
import { attr, html, type SafeHtml } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { fmtDateTime, ils2 } from "../lib/format.ts";
import { dbMessage, sb } from "../lib/supa.ts";
import { canWrite, flash, rerender, S } from "../state.ts";
import { CATS } from "../domain/categories.ts";
import { banner, copyText } from "./common.ts";
import { homeCards } from "./home.ts";
import { icon } from "./cat.ts";

const ENDPOINT = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "https://<project>.supabase.co"}/functions/v1/capture`;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
interface Tok { id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
const C = () => (S.extra.capture2 ??= { tokens: null as Tok[] | null, fresh: null as string | null, loading: false, log: null as any[] | null });

async function loadTokens() {
  const c = C();
  if (c.loading) return;
  c.loading = true;
  const { data } = await sb.from("capture_tokens").select("id, label, created_at, last_used_at, revoked_at").eq("household_id", S.hh!).order("created_at", { ascending: false }).limit(5);
  c.tokens = (data ?? []) as Tok[];
  c.loading = false;
  rerender();
}

const WALLET_BODY = `{"kind":"wallet","amount":"<Amount>","merchant":"<Merchant>","card":"<Card or Pass>"}`;
const QUICK_BODY = `{"kind":"quick","amount":"<Provided Input>","category":"<Chosen Item>"}`;
const copyRow = (label: string, value: string, key: string) =>
  html`<div class="copyrow"><span class="small"><b>${label}</b></span><code dir="ltr">${value}</code><button type="button" data-click="cap-copy" data-k="${key}">העתקה</button></div>`;

function setupCard(): SafeHtml {
  if (!canWrite()) return html``;
  const c = C();
  if (c.tokens === null) { void loadTokens(); }
  const active = ((c.tokens ?? []) as Tok[]).find((t) => !t.revoked_at);
  const ios = isIOS();
  return html`<div class="card" id="captureSetup">
    <div class="card-h"><h2>קליטה אוטומטית באייפון</h2>${icon("receipt")}</div>
    <p class="muted small">כל תשלום ב-Apple Pay נכנס לאפליקציה לבד, ולחיצה כפולה על גב הטלפון פותחת הוספה מהירה. מה שנכנס מכרטיס מחכה לפירוט ומתאחד איתו — לא נספר פעמיים.</p>
    ${!ios ? banner("לא זמין באנדרואיד — אפשר להוסיף ידנית או לצלם קבלה.", "info") : ""}
    ${c.fresh ? html`<div class="banner warn"><b>הקוד מוצג רק עכשיו.</b> מעתיקים אותו לקיצור הדרך (שלב 6). אחר כך הוא לא יוצג שוב.</div>
      ${copyRow("הקוד (X-Capture-Token)", c.fresh, "token")}
      <div class="row end"><button class="ghost" data-click="cap-hide">סיימתי, להסתיר</button></div>`
      : html`<p class="small">${active ? html`יש קוד פעיל${active.last_used_at ? ` · שימוש אחרון ${fmtDateTime(active.last_used_at)}` : " · עוד לא היה שימוש"}.` : "עוד אין קוד. צריך אחד כדי שקיצור הדרך יוכל להוסיף הוצאות בשמך."}</p>
      <div class="row"><button class="primary" data-click="cap-new">${active ? "קוד חדש (הישן יפסיק לעבוד)" : "יצירת קוד"}</button>${active ? html`<button class="ghost danger" data-click="cap-revoke">ביטול הקוד</button>` : ""}</div>`}
    <details ${attr(!!c.fresh, "open")}><summary><b>שלב אחר שלב: Apple Pay → האפליקציה</b> (iOS 17 ומעלה)</summary>
      <ol class="steps small">
        <li>פותחים את האפליקציה <b>קיצורים</b> (Shortcuts) באייפון.</li>
        <li>למטה לוחצים <b>אוטומציה</b>, ואז <b>+</b> (או "אוטומציה חדשה").</li>
        <li>גוללים ובוחרים <b>ארנק</b> (Wallet). מסמנים את <b>כל הכרטיסים</b>, ולמטה בוחרים <b>הפעלה מיידית</b> (Run Immediately). לוחצים <b>הבא</b>.</li>
        <li>לוחצים <b>אוטומציה ריקה חדשה</b>, ואז <b>הוספת פעולה</b>, מחפשים <b>קבלת התוכן של כתובת URL</b> (Get Contents of URL) ובוחרים בה.</li>
        <li>במקום "כתובת URL" מדביקים את הכתובת הזו:${copyRow("כתובת", ENDPOINT, "url")}</li>
        <li>לוחצים על החץ <b>›</b> ליד הפעולה: <b>שיטה</b> = POST. ב<b>כותרות</b> (Headers) מוסיפים: שם = <code dir="ltr">X-Capture-Token</code>, ערך = הקוד מלמעלה.</li>
        <li>ב<b>גוף הבקשה</b> בוחרים <b>JSON</b> ומוסיפים 4 שדות מסוג טקסט: <code dir="ltr">kind</code> = <code dir="ltr">wallet</code>, ו-<code dir="ltr">amount</code>, <code dir="ltr">merchant</code>, <code dir="ltr">card</code> — בכל אחד לוחצים על הערך ובוחרים את המשתנה <b>סכום</b> / <b>סוחר</b> / <b>כרטיס</b> מהאוטומציה (Amount / Merchant / Card or Pass).${copyRow("לדוגמה", WALLET_BODY, "wallet")}</li>
        <li>לוחצים <b>סיום</b>. משלמים פעם אחת ב-Apple Pay ובודקים ב"מה נקלט ומתי" שההוצאה הופיעה.</li>
      </ol></details>
    <details><summary><b>הוספה מהירה בלחיצה כפולה על גב הטלפון</b></summary>
      <ol class="steps small">
        <li>בקיצורים לוחצים <b>+</b> (קיצור דרך חדש) וקוראים לו "הוצאה מהירה".</li>
        <li>מוסיפים פעולה <b>בקשת קלט</b> (Ask for Input) מסוג <b>מספר</b>, עם השאלה "כמה?".</li>
        <li>מוסיפים פעולה <b>בחירה מתפריט</b> (Choose from List) עם הקטגוריות שרוצים, למשל:${copyRow("קטגוריות", CATS.slice(0, 6).join(", "), "cats")}</li>
        <li>מוסיפים <b>קבלת התוכן של כתובת URL</b> בדיוק כמו בשלבים 5–6 למעלה, ובגוף ה-JSON: <code dir="ltr">kind</code> = <code dir="ltr">quick</code>, <code dir="ltr">amount</code> = הקלט, <code dir="ltr">category</code> = הפריט שנבחר.${copyRow("לדוגמה", QUICK_BODY, "quick")}</li>
        <li>מוסיפים בסוף <b>הצגת התראה</b> (Show Notification) עם התוצאה — תופיע הודעה "נקלט: ₪…".</li>
        <li>ב<b>הגדרות</b> → <b>נגישות</b> → <b>מגע</b> → <b>הקשה על הגב</b> → <b>הקשה כפולה</b> → בוחרים "הוצאה מהירה".</li>
      </ol>
      <p class="muted small">הוספה מהירה נרשמת כמזומן ונספרת מיד. אפשר לשנות אחר כך בלשונית "תנועות".</p></details>
    <div><button class="ghost" data-click="go" data-to="log">${icon("receipt")} מה נקלט ומתי</button></div>
  </div>`;
}
homeCards.push(setupCard);

const SRC: Record<string, [string, string]> = {
  wallet: ["Apple Pay", "wallet"], quick: ["הוספה מהירה", "zap"], receipt: ["קבלה", "receipt"], import: ["קובץ פירוט", "building-2"],
  statement: ["פירוט (צילום/PDF)", "building-2"], manual: ["ידני", "wallet"], backup: ["גיבוי", "refresh-cw"],
};

export function renderCaptureLog(): SafeHtml {
  const c = C();
  if (c.log === null) {
    void sb.rpc("capture_log", { p_household: S.hh }).then(({ data, error }) => { c.log = error ? [] : (data ?? []); if (error) flash(dbMessage(error), "err"); rerender(); });
    return html`<div class="skel"><div class="skel-card"><div class="skel-line"></div><div class="skel-line" style="width:70%"></div></div></div>`;
  }
  return html`<div class="card"><div class="card-h"><h2>מה נקלט ומתי</h2><button class="ghost" data-click="log-refresh">${icon("refresh-cw")} רענון</button></div>
    <p class="muted small">50 הדברים האחרונים שנכנסו — מכל מקור.</p>
    ${c.log.length ? c.log.map((r: any) => {
      const [label, ic] = SRC[r.source] ?? [r.source, "circle-ellipsis"];
      return html`<div class="fxrow av"><span class="caticon s" style="--c:var(--accent-deep)">${icon(ic)}</span>
        <div class="n">${r.merchant}<small>${label} · ${fmtDateTime(r.created_at)}${r.created_by_name ? " · " + r.created_by_name : ""}</small></div>
        <div class="a num">${ils2(Number(r.amount))}</div>
        ${r.status === "review" ? html`<span class="chip info">לאישור</span>` : r.match_status === "awaiting_statement" ? html`<span class="chip grey">ממתין לפירוט</span>` : r.match_status === "matched" ? html`<span class="chip ok">הותאם</span>` : html`<span class="chip ok">נשמר</span>`}</div>`;
    }) : html`<p class="muted">עוד לא נקלט כלום.</p>`}</div>`;
}

on("click", "cap-new", async () => {
  try {
    const { data, error } = await sb.rpc("create_capture_token", { p_household: S.hh, p_label: isIOS() ? "iPhone" : "" });
    if (error) throw error;
    C().fresh = data as string;
    C().tokens = null;
  } catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "cap-revoke", async () => {
  try { const { error } = await sb.rpc("revoke_capture_tokens", { p_household: S.hh }); if (error) throw error; C().tokens = null; C().fresh = null; flash("הקוד בוטל. קיצור הדרך יפסיק לעבוד.", "info"); }
  catch (e) { flash(dbMessage(e), "err"); }
  rerender();
});
on("click", "cap-hide", () => { C().fresh = null; rerender(); });
on("click", "cap-copy", async (el) => {
  const v = { token: C().fresh ?? "", url: ENDPOINT, wallet: WALLET_BODY, quick: QUICK_BODY, cats: CATS.slice(0, 6).join(", ") }[el.dataset.k as "url"] ?? "";
  flash((await copyText(v)) ? "הועתק" : "לא הצלחתי להעתיק", "info");
});
on("click", "log-refresh", () => { C().log = null; rerender(); });
