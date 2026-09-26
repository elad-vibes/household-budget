export function loadEnv(file?: string): Record<string, string>;
export function need(env: Record<string, string>, ...keys: string[]): void;
export function projectRef(env: Record<string, string>): string;
export function redact(env: Record<string, string>, text: unknown): string;
