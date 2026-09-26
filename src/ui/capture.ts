// Receipt capture that feels like an app (design-brief §6): a big floating camera
// button with the queue counter, and a capture sheet with a framing guide, an
// instant sharpness badge for the last photo and "when will it be sent".
// Reuses the existing handlers in add.ts (rc-files / rc-retake / rc-send).
import { attr, html, type SafeHtml } from "../lib/html.ts";
import { on } from "../lib/events.ts";
import { describeNext } from "../domain/schedule.ts";
import { canWrite, rerender, S } from "../state.ts";
import { icon } from "./cat.ts";

const queued = () => S.queue.filter((r) => r.status === "queued").length;

export function captureFab(): SafeHtml {
  if (S.view !== "app" || !canWrite() || S.extra.capture || S.tab === "home") return html``;
  const n = queued();
  return html`<button class="fab" data-click="cap-open" aria-label="צילום קבלה${n ? ` (${n} בתור)` : ""}">${icon("camera")}${n ? html`<span class="badge num">${n}</span>` : ""}</button>`;
}

export function captureSheet(): SafeHtml {
  if (!S.extra.capture) return html``;
  const n = queued();
  const last = [...S.queue].sort((a, b) => b.createdAt - a.createdAt)[0];
  const fresh = last && Date.now() - last.createdAt < 10 * 60_000 && last.status === "queued";
  const blurry = fresh && (S.extra.blurry ?? []).includes(last.id);
  const next = S.settings ? describeNext(S.settings, new Date()).replace("השליחה הבאה: ", "") : "";
  return html`<div class="sheet-bg" data-click="cap-close"></div>
  <div class="sheet capsheet" role="dialog" aria-modal="true" aria-labelledby="capH">
    <div class="card-h"><h2 id="capH">צילום קבלה</h2><button class="ghost" data-click="cap-close" aria-label="סגירה">✕</button></div>
    <div class="frame" aria-hidden="true"><div class="corners"></div><span>הקבלה כולה בתוך המסגרת</span></div>
    <ul class="tips small muted"><li>ישר מעל הקבלה</li><li>באור טוב, בלי צל</li><li>קבלה ארוכה? אפשר כמה צילומים</li></ul>
    ${S.extra.rcBusy ? html`<div class="skel-line" style="width:60%"></div>` : ""}
    ${fresh ? html`<div class="shot"><img src="${last.thumb}" alt="הצילום האחרון">
      ${blurry ? html`<div><span class="chip miss">✗ מטושטש – צלם שוב</span><div class="row" style="margin-top:6px"><button data-click="rc-retake">לצלם שוב</button><button class="ghost" data-click="rc-keep-blurry">לשמור בכל זאת</button></div></div>`
        : html`<span class="chip ok">✓ חד</span>`}</div>` : ""}
    <div class="grid2">
      <label class="drop big-drop"><input type="file" data-change="rc-files" accept="image/*" capture="environment">${icon("camera")}<b>צילום</b></label>
      <label class="drop big-drop"><input type="file" data-change="rc-files" accept="image/*" multiple>${icon("images")}<b>מהגלריה</b></label>
    </div>
    <div class="row between"><span class="small"><b class="num">${n}</b> בתור${n && next ? ` · יישלח ${next.startsWith("יום") ? "ב" + next : next}` : ""}</span>
      ${n ? html`<button data-click="rc-send" ${attr(S.extra.sending, "disabled")}>לשלוח עכשיו</button>` : ""}</div>
  </div>`;
}

on("click", "cap-open", () => { S.extra.capture = true; rerender(); });
on("click", "cap-close", () => { S.extra.capture = false; rerender(); });
