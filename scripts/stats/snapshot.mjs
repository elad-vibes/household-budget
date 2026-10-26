// Admin dashboard: pure helpers (no I/O). Rebuilds the DB snapshot from an
// allow-list — anything the SQL might return beyond these fields is dropped —
// and derives the health checks shown at the top of the page.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const int = (v) => Math.max(0, Math.round(num(v)));
const usd = (v) => Math.round(num(v) * 10000) / 10000;
const iso = (v) => { if (v == null || v === "") return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const JOB = /^hb-[a-z0-9-]{1,40}$/;
const SCHEDULE = /^[0-9*,/ -]{1,40}$/;
const CRON_STATUS = new Set(["succeeded", "failed", "running", "starting", "connecting", "sending"]);

/** DB snapshot (stats_snapshot()) + GitHub deploy info → the only shape the page ever sees. */
export function cleanSnapshot(raw, deploy = null) {
  const r = raw ?? {};
  const month = MONTH.test(r.month) ? r.month : null;
  const out = {
    month,
    generated_at: iso(r.generated_at),
    households: { total: int(r.households?.total), active_30d: int(r.households?.active_30d) },
    users: { total: int(r.users?.total), active_7d: int(r.users?.active_7d), active_30d: int(r.users?.active_30d) },
    ai: {
      month_usd: usd(r.ai?.month_usd),
      cap_usd: usd(r.ai?.cap_usd),
      by_household: (Array.isArray(r.ai?.by_household) ? r.ai.by_household : []).map((h) => ({
        n: int(h.n), usd: usd(h.usd), quota_usd: usd(h.quota_usd),
        images: int(h.images), quota_images: int(h.quota_images),
        statements: int(h.statements), quota_statements: int(h.quota_statements),
        analyses: int(h.analyses), quota_analyses: int(h.quota_analyses),
      })),
      last_months: (Array.isArray(r.ai?.last_months) ? r.ai.last_months : [])
        .filter((m) => MONTH.test(m?.month)).map((m) => ({ month: m.month, usd: usd(m.usd) })),
    },
    receipts: {
      parsed: int(r.receipts?.parsed), unreadable: int(r.receipts?.unreadable), failed: int(r.receipts?.failed),
      waiting: int(r.receipts?.waiting), open_batches: int(r.receipts?.open_batches),
      oldest_open_at: iso(r.receipts?.oldest_open_at), last_checked_at: iso(r.receipts?.last_checked_at),
    },
    statements: { ok: int(r.statements?.ok), failed: int(r.statements?.failed) },
    analyses: { ok: int(r.analyses?.ok), failed: int(r.analyses?.failed) },
    cron: Array.isArray(r.cron)
      ? r.cron.filter((j) => JOB.test(j?.job)).map((j) => ({
          job: j.job,
          schedule: SCHEDULE.test(j.schedule) ? j.schedule : "",
          active: j.active !== false,
          last_run_at: iso(j.last_run_at),
          last_status: CRON_STATUS.has(j.last_status) ? j.last_status : null,
          runs_24h: int(j.runs_24h), failed_24h: int(j.failed_24h),
        }))
      : null,
    deploy: cleanDeploy(deploy),
  };
  const text = JSON.stringify(out);
  if (text.includes("@")) throw new Error("snapshot contains '@' — refusing to publish");
  return out;
}

function cleanDeploy(d) {
  if (!d) return null;
  return {
    last_success_at: iso(d.last_success_at),
    latest_at: iso(d.latest_at),
    latest_state: ["success", "failure", "cancelled", "running", "skipped"].includes(d.latest_state) ? d.latest_state : null,
    sha: /^[0-9a-f]{7}$/.test(d.sha ?? "") ? d.sha : null,
  };
}

/** GitHub REST "list workflow runs" responses → deploy summary. */
export function deployFromRuns(latestRes, successRes) {
  const latest = latestRes?.workflow_runs?.[0];
  const ok = successRes?.workflow_runs?.[0];
  if (!latest && !ok) return null;
  const state = !latest ? null : latest.status !== "completed" ? "running" : latest.conclusion;
  return {
    last_success_at: ok?.updated_at ?? null,
    latest_at: latest?.updated_at ?? null,
    latest_state: state,
    sha: (ok?.head_sha ?? "").slice(0, 7),
  };
}

/** Minutes between runs for the simple cron shapes we use; null when unknown. */
export function cronEveryMinutes(schedule) {
  const f = String(schedule ?? "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*" || dow !== "*") return null;
  if (hour === "*") {
    const step = /^\*\/(\d+)$/.exec(min);
    if (step) return Number(step[1]);
    if (/^\d+(,\d+)*$/.test(min)) return 60 / min.split(",").length;
    return null;
  }
  if (/^\d+$/.test(hour) && /^\d+$/.test(min)) return 1440;
  return null;
}

const minutesSince = (at, now) => (at ? (now - new Date(at).getTime()) / 60000 : Infinity);

/** Health checks for the top of the page: [{ level: ok|warn|bad, text }]. Worst first. */
export function healthChecks(s, now = Date.now(), { staleAfterMin = 20 } = {}) {
  const out = [];
  const add = (level, text) => out.push({ level, text });

  if (s.collector_error) add("bad", `האיסוף האחרון נכשל (${s.collector_error}) — מוצגים הנתונים הקודמים`);
  if (minutesSince(s.generated_at, now) > staleAfterMin) add("bad", `הנתונים לא התעדכנו מעל ${staleAfterMin} דקות`);

  const cap = s.ai.cap_usd;
  if (cap > 0 && s.ai.month_usd >= cap) add("bad", `עלות AI החודש הגיעה לתקרה ($${s.ai.month_usd.toFixed(2)} מתוך $${cap})`);
  else if (cap > 0 && s.ai.month_usd >= cap * 0.8) add("warn", "עלות AI החודש מעל 80% מהתקרה");
  for (const h of s.ai.by_household) {
    if (h.quota_usd > 0 && h.usd >= h.quota_usd) add("bad", `משפחה ${h.n} הגיעה למכסת העלות`);
    else if (h.quota_usd > 0 && h.usd >= h.quota_usd * 0.8) add("warn", `משפחה ${h.n} מעל 80% ממכסת העלות`);
  }

  if (s.cron === null) add("warn", "אין מידע על המשימות האוטומטיות");
  for (const j of s.cron ?? []) {
    if (!j.active) { add("warn", `המשימה ${j.job} כבויה`); continue; }
    const every = cronEveryMinutes(j.schedule);
    if (j.last_status === "failed") add("bad", `הריצה האחרונה של ${j.job} נכשלה`);
    else if (every && minutesSince(j.last_run_at, now) > every * 2 + 10) add("bad", `${j.job} לא רצה בזמן`);
    else if (j.failed_24h > 0) add("warn", `${j.job}: ${j.failed_24h} כשלים ב-24 שעות`);
  }

  if (minutesSince(s.receipts.oldest_open_at, now) !== Infinity && minutesSince(s.receipts.oldest_open_at, now) > 26 * 60) {
    add("bad", "יש קבלות שממתינות לקריאה יותר מ-26 שעות");
  }
  if (s.receipts.failed > 0) add("warn", `${s.receipts.failed} קבלות נכשלו החודש`);
  if (s.statements.failed > 0) add("warn", `${s.statements.failed} דפי חשבון נכשלו החודש`);
  if (s.deploy?.latest_state === "failure") add("bad", "ההעלאה האחרונה לאתר נכשלה");

  const rank = { bad: 0, warn: 1, ok: 2 };
  out.sort((a, b) => rank[a.level] - rank[b.level]);
  return out.length ? out : [{ level: "ok", text: "הכול תקין" }];
}
