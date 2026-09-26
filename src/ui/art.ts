// Our own flat illustrations (design-brief §2), drawn as inline SVG that takes its
// colors from the theme tokens, so every preset and dark mode recolors them.
// Decorative only (aria-hidden): the text next to each one carries the meaning.
// Listed in ASSETS.md — original work, no external source.
import { raw, type SafeHtml } from "../lib/html.ts";

const A = "var(--accent)", S = "var(--accent-soft)", D = "var(--accent-deep)", W = "var(--var)", F = "var(--surface)", L = "var(--line)";
const svg = (vb: string, body: string, cls = "art"): SafeHtml =>
  raw(`<svg class="${cls}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`);
const ground = `<ellipse cx="100" cy="128" rx="78" ry="8" fill="${S}"/>`;
const coin = (x: number, y: number, r = 11) =>
  `<circle cx="${x}" cy="${y}" r="${r}" fill="${W}"/><circle cx="${x}" cy="${y}" r="${r * 0.62}" fill="none" stroke="${F}" stroke-width="2" opacity=".7"/>`;

/** Time-of-day marks next to the greeting. */
export const timeArt = {
  morning: () => svg("0 0 48 48", `<path d="M6 34h36" stroke="${D}" stroke-width="3" stroke-linecap="round"/><path d="M13 34a11 11 0 0 1 22 0" fill="${W}"/>
    <g stroke="${W}" stroke-width="3" stroke-linecap="round"><path d="M24 14v4M11 20l3 3M37 20l-3 3M6 27h3M39 27h3"/></g>`, "tod"),
  noon: () => svg("0 0 48 48", `<circle cx="24" cy="24" r="9" fill="${W}"/><g stroke="${W}" stroke-width="3" stroke-linecap="round">
    <path d="M24 6v5M24 37v5M6 24h5M37 24h5M11 11l3.5 3.5M33.5 33.5 37 37M37 11l-3.5 3.5M14.5 33.5 11 37"/></g>`, "tod"),
  evening: () => svg("0 0 48 48", `<path d="M30 8a15 15 0 1 0 10 25A13 13 0 0 1 30 8z" fill="${A}"/>
    <circle cx="12" cy="12" r="1.8" fill="${W}"/><circle cx="20" cy="6" r="1.2" fill="${W}"/><circle cx="8" cy="22" r="1.2" fill="${W}"/>`, "tod"),
};

/** The app mark: a house with a coin (also the app icon). */
export const markArt = () => svg("0 0 64 64", `<rect width="64" height="64" rx="16" fill="${A}"/>
  <path d="M13 31 32 15l19 16" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M18 29v19h28V29" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
  <circle cx="32" cy="38" r="7" fill="#FFD27A"/><path d="M32 34.5v7" stroke="#8A5A00" stroke-width="2" stroke-linecap="round"/>`, "mark");

export const art = {
  /** no transactions yet: an open wallet with a receipt and coins */
  noTx: () => svg("0 0 200 140", `${ground}
    <rect x="58" y="22" width="56" height="74" rx="6" fill="${F}" stroke="${L}" stroke-width="2" transform="rotate(-8 86 59)"/>
    <g stroke="${L}" stroke-width="4" stroke-linecap="round" transform="rotate(-8 86 59)"><path d="M68 38h34M68 50h28M68 62h34M68 74h20"/></g>
    <rect x="44" y="62" width="112" height="60" rx="14" fill="${A}"/><rect x="44" y="62" width="112" height="18" rx="9" fill="${D}"/>
    <rect x="122" y="84" width="40" height="22" rx="11" fill="${D}"/><circle cx="136" cy="95" r="5" fill="${W}"/>
    ${coin(160, 44)}${coin(146, 30, 8)}`),
  /** receipt queue empty: a receipt with a check mark */
  queueEmpty: () => svg("0 0 200 140", `${ground}
    <path d="M70 14h60v106l-10-7-10 7-10-7-10 7-10-7-10 7z" fill="${F}" stroke="${L}" stroke-width="2" stroke-linejoin="round"/>
    <g stroke="${L}" stroke-width="4" stroke-linecap="round"><path d="M82 32h36M82 44h28M82 56h36"/></g>
    <circle cx="128" cy="86" r="22" fill="${A}"/><path d="m117 86 8 8 14-15" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`),
  /** shopping list empty: a bag with a leaf */
  shopEmpty: () => svg("0 0 200 140", `${ground}
    <path d="M62 50h76l-6 72H68z" fill="${A}"/><path d="M80 52V42a20 20 0 0 1 40 0v10" fill="none" stroke="${D}" stroke-width="6" stroke-linecap="round"/>
    <path d="M100 76c14-14 30-10 30-10s0 18-18 22c-6 1-10-2-12-12z" fill="${S}"/><path d="M100 90c6-8 14-14 22-18" stroke="${D}" stroke-width="3" fill="none" stroke-linecap="round"/>`),
  /** no goals yet: a jar and a falling coin */
  goalsEmpty: () => svg("0 0 200 140", `${ground}
    <rect x="72" y="34" width="56" height="12" rx="4" fill="${D}"/>
    <path d="M70 48h60v58a16 16 0 0 1-16 16H86a16 16 0 0 1-16-16z" fill="${F}" stroke="${A}" stroke-width="4"/>
    <path d="M74 98h52v8a12 12 0 0 1-12 12H86a12 12 0 0 1-12-12z" fill="${S}"/>
    ${coin(100, 16, 10)}<path d="M100 30v6" stroke="${W}" stroke-width="3" stroke-linecap="round" stroke-dasharray="2 4"/>`),
  /** success moments: a medal with a check and sparkles */
  success: () => svg("0 0 200 140", `${ground}
    <path d="M84 70 72 118l16-8 10 14 8-50zM116 70l12 48-16-8-10 14-8-50z" fill="${D}"/>
    <circle cx="100" cy="58" r="34" fill="${W}"/><circle cx="100" cy="58" r="25" fill="none" stroke="${F}" stroke-width="3" opacity=".8"/>
    <path d="m88 58 8 8 16-17" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <g fill="${A}"><path d="M40 40l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/><path d="M158 26l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/><circle cx="160" cy="78" r="4"/><circle cx="46" cy="90" r="3"/></g>`),
  /** error / offline: a cloud with a slash */
  offline: () => svg("0 0 200 140", `${ground}
    <path d="M62 104h78a24 24 0 0 0 0-48 34 34 0 0 0-64-6 26 26 0 0 0-14 54z" fill="${S}" stroke="${A}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M58 30l86 86" stroke="${W}" stroke-width="7" stroke-linecap="round"/>`),
  /** onboarding 1: the household's money in one place */
  intro1: () => svg("0 0 200 140", `${ground}
    <path d="M40 70 100 22l60 48" fill="none" stroke="${D}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M56 64v58h88V64" fill="${F}" stroke="${A}" stroke-width="6" stroke-linejoin="round"/>
    ${coin(100, 92, 20)}<path d="M100 84v16" stroke="${F}" stroke-width="4" stroke-linecap="round"/>`),
  /** onboarding 2: photograph receipts, Claude reads them */
  intro2: () => svg("0 0 200 140", `${ground}
    <rect x="66" y="10" width="68" height="118" rx="14" fill="${D}"/><rect x="72" y="22" width="56" height="92" rx="6" fill="${F}"/>
    <path d="M84 34h32v62l-5-4-6 4-5-4-6 4-5-4-5 4z" fill="${S}"/><g stroke="${A}" stroke-width="3" stroke-linecap="round"><path d="M90 46h20M90 56h14M90 66h20"/></g>
    <g fill="none" stroke="${W}" stroke-width="4" stroke-linecap="round"><path d="M78 30v-4h6M122 30v-4h-6M78 106v4h6M122 106v4h-6"/></g>`),
  /** onboarding 3: see where the money goes and where to save */
  intro3: () => svg("0 0 200 140", `${ground}
    <rect x="46" y="76" width="22" height="46" rx="5" fill="${S}"/><rect x="76" y="56" width="22" height="66" rx="5" fill="${A}"/>
    <rect x="106" y="86" width="22" height="36" rx="5" fill="${S}"/><rect x="136" y="40" width="22" height="82" rx="5" fill="${D}"/>
    <circle cx="68" cy="30" r="16" fill="${W}"/><path d="M62 46h12M64 52h8" stroke="${D}" stroke-width="4" stroke-linecap="round"/>`),
};
