// Edge Function "delete-account" — thin wrapper; the logic lives in _shared/handlers/account.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createDeleteAccountHandler } from "../_shared/handlers/account.ts";

Deno.serve(createDeleteAccountHandler(createDeps()));
