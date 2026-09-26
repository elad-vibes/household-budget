// Edge Function "analyze-month" — thin wrapper; the logic lives in _shared/handlers/analysis.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createAnalysisHandler } from "../_shared/handlers/analysis.ts";

Deno.serve(createAnalysisHandler(createDeps()));
