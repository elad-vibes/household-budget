// analyze-month: the month summary (built by the app, like the prototype) →
// structured analysis JSON. Links are restricted to the whitelisted catalog
// both by the schema enum and by sanitizeAnalysis().
import type Anthropic from "@anthropic-ai/sdk";
import { ESTIMATE_USD, LIMITS, RATE, costUsd } from "../config.ts";
import type { Deps } from "../deps.ts";
import { caller, finalize, rateLimit, release, requireAccess, reserve } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";
import { parseJson, sanitizeAnalysis, textOf } from "../ai.ts";
import { analysisPrompt, analysisSchemaFor } from "../prompts.ts";
import { isRegion } from "../region.ts";

export function createAnalysisHandler(deps: Deps) {
  return endpoint(deps, "analyze-month", async (req, body) => {
    const claims = await caller(req, deps);
    await requireAccess(deps, body.household_id, claims, "write");
    await rateLimit(deps, `u:${claims.sub}`, "analysis", RATE.analysis);

    const month = String(body.month ?? "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, "bad_month", "חודש לא תקין.");
    const summary = String(body.summary ?? "").trim();
    if (summary.length < 20) throw new HttpError(400, "empty", "אין מספיק נתונים לניתוח החודש.");
    if (summary.length > LIMITS.maxSummaryChars) throw new HttpError(413, "too_large", "הסיכום ארוך מדי.");

    const region = isRegion(body.region) ? body.region : "IL";   // 0016
    const model = deps.env.models.analysis;
    const reservation = await reserve(deps, body.household_id, claims.sub, "analysis", 1, ESTIMATE_USD.analysis, model);
    let msg: Anthropic.Message;
    try {
      msg = await deps.anthropic.messages.create({
        model,
        max_tokens: 8000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: analysisSchemaFor(region) as any } },
        messages: [{ role: "user", content: analysisPrompt(summary, region) }],
      });
    } catch (e) {
      await release(deps, reservation);
      deps.log("anthropic_error", { fn: "analyze-month", status: (e as any)?.status ?? 0 });
      throw new HttpError(502, "ai_unavailable", "הניתוח לא זמין כרגע. אפשר לנסות שוב בעוד כמה דקות.");
    }
    await finalize(deps, reservation, 1, msg.usage.input_tokens, msg.usage.output_tokens, costUsd(model, msg.usage));
    const data = sanitizeAnalysis(parseJson(textOf(msg)));
    await deps.rpc("svc_store_analysis", {
      p_household: body.household_id, p_user: claims.sub, p_month: month, p_data: data, p_model: model,
    });
    return { ok: true, analysis: { month, data, at: deps.now().toISOString() } };
  }, { maxBytes: 64 * 1024 });
}
