# Email import + share-to-app (Expensify-style) — build AFTER design-brief.md

## Goal
Families forward bills/receipts by email (or share a photo from WhatsApp) and they land in the existing receipt pipeline as `review` transactions. No new AI pipeline: reuse receipt_jobs / Message Batches / quotas / usage_ledger / payment-methods matcher.

## 1. Per-household inbound address
- Each household gets a secret address: `<slug>-<random 10 chars>@<inbound domain>`. Shown in "הבית והגדרות" with a copy button and a "צור כתובת חדשה" (rotate) button for the owner.
- Table `inbound_addresses` (household_id, local_part unique, active, created_at, rotated_at). RLS: members read, owner rotates.
- Inbound provider: prefer **Cloudflare Email Routing + Email Worker** (free) posting to an Edge Function; alternative **Brevo Inbound Parsing** (already have Brevo). Needs a domain with MX records — ask Elad ONCE, step-by-step, copy-paste DNS records. Record choice in DECISIONS.md.
- Edge Function `inbound-email`: verify shared secret/signature from the worker/provider, look up address, reject unknown/inactive.

## 2. Who may send (abuse / quota protection)
- Accept automatically when the sender is a household member's email, or Gmail's `X-Forwarded-For` / envelope sender is a member, or From is in the household's approved-senders list.
- Anything else → "ממתין לאישור שולח" in the app (sender, subject, date, attachment count). Nothing is sent to AI until a member approves ("אשר תמיד" adds to approved senders / "דחה").
- Gmail forwarding confirmation mails (forwarding-noreply@google.com) are NOT processed by AI: show the confirmation code/link in the app so the user can finish Gmail setup. <!-- scan-ok: public Google address, not a person -->

## 3. Processing
- Attachments: PDF, JPEG, PNG, HEIC (convert), ≤5MB each, ≤10 per email, ≤30 emails/day per household. Email body with no attachment: extract text of HTML invoice body if it looks like a bill; otherwise ignore.
- Submit immediately as a Message Batch (Haiku, same prompt as receipts; PDFs as document blocks). Quota enforced before submit; over quota → hold in `inbound_pending` until next period. Store nothing longer than needed: payload held only until batch submission (private bucket, auto-delete ≤24h), never logged.
- Results → transactions `source='email'`, status `review`, note = sender + subject. Run the payment-methods matcher (bill vs later card charge = no double count). Dedup by (household, sender, invoice number/amount/date).
- Links-only bills (portal link, no attachment): create a review item "חשבון בלי קובץ – להזין ידנית" with the sender and amount if found in text.

## 4. Bill insights (reuse analysis)
- Recurring biller up vs last period ("בזק עלה ב-12%"), expected bill missing this month, and a comparison link from the whitelisted LINKS catalog when a bill rises.

## 5. Share photos into the app
- Android: Web Share Target in the manifest (POST multipart → service worker → existing IndexedDB receipt queue). App appears in WhatsApp/Gallery "Share" sheet.
- iPhone (PWAs have no share target): in-app help card — WhatsApp → long-press photo → Share → Mail → household address (saved as a contact "קבלות הבית"), or Save to Photos → pick in app.
- No WhatsApp bot (Business API cost/complexity) — record in DECISIONS.md.

## Tests
Inbound signature rejection, unknown address, unapproved sender held, member auto-accepted, Gmail confirmation surfaced, attachment limits, quota hold, dedup, RLS on new tables, share-target E2E on Android emulation.

## Elad's steps
Put them in SETUP.md "like to a five-year-old": numbered, one action per step, copy-paste blocks (DNS records, Gmail filter + forwarding, iPhone contact).
