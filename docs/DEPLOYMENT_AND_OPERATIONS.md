# Deployment and operations

> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). **Nothing in this document was executed during the
> documentation task**; it describes how the system was deployed and how to operate it. Project reference, URLs and keys are placeholders.
> Rule: no deploy, push, migration, secret or Meta change without the owner's approval ([AI_DEVELOPER_CONTEXT.md](AI_DEVELOPER_CONTEXT.md)).
> Related: [BACKEND_DOCUMENTATION.md](BACKEND_DOCUMENTATION.md) · [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) · [SECURITY_DOCUMENTATION.md](SECURITY_DOCUMENTATION.md)

## 1. What is deployed where

| Part | Host | How it gets there | Status |
| --- | --- | --- | --- |
| Web app (static) | GitHub Pages (Pages source = GitHub Actions) | workflow `.github/workflows/deploy-web.yml` on push to `ccr-929f1931-uztnem` or `main` when `web/**` or the workflow changes, or manually (`workflow_dispatch`) | Tested live |
| Database, Auth, Storage, Realtime | Supabase project `<PROJECT_REF>` (Postgres 17.11) | SQL migrations applied by hand (see 3) | Tested live |
| Edge Functions (5) | same Supabase project | deployed with the Supabase CLI or Management API | Tested live (code parity with the repo **not byte-compared**) |
| WhatsApp webhook registration | Meta developer dashboard | manual; callback `https://<PROJECT_REF>.supabase.co/functions/v1/whatsapp-webhook` | Tested live |
| Test harness | local machine only | `scripts/*.mjs` | - |

Function JWT settings (`supabase/config.toml`): `whatsapp-webhook` **verify_jwt = false** (Meta calls it; HMAC protects it); `send-whatsapp`,
`admin-staff`, `mark-read`, `wa-diagnose` verify_jwt = true (plus in-code staff/admin checks).

## 2. Web app

- Build: `npm run build` (Vite, `base: "./"` so it works under the repository sub-path). Env vars at build time: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (both public). They are written in the workflow file; changing the project means editing it.
- Pipeline: checkout -> Node 22 -> `npm ci` in `web/` -> build -> upload `web/dist` -> deploy-pages. `concurrency: pages` cancels older runs.
- Note: because the workflow filters on `web/**`, a change that touches only `docs/` or `supabase/` does **not** redeploy the site. Pushing documentation therefore triggers nothing.
- Rollback: re-run an older successful workflow run, or `git revert` and push (needs approval).
- `web/public/_headers` is ignored by GitHub Pages (see security doc).

## 3. Database migrations

1. Write a new file in `supabase/migrations/` with the next timestamp (idempotent: `create ... if not exists`, `create or replace`, guarded `alter`).
2. Run `node scripts/check-sql-sync.mjs --fix` to regenerate `whatsapp_setup.sql`; commit both.
3. Test locally: `supabase start` (applies migrations), `npm run test:sql`, `npm run test:e2e`.
4. **Production (approval required):** the existing four migrations were applied through the Supabase Management API SQL endpoint (or SQL editor), not `supabase db push`, so the hosted project has **no migration history table**. Before using `db push` for the first time, register versions 20261114000000 - 20261117000000 as applied (`supabase migration repair --status applied <version>`) or it will try to re-run them.
5. Before and after, compare a hash/count of `wa_messages` and `conversations` (done for the deletion migration) and verify new functions in `pg_proc` and grants in `information_schema.routine_privileges`.
6. Document the migration in [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) (migration table) in the same change.
7. Rollback is hand-written per migration (none are auto-reversible); prefer additive migrations.

## 4. Edge Functions

- Deploy one function: `supabase functions deploy <name> --project-ref <PROJECT_REF>` (add `--no-verify-jwt` only for `whatsapp-webhook`; the CLI may require `--use-api` when Docker is unavailable and `--yes` to skip prompts, as found during the build).
- The function code is `supabase/functions/<name>/index.ts`; shared code in `_shared/` is bundled automatically.
- Secrets: `supabase secrets set NAME=value --project-ref <PROJECT_REF>` or the dashboard. List names (not values) with `supabase secrets list`. Required: `WA_TOKEN`, `WA_PHONE_ID`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`; optional: `WA_BUSINESS_ACCOUNT_ID`, `WA_GRAPH_VERSION`, `WA_MEDIA_MODE`, `WA_DRY_RUN`, `STAFF_EMAIL_DOMAIN`. **Never set `WA_DRY_RUN=true` on production** (messages would be faked).
- After deploy: call `wa-diagnose` (admin) and run the GET handshake check (`scripts/verify-webhook.mjs`), then send one test message to an allowed number.

## 5. Meta configuration (manual, in Meta's dashboard)

Callback URL + verify token; subscribe the `messages` field; WABA subscribed to the app (`POST /<WABA_ID>/subscribed_apps`, available as the opt-in
`wa-diagnose` action); recipient allow-list for the test number; token refresh (see [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md)). Not automated and not stored in the repo.

## 6. Environments

| Environment | Purpose | Notes |
| --- | --- | --- |
| Local | development and all automated tests | `supabase start` (DB 54322, API 54321, Studio 54323), Vite on 5173; functions served with `WA_DRY_RUN=true`; local npm cache seeding may be needed behind a TLS-intercepting proxy |
| Hosted ("production") | the only real environment | Supabase project + Pages + Meta test number; there is **no staging** |

## 7. Operating the system

| Task | How |
| --- | --- |
| Refresh the WhatsApp token | Supabase secret `WA_TOKEN` (see WhatsApp doc) - first thing to check if sending shows "token expired" |
| Add/disable a login | `admin-staff` function (admin) |
| Check the webhook | `wa-diagnose` as admin; Meta dashboard -> Webhook |
| Read logs | Supabase dashboard -> Edge Functions -> Logs (names, counts, codes; no content). Scripted access through the Management API logs endpoint **failed** during the audit, so it is unverified |
| Find a message that failed | the failed bubble shows the mapped reason; the raw reason is in `wa_messages.error` |
| Inspect data safely | Studio/SQL editor read-only queries; do not edit rows by hand |
| Clean test data | only with approval, only rows you created |

## 8. Monitoring, backups, scaling (all **unverified**)

- Monitoring/alerting: none configured that this audit could see.
- Backups: Supabase plan-dependent daily backups / PITR - **not verified for this project**; no restore has been tested; Storage objects are not part of a database backup.
- Capacity: one small Supabase instance; Realtime and function limits depend on the plan; the 20/min per-user send limit and Meta limits apply.
- Costs: Supabase plan, GitHub Pages (free), Meta conversation pricing once on a real number (not verified here).

## 9. Disaster recovery sketch

Rebuild: create a Supabase project; apply `whatsapp_setup.sql`; create the admin (`admin-staff` or the local script equivalent); set secrets; deploy the five functions; set the webhook
in Meta; update `VITE_SUPABASE_*` in the workflow. Message history is only recoverable from Supabase backups (unverified).

## 10. Git state at the time of writing

Branch `ccr-929f1931-uztnem`, latest commit `c4eb38e` (Delete for me ...), pushed and deployed after the owner's approval. The `docs/` folder is
**untracked and not committed or pushed**; the owner decides when.
