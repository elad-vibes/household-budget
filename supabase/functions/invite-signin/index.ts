// Edge Function "invite-signin" — thin wrapper; the logic lives in _shared/handlers/invite.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createInviteHandler } from "../_shared/handlers/invite.ts";

Deno.serve(createInviteHandler(createDeps()));
