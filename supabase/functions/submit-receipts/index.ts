// Edge Function "submit-receipts" — thin wrapper; the logic lives in _shared/handlers/receipts.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createSubmitReceiptsHandler } from "../_shared/handlers/receipts.ts";

Deno.serve(createSubmitReceiptsHandler(createDeps()));
