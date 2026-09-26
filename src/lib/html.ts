// Auto-escaping HTML templates. Every ${value} is escaped unless it is itself
// a SafeHtml (from html`` or raw()). Arrays are flattened. This replaces the
// prototype's manual esc() calls and makes injection the hard path.

export class SafeHtml {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"'`]/g, (c) => ESC[c]);

function part(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Only for markup we generate ourselves (never user or AI text). */
export const raw = (s: string) => new SafeHtml(s);

/** Boolean attribute: attr(isChecked, "checked") → checked | "" */
export const attr = (on: unknown, name: "checked" | "selected" | "disabled" | "hidden" | "open" | "required") =>
  new SafeHtml(on ? name : "");

export function render(el: Element | null, content: SafeHtml | string) {
  if (!el) return;
  el.innerHTML = content instanceof SafeHtml ? content.value : esc(content);
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T & Element>(sel)) as T[];

/** A validated https URL for href attributes (anything else becomes "#"). */
export function safeUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.href : "#";
  } catch {
    return "#";
  }
}
