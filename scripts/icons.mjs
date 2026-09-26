// Renders the app icons (PNG) from an inline SVG with a local Edge/Chromium via Playwright.
//   node scripts/icons.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const svg = (maskable) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00B89E"/><stop offset="1" stop-color="#00705F"/></linearGradient></defs>
  <rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#g)"/>
  <g transform="translate(256 262) scale(${maskable ? 0.78 : 1})">
    <path d="M-150 -30 L0 -150 L150 -30" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="0" y="112" font-family="Segoe UI, Arial, sans-serif" font-size="230" font-weight="700" fill="#fff" text-anchor="middle">₪</text>
  </g></svg>`;

const out = [
  ["public/icons/icon-192.png", 192, false],
  ["public/icons/icon-512.png", 512, false],
  ["public/icons/maskable-512.png", 512, true],
  ["public/icons/apple-touch-icon.png", 180, true], // iOS rounds the corners itself; no transparency
];
mkdirSync("public/icons", { recursive: true });
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch());
const page = await browser.newPage();
for (const [file, size, maskable] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(maskable).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: !maskable, clip: { x: 0, y: 0, width: size, height: size } });
  console.log("wrote", file);
}
await browser.close();
