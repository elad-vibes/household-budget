export const FIXTURES: string;
export function luhn(digits: string): boolean;
export function israeliId(digits: string): boolean;
export function scanText(text: string, opts?: { path?: string; names?: string[]; envValues?: { key: string; value: string }[] }): { kind: string; value: string }[];
export function scanPath(path: string): { kind: string; value: string }[];
