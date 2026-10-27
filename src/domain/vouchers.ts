// ארנק שוברים (feature 4) — pure helpers. The balance itself is kept by the database
// (0014 triggers); these only decide what to show and when to remind.

export interface Voucher {
  id: string; household_id?: string; name: string; issuer: string; initial_amount: number; balance: number;
  currency: string; expires_on: string | null; note: string; code_last4: string | null;
  payment_method_id: string | null; archived: boolean; created_at?: string;
}
export interface VoucherUse { id: string; voucher_id: string; transaction_id: string | null; amount: number; date: string; note: string }

const DAY = 86_400_000;
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/** Whole days from `today` to the expiry date (negative = expired); null = no expiry. */
export const daysToExpiry = (v: Pick<Voucher, "expires_on">, today: string) =>
  v.expires_on ? Math.round((utc(v.expires_on) - utc(today)) / DAY) : null;

/** The reminder window a voucher is in — 30 / 7 / 1 days, same rule as svc_due_notifications. */
export function reminderWindow(v: Pick<Voucher, "expires_on" | "balance" | "archived">, today: string): 30 | 7 | 1 | null {
  const d = daysToExpiry(v, today);
  if (v.archived || !(v.balance > 0) || d === null || d < 0 || d > 30) return null;
  return d <= 1 ? 1 : d <= 7 ? 7 : 30;
}

/** For the overview: vouchers with money left that expire within `days`, soonest first. */
export function expiringSoon(list: Voucher[], today: string, days = 30): (Voucher & { days: number })[] {
  return list
    .map((v) => ({ ...v, days: daysToExpiry(v, today) ?? Infinity }))
    .filter((v) => !v.archived && v.balance > 0 && v.days >= 0 && v.days <= days)
    .sort((a, b) => a.days - b.days);
}

/** Wallet order: usable with money first (by expiry, none last), then expired, used up, archived. */
export function walletOrder(list: Voucher[], today: string): Voucher[] {
  const rank = (v: Voucher) => (v.archived ? 3 : !(v.balance > 0) ? 2 : (daysToExpiry(v, today) ?? 0) < 0 ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.expires_on ?? "9999").localeCompare(b.expires_on ?? "9999") || a.name.localeCompare(b.name));
}

/** Last 4 letters/digits of a code for display; the full code is never stored. */
export const last4 = (code: string) => {
  const s = code.replace(/[^0-9A-Za-z]/g, "");
  return s.length >= 4 ? s.slice(-4) : null;
};
