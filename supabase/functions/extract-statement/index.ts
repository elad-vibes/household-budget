// Edge Function "extract-statement" — thin wrapper; the logic lives in _shared/handlers/statement.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createStatementHandler } from "../_shared/handlers/statement.ts";

Deno.serve(createStatementHandler(createDeps()));
