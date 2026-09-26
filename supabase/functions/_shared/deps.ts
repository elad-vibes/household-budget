// Everything a handler needs from the outside world. The real implementation
// lives in supabaseDeps.ts (Deno); tests pass fakes.
import type Anthropic from "@anthropic-ai/sdk";
import type { Models } from "./config.ts";

export interface Claims {
  sub: string;
  email?: string;
  aal?: string;   // 'aal1' | 'aal2'
  role?: string;  // 'authenticated'
}

export interface Deps {
  env: {
    allowedOrigins: string[];
    requireOrigin: boolean;
    cronSecret: string;
    appUrl: string;
    models: Models;
    vapidPublicKey?: string;
    vapidPrivateKey?: string;
    vapidSubject?: string;
  };
  /** Verifies a user access token; null when invalid/expired. */
  verifyJwt(token: string): Promise<Claims | null>;
  /** Calls a Postgres function with the service role. Throws on error. */
  rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T>;
  anthropic: Anthropic;
  admin: {
    createUser(email: string): Promise<"created" | "exists">;
    deleteUser(userId: string): Promise<void>;
    /** Verified + unverified TOTP/WebAuthn factor ids (not recovery codes). */
    listFactorIds(userId: string): Promise<string[]>;
    deleteFactor(userId: string, factorId: string): Promise<void>;
  };
  /** Called by poll-batches with the households whose receipts are ready (Phase 2: push). */
  onReceiptsReady?(done: { household_id: string; submitted_by: string | null; parsed: number }[]): Promise<void>;
  /** HTTP client for Web Push (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Structured, payload-free logging. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  now(): Date;
}
