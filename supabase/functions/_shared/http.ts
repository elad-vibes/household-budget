// HTTP plumbing shared by every Edge Function: CORS pinned to the app origin,
// JSON in/out, Hebrew error messages, and no request payloads in logs.
import type { Deps } from "./deps.ts";
import { LIMITS } from "./config.ts";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    public messageHe: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

export type Handler = (req: Request) => Promise<Response>;

/**
 * Wraps a function body: OPTIONS preflight, POST only, origin allow-list,
 * body size limit, error → JSON. `fn` returns the JSON body for 200.
 */
export function endpoint(
  deps: Deps,
  name: string,
  fn: (req: Request, body: any) => Promise<unknown>,
  opts: { allowNoOrigin?: boolean; maxBytes?: number } = {},
): Handler {
  return async (req: Request) => {
    const started = Date.now();
    const origin = req.headers.get("origin");
    const headers = corsHeaders(origin, deps.env.allowedOrigins);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: origin && headers["Access-Control-Allow-Origin"] ? 204 : 403, headers });
    }
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed", "שיטה לא נתמכת.");
      if (origin && !headers["Access-Control-Allow-Origin"]) throw new HttpError(403, "origin_not_allowed", "הבקשה לא הגיעה מהאפליקציה.");
      if (!origin && !opts.allowNoOrigin && deps.env.requireOrigin) {
        throw new HttpError(403, "origin_required", "הבקשה לא הגיעה מהאפליקציה.");
      }
      const body = await readJson(req, opts.maxBytes ?? 256 * 1024);
      const out = await fn(req, body);
      deps.log(name, { status: 200, ms: Date.now() - started });
      return json(out, 200, headers);
    } catch (e) {
      if (e instanceof HttpError) {
        deps.log(name, { status: e.status, code: e.code, ms: Date.now() - started });
        return json({ error: e.code, message: e.messageHe, ...e.extra }, e.status, headers);
      }
      // Never log the payload or the error object (it may echo user data).
      deps.log(name, { status: 500, code: "internal", kind: (e as Error)?.name ?? "Error", ms: Date.now() - started });
      return json({ error: "internal", message: "משהו השתבש בשרת. כדאי לנסות שוב בעוד רגע." }, 500, headers);
    }
  };
}

export async function readJson(req: Request, maxBytes = LIMITS.maxRequestBytes): Promise<any> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "too_large", "הקבצים גדולים מדי לשליחה אחת.");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "too_large", "הקבצים גדולים מדי לשליחה אחת.");
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "bad_json", "הבקשה לא תקינה.");
  }
}

/** Constant-time string comparison (for the cron secret). */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
