# Feature – payment methods + no double counting

Problem: a receipt or manual expense paid by card will ALSO arrive in the monthly card statement → counted twice. Cash never appears in any statement.

## Data
- New table `payment_methods` per household: type (`cash` | `credit_card` | `debit_card` | `bank_transfer` | `standing_order` | `bit_paybox` | `other`), label ("מקס של שלי"), issuer (Max/Isracard/Cal/Amex/Diners/bank name), last4 (optional, 4 digits only – never a full number), owner person_id, active. RLS like other household tables + tests.
- `transactions.payment_method_id` (nullable) and `transactions.match_status` (`none` | `awaiting_statement` | `matched` | `unmatched_after_statement`), `matched_transaction_id`.
- Statement imports (Excel/CSV/photo) are tagged with the payment method (ask once per import; remember per file source; auto-detect from last4/issuer in the file when possible).

## Adding an expense (manual or receipt photo)
- Required quick choice "איך שילמת?" with chips: מזומן · <each saved card> · ביט/פייבוקס · העברה · אחר. Remember the person's last choice as default.
- Receipt photos: the extraction prompt also returns payment method hints ("אשראי ****1234", "מזומן", "ויזה") → prefill the chip, user confirms.
- Cash → counted immediately as an expense.
- Card / bit / transfer → saved with `match_status = awaiting_statement`: shown in the month with a "ממתין לפירוט" badge and counted ONCE.

## Matching when a statement is imported
- For each awaiting item: same payment method (or same issuer), amount equal (±1₪, or exact installment amount), date within −2…+5 days, merchant fuzzy match → auto-merge: keep ONE transaction (statement amount/date are the source of truth; keep receipt category, note, line items, person). Show a summary: "3 קבלות הותאמו לפירוט, 1 לא נמצאה".
- Ambiguous (several candidates) → review screen with suggested pairs; user confirms.
- After the statement for that month is imported and an item is still unmatched → `unmatched_after_statement`, surfaced in "לבדוק".
- Bank statements: ATM withdrawals = category "משיכת מזומן" (a transfer to cash, NOT an expense). Bit/PayBox transfers in the bank statement match against awaiting bit items the same way.

## Insights
- Overview card "מזומן": cash withdrawn this month vs cash expenses logged → "₪400 במזומן בלי פירוט".
- Split of spending by payment method (per card), useful for spotting which card carries what.
- Fixed expenses can be linked to a payment method ("ביטוח בריאות – הוראת קבע בבנק").

## Tests
- RLS for payment_methods; unit tests for the matcher (exact, ±days, installments, two candidates, no candidate, refunds); E2E: add cash receipt + card receipt → import synthetic statement → card receipt merged, cash stays, totals not doubled.
