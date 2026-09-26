// Sign-in (e-mail code + magic link), joining by invite, and two-factor
// authentication: enrollment (QR / "add to authenticator" link / manual code →
// verify → 10 recovery codes), the code prompt on a new device, and recovery.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { appUrl, dbMessage, sb } from "../lib/supa.ts";
import { S, flash, household, isOwner, rerender } from "../state.ts";
import { fn } from "../data.ts";
import { banner, copyText, downloadBlob } from "./common.ts";
import { markArt } from "./art.ts";

const logo = markArt();
const A = () => (S.extra.auth ??= {}) as Record<string, any>;
const JOIN_KEY = "hb2-join";

// ------------------------------------------------------------------ sign in
export function renderSignin(): SafeHtml {
  const a = A();
  if (a.sentTo) return codeForm(a.sentTo, "signin");
  return html`<div class="auth">${logo}<h1>הכסף של הבית</h1>
    <p class="muted">מתחברים עם כתובת המייל. נשלח אליכם קוד בן 6 ספרות (וגם קישור).</p>
    ${a.msg ? banner(a.msg, a.msgKind ?? "info") : ""}
    <form class="card" data-submit="signin-email">
      <label class="f">כתובת מייל<input type="email" id="authEmail" autocomplete="email" inputmode="email" required value="${a.email ?? ""}"></label>
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "שליחת קוד"}</button>
    </form>
    <p class="muted small">משתמשים חדשים מצטרפים רק דרך קישור הזמנה ממי שמנהל את משק הבית.</p>
    <p class="small"><a href="#/install">איך מתקינים את האפליקציה במסך הבית?</a></p>
  </div>`;
}

function codeForm(email: string, mode: "signin" | "join"): SafeHtml {
  const a = A();
  return html`<div class="auth">${logo}<h1>בדקו את המייל</h1>
    <p>שלחנו ל-<b dir="ltr">${email}</b> מייל עם קוד. מקלידים אותו כאן.</p>
    <p class="muted small">אפשר גם ללחוץ על הקישור במייל. באייפון, כשהאפליקציה מותקנת במסך הבית, עדיף להקליד את הקוד. לא הגיע? כדאי לבדוק בספאם, או שהכתובת נכונה.</p>
    ${a.msg ? banner(a.msg, a.msgKind ?? "err") : ""}
    <form class="card" data-submit="verify-code" data-mode="${mode}">
      <label class="f">הקוד מהמייל<input class="code" id="authCode" inputmode="numeric" autocomplete="one-time-code" maxlength="10" required></label>
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "כניסה"}</button>
    </form>
    <div class="row"><button class="ghost" data-click="resend" data-mode="${mode}" ${attr(a.cooldown, "disabled")}>שליחה חוזרת</button><button class="ghost" data-click="change-email">כתובת אחרת</button></div>
  </div>`;
}

async function sendCode(email: string, redirect: string) {
  const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirect } });
  // Unknown addresses get the same screen (no account enumeration).
  if (error && !/signups not allowed|not found|otp_disabled/i.test(error.message)) {
    if (/rate|too many|security purposes/i.test(error.message)) throw new Error("נשלחו יותר מדי קודים. אפשר לנסות שוב בעוד דקה.");
    throw new Error("שליחת המייל נכשלה. כדאי לנסות שוב בעוד רגע.");
  }
}

on("submit", "signin-email", async () => {
  const a = A();
  const email = ($("authEmail") as HTMLInputElement).value.trim().toLowerCase();
  a.busy = true; a.msg = null; a.email = email; rerender();
  try {
    await sendCode(email, appUrl());
    a.sentTo = email;
    startCooldown();
  } catch (e: any) { a.msg = e.message; a.msgKind = "err"; }
  a.busy = false; rerender();
});

function startCooldown() {
  const a = A();
  a.cooldown = true;
  setTimeout(() => { a.cooldown = false; rerender(); }, 60_000);
}

on("click", "resend", async (el) => {
  const a = A();
  try {
    await sendCode(a.sentTo, el.dataset.mode === "join" ? `${appUrl()}#/join/${S.joinToken}` : appUrl());
    startCooldown();
    flash("נשלח קוד חדש", "info");
  } catch (e: any) { flash(e.message, "err"); }
});
on("click", "change-email", () => { const a = A(); a.sentTo = null; a.msg = null; rerender(); });

on("submit", "verify-code", async () => {
  const a = A();
  const token = ($("authCode") as HTMLInputElement).value.replace(/\D/g, "");
  if (token.length < 6) { a.msg = "הקוד צריך להיות לפחות 6 ספרות."; rerender(); return; }
  a.busy = true; a.msg = null; rerender();
  const { error } = await sb.auth.verifyOtp({ email: a.sentTo, token, type: "email" });
  a.busy = false;
  if (error) { a.msg = /expired/i.test(error.message) ? "תוקף הקוד פג. אפשר לבקש קוד חדש." : "הקוד לא נכון. כדאי לבדוק ולנסות שוב."; a.msgKind = "err"; rerender(); return; }
  a.sentTo = null;
  // onAuthStateChange (main.ts) continues: join → accept invite, or boot
});

// ------------------------------------------------------------------- join
export function renderJoin(): SafeHtml {
  const a = A();
  if (a.sentTo) return codeForm(a.sentTo, "join");
  const info = a.invite as { household_name: string; role: string; person_name: string | null } | null;
  if (a.inviteError) return html`<div class="auth">${logo}<h1>הזמנה</h1>${banner(a.inviteError, "err")}<p><button class="ghost" data-click="join-cancel">למסך הכניסה</button></p></div>`;
  if (!info) return html`<div class="auth">${logo}<p class="muted"><span class="spin"></span> בודק את ההזמנה…</p></div>`;
  const role = { owner: "מנהל/ת משק הבית", member: "חבר/ה", viewer: "צפייה בלבד" }[info.role] ?? info.role;
  return html`<div class="auth">${logo}<h1>הוזמנתם ל"${info.household_name}"</h1>
    <p class="muted">הרשאה: ${role}. ${info.role === "owner" ? "למנהל/ת נדרש גם אימות דו-שלבי עם אפליקציית אימות — נגדיר אותו מיד אחרי הכניסה." : ""}</p>
    ${a.msg ? banner(a.msg, a.msgKind ?? "err") : ""}
    <form class="card" data-submit="join-submit">
      <label class="f">איך לקרוא לך באפליקציה?<input type="text" id="joinName" maxlength="30" required value="${a.joinName ?? info.person_name ?? ""}"></label>
      ${S.user ? html`<p class="small">מחובר/ת בתור <b dir="ltr">${S.user.email}</b></p>`
        : html`<label class="f">כתובת מייל<input type="email" id="joinEmail" autocomplete="email" inputmode="email" required></label>`}
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : S.user ? "הצטרפות" : "שליחת קוד"}</button>
    </form>
  </div>`;
}

export async function loadInvite() {
  const a = A();
  if (!S.joinToken || a.invite || a.inviteError) return;
  try {
    a.invite = await fn.inviteInfo(S.joinToken);
  } catch (e: any) {
    a.inviteError = e.message;
  }
  rerender();
}

on("submit", "join-submit", async () => {
  const a = A();
  const name = ($("joinName") as HTMLInputElement).value.trim();
  a.joinName = name;
  a.busy = true; a.msg = null; rerender();
  try {
    if (S.user) {
      await acceptInvite();
      return;
    }
    const email = ($("joinEmail") as HTMLInputElement).value.trim().toLowerCase();
    await fn.inviteClaim(S.joinToken!, email);
    localStorage.setItem(JOIN_KEY, JSON.stringify({ token: S.joinToken, name }));
    await sendCode(email, `${appUrl()}#/join/${S.joinToken}`);
    a.sentTo = email;
    startCooldown();
  } catch (e: any) {
    a.msg = e.message; a.msgKind = "err";
  } finally {
    a.busy = false; rerender();
  }
});

/**
 * Leaves the invite screen (bug 2026-09-27: after "the link was already used" the way out did nothing —
 * the pending token kept routing back to it). Clears every trace of the invite, then goes to sign-in
 * (or the app when already signed in).
 */
export function leaveJoin() {
  const a = A();
  try { localStorage.removeItem(JOIN_KEY); } catch { /* private mode */ }
  S.joinToken = null;
  a.invite = null; a.inviteError = null; a.sentTo = null; a.msg = null;
  history.replaceState(null, "", location.pathname + location.search);
}
on("click", "join-cancel", () => {
  leaveJoin();
  if (S.user) location.reload(); else { S.view = "signin"; rerender(); }
});

/** Called after sign-in when a join token is pending. */
export async function acceptInvite(): Promise<boolean> {
  const a = A();
  let pending: { token: string; name: string } | null = null;
  try { pending = JSON.parse(localStorage.getItem(JOIN_KEY) || "null"); } catch { /* ignore */ }
  const token = S.joinToken ?? pending?.token;
  if (!token) return false;
  const name = a.joinName ?? pending?.name ?? null;
  const { data, error } = await sb.rpc("accept_invite", { p_token: token, p_display_name: name });
  localStorage.removeItem(JOIN_KEY);
  if (error) { a.inviteError = dbMessage(error); S.joinToken = null; S.view = "join"; rerender(); return false; }
  localStorage.setItem("hb2-hh", String(data));
  S.joinToken = null;
  history.replaceState(null, "", location.pathname + location.search);
  location.hash = "#/overview";
  location.reload();
  return true;
}

// -------------------------------------------------------------- MFA prompt
export function renderMfaChallenge(): SafeHtml {
  const a = A();
  if (a.recover) {
    return html`<div class="auth">${logo}<h1>שחזור עם קוד גיבוי</h1>
      <p class="muted">מקלידים אחד מ-10 קודי השחזור שנשמרו כשהגדרתם את האימות. אחרי זה תתבקשו להתחבר שוב ולהגדיר אפליקציית אימות חדשה.</p>
      ${a.msg ? banner(a.msg, "err") : ""}
      <form class="card" data-submit="mfa-recover"><label class="f">קוד שחזור<input id="recCode" dir="ltr" autocomplete="off" maxlength="20" required placeholder="XXXXX-XXXXX"></label>
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>שחזור</button></form>
      <button class="ghost" data-click="mfa-recover-toggle">חזרה</button></div>`;
  }
  return html`<div class="auth">${logo}<h1>קוד מאפליקציית האימות</h1>
    <p class="muted">${household()?.name ? `כדי לפתוח את "${household()!.name}" ` : ""}מקלידים את הקוד בן 6 הספרות שמופיע עכשיו באפליקציית האימות (Google Authenticator, Microsoft Authenticator או "סיסמאות" באייפון).</p>
    ${a.msg ? banner(a.msg, "err") : ""}
    <form class="card" data-submit="mfa-verify">
      <label class="f">קוד<input class="code" id="mfaCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
      <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "אישור"}</button>
    </form>
    ${a.webauthnFactor ? html`<button data-click="mfa-passkey-auth">כניסה עם Face ID / מפתח גישה</button>` : ""}
    <div class="row"><button class="ghost" data-click="mfa-recover-toggle">אין לי גישה לאפליקציה</button><button class="ghost" data-click="signout">יציאה</button></div>
  </div>`;
}

async function factors() {
  const { data } = await sb.auth.mfa.listFactors();
  const all = (data?.all ?? []) as any[];
  return {
    totp: all.find((f) => f.factor_type === "totp" && f.status === "verified"),
    webauthn: all.find((f) => f.factor_type === "webauthn" && f.status === "verified"),
    unverified: all.filter((f) => f.status === "unverified"),
  };
}

export async function prepareChallenge() {
  const f = await factors();
  A().webauthnFactor = f.webauthn?.id ?? null;
}

on("submit", "mfa-verify", async () => {
  const a = A();
  const code = ($("mfaCode") as HTMLInputElement).value.replace(/\D/g, "");
  const f = await factors();
  if (!f.totp) { a.msg = "לא נמצאה אפליקציית אימות מוגדרת."; rerender(); return; }
  a.busy = true; a.msg = null; rerender();
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: f.totp.id, code });
  a.busy = false;
  if (error) { a.msg = "הקוד לא נכון או שפג תוקפו (הוא מתחלף כל 30 שניות). כדאי לנסות שוב."; rerender(); return; }
  location.reload();
});

on("click", "mfa-passkey-auth", async () => {
  const a = A();
  const { error } = await (sb.auth.mfa as any).webauthn.authenticate({ factorId: a.webauthnFactor, webauthn: { rpId: location.hostname, rpOrigins: [location.origin] } });
  if (error) { a.msg = "הכניסה עם מפתח הגישה לא הצליחה. אפשר להקליד קוד."; rerender(); return; }
  location.reload();
});

on("click", "mfa-recover-toggle", () => { const a = A(); a.recover = !a.recover; a.msg = null; rerender(); });
on("submit", "mfa-recover", async () => {
  const a = A();
  a.busy = true; rerender();
  try {
    await fn.mfaRecover(($("recCode") as HTMLInputElement).value.trim());
    await sb.auth.signOut();
    A().msg = "קוד השחזור התקבל. התחברו שוב, ואז נגדיר אפליקציית אימות חדשה.";
    A().msgKind = "ok";
    A().recover = false;
    S.view = "signin";
  } catch (e: any) { a.msg = e.message; }
  a.busy = false; rerender();
});

// ---------------------------------------------------------- MFA enrollment
export function renderMfaEnroll(): SafeHtml {
  const a = A();
  const required = isOwner() || !!S.settings?.require_mfa || S.extra.adminGate;
  const step = a.enroll?.step ?? "intro";
  if (step === "codes") {
    const codes: string[] = a.enroll.codes ?? [];
    return html`<div class="auth">${logo}<h1>קודי שחזור</h1>
      <p>אם הטלפון יאבד, אפשר להיכנס עם אחד מהקודים האלה (כל קוד פעם אחת). שמרו אותם <b>מחוץ לטלפון הזה</b>: הדפסה, מנהל סיסמאות, או צילום שנשמר אצל בן/בת הזוג.</p>
      <div class="codes">${codes.map((c) => html`<span>${c}</span>`)}</div>
      <div class="row"><button data-click="codes-copy2">העתקה</button><button data-click="codes-download">הורדה כקובץ</button></div>
      <label class="chk"><input type="checkbox" id="codesSaved" data-change="codes-saved"> שמרתי את הקודים במקום בטוח</label>
      <button class="primary big" data-click="enroll-done" ${attr(!a.enroll.saved, "disabled")}>סיום</button>
    </div>`;
  }
  if (step === "qr") {
    const e = a.enroll;
    return html`<div class="auth">${logo}<h1>הוספה לאפליקציית האימות</h1>
      <ol class="steps">
        <li><b>בטלפון הזה:</b> לוחצים על הכפתור. הוא פותח את אפליקציית האימות (או "סיסמאות" באייפון) ומוסיף את החשבון.
          <div style="margin-top:8px"><a class="links" href="${e.uri}"><span style="background:var(--accent);color:#fff;border-radius:12px;padding:10px 16px;display:inline-block;text-decoration:none">הוספה לאפליקציית האימות</span></a></div></li>
        <li><b>ממחשב או טלפון אחר:</b> סורקים את הקוד.<div class="qr" style="margin-top:8px"><img src="${e.qr}" alt="QR להוספה לאפליקציית האימות"></div></li>
        <li><b>ידנית:</b> מעתיקים את המפתח לאפליקציה.<div class="secret" style="margin-top:8px">${e.secret}</div><button class="ghost" data-click="secret-copy">העתקת המפתח</button></li>
      </ol>
      ${a.msg ? banner(a.msg, "err") : ""}
      <form class="card" data-submit="enroll-verify">
        <label class="f">הקוד בן 6 הספרות שמופיע עכשיו באפליקציה<input class="code" id="enrollCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
        <button class="primary big" type="submit" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "אימות"}</button>
      </form>
      <button class="ghost" data-click="enroll-cancel">${required ? "יציאה" : "לא עכשיו"}</button>
    </div>`;
  }
  return html`<div class="auth">${logo}<h1>אימות דו-שלבי</h1>
    <p>${required ? "כדי לשמור על הנתונים הכספיים של משק הבית, נדרש אימות דו-שלבי." : "מומלץ: גם אם מישהו ישיג גישה למייל שלכם, הוא לא ייכנס בלי הטלפון."}
      בכל כניסה ממכשיר חדש תקלידו קוד מתחלף מאפליקציית אימות. במכשיר שכבר מחובר לא תתבקשו בכל פתיחה.</p>
    <div class="card"><h3>צריך אפליקציית אימות אחת מאלה:</h3>
      <ul class="plain"><li>באייפון (iOS 18 ומעלה): אפליקציית "סיסמאות" המובנית — אין צורך להתקין</li><li>Google Authenticator</li><li>Microsoft Authenticator</li></ul>
      <p class="muted small">בלי SMS: הודעות SMS פחות בטוחות (אפשר להעביר מספר לכרטיס SIM אחר).</p></div>
    ${a.msg ? banner(a.msg, "err") : ""}
    <button class="primary big" data-click="enroll-start" ${attr(a.busy, "disabled")}>${a.busy ? html`<span class="spin"></span>` : "המשך"}</button>
    <button class="ghost" data-click="enroll-cancel">${required ? "יציאה" : "לא עכשיו"}</button>
  </div>`;
}

on("click", "mfa-enroll-start", () => { S.view = "mfa-enroll"; A().enroll = { step: "intro" }; rerender(); });
on("click", "enroll-start", async () => {
  const a = A();
  a.busy = true; a.msg = null; rerender();
  try {
    const f = await factors();
    for (const u of f.unverified) await sb.auth.mfa.unenroll({ factorId: u.id });  // clean half-finished attempts
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `הכסף של הבית ${new Date().toISOString().slice(0, 10)}`, issuer: "הכסף של הבית" });
    if (error || !data) throw error ?? new Error("enroll");
    a.enroll = { step: "qr", factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
  } catch {
    a.msg = "ההגדרה לא התחילה. כדאי לנסות שוב.";
  }
  a.busy = false; rerender();
});
on("click", "secret-copy", async () => flash((await copyText(A().enroll?.secret ?? "")) ? "המפתח הועתק" : "לא הצלחתי להעתיק", "info"));
on("submit", "enroll-verify", async () => {
  const a = A();
  const code = ($("enrollCode") as HTMLInputElement).value.replace(/\D/g, "");
  a.busy = true; a.msg = null; rerender();
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: a.enroll.factorId, code });
  if (error) { a.busy = false; a.msg = "הקוד לא נכון. בודקים שהשעה בטלפון מדויקת ומקלידים את הקוד שמופיע עכשיו."; rerender(); return; }
  await sb.auth.refreshSession();
  const { data, error: e2 } = await sb.rpc("generate_recovery_codes");
  a.busy = false;
  a.enroll = { step: "codes", codes: e2 ? [] : (data as string[]), saved: false };
  S.hasFactor = true;
  rerender();
});
on("change", "codes-saved", (el) => { A().enroll.saved = (el as HTMLInputElement).checked; rerender(); });
on("click", "codes-copy2", async () => flash((await copyText((A().enroll?.codes ?? []).join("\n"))) ? "הקודים הועתקו" : "לא הצלחתי להעתיק", "info"));
on("click", "codes-download", () => {
  const codes: string[] = A().enroll?.codes ?? [];
  downloadBlob(new Blob([`הכסף של הבית — קודי שחזור לאימות דו-שלבי\n${S.user?.email ?? ""}\nכל קוד פעם אחת.\n\n${codes.join("\n")}\n`], { type: "text/plain;charset=utf-8" }), "קודי-שחזור-הכסף-של-הבית.txt");
});
on("click", "enroll-done", () => { A().enroll = null; location.reload(); });
on("click", "enroll-cancel", async () => {
  const required = isOwner() || !!S.settings?.require_mfa || S.extra.adminGate;
  if (required) { await sb.auth.signOut(); location.hash = ""; location.reload(); return; }
  A().enroll = null;
  S.view = "app";
  rerender();
});

// Optional extra factor: Face ID / passkey (Supabase WebAuthn MFA, experimental).
on("click", "mfa-passkey", async () => {
  try {
    const { error } = await (sb.auth.mfa as any).webauthn.register({ friendlyName: "Face ID / מפתח גישה", webauthn: { rpId: location.hostname, rpOrigins: [location.origin] } });
    if (error) throw error;
    flash("✓ נוסף מפתח גישה. בכניסה הבאה אפשר לבחור Face ID.", "ok");
  } catch {
    S.extra.webauthnOk = false;
    flash("מפתחות גישה עוד לא זמינים בשרת הזה. אפליקציית האימות ממשיכה לעבוד כרגיל.", "info");
  }
  rerender();
});
