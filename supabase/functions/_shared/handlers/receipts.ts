// submit-receipts: queued receipt images → one Anthropic Message Batch.
// poll-batches (pg_cron every 30 min): finished batches → 'review' transactions.
// Images are sent inline and never stored on the server.
import type Anthropic from "@anthropic-ai/sdk";
import { ESTIMATE_USD, LIMITS, RATE, costUsd } from "../config.ts";
import type { Deps } from "../deps.ts";
import { checkFile, IMAGE_TYPES } from "../files.ts";
import { caller, isUuid, rateLimit, release, requireAccess, reserve } from "../guard.ts";
import { endpoint, HttpError, safeEqual } from "../http.ts";
import { parseJson, sanitizeReceipt, textOf } from "../ai.ts";
import { RECEIPT_PROMPT, RECEIPT_SCHEMA } from "../prompts.ts";

const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function createSubmitReceiptsHandler(deps: Deps) {
  return endpoint(deps, "submit-receipts", async (req, body) => {
    const claims = await caller(req, deps);
    await requireAccess(deps, body.household_id, claims, "write");
    await rateLimit(deps, `u:${claims.sub}`, "receipts", RATE.receipts);

    const list = Array.isArray(body.receipts) ? body.receipts : [];
    if (!list.length) throw new HttpError(400, "no_files", "אין קבלות לשליחה.");
    if (list.length > LIMITS.maxReceiptsPerCall) {
      throw new HttpError(400, "too_many", `אפשר עד ${LIMITS.maxReceiptsPerCall} קבלות בכל שליחה.`);
    }
    const seen = new Set<string>();
    const receipts = list.map((r: any) => {
      const clientId = String(r?.client_id ?? "");
      if (!CLIENT_ID.test(clientId) || seen.has(clientId)) throw new HttpError(400, "bad_client_id", "מזהה קבלה לא תקין.");
      seen.add(clientId);
      const file = checkFile(r, IMAGE_TYPES);
      return { clientId, personId: isUuid(r?.person_id) ? r.person_id : null, file };
    });

    const model = deps.env.models.receipts;
    const reservation = await reserve(deps, body.household_id, claims.sub, "receipt",
      receipts.length, ESTIMATE_USD.receipt * receipts.length, model);

    let batch: Anthropic.Messages.MessageBatch;
    try {
      batch = await deps.anthropic.messages.batches.create({
        requests: receipts.map((r: typeof receipts[number]) => ({
          custom_id: r.clientId,
          params: {
            model,
            max_tokens: 4096,
            output_config: { format: { type: "json_schema", schema: RECEIPT_SCHEMA as any } },
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: r.file.media_type as "image/jpeg", data: r.file.data } },
                { type: "text", text: RECEIPT_PROMPT },
              ],
            }],
          },
        })),
      });
    } catch (e) {
      await release(deps, reservation);
      deps.log("anthropic_error", { fn: "submit-receipts", status: (e as any)?.status ?? 0 });
      throw new HttpError(502, "ai_unavailable", "השליחה לקריאה לא הצליחה כרגע. הקבלות נשארות במכשיר וננסה שוב.");
    }

    const jobId = await deps.rpc<string>("svc_record_receipt_job", {
      p_household: body.household_id,
      p_user: claims.sub,
      p_batch_id: batch.id,
      p_model: model,
      p_items: receipts.map((r: typeof receipts[number]) => ({ client_id: r.clientId, person_id: r.personId })),
      p_reservation: reservation,
    });
    deps.log("receipts_submitted", { count: receipts.length });
    return { ok: true, job_id: jobId, accepted: receipts.map((r: typeof receipts[number]) => r.clientId) };
  }, { maxBytes: LIMITS.maxRequestBytes });
}

interface OpenJob { id: string; batch_id: string; model: string; household_id: string; created_at: string }

export function createPollBatchesHandler(deps: Deps) {
  return endpoint(deps, "poll-batches", async (req) => {
    if (!safeEqual(req.headers.get("x-cron-secret") ?? "", deps.env.cronSecret)) {
      throw new HttpError(401, "unauthorized", "unauthorized");
    }
    const jobs = await deps.rpc<OpenJob[]>("svc_open_receipt_jobs", { p_limit: 20 });
    let completed = 0;
    const done: { household_id: string; submitted_by: string | null; parsed: number }[] = [];
    for (const job of jobs ?? []) {
      try {
        const batch = await deps.anthropic.messages.batches.retrieve(job.batch_id);
        await deps.rpc("svc_touch_receipt_job", { p_job: job.id });
        if (batch.processing_status !== "ended") continue;

        const results: unknown[] = [];
        let input = 0, output = 0, usd = 0;
        for await (const r of await deps.anthropic.messages.batches.results(job.batch_id)) {
          if (r.result.type === "succeeded") {
            const msg = r.result.message;
            input += msg.usage.input_tokens;
            output += msg.usage.output_tokens;
            usd += costUsd(job.model, msg.usage, true);
            try {
              results.push({ client_id: r.custom_id, ...sanitizeReceipt(parseJson(textOf(msg))) });
            } catch {
              results.push({ client_id: r.custom_id, ok: false, reason: "unreadable" });
            }
          } else {
            results.push({ client_id: r.custom_id, ok: false, reason: "failed" });
          }
        }
        const out = await deps.rpc<any>("svc_complete_receipt_job", {
          p_job: job.id, p_results: results, p_input: input, p_output: output, p_usd: Math.round(usd * 1e5) / 1e5,
        });
        if (out?.ok) {
          completed++;
          done.push({ household_id: out.household_id, submitted_by: out.submitted_by, parsed: out.parsed });
        }
      } catch (e) {
        const status = (e as any)?.status ?? 0;
        deps.log("poll_error", { job: job.id, status });
        // A batch that Anthropic no longer knows about will never finish.
        if (status === 404) await deps.rpc("svc_fail_receipt_job", { p_job: job.id, p_error: "batch_not_found" });
      }
    }
    if (done.length && deps.onReceiptsReady) await deps.onReceiptsReady(done);
    return { ok: true, checked: jobs?.length ?? 0, completed };
  }, { allowNoOrigin: true, maxBytes: 1024 });
}
