// Edge Function "notify" — thin wrapper; the logic lives in _shared/handlers/notify.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createNotifyHandler } from "../_shared/handlers/notify.ts";

Deno.serve(createNotifyHandler(createDeps()));
