// Edge Function handlers with a mocked Anthropic client and fake RPCs.
import { describe, expect, it } from "vitest";
import { createStatementHandler } from "../../supabase/functions/_shared/handlers/statement.ts";
import { createPollBatchesHandler, createSubmitReceiptsHandler } from "../../supabase/functions/_shared/handlers/receipts.ts";
import { createAnalysisHandler } from "../../supabase/functions/_shared/handlers/analysis.ts";
import { createInviteHandler } from "../../supabase/functions/_shared/handlers/invite.ts";
import { createDeleteAccountHandler, createMfaRecoverHandler, createMfaResetHandler } from "../../supabase/functions/_shared/handlers/account.ts";
import { costUsd } from "../../supabase/functions/_shared/config.ts";
import { HH, JPEG, makeDeps, message, ORIGIN, PDF, PERSON, PNG, req } from "./fakes.ts";
import { NAMES } from "../fixtures/synthetic.ts";

const call = async (h: (r: Request) => Promise<Response>, r: Request) => {
  const res = await h(r);
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};

const STATEMENT_JSON = {
  docType: "credit_card", title: "פירוט מקס חיוב 02/09/26", statementTotal: 512.4,
  rows: [
    { date: "2026-08-03", month: "2026-08", merchant: "שופרסל דיל", amount: 312.4, category: "סופר ומכולת", fixed: false, note: "" },
    { date: "2026-08-05", month: "2026-08", merchant: "הראל ביטוח", amount: 200, category: "קטגוריה מומצאת", fixed: true, note: "" },
    { date: "bad", month: "2026-08", merchant: "שורה בלי סכום", amount: 0, category: "שונות", fixed: false, note: "" },
  ],
};

describe("CORS, auth and access (extract-statement)", () => {
  it("answers the preflight only for the app origin", async () => {
    const { deps } = makeDeps();
    const h = createStatementHandler(deps);
    const ok = await h(req(null, { method: "OPTIONS" }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    const bad = await h(req(null, { method: "OPTIONS", origin: "https://evil.example" }));
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses other origins, missing sessions and bad tokens", async () => {
    const { deps } = makeDeps();
    const h = createStatementHandler(deps);
    expect((await call(h, req({}, { token: "tok-aal1", origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(h, req({}, {}))).status).toBe(401);
    expect((await call(h, req({}, { token: "forged" }))).status).toBe(401);
  });

  it("refuses non-members, viewers and sessions that still need the 2nd factor", async () => {
    for (const [access, code] of [
      [{ role: null, mfa_required: false, mfa_ok: true }, "not_member"],
      [{ role: "viewer", mfa_required: false, mfa_ok: true }, "viewer"],
      [{ role: "owner", mfa_required: true, mfa_ok: false }, "mfa_required"],
    ] as const) {
      const { deps, s } = makeDeps({ access: access as any });
      const r = await call(createStatementHandler(deps), req({ household_id: HH, files: [{ media_type: "image/jpeg", data: JPEG }] }, { token: "tok-aal1" }));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(code);
      expect(s.anthropicCalls).toHaveLength(0);
    }
  });

  it("rate limits per user", async () => {
    const { deps, s } = makeDeps({ rateOk: false });
    const r = await call(createStatementHandler(deps), req({ household_id: HH, files: [{ media_type: "image/jpeg", data: JPEG }] }, { token: "tok-aal1" }));
    expect(r.status).toBe(429);
    expect(s.anthropicCalls).toHaveLength(0);
  });
});

describe("file validation", () => {
  const send = async (files: unknown[]) => {
    const { deps, s } = makeDeps({ message: message(STATEMENT_JSON) });
    const r = await call(createStatementHandler(deps), req({ household_id: HH, files }, { token: "tok-aal1" }));
    return { ...r, s };
  };
  it("rejects unsupported mime types", async () => {
    expect((await send([{ media_type: "image/gif", data: JPEG }])).status).toBe(415);
  });
  it("rejects a file whose bytes do not match its declared type", async () => {
    expect((await send([{ media_type: "image/jpeg", data: PNG }])).body.error).toBe("type_mismatch");
  });
  it("rejects files over 5MB", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const r = await send([{ media_type: "image/jpeg", data: big.toString("base64") }]);
    expect(r.status).toBe(413);
  });
  it("rejects too many images and PDF mixed with images", async () => {
    expect((await send(Array(7).fill({ media_type: "image/jpeg", data: JPEG }))).body.error).toBe("too_many");
    expect((await send([{ media_type: "application/pdf", data: PDF }, { media_type: "image/jpeg", data: JPEG }])).body.error).toBe("one_pdf");
  });
  it("rejects garbage base64", async () => {
    expect((await send([{ media_type: "image/jpeg", data: "not base64 at all!!".repeat(4) }])).status).toBe(400);
  });
});

describe("extract-statement", () => {
  it("checks the quota BEFORE calling Claude", async () => {
    const { deps, s } = makeDeps({ reserve: { ok: false, reason: "quota_statement" } });
    const r = await call(createStatementHandler(deps), req({ household_id: HH, files: [{ media_type: "image/jpeg", data: JPEG }] }, { token: "tok-aal1" }));
    expect(r.status).toBe(402);
    expect(r.body.message).toMatch(/מכסת/);
    expect(s.anthropicCalls).toHaveLength(0);
  });

  it("returns sanitized rows and records the real cost", async () => {
    const { deps, s } = makeDeps({ message: message(STATEMENT_JSON) });
    const r = await call(createStatementHandler(deps), req({
      household_id: HH, files: [{ media_type: "image/jpeg", data: JPEG }, { media_type: "image/png", data: PNG }],
      fixed_hints: [{ name: "ביטוח בריאות", keyword: "הראל" }],
    }, { token: "tok-aal1" }));
    expect(r.status).toBe(200);
    expect(r.body.doc.rows).toHaveLength(2);
    expect(r.body.doc.rows[1].category).toBe("שונות");
    expect(r.body.doc.statementTotal).toBe(512.4);

    const params = s.anthropicCalls[0].params;
    expect(params.model).toBe("claude-sonnet-5");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(params.messages[0].content.filter((c: any) => c.type === "image")).toHaveLength(2);
    expect(params.messages[0].content.at(-1).text).toContain("ביטוח בריאות : הראל");

    const fin = s.rpcCalls.find((c) => c.fn === "svc_finalize_usage")!;
    expect(fin.args.p_usd).toBeCloseTo(costUsd("claude-sonnet-5", { input_tokens: 5000, output_tokens: 3000 }), 6);
    expect(fin.args.p_usd).toBeCloseTo(0.04, 6);
  });

  it("sends a PDF as a document block", async () => {
    const { deps, s } = makeDeps({ message: message(STATEMENT_JSON) });
    await call(createStatementHandler(deps), req({ household_id: HH, files: [{ media_type: "application/pdf", data: PDF }] }, { token: "tok-aal1" }));
    expect(s.anthropicCalls[0].params.messages[0].content[0].type).toBe("document");
  });

  it("releases the reservation when Claude fails", async () => {
    const { deps, s } = makeDeps({ createError: Object.assign(new Error("overloaded"), { status: 529 }) });
    const r = await call(createStatementHandler(deps), req({ household_id: HH, files: [{ media_type: "image/jpeg", data: JPEG }] }, { token: "tok-aal1" }));
    expect(r.status).toBe(502);
    expect(s.rpcCalls.map((c) => c.fn)).toContain("svc_release_usage");
  });

  it("handles a refusal", async () => {
    const { deps } = makeDeps({ message: message("", { stop_reason: "refusal" }) });
    const r = await call(createStatementHandler(deps), req({ household_id: HH, files: [{ media_type: "image/jpeg", data: JPEG }] }, { token: "tok-aal1" }));
    expect(r.status).toBe(422);
  });

  it("never logs file contents or merchant names", async () => {
    const { deps, s } = makeDeps({ message: message(STATEMENT_JSON) });
    await call(createStatementHandler(deps), req({ household_id: HH, files: [{ media_type: "image/jpeg", data: JPEG }] }, { token: "tok-aal1" }));
    const all = s.logs.join("\n");
    expect(all).not.toContain(JPEG.slice(0, 20));
    expect(all).not.toContain("שופרסל");
  });
});

describe("submit-receipts (Message Batches)", () => {
  const receipt = (i: number) => ({ client_id: `r${i}`, person_id: PERSON, media_type: "image/jpeg", data: JPEG });

  it("creates ONE batch with one request per receipt, images inline, Haiku", async () => {
    const { deps, s } = makeDeps();
    const r = await call(createSubmitReceiptsHandler(deps), req({ household_id: HH, receipts: [receipt(1), receipt(2), receipt(3)] }, { token: "tok-aal1" }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, job_id: "job-1", accepted: ["r1", "r2", "r3"] });
    const batch = s.anthropicCalls.find((c) => c.kind === "batch")!.params;
    expect(batch.requests).toHaveLength(3);
    expect(batch.requests[0].custom_id).toBe("r1");
    expect(batch.requests[0].params.model).toBe("claude-haiku-4-5");
    expect(batch.requests[0].params.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg" } });
    const reserveCall = s.rpcCalls.find((c) => c.fn === "svc_reserve_usage")!;
    expect(reserveCall.args).toMatchObject({ p_kind: "receipt", p_units: 3 });
    const job = s.rpcCalls.find((c) => c.fn === "svc_record_receipt_job")!;
    expect(job.args.p_batch_id).toBe("msgbatch_test_1");
    expect(job.args.p_items).toEqual([1, 2, 3].map((i) => ({ client_id: `r${i}`, person_id: PERSON })));
  });

  it("limits receipts per call and rejects duplicate ids", async () => {
    const { deps } = makeDeps();
    const h = createSubmitReceiptsHandler(deps);
    expect((await call(h, req({ household_id: HH, receipts: Array.from({ length: 11 }, (_, i) => receipt(i)) }, { token: "tok-aal1" }))).body.error).toBe("too_many");
    expect((await call(h, req({ household_id: HH, receipts: [receipt(1), receipt(1)] }, { token: "tok-aal1" }))).body.error).toBe("bad_client_id");
  });

  it("quota exceeded → receipts stay on the device, no batch", async () => {
    const { deps, s } = makeDeps({ reserve: { ok: false, reason: "quota_receipt" } });
    const r = await call(createSubmitReceiptsHandler(deps), req({ household_id: HH, receipts: [receipt(1)] }, { token: "tok-aal1" }));
    expect(r.status).toBe(402);
    expect(r.body.message).toMatch(/יחכו במכשיר/);
    expect(s.anthropicCalls).toHaveLength(0);
  });

  it("releases the reservation if the batch cannot be created", async () => {
    const { deps, s } = makeDeps({ createError: Object.assign(new Error("x"), { status: 500 }) });
    const r = await call(createSubmitReceiptsHandler(deps), req({ household_id: HH, receipts: [receipt(1)] }, { token: "tok-aal1" }));
    expect(r.status).toBe(502);
    expect(s.rpcCalls.map((c) => c.fn)).toContain("svc_release_usage");
    expect(s.rpcCalls.map((c) => c.fn)).not.toContain("svc_record_receipt_job");
  });
});

describe("poll-batches (cron)", () => {
  const job = { id: "job-1", batch_id: "msgbatch_1", model: "claude-haiku-4-5", household_id: HH, created_at: "2026-09-26T08:00:00Z" };
  const cron = { "x-cron-secret": "cron-secret-for-tests-0123456789" };

  it("requires the cron secret", async () => {
    const { deps } = makeDeps();
    expect((await call(createPollBatchesHandler(deps), req({}, { origin: null, headers: { "x-cron-secret": "nope" } }))).status).toBe(401);
  });

  it("leaves unfinished batches alone", async () => {
    const { deps, s } = makeDeps({ openJobs: [job], batch: { processing_status: "in_progress" } });
    const r = await call(createPollBatchesHandler(deps), req({}, { origin: null, headers: cron }));
    expect(r.body).toEqual({ ok: true, checked: 1, completed: 0 });
    expect(s.rpcCalls.map((c) => c.fn)).toContain("svc_touch_receipt_job");
    expect(s.rpcCalls.map((c) => c.fn)).not.toContain("svc_complete_receipt_job");
  });

  it("turns results into review transactions and bills at the batch price", async () => {
    const good = message({ is_receipt: true, merchant: "מכולת השכונה", date: "2026-09-20", total: 87.5, category: "סופר ומכולת", note: "", payment: "אשראי 98761234",
      items: [{ name: "חלב 3%", qty: 2, unit_price: 6.9, total: 13.8 }] }, { usage: { input_tokens: 2000, output_tokens: 400 } });
    const blurry = message({ is_receipt: false, merchant: "", date: "", total: 0, category: "שונות", note: "", items: [] },
      { usage: { input_tokens: 2000, output_tokens: 50 } });
    const { deps, s } = makeDeps({
      openJobs: [job], batch: { processing_status: "ended" },
      batchResults: [
        { custom_id: "r1", result: { type: "succeeded", message: good } },
        { custom_id: "r2", result: { type: "succeeded", message: blurry } },
        { custom_id: "r3", result: { type: "errored", error: { type: "error" } } },
      ],
    });
    const r = await call(createPollBatchesHandler(deps), req({}, { origin: null, headers: cron }));
    expect(r.body.completed).toBe(1);
    const done = s.rpcCalls.find((c) => c.fn === "svc_complete_receipt_job")!.args;
    expect(done.p_results[0]).toMatchObject({ client_id: "r1", ok: true, receipt: { total: 87.5, items: [{ name: "חלב 3%" }], payment: "אשראי ****1234" } }); // never a full card number
    expect(done.p_results[1]).toEqual({ client_id: "r2", ok: false, reason: "unreadable" });
    expect(done.p_results[2]).toEqual({ client_id: "r3", ok: false, reason: "failed" });
    // Haiku $1/$5 per MTok, batch −50%: (4000×1 + 450×5)/1e6 × 0.5
    expect(done.p_usd).toBeCloseTo(0.003125, 4); // stored as numeric(10,5)
    expect(s.ready).toEqual([{ household_id: HH, submitted_by: expect.any(String), parsed: 1 }]);
    // results saved → the batch is deleted at Anthropic (data minimization)
    expect(s.anthropicCalls.filter((c) => c.kind === "delete").map((c) => c.params)).toEqual(["msgbatch_1"]);
  });

  it("fails a job whose batch no longer exists", async () => {
    const { deps, s } = makeDeps({ openJobs: [job], retrieveError: Object.assign(new Error("nf"), { status: 404 }) });
    await call(createPollBatchesHandler(deps), req({}, { origin: null, headers: cron }));
    expect(s.rpcCalls.map((c) => c.fn)).toContain("svc_fail_receipt_job");
  });
});

describe("analyze-month", () => {
  const summary = "חודש: ספטמבר 2026\nסה\"כ הוצאות: 8,200 ₪ ...".padEnd(200, " .");
  it("drops links that are not in the whitelist and stores the analysis", async () => {
    const { deps, s } = makeDeps({
      message: message({ status: "מצב טוב", changes: "", checks: ["לבדוק"],
        tips: [{ title: "חשמל", text: "לעבור ספק", save: 40, links: ["elec_cmp", "https://evil.example", "harb"] }] }),
    });
    const r = await call(createAnalysisHandler(deps), req({ household_id: HH, month: "2026-09", summary }, { token: "tok-aal1" }));
    expect(r.status).toBe(200);
    expect(r.body.analysis.data.tips[0].links).toEqual(["elec_cmp", "harb"]);
    const stored = s.rpcCalls.find((c) => c.fn === "svc_store_analysis")!.args;
    expect(stored.p_month).toBe("2026-09");
    expect(s.anthropicCalls[0].params.messages[0].content).toContain("<summary>");
  });

  it("validates the month and the summary size", async () => {
    const { deps } = makeDeps();
    const h = createAnalysisHandler(deps);
    expect((await call(h, req({ household_id: HH, month: "2026-13", summary }, { token: "tok-aal1" }))).status).toBe(400);
    expect((await call(h, req({ household_id: HH, month: "2026-09", summary: "x".repeat(15000) }, { token: "tok-aal1" }))).status).toBe(413);
  });
});

describe("invite-signin", () => {
  const token = "a".repeat(64);
  it("shows the household name for a valid invite", async () => {
    const { deps } = makeDeps();
    const r = await call(createInviteHandler(deps), req({ action: "info", token }));
    expect(r.body).toMatchObject({ ok: true, household_name: NAMES.hhA });
  });
  it("explains used / expired invites in Hebrew", async () => {
    const { deps } = makeDeps({ invite: { ok: false, reason: "expired" } });
    const r = await call(createInviteHandler(deps), req({ action: "info", token }));
    expect(r.status).toBe(410);
    expect(r.body.message).toMatch(/תוקף/);
  });
  it("claims the invite and creates the account", async () => {
    const { deps, s } = makeDeps();
    const r = await call(createInviteHandler(deps), req({ action: "claim", token, email: " Grandma@Example.Test " }));
    expect(r.body).toEqual({ ok: true });
    expect(s.admin).toEqual(["create:grandma@example.test"]);
  });
  it("does not create an account if the invite is bound to another e-mail", async () => {
    const { deps, s } = makeDeps({ claim: { ok: false, reason: "claimed" } });
    const r = await call(createInviteHandler(deps), req({ action: "claim", token, email: "x@example.test" }));
    expect(r.status).toBe(410);
    expect(s.admin).toHaveLength(0);
  });
  it("rate limits by the proxy-added IP, not a client-supplied one", async () => {
    const { deps, s } = makeDeps();
    await call(createInviteHandler(deps), req({ action: "info", token }, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } }));
    expect(s.rpcCalls.find((c) => c.fn === "svc_rate_limit" && c.args.p_bucket === "invite")!.args.p_key).toBe("ip:203.0.113.9");
  });

  it("validates token and e-mail, and rate limits by IP", async () => {
    const { deps } = makeDeps();
    const h = createInviteHandler(deps);
    expect((await call(h, req({ action: "info", token: "short" }))).status).toBe(400);
    expect((await call(h, req({ action: "claim", token, email: "not-an-email" }))).status).toBe(400);
    const limited = makeDeps({ rateOk: false });
    expect((await call(createInviteHandler(limited.deps), req({ action: "info", token }))).status).toBe(429);
  });
});

describe("account: delete, MFA recovery, MFA reset", () => {
  it("delete-account needs the confirm word and refuses the last owner of a shared household", async () => {
    const { deps, s } = makeDeps({ deletionPrep: { ok: false, blocked: [NAMES.hhA] } });
    const h = createDeleteAccountHandler(deps);
    expect((await call(h, req({}, { token: "tok-aal1" }))).body.error).toBe("confirm");
    const r = await call(h, req({ confirm: "מחיקה" }, { token: "tok-aal1" }));
    expect(r.status).toBe(409);
    expect(s.admin).toHaveLength(0);
  });
  it("delete-account requires aal2 when the user has a factor, then deletes", async () => {
    const withFactor = makeDeps({ factors: ["f1"] });
    expect((await call(createDeleteAccountHandler(withFactor.deps), req({ confirm: "מחיקה" }, { token: "tok-aal1" }))).body.error).toBe("mfa_required");
    const ok = makeDeps({ factors: ["f1"] });
    expect((await call(createDeleteAccountHandler(ok.deps), req({ confirm: "מחיקה" }, { token: "tok-aal2" }))).status).toBe(200);
    expect(ok.s.admin).toEqual([expect.stringMatching(/^delete:/)]);
  });
  it("mfa-recover: a wrong code changes nothing; a right one removes the lost factors", async () => {
    const bad = makeDeps({ factors: ["f1"] });
    expect((await call(createMfaRecoverHandler(bad.deps), req({ code: "AAAAA-BBBBB" }, { token: "tok-aal1" }))).status).toBe(400);
    expect(bad.s.admin).toHaveLength(0);
    const good = makeDeps({ factors: ["f1", "f2"], recoveryOk: true });
    expect((await call(createMfaRecoverHandler(good.deps), req({ code: "AAAAA-BBBBB" }, { token: "tok-aal1" }))).status).toBe(200);
    expect(good.s.admin.filter((a) => a.startsWith("factor:"))).toHaveLength(2);
    expect(good.s.rpcCalls.map((c) => c.fn)).toContain("svc_clear_recovery_codes");
  });
  it("mfa-reset: needs aal2 and the database's permission", async () => {
    const body = { household_id: HH, user_id: "44444444-4444-4444-8444-444444444444" };
    const a1 = makeDeps({ canReset: true });
    expect((await call(createMfaResetHandler(a1.deps), req(body, { token: "tok-aal1" }))).status).toBe(403);
    const no = makeDeps({ canReset: false });
    expect((await call(createMfaResetHandler(no.deps), req(body, { token: "tok-aal2" }))).body.error).toBe("not_allowed");
    const yes = makeDeps({ canReset: true, factors: ["f9"] });
    expect((await call(createMfaResetHandler(yes.deps), req(body, { token: "tok-aal2" }))).status).toBe(200);
    expect(yes.s.admin).toEqual([`factor:${body.user_id}:f9`]);
  });
});
