// Edge Function "fx-rates" — thin wrapper; the logic lives in _shared/handlers/fx.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createFxRatesHandler } from "../_shared/handlers/fx.ts";

Deno.serve(createFxRatesHandler(createDeps()));
