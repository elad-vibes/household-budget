// Renders the app icons and the iOS splash screens (PNG) from one SVG master with a
// local Edge/Chromium via Playwright. The mark is original (house + coin, no brand logos),
// the same drawing as markArt() in src/ui/art.ts.
//   node scripts/icons.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const ACCENT = "#00A58E", DEEP = "#00705F";

/** SVG master, 512×512. maskable = full-bleed background and the mark inside the 80% safe zone. */
const master = (maskable, bg = true) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#19D3B3"/><stop offset="1" stop-color="${DEEP}"/></linearGradient>
    <radialGradient id="glow" cx=".25" cy=".18" r=".75"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="coin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE9A8"/><stop offset="1" stop-color="#F4B63A"/></linearGradient>
    <linearGradient id="roof" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF9F72"/><stop offset="1" stop-color="#F0583A"/></linearGradient>
  </defs>
  ${bg ? `<rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#g)"/><rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#glow)"/>` : ""}
  <g transform="translate(256 262) scale(${maskable ? 0.74 : 0.92}) translate(-256 -256)">
    <ellipse cx="256" cy="424" rx="158" ry="15" fill="#003D33" opacity=".35"/>
    <rect x="164" y="146" width="34" height="90" rx="9" fill="#C8472B"/>
    <circle cx="352" cy="172" r="76" fill="url(#coin)"/><circle cx="352" cy="172" r="55" fill="none" stroke="#E2A22E" stroke-width="9"/>
    <g fill="none" stroke="#B87A14" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M330 198V150h16v34"/><path d="M374 146v48h-16v-34"/></g>
    <path d="M148 262h216v134a24 24 0 0 1-24 24H172a24 24 0 0 1-24-24z" fill="#FFF8EC"/>
    <path d="M148 280 256 176l108 104z" fill="#FFF8EC"/>
    <path d="M118 276 256 158l138 118" fill="none" stroke="url(#roof)" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M226 420v-64a30 30 0 0 1 60 0v64z" fill="#0B8C77"/><circle cx="272" cy="382" r="5" fill="#FFD27A"/>
  </g></svg>`;

const ICONS = [
  ["public/icons/icon-192.png", 192, false],
  ["public/icons/icon-512.png", 512, false],
  ["public/icons/maskable-512.png", 512, true],
  ["public/icons/apple-touch-icon.png", 180, true], // iOS rounds the corners itself; no transparency
];

// iPhone portrait splash screens: [css width, css height, device pixel ratio]
const SPLASH = [
  [440, 956, 3], [430, 932, 3], [402, 874, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3],
  [375, 812, 3], [414, 896, 3], [414, 896, 2], [375, 667, 2],
];

const splashHtml = (w) => `<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(w * 0.06)}px;
  background:${ACCENT};font-family:'Segoe UI',Arial,sans-serif">
  <div style="width:${Math.round(w * 0.46)}px;height:${Math.round(w * 0.46)}px">${master(true, false).replace("<svg ", '<svg width="100%" height="100%" ')}</div>
  <div dir="rtl" style="color:#fff;font-size:${Math.round(w * 0.075)}px;font-weight:700">הכסף של הבית</div></body></html>`;

mkdirSync("public/icons", { recursive: true });
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch());
let page = await browser.newPage();
for (const [file, size, maskable] of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${master(maskable).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: !maskable, clip: { x: 0, y: 0, width: size, height: size } });
  console.log("wrote", file);
}
const links = [];
for (const [w, h, dpr] of SPLASH) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  page = await ctx.newPage();
  await page.setContent(splashHtml(w));
  const name = `splash-${w * dpr}x${h * dpr}.png`;
  await page.screenshot({ path: `public/icons/${name}` });
  await ctx.close();
  links.push(`<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" href="/icons/${name}">`);
  console.log("wrote", name);
}
mkdirSync("scratch", { recursive: true });
writeFileSync("scratch/splash-links.html", links.join("\n") + "\n");
await browser.close();
