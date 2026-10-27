// הוספה — receipts (queue), statements/Excel (review first), manual entry.
import { attr, html, type SafeHtml, $ } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { addM, curMonth, ils, mLabel, today, uid } from "../lib/format.ts";
import { blobToBase64, prepareImage, STATEMENT_MAX_PIXELS, MAX_UPLOAD_BYTES } from "../lib/image.ts";
import { fileKind, ImportError, localParse } from "../domain/parser.ts";
import { describeNext } from "../domain/schedule.ts";
import { dupKey, personOptions } from "../domain/calc.ts";
import { EXCL } from "../domain/categories.ts";
import type { DraftDoc } from "../domain/types.ts";
import { canWrite, ctx, flash, rerender, S } from "../state.ts";
import { fn, insertTx } from "../data.ts";
import { capture, removeReceipt, sendQueued, updateReceipt } from "../receipts.ts";
import { banner, catOptions, personOptionsHtml, personSelect } from "./common.ts";
import { renderReview } from "./review.ts";
import { I } from "./icons.ts";
import { chipValue, guessStatementMethod, lastMethod, methodById, methodChips, rememberMethod, settle } from "../payments.ts";
import { initialStatus, isAtmRow } from "../domain/match.ts";
import { art } from "./art.ts";
import { currentRate, ensureFx, rateLine, tripCurrency, tripOn } from "./trip.ts";
import { fmtForeign, symbolOf, toIls } from "../domain/fx.ts";

export function renderAdd(): SafeHtml {
  if (!canWrite()) return banner("יש לך הרשאת צפייה בלבד, אז אי אפשר להוסיף הוצאות.", "warn");
  return html`
    ${personPicker()}
    ${receiptsCard()}
    <div class="card">
      <h2>העלאת פירוט אשראי או בנק</h2>
      <p class="muted small">קובץ Excel או CSV מאתר הבנק או חברת האשראי נקרא כאן במכשיר, בלי הגבלה. צילום מסך או PDF של פירוט נקרא על ידי Claude. אחרי הקריאה כל השורות מוצגות לבדיקה לפני שמירה.</p>
      <label class="f">לאיזה חודש הפירוט?<select data-change="st-month">
        <option value="" ${attr(!S.extra.stMonth, "selected")}>בחירה…</option>
        ${stMonthOptions().map((m) => html`<option value="${m}" ${attr(S.extra.stMonth === m, "selected")}>${mLabel(m)}</option>`)}
      </select></label>
      ${!S.extra.stMonth ? html`<p class="muted small">קודם לבחור חודש — כך אפשר לבדוק שהתאריכים שנקראים מהקובץ באמת מתאימים.</p>` : ""}
      <label class="drop">
        <input type="file" id="stFiles" data-change="st-files" multiple accept="image/*,.pdf,.xlsx,.xls,.csv" ${attr(!S.extra.stMonth, "disabled")}>
        <b>לבחור קובץ פירוט</b>
        <span class="muted small">Excel, CSV, PDF או צילומי מסך של אותו פירוט</span>
      </label>
      ${S.extra.stStatus ? banner(S.extra.stStatus.text, S.extra.stStatus.kind) : ""}
      ${renderReview()}
    </div>
    <div class="card">
      <h2>הוספה ידנית</h2>
      <form class="grid2" data-submit="manual">
        <label class="f">תאריך<input type="date" id="mDate" required value="${today()}"></label>
        <label class="f">סכום (${symbolOf(mCur())})<input type="number" id="mAmt" step="0.01" inputmode="decimal" required placeholder="0.00" data-input="m-amt"></label>
        ${tripOn() ? tripRow() : ""}
        <label class="f" style="grid-column:1/-1">על מה<input type="text" id="mDesc" required maxlength="80" placeholder="למשל: שוק, מתנה ליום הולדת, מזומן לבייביסיטר"></label>
        <label class="f">קטגוריה<select id="mCat">${catOptions("סופר ומכולת", false)}</select></label>
        <label class="f">של מי${personSelect("mPerson", S.upPerson || null)}</label>
        <div class="f" style="grid-column:1/-1"><span id="mPmL">איך שילמת?</span>${methodChips("manual", chipValue("manual", lastMethod(S.upPerson || null)))}</div>
        <div class="row between" style="grid-column:1/-1">
          <label class="chk"><input type="checkbox" id="mFixed"> הוצאה קבועה</label>
          <button class="primary" type="submit">הוספה</button>
        </div>
      </form>
    </div>`;
}

// ------------------------------------------------------------ מצב טיול in the manual form
/** The currency of the manual amount: the trip currency while trip mode is on (switchable to ₪). */
const mCur = (): string => (tripOn() ? (S.extra.mCur ?? tripCurrency()) : "ILS");

function tripRow(): SafeHtml {
  ensureFx();
  const cur = mCur(), trip = tripCurrency();
  return html`<div class="f" style="grid-column:1/-1">
    <div class="seg" role="group" aria-label="מטבע">${[trip, "ILS"].map((c) => html`<button type="button" data-click="m-cur" data-c="${c}" aria-pressed="${cur === c ? "true" : "false"}">${c === "ILS" ? "₪ שקל" : `${symbolOf(c)} ${c}`}</button>`)}</div>
    ${cur !== "ILS" ? html`<span class="small" id="mConv">${convText(cur)}</span><span class="muted small">${rateLine(cur)}</span>` : ""}
  </div>`;
}
function convText(cur: string, amount = NaN): string {
  const r = currentRate(cur);
  if (!r) return "אין עדיין שער — אפשר להזין שער ידני בלשונית הבית ← מצב טיול.";
  return isFinite(amount) && amount ? `≈ ${ils(toIls(amount, r.rate), 2)}` : "הסכום יומר לשקלים לפי השער:";
}
on("click", "m-cur", (el) => { S.extra.mCur = el.dataset.c; rerender(); });
on("input", "m-amt", (el) => {
  const out = $("mConv");
  if (out && mCur() !== "ILS") out.textContent = convText(mCur(), parseFloat((el as HTMLInputElement).value));
});

function personPicker(): SafeHtml {
  return html`<div class="card" style="padding:12px 16px">
    <div class="small" style="font-weight:600;color:var(--ink2)">של מי ההוצאות?</div>
    <div class="seg">${personOptions(ctx()).map(([k, n]) => html`<button type="button" data-click="up-person" data-p="${k}" aria-pressed="${S.upPerson === k ? "true" : "false"}">${n}</button>`)}</div>
  </div>`;
}

function receiptsCard(): SafeHtml {
  const q = S.queue;
  const queued = q.filter((r) => r.status === "queued").length;
  const inFlight = q.filter((r) => r.status === "submitted").length;
  const failed = q.filter((r) => r.status === "failed").length;
  const blurry: string[] = S.extra.blurry ?? [];
  const statusChip = (s: string) => ({
    queued: html`<span class="chip grey">בתור</span>`, sending: html`<span class="chip info">נשלחת</span>`,
    submitted: html`<span class="chip info">בקריאה</span>`, done: html`<span class="chip ok">נקראה · שמורה</span>`,
    failed: html`<span class="chip miss">לא נקראה</span>`,
  } as Record<string, SafeHtml>)[s];
  return html`<div class="card">
    <div class="card-h"><h2>קבלות</h2><span class="muted small">${S.settings ? describeNext(S.settings, new Date()) : ""}</span></div>
    <p class="muted small">מצלמים את הקבלה ברגע הקנייה. הקבלות נשמרות רק במכשיר ונשלחות לקריאה ביחד (זול יותר). אחרי הקריאה הן מחכות לאישור בלשונית "תנועות", והתמונה נמחקת מהמכשיר.</p>
    <div class="grid2">
      <label class="drop" style="padding:16px">
        <input type="file" id="rcCam" data-change="rc-files" accept="image/*" capture="environment">
        ${I.camera}<b>צילום קבלה</b>
      </label>
      <label class="drop" style="padding:16px">
        <input type="file" id="rcPick" data-change="rc-files" accept="image/*" multiple>
        <b>מהגלריה</b><span class="muted small">אפשר כמה ביחד</span>
      </label>
    </div>
    ${blurry.length ? banner(html`<b>${blurry.length === 1 ? "התמונה נראית מטושטשת." : `${blurry.length} תמונות נראות מטושטשות.`}</b> קבלה מטושטשת לא תיקרא טוב. כדאי לצלם שוב באור טוב, ישר מעל הקבלה.
        <div class="row" style="margin-top:8px"><button data-click="rc-retake">למחוק ולצלם שוב</button><button class="ghost" data-click="rc-keep-blurry">לשמור בכל זאת</button></div>`, "warn") : ""}
    ${S.extra.rcBusy ? html`<p class="muted"><span class="spin"></span> מכין את התמונות…</p>` : ""}
    ${!q.length ? html`<div class="empty">${art.queueEmpty()}<p class="muted small">אין קבלות שמחכות לשליחה. אפשר לצלם גם מהכפתור העגול בכל מסך.</p></div>` : ""}
    ${q.length ? html`<div class="rq">${q.map((r) => html`<div class="it">
        <img src="${r.thumb}" alt="קבלה">
        ${r.status === "queued" || r.status === "failed" || r.status === "done" ? html`<button class="x ghost" data-click="rc-del" data-id="${r.id}" aria-label="מחיקה">✕</button>` : ""}
        <div class="meta">${statusChip(r.status)}
          ${r.status === "queued" ? html`<select data-change="rc-person" data-id="${r.id}" aria-label="של מי">${personOptionsHtml(r.personId)}</select>` : ""}
          ${r.error ? html`<span class="muted">${r.error}</span>` : ""}
          <label class="keep"><input type="checkbox" data-change="rc-keep" data-id="${r.id}" ${attr(r.keep, "checked")}> לשמור לאחריות</label>
        </div></div>`)}</div>` : ""}
    <div class="row between">
      <span class="muted small">${queued ? `${queued} בתור` : "אין קבלות בתור"}${inFlight ? ` · ${inFlight} בקריאה` : ""}${failed ? ` · ${failed} לא נקראו` : ""}</span>
      <button class="primary" data-click="rc-send" ${attr(!(queued + failed) || S.extra.sending, "disabled")}>${S.extra.sending ? html`<span class="spin"></span> שולח…` : "לשלוח עכשיו"}</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------ receipts
on("click", "up-person", (el) => { S.upPerson = el.dataset.p ?? ""; rerender(); });

on("change", "rc-files", async (el) => {
  const input = el as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  S.extra.rcBusy = true;
  rerender();
  try {
    const blurry = await capture(files, S.upPerson || null);
    S.extra.blurry = [...(S.extra.blurry ?? []), ...blurry];
    if (!blurry.length) flash(files.length > 1 ? `✓ ${files.length} קבלות נוספו לתור` : "✓ הקבלה נוספה לתור", "ok");
    if (S.settings?.send_mode === "immediate" && !blurry.length) await sendQueued();
  } catch {
    flash("לא הצלחנו לקרוא את התמונה. אפשר לנסות צילום אחר.", "err");
  } finally {
    S.extra.rcBusy = false;
    rerender();
  }
});
on("click", "rc-retake", async () => {
  for (const id of S.extra.blurry ?? []) await removeReceipt(id);
  S.extra.blurry = [];
  rerender();
  ($("rcCam") as HTMLInputElement | null)?.click();
});
on("click", "rc-keep-blurry", async () => {
  S.extra.blurry = [];
  if (S.settings?.send_mode === "immediate") await sendQueued();
  rerender();
});
on("click", "rc-del", async (el) => { await removeReceipt(el.dataset.id!); rerender(); });
on("change", "rc-person", async (el) => { await updateReceipt(el.dataset.id!, { personId: (el as HTMLSelectElement).value || null }); rerender(); });
on("change", "rc-keep", async (el) => { await updateReceipt(el.dataset.id!, { keep: (el as HTMLInputElement).checked }); rerender(); });
on("click", "rc-send", async () => { await sendQueued(); });

// ------------------------------------------------------------ statements
function stStatus(text: string | SafeHtml | null, kind: "info" | "warn" | "err" | "ok" = "info") {
  S.extra.stStatus = text ? { text, kind } : null;
  rerender();
}

/** last 13 months, current first — a statement is always for a past or the current month. */
function stMonthOptions(): string[] {
  const out: string[] = [];
  let m = curMonth();
  for (let i = 0; i < 13; i++) { out.push(m); m = addM(m, -1); }
  return out;
}

on("change", "st-month", (el) => {
  S.extra.stMonth = (el as HTMLSelectElement).value;
  rerender();
});

on("change", "st-files", async (el) => {
  const input = el as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length || S.busy) return;
  const declaredMonth = S.extra.stMonth as string | undefined;
  if (!declaredMonth) { stStatus("קודם צריך לבחור לאיזה חודש הפירוט.", "err"); return; }
  S.busy = true;
  const docs: DraftDoc[] = [];
  const errs: string[] = [];
  const sheets = files.filter((f) => ["xlsx", "csv"].includes(fileKind(f)));
  const pdfs = files.filter((f) => fileKind(f) === "pdf");
  const imgs = files.filter((f) => fileKind(f) === "img");
  for (const f of files.filter((f) => fileKind(f) === "other")) errs.push(`${f.name}: סוג קובץ לא נתמך`);
  try {
    for (const f of sheets) {
      stStatus(html`<span class="spin"></span> קורא את ${f.name}…`);
      try {
        docs.push(toDraft(await localParse(f), "import", declaredMonth));
      } catch (e) {
        // ImportError carries the loud message: which columns are missing / which were found
        errs.push(e instanceof ImportError ? e.message : `${f.name}: הקובץ לא נפתח. אולי הוא פגום או מוגן בסיסמה.`);
      }
    }
    const hints = S.fixed.map((x) => ({ name: x.name, keyword: x.keyword }));
    const jobs: { label: string; files: { media_type: string; data: string }[] }[] = [];
    for (const p of pdfs) {
      if (p.size > MAX_UPLOAD_BYTES) { errs.push(`${p.name}: הקובץ גדול מ-5MB. אפשר לשלוח צילומי מסך במקום.`); continue; }
      jobs.push({ label: p.name, files: [{ media_type: "application/pdf", data: await blobToBase64(p) }] });
    }
    if (imgs.length) {
      stStatus(html`<span class="spin"></span> מכין את התמונות…`);
      const prepared = [];
      for (const f of imgs.slice(0, 6)) prepared.push({ media_type: "image/jpeg", data: await blobToBase64((await prepareImage(f, STATEMENT_MAX_PIXELS, 0.85)).blob) });
      if (imgs.length > 6) errs.push("אפשר עד 6 צילומים של אותו פירוט בכל פעם.");
      jobs.push({ label: imgs.length > 1 ? `${Math.min(6, imgs.length)} תמונות` : imgs[0].name, files: prepared });
    }
    for (let j = 0; j < jobs.length; j++) {
      const step = jobs.length > 1 ? `(${j + 1}/${jobs.length}) ` : "";
      stStatus(html`<span class="spin"></span> ${step}Claude קורא את ${jobs[j].label}… זה יכול לקחת עד דקה.`);
      try {
        const r = await fn.statement(jobs[j].files, hints);
        if (r.doc?.rows?.length) docs.push(toDraft(r.doc, "statement", declaredMonth));
        else errs.push(`${jobs[j].label}: לא נמצאו תנועות. כדאי לנסות צילום חד יותר או קובץ יצוא.`);
      } catch (e: any) {
        errs.push(`${jobs[j].label}: ${e?.message ?? "הקריאה נכשלה"}`);
      }
    }
  } finally {
    S.busy = false;
  }
  if (!docs.length) { stStatus(errs.join(" · ") || "לא נמצאו תנועות בקבצים.", "err"); return; }
  S.pending = { personId: S.upPerson || null, docs };
  stStatus(errs.length ? errs.join(" · ") : null, "warn");
});

function toDraft(r: { title: string; docType: string; statementTotal: number | null; rows: any[]; hint?: string }, source: "import" | "statement", declaredMonth: string): DraftDoc {
  const person = S.upPerson || null;
  const existing = new Set(S.tx.map((t) => dupKey(t)));
  const title = String(r.title || "מסמך").slice(0, 80);
  const hint = String(r.hint || title);
  return {
    title, docType: r.docType, statementTotal: typeof r.statementTotal === "number" ? r.statementTotal : null, source,
    methodId: guessStatementMethod({ title, hint }), hint, choices: {}, declaredMonth,
    rows: r.rows.map((x) => {
      const dup = existing.has(dupKey({ person_id: person, date: x.date, amount: x.amount, merchant: x.merchant }));
      // ATM = cash moved, not spent: saved (for the cash card) but never counted
      const category = isAtmRow(x.merchant) ? "משיכת מזומן" : x.category;
      const excl = (EXCL as readonly string[]).includes(category) && category !== "הכנסה" && category !== "משיכת מזומן";
      // the read date's month disagreeing with what the uploader declared is exactly the shape of bug this guards against —
      // never silently trust either side, surface it and let the review screen force a resolution
      const monthMismatch = x.month !== declaredMonth;
      const foreign = x.original_currency && x.fx_rate ? { original_amount: x.original_amount, original_currency: x.original_currency, fx_rate: x.fx_rate } : {};
      return { id: uid(), date: x.date, month: x.month, merchant: x.merchant, amount: x.amount, category, fixed: !!x.fixed, note: x.note ?? "", dup, keep: !dup && !excl, monthMismatch, mismatchAck: false, ...foreign };
    }),
  };
}

// ------------------------------------------------------------ manual
on("submit", "manual", async () => {
  const a = parseFloat(($("mAmt") as HTMLInputElement).value);
  const d = ($("mDate") as HTMLInputElement).value;
  const desc = ($("mDesc") as HTMLInputElement).value.trim();
  if (!d || !desc || !isFinite(a) || a === 0) { flash("צריך למלא תאריך, סכום ותיאור.", "err"); return; }
  const cat = ($("mCat") as HTMLSelectElement).value;
  const person = ($("mPerson") as HTMLSelectElement).value || null;
  const pm = chipValue("manual", lastMethod(S.upPerson || null));
  if (S.methods.length && !methodById(pm)) { flash("צריך לבחור איך שילמת.", "err"); return; }
  // trip mode: the typed amount is in the trip currency → ₪ by today's rate, the original is kept
  const cur = mCur();
  const rate = cur === "ILS" ? null : currentRate(cur);
  if (cur !== "ILS" && !rate) { flash("אין עדיין שער ל-" + cur + ". אפשר להזין שער ידני בלשונית הבית ← מצב טיול.", "err"); return; }
  const typed = cat === "הכנסה" ? Math.abs(a) : Math.round(a * 100) / 100;
  const amount = rate ? toIls(typed, rate.rate) : typed;
  const foreign = rate ? { original_amount: typed, original_currency: cur, fx_rate: rate.rate } : {};
  try {
    const [row] = await insertTx([{
      ...foreign,
      date: d, month: d.slice(0, 7), merchant: desc.slice(0, 80), amount,
      category: cat, is_fixed: ($("mFixed") as HTMLInputElement).checked, note: "הוזן ידנית",
      person_id: person, source: "manual", source_title: "הוספה ידנית", status: "saved",
      payment_method_id: pm || null, match_status: cat === "הכנסה" ? "none" : initialStatus(methodById(pm)),
    }]);
    if (pm) rememberMethod(person, pm);
    const merged = row && cat !== "הכנסה" ? await settle(row) : null;
    ($("mAmt") as HTMLInputElement).value = "";
    ($("mDesc") as HTMLInputElement).value = "";
    flash(`✓ נוסף: ${desc} · ${ils(amount, 2)}${rate ? ` (${fmtForeign(typed, cur)})` : ""}${merged ? " · " + merged : ""}`, "ok");
  } catch (e: any) {
    const { dbMessage } = await import("../lib/supa.ts");
    flash(dbMessage(e), "err");
  }
});
