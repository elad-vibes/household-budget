// Edge Function "capture" — thin wrapper; the logic lives in _shared/handlers/capture.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createCaptureHandler } from "../_shared/handlers/capture.ts";

Deno.serve(createCaptureHandler(createDeps()));
