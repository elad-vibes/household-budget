// Small shared UI pieces.
import { attr, html, safeUrl, type SafeHtml } from "../lib/html.ts";
import { isLinkId, LINKS } from "../domain/categories.ts";
import { personOptions } from "../domain/calc.ts";
import { ctx } from "../state.ts";
import { ALLCATS, CATS } from "../domain/categories.ts";

/** Renders ONLY whitelisted links (AI output can never inject a URL). */
export function linkHtml(ids: readonly string[] | undefined): SafeHtml {
  const a = (ids ?? []).filter(isLinkId);
  if (!a.length) return html``;
  return html`<div class="links">${a.map((i) => html`<a href="${safeUrl(LINKS[i].u)}" target="_blank" rel="noopener noreferrer" title="${LINKS[i].d}">${LINKS[i].t}</a>`)}</div>`;
}

export function personSelect(id: string, value: string | null, extraClass = ""): SafeHtml {
  const v = value ?? "";
  return html`<select id="${id}" class="${extraClass}">${personOptions(ctx()).map(([k, n]) => html`<option value="${k}" ${attr(k === v, "selected")}>${n}</option>`)}</select>`;
}

export function personOptionsHtml(value: string | null): SafeHtml {
  const v = value ?? "";
  return html`${personOptions(ctx()).map(([k, n]) => html`<option value="${k}" ${attr(k === v, "selected")}>${n}</option>`)}`;
}

export function catOptions(selected: string, withExcl = true): SafeHtml {
  const list = withExcl ? ALLCATS : [...CATS, "הכנסה"];
  return html`${list.map((c) => html`<option ${attr(c === selected, "selected")}>${c}</option>`)}`;
}

export function banner(text: string | SafeHtml, kind: "info" | "warn" | "err" | "ok" = "info"): SafeHtml {
  return html`<div class="banner ${kind}" role="${kind === "err" ? "alert" : "status"}">${text}</div>`;
}

export function copyText(t: string): Promise<boolean> {
  return navigator.clipboard?.writeText(t).then(() => true, () => false) ?? Promise.resolve(false);
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
