// Edge Function "poll-batches" — thin wrapper; the logic lives in _shared/handlers/receipts.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createPollBatchesHandler } from "../_shared/handlers/receipts.ts";

Deno.serve(createPollBatchesHandler(createDeps()));
