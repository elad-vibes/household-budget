// extract-statement: card/bank statement photos or a PDF → rows for review.
// Synchronous (the user is waiting on the review screen). Nothing is stored:
// the app saves the rows the user approved, through RLS.
import type Anthropic from "@anthropic-ai/sdk";
import { ESTIMATE_USD, LIMITS, RATE, costUsd } from "../config.ts";
import type { Deps } from "../deps.ts";
import { type CheckedFile, checkFile, IMAGE_TYPES, PDF_TYPE } from "../files.ts";
import { caller, finalize, rateLimit, release, requireAccess, reserve } from "../guard.ts";
import { endpoint, HttpError } from "../http.ts";
import { parseJson, sanitizeStatement, textOf } from "../ai.ts";
import { israelDateStr, statementPrompt, statementSchemaFor } from "../prompts.ts";
import { isRegion, regionOf } from "../region.ts";

export function createStatementHandler(deps: Deps) {
  return endpoint(deps, "extract-statement", async (req, body) => {
    const claims = await caller(req, deps);
    await requireAccess(deps, body.household_id, claims, "write");
    await rateLimit(deps, `u:${claims.sub}`, "statement", RATE.statement);

    const raw = Array.isArray(body.files) ? body.files : [];
    if (!raw.length) throw new HttpError(400, "no_files", "לא נבחרו קבצים.");
    const files: CheckedFile[] = raw.map((f: unknown) => checkFile(f, [...IMAGE_TYPES, PDF_TYPE]));
    const pdfs = files.filter((f) => f.media_type === PDF_TYPE);
    if (pdfs.length > 1 || (pdfs.length === 1 && files.length > 1)) {
      throw new HttpError(400, "one_pdf", "אפשר לשלוח קובץ PDF אחד בכל פעם, בלי תמונות נוספות.");
    }
    if (files.length > LIMITS.maxStatementImages) {
      throw new HttpError(400, "too_many", `אפשר עד ${LIMITS.maxStatementImages} תמונות של אותו מסמך בכל פעם.`);
    }
    const hints = (Array.isArray(body.fixed_hints) ? body.fixed_hints : [])
      .slice(0, LIMITS.maxFixedHints)
      .map((h: any) => ({ name: String(h?.name ?? "").slice(0, 60), keyword: String(h?.keyword ?? "").slice(0, 40) }))
      .filter((h: { name: string; keyword: string }) => h.name && h.keyword);

    // the household's region (0016) from the app: it only shapes this household's own prompt (no data is read with it)
    const region = isRegion(body.region) ? body.region : "IL";
    const model = deps.env.models.statements;
    const reservation = await reserve(deps, body.household_id, claims.sub, "statement", 1, ESTIMATE_USD.statement, model);

    const kind = pdfs.length
      ? "מצורפים עמודי PDF של מסמך אחד (פירוט אשראי, דף בנק או קבלה)."
      : "מצורפות תמונות של מסמך אחד (פירוט כרטיס אשראי, דף בנק או קבלה). אם יש כמה תמונות, הן עמודים של אותו מסמך, וייתכן שחלקן חופפות: אל תכפיל/י שורות שמופיעות פעמיים.";
    const content: Anthropic.ContentBlockParam[] = files.map((f) =>
      f.media_type === PDF_TYPE
        ? { type: "document", source: { type: "base64", media_type: PDF_TYPE, data: f.data } }
        : { type: "image", source: { type: "base64", media_type: f.media_type as "image/jpeg", data: f.data } },
    );
    content.push({ type: "text", text: statementPrompt(kind, hints, israelDateStr(deps.now(), region), region) });

    let msg: Anthropic.Message;
    try {
      msg = await deps.anthropic.messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: statementSchemaFor(region) as any } },
        messages: [{ role: "user", content }],
      });
    } catch (e) {
      await release(deps, reservation);
      deps.log("anthropic_error", { fn: "extract-statement", status: (e as any)?.status ?? 0 });
      throw new HttpError(502, "ai_unavailable", "הקריאה האוטומטית לא זמינה כרגע. אפשר לנסות שוב בעוד כמה דקות.");
    }
    await finalize(deps, reservation, 1, msg.usage.input_tokens, msg.usage.output_tokens, costUsd(model, msg.usage));
    const doc = sanitizeStatement(parseJson(textOf(msg)), regionOf(region).currency);
    return { ok: true, doc };
  }, { maxBytes: LIMITS.maxRequestBytes });
}
