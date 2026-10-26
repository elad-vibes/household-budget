// Row shapes as they come from Supabase (numeric columns arrive as strings
// from PostgREST only for numeric types; we normalize to numbers on load).

export type Role = "owner" | "member" | "viewer";

export interface Household { id: string; name: string; role: Role }

export interface Settings {
  household_id: string;
  theme: string;
  send_mode: "immediate" | "weekly" | "monthly";
  send_weekday: number;
  send_monthday: number;
  require_mfa: boolean;
  /** "איפה הכי זול?" comparison location (0010) — the only location sent to SuperMCP */
  price_city?: string | null;
  price_street?: string | null;
  quota_images: number;
  quota_statements: number;
  quota_analyses: number;
  quota_usd: number;
}

export interface Person { id: string; household_id: string; name: string; user_id: string | null; sort: number; archived: boolean; legacy_key: string | null }

export interface Member { user_id: string; role: Role; joined_at: string; display_name: string }

export interface Tx {
  id: string;
  household_id: string;
  date: string;
  month: string;
  merchant: string;
  amount: number;
  category: string;
  is_fixed: boolean;
  note: string;
  person_id: string | null;
  source: "manual" | "import" | "statement" | "receipt" | "backup" | "wallet" | "quick";
  source_title: string;
  status: "review" | "saved";
  receipt_job_id?: string | null;
  receipt_client_id?: string | null;
  created_by?: string | null;
  created_at?: string;
  // payment methods (0008): card/bit/transfer items wait for the statement and are merged, never counted twice
  payment_method_id?: string | null;
  match_status?: "none" | "awaiting_statement" | "matched" | "unmatched_after_statement";
  matched_transaction_id?: string | null;
  payment_hint?: string;
  // 0009: an AI-read date more than 2 days in the future or 60 days before the upload is kept
  // as given (never silently changed) but flagged, instead of hiding as a normal-looking date.
  date_uncertain?: boolean;
}

export interface Fixed {
  id: string;
  household_id: string;
  name: string;
  amount: number;
  keyword: string;
  category: string;
  person_id: string | null;
  cycle: 1 | 2 | 12;
  due_day: number | null;
  note: string;
  payment_method_id?: string | null;
}

export interface ShopItem { id: string; household_id: string; name: string; qty: number; done: boolean; sort: number }

export interface AnalysisTip { title: string; text: string; save: number | null; links: string[] }
export interface AnalysisData { status: string; changes: string; tips: AnalysisTip[]; checks: string[]; local?: boolean }
export interface Analysis { month: string; data: AnalysisData; created_at?: string; model?: string }

export interface Invite {
  id: string; role: Role; person_name: string | null; created_at: string; expires_at: string;
  used_at: string | null; revoked_at: string | null; claimed_email: string | null;
}

export interface Usage {
  month: string; images: number; statements: number; analyses: number; usd: number;
  quota_images: number; quota_statements: number; quota_analyses: number; quota_usd: number;
}

/** A row on the review screen before it is saved. */
export interface DraftRow {
  id: string;
  date: string;
  month: string;
  merchant: string;
  amount: number;
  category: string;
  fixed: boolean;
  note: string;
  keep: boolean;
  dup: boolean;
  /** this row's month doesn't match the month the uploader declared for the whole document */
  monthMismatch: boolean;
  /** uploader confirmed the date is right despite monthMismatch */
  mismatchAck: boolean;
}

export interface DraftDoc {
  title: string;
  docType: string;
  statementTotal: number | null;
  source: "import" | "statement";
  rows: DraftRow[];
  /** which payment method this statement belongs to ("" = not chosen yet, "none" = don't match) */
  methodId: string;
  /** text used to auto-detect the method (file name, header lines with last 4 digits / issuer) */
  hint: string;
  /** user's answers for ambiguous rows: row id → waiting transaction id ("" = none of them) */
  choices: Record<string, string>;
  /** month the uploader said this document covers ("YYYY-MM"), used to flag rows whose date disagrees */
  declaredMonth: string;
}
