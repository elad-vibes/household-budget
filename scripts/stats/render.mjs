// Admin dashboard: snapshot → one static, self-contained HTML page (Hebrew, RTL,
// light + dark). No external requests; the only script updates "לפני X דק'" and
// marks the page stale. Every value is escaped.
import { cronEveryMinutes, healthChecks } from "./snapshot.mjs";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const TZ = "Asia/Bangkok";
const when = (at) => {
  if (!at) return "—";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
};
const ago = (at) => (at ? `<span class="ago" data-at="${esc(at)}"></span>` : "");
const money = (v) => (Number(v) === 0 ? "$0" : `$${Number(v).toFixed(v >= 1 ? 2 : 3)}`);
const pct = (v, of) => (of > 0 ? Math.round((v / of) * 100) : 0);
const level = (p) => (p >= 100 ? "bad" : p >= 80 ? "warn" : "ok");
const ICON = { ok: "✓", warn: "!", bad: "✕" };
const JOBS = {
  "hb-poll-batches": "קריאת קבלות שנשלחו",
  "hb-notify": "התראות לטלפון",
  "hb-cleanup": "ניקוי לילי",
};
const STATUS = { succeeded: ["ok", "הצליחה"], failed: ["bad", "נכשלה"], running: ["warn", "רצה עכשיו"], starting: ["warn", "מתחילה"] };
const DEPLOY = { success: ["ok", "הצליחה"], failure: ["bad", "נכשלה"], running: ["warn", "רצה עכשיו"], cancelled: ["warn", "בוטלה"], skipped: ["warn", "דולגה"] };
const every = (schedule) => {
  const m = cronEveryMinutes(schedule);
  return m == null ? esc(schedule) : m >= 1440 ? "פעם ביום" : m >= 60 ? `כל ${m / 60} שעות` : `כל ${m} דק'`;
};

function meter(value, of, label) {
  const p = pct(value, of);
  const lv = level(p);
  return `<div class="meter ${lv}" role="img" aria-label="${esc(label)}: ${p}%">
    <div class="track"><div class="fill" style="width:${Math.min(p, 100)}%"></div></div>
    <span class="mlabel">${lv === "ok" ? "" : `${ICON[lv]} `}${p}%</span></div>`;
}

const chip = (lv, text) => `<span class="chip ${lv}"><b aria-hidden="true">${ICON[lv]}</b>${esc(text)}</span>`;
const of = (v, q) => `${v}<span class="muted"> / ${q}</span>`;

function monthsChart(months) {
  if (!months.length) return "";
  const W = 560, H = 160, top = 24, bottom = 26;
  const max = Math.max(...months.map((m) => m.usd), 0.01);
  const col = W / months.length;
  const bw = Math.min(40, col * 0.5);
  const label = (m) => `${m.month.slice(5)}/${m.month.slice(2, 4)}`;
  const bars = months.map((m, i) => {
    const h = Math.max((m.usd / max) * (H - top - bottom), m.usd > 0 ? 3 : 0);
    const cx = W - (i + 0.5) * col;   // RTL: oldest on the right
    const x = cx - bw / 2;
    const y = H - bottom - h;
    const last = i === months.length - 1;
    const r = Math.min(4, h / 2, bw / 2);
    const path = h > 0 ? `M${x},${H - bottom} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - bottom} Z` : "";
    return `<g class="bar${last ? " now" : ""}"><title>${esc(label(m))}: ${money(m.usd)}</title>
      <rect class="hit" x="${cx - col / 2}" y="0" width="${col}" height="${H}"></rect>
      ${path ? `<path d="${path}"></path>` : ""}
      ${last ? `<text class="val" x="${x + bw / 2}" y="${y - 6}" text-anchor="middle">${money(m.usd)}</text>` : ""}
      <text class="axis" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(label(m))}</text></g>`;
  }).join("");
  const rows = months.map((m) => `<tr><td>${esc(label(m))}</td><td class="num">${money(m.usd)}</td></tr>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="עלות AI לפי חודש, 6 חודשים">
      <line class="base" x1="0" x2="${W}" y1="${H - bottom}" y2="${H - bottom}"></line>${bars}</svg>
    <details><summary>כטבלה</summary><table class="t"><thead><tr><th>חודש</th><th class="num">עלות</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}

/** @param s cleaned snapshot (+ optional collector_error) */
export function renderPage(s, now = Date.now()) {
  const checks = healthChecks(s, now);
  const worst = checks[0].level;
  const capP = pct(s.ai.month_usd, s.ai.cap_usd);
  const d = s.deploy;
  const [dLv, dText] = DEPLOY[d?.latest_state] ?? ["warn", "לא ידוע"];

  const families = s.ai.by_household.map((h) => `<tr>
      <th scope="row">משפחה ${h.n}</th>
      <td class="cost"><div class="costline"><span class="num">${money(h.usd)}</span><span class="muted"> / $${h.quota_usd}</span></div>${meter(h.usd, h.quota_usd, `משפחה ${h.n} מול המכסה`)}</td>
      <td class="num">${of(h.images, h.quota_images)}</td>
      <td class="num">${of(h.statements, h.quota_statements)}</td>
      <td class="num">${of(h.analyses, h.quota_analyses)}</td></tr>`).join("");

  const cron = s.cron === null
    ? `<p class="muted">אין גישה לטבלת המשימות (pg_cron).</p>`
    : `<table class="t"><thead><tr><th>משימה</th><th>תדירות</th><th>ריצה אחרונה</th><th>מצב</th><th class="num">24 שעות</th></tr></thead><tbody>${
      s.cron.map((j) => {
        const [lv, txt] = !j.active ? ["warn", "כבויה"] : STATUS[j.last_status] ?? ["warn", "אין ריצות"];
        return `<tr><th scope="row">${esc(JOBS[j.job] ?? j.job)}<div class="muted small" dir="ltr">${esc(j.job)}</div></th>
          <td>${every(j.schedule)}</td><td>${when(j.last_run_at)}<div class="muted small">${ago(j.last_run_at)}</div></td>
          <td>${chip(lv, txt)}</td><td class="num">${j.runs_24h}${j.failed_24h ? ` <span class="bad-text">(${j.failed_24h} נכשלו)</span>` : ""}</td></tr>`;
      }).join("")}</tbody></table>`;

  const r = s.receipts;
  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="refresh" content="300">
<title>לוח ניהול · הכסף של הבית</title>
<style>
:root{color-scheme:light;--bg:#f6f5f2;--surface:#fcfcfb;--line:#e4e2dc;--text:#0b0b0b;--text2:#52514e;--muted:#6b6963;
--series:#2a78d6;--track:#ebe9e3;--good:#0ca30c;--good-t:#006300;--warn:#fab219;--warn-t:#8a5a00;--bad:#d03b3b;--bad-t:#b42323}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#111110;--surface:#1a1a19;--line:#33332f;--text:#f0efec;
--text2:#c3c2b7;--muted:#9a998f;--series:#3987e5;--track:#2b2b28;--good-t:#5fd35f;--warn-t:#fab219;--bad-t:#f08080}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#111110;--surface:#1a1a19;--line:#33332f;--text:#f0efec;--text2:#c3c2b7;--muted:#9a998f;
--series:#3987e5;--track:#2b2b28;--good-t:#5fd35f;--warn-t:#fab219;--bad-t:#f08080}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 40px}
h1{font-size:22px;margin:0}
h2{font-size:16px;margin:0 0 12px}
.sub{color:var(--text2);margin:2px 0 16px}
.muted{color:var(--muted)} .small{font-size:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:14px}
.checks{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:13px;background:var(--surface)}
.chip b{display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:#fff;font-size:11px}
.chip.ok b{background:var(--good)} .chip.warn b{background:var(--warn);color:#2a1c00} .chip.bad b{background:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:14px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.tile .k{color:var(--text2);font-size:13px}
.tile .v{font-size:28px;font-weight:650;letter-spacing:-.01em;font-variant-numeric:tabular-nums;margin:2px 0}
.tile .s{color:var(--muted);font-size:13px}
.num{font-variant-numeric:tabular-nums;text-align:left}
.t{width:100%;border-collapse:collapse;font-size:14px}
.t th,.t td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:right;vertical-align:middle}
.t thead th{color:var(--text2);font-weight:500;font-size:13px}
.t tbody th{font-weight:600}
.t td.num,.t th.num{text-align:left}
.cost{min-width:170px}
.costline{margin-bottom:4px}
.meter{display:flex;align-items:center;gap:8px}
.track{flex:1;height:8px;background:var(--track);border-radius:4px;overflow:hidden}
.fill{height:100%;background:var(--series);border-radius:4px}
.meter.warn .fill{background:var(--warn)} .meter.bad .fill{background:var(--bad)}
.mlabel{font-size:12px;color:var(--text2);min-width:44px;font-variant-numeric:tabular-nums}
.meter.warn .mlabel{color:var(--warn-t)} .meter.bad .mlabel{color:var(--bad-t)}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:14px}
.grid3 .card{margin-top:0}
.kv{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--line)}
.kv:last-child{border-bottom:0}
.bad-text{color:var(--bad-t)} .good-text{color:var(--good-t)}
.chart{width:100%;height:auto;display:block}
.chart .base{stroke:var(--line);stroke-width:1}
.chart path{fill:var(--series);opacity:.55} .chart .now path{opacity:1}
.chart .hit{fill:transparent} .chart .bar:hover path{opacity:1}
.chart .axis{fill:var(--muted);font-size:12px} .chart .val{fill:var(--text);font-size:13px;font-weight:600}
details{margin-top:8px;font-size:13px} summary{cursor:pointer;color:var(--text2)}
footer{color:var(--muted);font-size:12px;margin-top:20px}
.banner{display:none;background:var(--bad);color:#fff;border-radius:10px;padding:8px 12px;margin-bottom:12px}
.stale .banner{display:block}
.scroll{overflow-x:auto}
.scroll .t{min-width:540px}
@media (max-width:760px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.grid3{grid-template-columns:1fr}.tile .v{font-size:24px}}
</style></head>
<body data-generated="${esc(s.generated_at)}" data-worst="${worst}">
<main>
<div class="banner">הנתונים בדף ישנים — האיסוף בשרת לא רץ.</div>
<h1>הכסף של הבית · לוח ניהול</h1>
<p class="sub">חודש ${esc(s.month ?? "—")} · עודכן ${when(s.generated_at)} (שעון תאילנד) · ${ago(s.generated_at)}</p>

<div class="checks" aria-label="מצב">${checks.map((c) => chip(c.level, c.text)).join("")}</div>

<div class="tiles">
  <div class="tile"><div class="k">משפחות פעילות (30 יום)</div><div class="v">${s.households.active_30d}<span class="muted" style="font-size:18px"> / ${s.households.total}</span></div><div class="s">מתוך כל המשפחות</div></div>
  <div class="tile"><div class="k">משתמשים פעילים (7 ימים)</div><div class="v">${s.users.active_7d}</div><div class="s">${s.users.active_30d} ב-30 יום · ${s.users.total} רשומים</div></div>
  <div class="tile"><div class="k">עלות AI החודש</div><div class="v">${money(s.ai.month_usd)}</div>${meter(s.ai.month_usd, s.ai.cap_usd, "מול התקרה הגלובלית")}<div class="s">תקרה $${s.ai.cap_usd} (${capP}%)</div></div>
  <div class="tile"><div class="k">העלאה אחרונה לאתר</div><div class="v" style="font-size:20px;margin-top:8px">${when(d?.last_success_at)}</div><div class="s">${ago(d?.last_success_at)}${d?.sha ? ` · <span dir="ltr">${esc(d.sha)}</span>` : ""}</div><div style="margin-top:6px">${chip(dLv, `ריצה אחרונה: ${dText}`)}</div></div>
</div>

<section class="card"><h2>עלות AI לפי משפחה — החודש</h2>
<div class="scroll"><table class="t"><thead><tr><th>משפחה</th><th>עלות מול מכסה</th><th class="num">קבלות</th><th class="num">פירוטים</th><th class="num">ניתוחים</th></tr></thead>
<tbody>${families || `<tr><td colspan="5" class="muted">אין משפחות</td></tr>`}</tbody></table></div>
<p class="muted small">משפחות מוצגות לפי מספר סידורי (סדר ההקמה), בלי שמות.</p></section>

<section class="card"><h2>עלות AI — 6 חודשים אחרונים</h2>${monthsChart(s.ai.last_months)}</section>

<div class="grid3">
<section class="card"><h2>קבלות החודש</h2>
  <div class="kv"><span>נקראו</span><b class="num good-text">${r.parsed}</b></div>
  <div class="kv"><span>לא קריאות</span><b class="num">${r.unreadable}</b></div>
  <div class="kv"><span>נכשלו</span><b class="num${r.failed ? " bad-text" : ""}">${r.failed}</b></div>
  <div class="kv"><span>ממתינות לקריאה</span><b class="num">${r.waiting}</b></div>
  <p class="muted small">${r.open_batches} שליחות פתוחות${r.oldest_open_at ? ` · הוותיקה מ-${when(r.oldest_open_at)}` : ""} · בדיקה אחרונה ${when(r.last_checked_at)}</p></section>
<section class="card"><h2>דפי חשבון החודש</h2>
  <div class="kv"><span>הצליחו</span><b class="num good-text">${s.statements.ok}</b></div>
  <div class="kv"><span>נכשלו</span><b class="num${s.statements.failed ? " bad-text" : ""}">${s.statements.failed}</b></div></section>
<section class="card"><h2>ניתוחי חודש</h2>
  <div class="kv"><span>הצליחו</span><b class="num good-text">${s.analyses.ok}</b></div>
  <div class="kv"><span>נכשלו</span><b class="num${s.analyses.failed ? " bad-text" : ""}">${s.analyses.failed}</b></div></section>
</div>

<section class="card"><h2>משימות אוטומטיות (cron)</h2><div class="scroll">${cron}</div></section>

<footer>מה לא מוצג כאן, בכוונה: סכומי קניות, חנויות, פריטים, שמות אנשים ומיילים. הדף נבנה מחדש כל 5 דקות בשרת, ונטען מחדש לבד.</footer>
</main>
<script>
(function(){
  function rel(ms){var m=Math.round(ms/60000);if(m<1)return"עכשיו";if(m<60)return"לפני "+m+" דק'";var h=Math.round(m/60);if(h<48)return"לפני "+h+" שעות";return"לפני "+Math.round(h/24)+" ימים";}
  function tick(){var now=Date.now();document.querySelectorAll(".ago").forEach(function(e){e.textContent=rel(now-new Date(e.dataset.at).getTime());});
    var g=new Date(document.body.dataset.generated).getTime();document.documentElement.classList.toggle("stale",!g||now-g>20*60000);}
  tick();setInterval(tick,30000);
})();
</script>
</body></html>`;
}
