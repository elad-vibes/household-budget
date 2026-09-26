// הבית — household, people, members & invites, receipts send mode, security
// (2FA), themes, usage, backup, account.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { armed2, isArmed, on } from "../lib/events.ts";
import { fmtDate, HEB_D } from "../lib/format.ts";
import { THEMES } from "../domain/categories.ts";
import { activePeople } from "../domain/calc.ts";
import { canWrite, ctx, flash, household, isOwner, rerender, S } from "../state.ts";
import {
  addPerson, chooseHousehold, createInvite, deleteHousehold, deletePerson, fn, removeMember, renameHousehold,
  revokeInvite, setMyName, setRequireMfa, setRole, transferOwnership, updatePerson, updateSettings,
} from "../data.ts";
import { appUrl, dbMessage, sb } from "../lib/supa.ts";
import { exportExcel, exportJson, importBackup, legacyCount, legacyData } from "../importer.ts";
import { banner, copyText } from "./common.ts";

/** Phase 2 cards (notifications…) register here. */
export const homeCards: (() => SafeHtml)[] = [];

const ROLE: Record<string, string> = { owner: "מנהל/ת", member: "חבר/ה", viewer: "צפייה בלבד" };

export function renderHome(): SafeHtml {
  return html`${householdCard()}${peopleCard()}${membersCard()}${receiptSettingsCard()}${securityCard()}
    ${homeCards.map((f) => f())}${themeCard()}${usageCard()}${backupCard()}${accountCard()}`;
}

function householdCard(): SafeHtml {
  const me = S.members.find((m) => m.user_id === S.user?.id);
  return html`<div class="card">
    <h2>משק הבית</h2>
    ${S.households.length > 1 ? html`<label class="f">משק בית פעיל<select data-change="hh-switch">${S.households.map((h) => html`<option value="${h.id}" ${attr(h.id === S.hh, "selected")}>${h.name} (${ROLE[h.role]})</option>`)}</select></label>` : ""}
    <label class="f">שם משק הבית<input type="text" id="hhName" maxlength="60" value="${household()?.name ?? ""}" data-change="hh-rename" ${attr(!isOwner(), "disabled")}></label>
    <label class="f">השם שלך באפליקציה<input type="text" id="myName" maxlength="40" value="${me?.display_name ?? ""}" data-change="my-name"></label>
    <p class="muted small">${S.user?.email ?? ""} · ${ROLE[S.role ?? "viewer"]}</p>
  </div>`;
}

function peopleCard(): SafeHtml {
  const w = canWrite();
  const counts: Record<string, number> = {};
  for (const t of S.tx) if (t.person_id) counts[t.person_id] = (counts[t.person_id] || 0) + 1;
  return html`<div class="card">
    <h2>מי בבית</h2>
    <p class="muted small">לכל מי שמופיע כאן אפשר לשייך הוצאות, גם בלי חשבון (למשל ילדים). כדי שמישהו יוכל גם להיכנס ולהעלות בעצמו, שולחים לו הזמנה בכרטיס "חברי משק הבית".</p>
    <div>${activePeople(ctx()).map((p) => {
      const armed = isArmed("person/" + p.id);
      return html`<div class="member"><input type="text" maxlength="30" value="${p.name}" data-change="person-name" data-id="${p.id}" aria-label="שם" ${attr(!w, "disabled")}>
        <span class="muted small num">${counts[p.id] || 0} תנועות${p.user_id ? " · עם חשבון" : ""}</span>
        ${w && !p.user_id ? html`<button class="ghost ${armed ? "danger" : ""}" data-click="person-del" data-id="${p.id}" aria-label="הסרה">${armed ? "להסיר?" : "✕"}</button>` : ""}</div>`;
    })}</div>
    ${w ? html`<form class="row" style="flex-wrap:nowrap" data-submit="person-add"><input type="text" id="newPerson" maxlength="30" placeholder="שם (למשל: נועה)" aria-label="שם בן בית חדש"><button type="submit">הוספה</button></form>` : ""}
  </div>`;
}

function membersCard(): SafeHtml {
  const own = isOwner();
  const link: string | null = S.extra.inviteLink ?? null;
  const pending = S.invites.filter((i) => !i.used_at && !i.revoked_at && new Date(i.expires_at) > new Date());
  return html`<div class="card">
    <h2>חברי משק הבית</h2>
    <div>${S.members.map((m) => {
      const me = m.user_id === S.user?.id;
      const armed = isArmed("member/" + m.user_id);
      return html`<div class="member"><div class="who">${m.display_name || "ללא שם"}${me ? " (את/ה)" : ""}<small>${ROLE[m.role]} · הצטרפות ${fmtDate(m.joined_at)}</small></div>
        ${own && !me ? html`<select data-change="member-role" data-id="${m.user_id}" aria-label="תפקיד">${(["member", "viewer"] as const).map((r) => html`<option value="${r}" ${attr(m.role === r, "selected")}>${ROLE[r]}</option>`)}</select>` : ""}
        ${own && !me && m.role !== "owner" ? html`<button class="ghost" data-click="member-mfa-reset" data-id="${m.user_id}" title="איפוס אימות דו-שלבי">איפוס 2FA</button>` : ""}
        ${(own && !me) ? html`<button class="ghost ${armed ? "danger" : ""}" data-click="member-remove" data-id="${m.user_id}">${armed ? "להסיר?" : "הסרה"}</button>` : ""}</div>`;
    })}</div>
    ${own ? html`<h3>הזמנת בן בית</h3>
      <p class="muted small">הקישור מתאים לאדם אחד, תקף 7 ימים, ונקשר לכתובת המייל הראשונה שמשתמשת בו. למשק הבית יש מנהל/ת אחד/ת, שחייב/ת אימות דו-שלבי.</p>
      <form class="grid2" data-submit="invite-create">
        <label class="f">שם (לא חובה)<input type="text" id="invName" maxlength="30" placeholder="למשל: סבתא"></label>
        <label class="f">הרשאה<select id="invRole"><option value="member">חבר/ה – מוסיפים ועורכים</option><option value="viewer">צפייה בלבד</option></select></label>
        <div class="row end" style="grid-column:1/-1"><button class="primary" type="submit">יצירת קישור הזמנה</button></div>
      </form>
      ${link ? html`<div class="banner ok"><div>הקישור מוכן. אפשר לשלוח אותו בוואטסאפ:</div><div class="secret" style="margin:8px 0">${link}</div>
        <div class="row"><button data-click="invite-copy">העתקה</button>${"share" in navigator ? html`<button data-click="invite-share">שיתוף</button>` : ""}</div></div>` : ""}
      ${pending.length ? html`<div>${pending.map((i) => html`<div class="fxrow"><div class="n">${i.person_name || "הזמנה"} · ${ROLE[i.role]}<small>${i.claimed_email ? "נקשרה ל-" + i.claimed_email : "עוד לא נפתחה"} · עד ${fmtDate(i.expires_at)}</small></div><span></span><button class="ghost" data-click="invite-revoke" data-id="${i.id}">ביטול</button></div>`)}</div>` : ""}` : ""}
  </div>${transferCard()}`;
}

/** Owner only: hand the household to another member (roles swap in one step). */
function transferCard(): SafeHtml {
  const others = S.members.filter((m) => m.user_id !== S.user?.id);
  if (!isOwner() || !others.length) return html``;
  const pick: string = S.extra.transferTo ?? "";
  const who = others.find((m) => m.user_id === pick);
  const armed = !!who && isArmed("transfer/" + pick);
  return html`<div class="card">
    <h2>העברת ניהול</h2>
    <p class="muted small">למשק הבית יש מנהל/ת אחד/ת. אחרי ההעברה את/ה נשאר/ת כחבר/ה, והמנהל/ת החדש/ה יתבקש/תתבקש להגדיר אימות דו-שלבי. כדי לעזוב את משק הבית או למחוק את החשבון, קודם מעבירים את הניהול.</p>
    <label class="f">למי להעביר<select id="trTo" data-change="transfer-pick"><option value="">בחירה…</option>${others.map((m) => html`<option value="${m.user_id}" ${attr(m.user_id === pick, "selected")}>${m.display_name || "ללא שם"} (${ROLE[m.role]})</option>`)}</select></label>
    ${armed ? html`<div class="banner warn">${who!.display_name || "ללא שם"} יהיה/תהיה המנהל/ת, ואת/ה תהיה/תהיה חבר/ה. ללחוץ שוב לאישור.</div>` : ""}
    <div class="row end"><button class="${armed ? "danger" : ""}" data-click="transfer" ${attr(!who, "disabled")}>${armed ? "כן, להעביר את הניהול" : "העברת ניהול"}</button></div>
  </div>`;
}

function receiptSettingsCard(): SafeHtml {
  const s = S.settings;
  if (!s) return html``;
  const w = canWrite();
  return html`<div class="card">
    <h2>שליחת קבלות לקריאה</h2>
    <p class="muted small">קבלות שמצלמים נשמרות במכשיר ונשלחות לקריאה ביחד. שליחה שבועית או חודשית זולה יותר. אפשר תמיד ללחוץ "לשלוח עכשיו".</p>
    <div class="seg">${(["immediate", "weekly", "monthly"] as const).map((k) => html`<button type="button" data-click="send-mode" data-v="${k}" aria-pressed="${s.send_mode === k ? "true" : "false"}" ${attr(!w, "disabled")}>${{ immediate: "מיד", weekly: "פעם בשבוע", monthly: "פעם בחודש" }[k]}</button>`)}</div>
    ${s.send_mode === "weekly" ? html`<label class="f">ביום<select data-change="send-weekday" ${attr(!w, "disabled")}>${HEB_D.map((d, i) => html`<option value="${i}" ${attr(s.send_weekday === i, "selected")}>יום ${d}</option>`)}</select></label>` : ""}
    ${s.send_mode === "monthly" ? html`<label class="f">בתאריך<select data-change="send-monthday" ${attr(!w, "disabled")}>${Array.from({ length: 28 }, (_, i) => i + 1).map((d) => html`<option value="${d}" ${attr(s.send_monthday === d, "selected")}>${d} בחודש</option>`)}</select></label>` : ""}
  </div>`;
}

function securityCard(): SafeHtml {
  const rc = S.extra.recovery as { total: number; remaining: number } | undefined;
  const codes: string[] | undefined = S.extra.newCodes;
  return html`<div class="card">
    <h2>אבטחה ואימות דו-שלבי</h2>
    ${S.hasFactor
      ? html`<p>✓ אימות דו-שלבי פעיל. במכשיר חדש או אחרי יציאה תתבקשו להזין קוד מאפליקציית האימות.</p>
        ${rc ? html`<p class="muted small">קודי שחזור: נשארו ${rc.remaining} מתוך ${rc.total}.</p>` : ""}
        <div class="row"><button data-click="mfa-new-codes">קודי שחזור חדשים</button>${S.extra.webauthnOk !== false ? html`<button class="ghost" data-click="mfa-passkey">הוספת Face ID / מפתח גישה</button>` : ""}</div>
        ${codes ? html`<div class="banner warn">הקודים הישנים כבר לא עובדים. שמרו את החדשים במקום בטוח (לא בטלפון הזה בלבד):</div>
          <div class="codes">${codes.map((c) => html`<span>${c}</span>`)}</div>
          <div class="row"><button data-click="codes-copy">העתקה</button><button class="ghost" data-click="codes-hide">סיימתי</button></div>` : ""}`
      : html`<p>${isOwner() ? "בעלי משק בית חייבים אימות דו-שלבי." : "מומלץ מאוד: גם אם מישהו ישיג גישה למייל שלכם, הוא לא יוכל להיכנס בלי הקוד מהטלפון."}</p>
        <div><button class="primary" data-click="mfa-enroll-start">הפעלת אימות דו-שלבי</button></div>`}
    ${isOwner() ? html`<label class="chk"><input type="checkbox" data-change="require-mfa" ${attr(S.settings?.require_mfa, "checked")}> לחייב אימות דו-שלבי לכל בני הבית</label>` : ""}
  </div>`;
}

const SCHEMES = [["system", "כמו בטלפון"], ["light", "בהיר"], ["dark", "כהה"]] as const;
function currentScheme() { try { return localStorage.getItem("hb2-scheme") ?? "system"; } catch { return "system"; } }
on("click", "scheme", (el) => { try { localStorage.setItem("hb2-scheme", el.dataset.v!); } catch { /* private mode */ } rerender(); });

function themeCard(): SafeHtml {
  return html`<div class="card"><h2>צבעים ומראה</h2>
    <div class="f"><span class="small" style="font-weight:600;color:var(--ink2)">מצב תצוגה (במכשיר הזה)</span><div class="seg">${SCHEMES.map(([k, l]) => html`<button type="button" data-click="scheme" data-v="${k}" aria-pressed="${currentScheme() === k ? "true" : "false"}">${l}</button>`)}</div></div>
    <p class="muted small">אפשר להתאים את צבעי האפליקציה לגוון של הבנק או של כרטיס האשראי.</p>
    <div class="swatches">${Object.entries(THEMES).map(([k, t]) => html`<button type="button" class="swatch" data-click="theme" data-k="${k}" aria-pressed="${(S.settings?.theme || "max") === k ? "true" : "false"}" ${attr(!canWrite(), "disabled")}><i><span style="background:${t.accent}"></span><span style="background:${t.soft}"></span><span style="background:${t.var}"></span></i><span class="small">${t.label}</span></button>`)}</div>
  </div>`;
}

function usageCard(): SafeHtml {
  const u = S.usage;
  if (!u) return html``;
  const line = (label: string, used: number, q: number) => html`<div><div class="row between small"><span>${label}</span><span class="num">${used} / ${q}</span></div><div class="bar ${used >= q ? "over" : used >= q * 0.8 ? "warn" : ""}"><span style="width:${Math.min(100, q ? (used / q) * 100 : 100)}%"></span></div></div>`;
  return html`<div class="card"><h2>שימוש החודש</h2>
    ${line("קבלות שנקראו", u.images, u.quota_images)}${line("פירוטים שנקראו", u.statements, u.quota_statements)}${line("ניתוחים", u.analyses, u.quota_analyses)}
    <p class="muted small">עלות משוערת החודש: $${u.usd.toFixed(2)} מתוך $${u.quota_usd.toFixed(2)}. קריאת Excel ו-CSV לא נספרת.</p></div>`;
}

function backupCard(): SafeHtml {
  const legacy = legacyData();
  return html`<div class="card"><h2>גיבוי ושחזור</h2>
    <p class="muted small">הנתונים שמורים בענן ומשותפים לכל בני הבית. אפשר גם להוריד עותק לעצמכם.</p>
    <div class="row"><button data-click="bk-json">הורדת גיבוי (JSON)</button><button data-click="bk-xlsx">הורדה כ-Excel</button></div>
    ${canWrite() ? html`<label class="row" style="gap:0"><input type="file" id="bkFile" data-change="bk-import" accept=".json,application/json" hidden><button type="button" data-click="bk-pick">טעינת קובץ גיבוי</button></label>` : ""}
    ${legacy && canWrite() ? banner(html`נמצאו במכשיר הזה ${legacyCount(legacy)} תנועות מהגרסה הקודמת של האפליקציה. <button data-click="bk-legacy">ייבוא</button>`, "info") : ""}
    <p class="muted small">הגרסה הקודמת עדיין זמינה ב-<a href="legacy/" target="_blank" rel="noopener">הגרסה הישנה</a>.</p>
  </div>`;
}

function accountCard(): SafeHtml {
  const armedHH = isArmed("hh-delete");
  return html`<div class="card"><h2>חשבון</h2>
    <div class="row"><button data-click="go" data-to="install">התקנה למסך הבית</button>${S.isAdmin ? html`<button data-click="go" data-to="admin">ניהול מערכת</button>` : ""}<button data-click="signout">יציאה</button><button class="ghost" data-click="signout-all">יציאה מכל המכשירים</button></div>
    ${S.members.length > 1 && !isOwner() ? html`<button class="ghost danger" data-click="leave">עזיבת משק הבית</button>` : ""}
    ${S.members.length > 1 && isOwner() ? html`<p class="muted small">כדי לעזוב את משק הבית, קודם מעבירים את הניהול למישהו אחר.</p>` : ""}
    ${isOwner() ? html`<details><summary class="small">מחיקת משק הבית וכל הנתונים שלו</summary>
      <p class="small">כל התנועות, הקבועות, הקניות והניתוחים של "${household()?.name ?? ""}" יימחקו לצמיתות, לכל בני הבית.</p>
      <label class="f">כדי לאשר, הקלידו את שם משק הבית<input type="text" id="hhDelName"></label>
      <button class="danger ${armedHH ? "primary" : ""}" data-click="hh-delete">${armedHH ? "ללחוץ שוב למחיקה סופית" : "מחיקת משק הבית"}</button></details>` : ""}
    <details><summary class="small">מחיקת החשבון שלי</summary>
      <p class="small">החשבון נמחק. משקי בית שאתם היחידים בהם נמחקים עם כל הנתונים. אם אתם מנהלי משק בית שיש בו אנשים נוספים, צריך קודם להעביר את הניהול.</p>
      <label class="f">כדי לאשר, הקלידו: מחיקה<input type="text" id="accDel"></label>
      <button class="danger" data-click="acc-delete">מחיקת החשבון</button></details>
  </div>`;
}

// ------------------------------------------------------------------ actions
/** Edge Function errors already carry a Hebrew message; database errors are translated. */
const errText = (e: any) => (e?.extra !== undefined ? e.message : dbMessage(e));
const run = async (f: () => Promise<unknown>, ok?: string) => {
  try { await f(); if (ok) flash(ok, "ok"); } catch (e) { flash(errText(e), "err"); }
  rerender();
};

on("change", "hh-switch", (el) => { chooseHousehold((el as HTMLSelectElement).value); location.reload(); });
on("change", "hh-rename", (el) => { const v = (el as HTMLInputElement).value.trim(); if (v) run(() => renameHousehold(v.slice(0, 60)), "✓ השם עודכן"); });
on("change", "my-name", (el) => { const v = (el as HTMLInputElement).value.trim(); if (v) run(() => setMyName(v), "✓ נשמר"); });
on("change", "person-name", (el) => { const v = (el as HTMLInputElement).value.trim(); if (v) run(() => updatePerson(el.dataset.id!, { name: v.slice(0, 30) })); });
on("click", "person-del", (el) => {
  const id = el.dataset.id!;
  if (!armed2("person/" + id, rerender)) return;
  const used = S.tx.some((t) => t.person_id === id) || S.fixed.some((f) => f.person_id === id);
  run(() => (used ? updatePerson(id, { archived: true }) : deletePerson(id)), used ? "הוסתר. התנועות הקיימות נשארות." : undefined);
});
on("submit", "person-add", () => {
  const inp = $("newPerson") as HTMLInputElement;
  const n = inp.value.trim();
  if (!n) return;
  if (activePeople(ctx()).length >= 12) { flash("אפשר עד 12 בני בית.", "err"); return; }
  run(() => addPerson(n), `✓ ${n} נוסף/ה. אפשר לשייך אליו/ה הוצאות.`);
});
on("change", "member-role", (el) => run(() => setRole(el.dataset.id!, (el as HTMLSelectElement).value), "✓ ההרשאה עודכנה"));
on("change", "transfer-pick", (el) => { S.extra.transferTo = (el as HTMLSelectElement).value; rerender(); });
on("click", "transfer", () => {
  const to: string = S.extra.transferTo ?? "";
  if (!to || !armed2("transfer/" + to, rerender)) return;
  run(async () => { await transferOwnership(to); S.extra.transferTo = undefined; location.reload(); }, "✓ הניהול הועבר");
});
on("click", "member-remove", (el) => { if (armed2("member/" + el.dataset.id, rerender)) run(() => removeMember(el.dataset.id!), "✓ הוסר/ה ממשק הבית"); });
on("click", "member-mfa-reset", (el) => run(() => fn.mfaReset(el.dataset.id!), "✓ האימות הדו-שלבי אופס. בכניסה הבאה יוגדר מחדש."));
on("submit", "invite-create", () => run(async () => {
  const token = await createInvite(($("invRole") as HTMLSelectElement).value, ($("invName") as HTMLInputElement).value.trim());
  S.extra.inviteLink = `${appUrl()}#/join/${token}`;
}));
on("click", "invite-copy", async () => flash((await copyText(S.extra.inviteLink)) ? "הקישור הועתק" : "לא הצלחתי להעתיק", "info"));
on("click", "invite-share", async () => { try { await navigator.share({ title: "הזמנה ל״הכסף של הבית״", url: S.extra.inviteLink }); } catch { /* cancelled */ } });
on("click", "invite-revoke", (el) => run(() => revokeInvite(el.dataset.id!), "ההזמנה בוטלה"));
on("click", "send-mode", (el) => run(() => updateSettings({ send_mode: el.dataset.v as "weekly" })));
on("change", "send-weekday", (el) => run(() => updateSettings({ send_weekday: +(el as HTMLSelectElement).value })));
on("change", "send-monthday", (el) => run(() => updateSettings({ send_monthday: +(el as HTMLSelectElement).value })));
on("click", "theme", (el) => run(() => updateSettings({ theme: el.dataset.k! })));
on("change", "require-mfa", (el) => run(() => setRequireMfa((el as HTMLInputElement).checked), "✓ נשמר"));
on("click", "mfa-new-codes", () => run(async () => {
  const { data, error } = await sb.rpc("generate_recovery_codes");
  if (error) throw error;
  S.extra.newCodes = data as string[];
  S.extra.recovery = { total: 10, remaining: 10 };
}));
on("click", "codes-copy", async () => flash((await copyText((S.extra.newCodes ?? []).join("\n"))) ? "הקודים הועתקו" : "לא הצלחתי להעתיק", "info"));
on("click", "codes-hide", () => { S.extra.newCodes = undefined; rerender(); });
on("click", "bk-json", () => exportJson());
on("click", "bk-xlsx", () => run(() => exportExcel()));
on("click", "bk-pick", () => ($("bkFile") as HTMLInputElement | null)?.click());
on("change", "bk-import", async (el) => {
  const f = (el as HTMLInputElement).files?.[0];
  (el as HTMLInputElement).value = "";
  if (!f) return;
  let d: unknown;
  try { d = JSON.parse(await f.text()); } catch { flash("הקובץ לא נקרא. צריך לבחור קובץ גיבוי (JSON).", "err"); return; }
  try { flash(await importBackup(d), "ok"); } catch (e: any) { flash(e?.message || "הייבוא נכשל", "err"); }
  rerender();
});
on("click", "bk-legacy", async () => {
  try { flash(await importBackup(legacyData()), "ok"); } catch (e: any) { flash(e?.message || "הייבוא נכשל", "err"); }
  rerender();
});
on("click", "signout", async () => { await sb.auth.signOut(); location.hash = ""; location.reload(); });
// e.g. a lost phone: ends every session of this account on every device
on("click", "signout-all", async () => { await sb.auth.signOut({ scope: "global" }); location.hash = ""; location.reload(); });
on("click", "leave", () => { if (armed2("leave", rerender)) run(async () => { await removeMember(S.user!.id); location.reload(); }); });
on("click", "hh-delete", () => {
  const typed = ($("hhDelName") as HTMLInputElement | null)?.value.trim();
  if (typed !== household()?.name) { flash("השם שהוקלד לא תואם.", "err"); return; }
  if (!armed2("hh-delete", rerender)) return;
  run(async () => { await deleteHousehold(); localStorage.removeItem("hb2-hh"); location.reload(); });
});
on("click", "acc-delete", () => {
  if (($("accDel") as HTMLInputElement | null)?.value.trim() !== "מחיקה") { flash("צריך להקליד: מחיקה", "err"); return; }
  run(async () => { await fn.deleteAccount(); await sb.auth.signOut(); location.hash = ""; location.reload(); });
});
