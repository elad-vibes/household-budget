// Fake dependencies for Edge Function tests: an in-memory "database" that
// answers the svc_* RPCs, a mocked Anthropic client, and a recording logger.
import type { Claims, Deps } from "../../supabase/functions/_shared/deps.ts";
import { NAMES } from "../fixtures/synthetic.ts";

export const HH = "11111111-1111-4111-8111-111111111111";
export const USER = "22222222-2222-4222-8222-222222222222";
export const PERSON = "33333333-3333-4333-8333-333333333333";
export const ORIGIN = "https://elad-vibes.github.io";

export const b64 = (bytes: number[], pad = 40) =>
  Buffer.from([...bytes, ...Array.from({ length: pad }, (_, i) => (i * 37) % 256)]).toString("base64");
export const JPEG = b64([0xff, 0xd8, 0xff, 0xe0]);
export const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PDF = Buffer.from("%PDF-1.4\n" + "x".repeat(60)).toString("base64");

export interface FakeState {
  access: { role: string | null; mfa_required: boolean; mfa_ok: boolean };
  reserve: { ok: boolean; reason?: string };
  rateOk: boolean;
  rpcCalls: { fn: string; args: any }[];
  logs: string[];
  anthropicCalls: { kind: string; params: any }[];
  message: any;                // next messages.create result
  createError: any;            // thrown by messages.create / batches.create when set
  batch: { processing_status: string };
  batchResults: any[];
  retrieveError: any;
  openJobs: any[];
  invite: any;
  claim: any;
  recoveryOk: boolean;
  canReset: boolean;
  deletionPrep: any;
  factors: string[];
  admin: string[];
  ready: any[];
}

export function makeDeps(over: Partial<FakeState> = {}) {
  const s: FakeState = {
    access: { role: "member", mfa_required: false, mfa_ok: true },
    reserve: { ok: true },
    rateOk: true,
    rpcCalls: [],
    logs: [],
    anthropicCalls: [],
    message: null,
    createError: null,
    batch: { processing_status: "in_progress" },
    batchResults: [],
    retrieveError: null,
    openJobs: [],
    invite: { ok: true, household_name: NAMES.hhA, role: "member", person_name: NAMES.grandma },
    claim: { ok: true },
    recoveryOk: false,
    canReset: false,
    deletionPrep: { ok: true },
    factors: [],
    admin: [],
    ready: [],
    ...over,
  };

  const tokens: Record<string, Claims> = {
    "tok-aal1": { sub: USER, email: "user@example.test", aal: "aal1", role: "authenticated" },
    "tok-aal2": { sub: USER, email: "user@example.test", aal: "aal2", role: "authenticated" },
  };

  const rpc = async (fn: string, args: any): Promise<any> => {
    s.rpcCalls.push({ fn, args });
    switch (fn) {
      case "svc_access": return s.access;
      case "svc_rate_limit": return s.rateOk;
      case "svc_reserve_usage": return s.reserve.ok ? { ok: true, reservation_id: "res-1" } : { ok: false, reason: s.reserve.reason };
      case "svc_record_receipt_job": return "job-1";
      case "svc_open_receipt_jobs": return s.openJobs;
      case "svc_complete_receipt_job": return { ok: true, household_id: HH, submitted_by: USER, parsed: 1 };
      case "svc_invite_info": return s.invite;
      case "svc_claim_invite": return s.claim;
      case "svc_use_recovery_code": return s.recoveryOk;
      case "svc_can_reset_mfa": return s.canReset;
      case "svc_prepare_account_deletion": return s.deletionPrep;
      default: return null;
    }
  };

  const anthropic = {
    messages: {
      create: async (params: any) => {
        s.anthropicCalls.push({ kind: "create", params });
        if (s.createError) throw s.createError;
        return s.message;
      },
      batches: {
        create: async (params: any) => {
          s.anthropicCalls.push({ kind: "batch", params });
          if (s.createError) throw s.createError;
          return { id: "msgbatch_test_1", processing_status: "in_progress" };
        },
        retrieve: async (id: string) => {
          s.anthropicCalls.push({ kind: "retrieve", params: id });
          if (s.retrieveError) throw s.retrieveError;
          return { id, ...s.batch };
        },
        delete: async (id: string) => {
          s.anthropicCalls.push({ kind: "delete", params: id });
          return { id, type: "message_batch_deleted" };
        },
        results: async (id: string) => {
          s.anthropicCalls.push({ kind: "results", params: id });
          return (async function* () { for (const r of s.batchResults) yield r; })();
        },
      },
    },
  };

  const deps: Deps = {
    env: {
      allowedOrigins: [ORIGIN, "http://localhost:5173"],
      requireOrigin: true,
      cronSecret: "cron-secret-for-tests-0123456789",
      appUrl: "https://elad-vibes.github.io/household-budget/",
      models: { receipts: "claude-haiku-4-5", statements: "claude-sonnet-5", analysis: "claude-sonnet-5" },
    },
    verifyJwt: async (t) => tokens[t] ?? null,
    rpc,
    anthropic: anthropic as any,
    admin: {
      createUser: async (email) => { s.admin.push(`create:${email}`); return "created"; },
      deleteUser: async (id) => { s.admin.push(`delete:${id}`); },
      listFactorIds: async () => s.factors,
      deleteFactor: async (uid, fid) => { s.admin.push(`factor:${uid}:${fid}`); },
    },
    onReceiptsReady: async (done) => { s.ready.push(...done); },
    log: (event, fields = {}) => { s.logs.push(JSON.stringify({ event, ...fields })); },
    now: () => new Date("2026-09-26T10:00:00Z"),
  };
  return { deps, s };
}

export function req(body: unknown, opts: { token?: string; origin?: string | null; method?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Request("https://example.supabase.co/functions/v1/x", {
    method: opts.method ?? "POST",
    headers,
    body: opts.method === "OPTIONS" ? undefined : JSON.stringify(body),
  });
}

export function message(json: unknown, over: Record<string, unknown> = {}) {
  return {
    id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
    stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: typeof json === "string" ? json : JSON.stringify(json) }],
    usage: { input_tokens: 5000, output_tokens: 3000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...over,
  };
}
