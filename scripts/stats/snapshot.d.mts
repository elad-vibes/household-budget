export type Level = "ok" | "warn" | "bad";
export interface Household { n: number; usd: number; quota_usd: number; images: number; quota_images: number; statements: number; quota_statements: number; analyses: number; quota_analyses: number }
export interface CronJob { job: string; schedule: string; active: boolean; last_run_at: string | null; last_status: string | null; runs_24h: number; failed_24h: number }
export interface Deploy { last_success_at: string | null; latest_at: string | null; latest_state: string | null; sha: string | null }
export interface Snapshot {
  month: string | null;
  generated_at: string | null;
  households: { total: number; active_30d: number };
  users: { total: number; active_7d: number; active_30d: number };
  ai: { month_usd: number; cap_usd: number; by_household: Household[]; last_months: { month: string; usd: number }[] };
  receipts: { parsed: number; unreadable: number; failed: number; waiting: number; open_batches: number; oldest_open_at: string | null; last_checked_at: string | null };
  statements: { ok: number; failed: number };
  analyses: { ok: number; failed: number };
  cron: CronJob[] | null;
  deploy: Deploy | null;
  collector_error?: string;
}
export function cleanSnapshot(raw: unknown, deploy?: unknown): Snapshot;
export function deployFromRuns(latestRes: unknown, successRes: unknown): { last_success_at: string | null; latest_at: string | null; latest_state: string | null; sha: string } | null;
export function cronEveryMinutes(schedule: string): number | null;
export function healthChecks(s: Snapshot, now?: number, opts?: { staleAfterMin?: number }): { level: Level; text: string }[];
