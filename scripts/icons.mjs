// Renders the app icons and the iOS splash screens (PNG) from one SVG master with a
// local Edge/Chromium via Playwright. The mark is original (house + coin, no brand logos),
// the same drawing as markArt() in src/ui/art.ts.
//   node scripts/icons.mjs
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const ACCENT = "#00A58E", DEEP = "#00705F";

/** SVG master, 512×512. maskable = full-bleed background and the mark inside the 80% safe zone. */
const master = (maskable, bg = true) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00B89E"/><stop offset="1" stop-color="${DEEP}"/></linearGradient></defs>
  ${bg ? `<rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#g)"/>` : ""}
  <g transform="translate(256 262) scale(${maskable ? 0.74 : 0.92}) translate(-256 -256)">
    <path d="M104 250 256 122l152 128" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M144 232v156h224V232" fill="none" stroke="#fff" stroke-width="40" stroke-linejoin="round"/>
    <circle cx="256" cy="304" r="58" fill="#FFD27A"/><circle cx="256" cy="304" r="38" fill="none" stroke="#E0A93A" stroke-width="8"/>
    <path d="M256 276v56" stroke="#8A5A00" stroke-width="14" stroke-linecap="round"/>
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
  <div style="width:${Math.round(w * 0.34)}px;height:${Math.round(w * 0.34)}px">${master(true, false).replace("<svg ", '<svg width="100%" height="100%" ')}</div>
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
