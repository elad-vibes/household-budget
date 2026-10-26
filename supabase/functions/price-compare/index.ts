// Edge Function "price-compare" — thin wrapper; the logic lives in _shared/handlers/price.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createPriceCompareHandler } from "../_shared/handlers/price.ts";

Deno.serve(createPriceCompareHandler(createDeps()));
