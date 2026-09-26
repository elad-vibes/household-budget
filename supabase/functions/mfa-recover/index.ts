// Edge Function "mfa-recover" — thin wrapper; the logic lives in _shared/handlers/account.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createMfaRecoverHandler } from "../_shared/handlers/account.ts";

Deno.serve(createMfaRecoverHandler(createDeps()));
