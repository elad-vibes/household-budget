// Models, prices and limits. Model IDs can be overridden with Edge Function
// secrets (MODEL_RECEIPTS / MODEL_STATEMENTS / MODEL_ANALYSIS).

export const DEFAULT_MODELS = {
  receipts: "claude-haiku-4-5",   // Message Batches API (async, 50% cheaper)
  statements: "claude-sonnet-5",  // synchronous, the user reviews right away
  analysis: "claude-sonnet-5",    // synchronous, structured JSON
} as const;
export type Models = { receipts: string; statements: string; analysis: string };

/** USD per 1M tokens. Unknown models fall back to the most expensive known price. */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-5": { in: 5, out: 25 },
};
export const BATCH_DISCOUNT = 0.5;

export const LIMITS = {
  maxFileBytes: 5 * 1024 * 1024,      // per image / PDF
  maxRequestBytes: 24 * 1024 * 1024,  // whole JSON body (base64 inflates ~33%)
  maxReceiptsPerCall: 10,
  maxStatementImages: 6,
  maxSummaryChars: 14_000,
  maxFixedHints: 60,
};

/** Conservative estimates reserved against the quota before each call. */
export const ESTIMATE_USD = { receipt: 0.003, statement: 0.08, analysis: 0.05 } as const;

/** [max calls, window seconds] per user (or per IP for public endpoints). */
export const RATE: Record<string, [number, number]> = {
  statement: [20, 3600],
  receipts: [30, 3600],
  analysis: [10, 3600],
  inviteIp: [15, 900],
  inviteToken: [6, 900],
  recover: [5, 3600],
  reset: [10, 3600],
  account: [5, 3600],
};

export interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export function costUsd(model: string, u: TokenUsage, batch = false): number {
  const p = PRICES[model] ?? { in: 5, out: 25 };
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  const usd = (input * p.in + (u.output_tokens ?? 0) * p.out) / 1_000_000;
  return Math.round(usd * (batch ? BATCH_DISCOUNT : 1) * 1e6) / 1e6;
}
