# Feature – automatic weekly database backup

Verified 2026-09-27 in Supabase docs: Free plan projects get NO automatic backups ("We recommend that free tier plan projects regularly export their data using the Supabase CLI `db dump` command and maintain off-site backups").

## Build
- GitHub Actions workflow `backup.yml` in this repo: weekly (Sunday 03:00 Israel time) + manual `workflow_dispatch`.
- Steps: `supabase db dump` for schema, data (`--data-only`) and roles → quick restore test of the plain dump into a throwaway Postgres service container (row counts per table must match) → encrypt with **age** using a public key stored in the repo (`backup/age-recipient.txt`) → push the encrypted files to a separate **private** repo `elad-vibes/household-budget-backups` (date-stamped folder). Keep the last 12 weekly backups, delete older ones.
- Secrets in Actions: `SUPABASE_DB_URL` (pooler connection string with the DB password) and a fine-grained token / deploy key that can write ONLY to the backups repo. Never upload unencrypted dumps as workflow artifacts or print them in logs (this repo is public).
- The age **private** key is generated on Elad's PC, shown once, and stored by Elad (password manager + printed copy). It is never committed or stored in GitHub.
- On failure: the workflow fails loudly (GitHub e-mails Elad) and the super-admin screen shows "last successful backup: <date>" (read from a tiny status row the workflow writes via the service role).
- `RESTORE.md`: click-by-click restore for a non-developer (decrypt with age → `psql` into a new or the same project), plus how to restore a single household.
- Also note in ADMIN.md: upgrading to Supabase Pro adds daily managed backups if ever needed.

## Tests
- Workflow run once manually and verified green; restore test passes; the backups repo shows only `.age` files.
