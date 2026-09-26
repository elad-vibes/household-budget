// Supabase client. Only the PUBLISHABLE (anon) key ever reaches the browser;
// it is public by design and every table is protected by RLS.
import { createClient, FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const configured = !!(URL_ && KEY);

export const sb: SupabaseClient = createClient(URL_ || "https://example.invalid", KEY || "missing", {
  auth: {
    flowType: "pkce",          // magic link returns ?code=… (the hash is ours, for routing)
    persistSession: true,      // long-lived sessions: no code on every open
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "hb2-auth",
  },
});

/** Where magic links should land (the app root, whatever the base path is). */
export const appUrl = () => location.origin + import.meta.env.BASE_URL;

/** Calls an Edge Function and turns its Hebrew error message into an Error. */
export async function invoke<T = any>(name: string, body: unknown): Promise<T> {
  const { data, error } = await sb.functions.invoke(name, { body: body as Record<string, unknown> });
  if (error) {
    let msg = "משהו השתבש בתקשורת עם השרת. כדאי לנסות שוב.";
    let code = "error";
    let extra: any = {};
    if (error instanceof FunctionsHttpError) {
      try {
        extra = await error.context.json();
        msg = extra.message || msg;
        code = extra.error || code;
      } catch { /* not JSON */ }
    }
    throw Object.assign(new Error(msg), { code, extra });
  }
  return data as T;
}

/** Hebrew message for a PostgREST / RPC error. */
export function dbMessage(e: any): string {
  const m = String(e?.message ?? "");
  if (/not_owner/.test(m)) return "רק בעלי משק הבית יכולים לעשות את זה (ואחרי אימות דו-שלבי).";
  if (/last_owner/.test(m)) return "צריך להשאיר לפחות בעלים אחד במשק הבית.";
  if (/use_delete_household/.test(m)) return "אתם האחרונים במשק הבית. אפשר למחוק את משק הבית במקום לעזוב.";
  if (/too_many_invites/.test(m)) return "יש יותר מדי הזמנות פתוחות. אפשר לבטל חלק מהן.";
  if (/invite_used/.test(m)) return "ההזמנה כבר שימשה להצטרפות.";
  if (/invite_other_email/.test(m)) return "ההזמנה נשלחה לכתובת מייל אחרת.";
  if (/invite_invalid/.test(m)) return "ההזמנה לא תקינה או שפג תוקפה.";
  if (/aal2_required|mfa/.test(m)) return "צריך קודם להזין קוד מאפליקציית האימות.";
  if (/row-level security|permission denied|42501/.test(m + e?.code)) return "אין הרשאה לפעולה הזאת.";
  if (/JWT|session/i.test(m)) return "צריך להתחבר מחדש.";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "אין חיבור לאינטרנט כרגע.";
  return "השמירה נכשלה. כדאי לנסות שוב.";
}
