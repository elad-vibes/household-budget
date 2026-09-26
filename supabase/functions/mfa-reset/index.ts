// Edge Function "mfa-reset" — thin wrapper; the logic lives in _shared/handlers/account.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createMfaResetHandler } from "../_shared/handlers/account.ts";

Deno.serve(createMfaResetHandler(createDeps()));
