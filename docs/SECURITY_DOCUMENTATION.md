# Security documentation

> **Phase 2 notice (2026-11-16):** this document describes the single-tenant baseline. Shared-inbox visibility and the global WA_TOKEN are replaced by tenant isolation and per-connection Vault tokens; see MULTI_TENANT_SECURITY.md.


> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). No secret value is written here, only names and
> where each lives. Related: [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) · [WEBHOOK_DOCUMENTATION.md](WEBHOOK_DOCUMENTATION.md) ·
> [KNOWN_ISSUES_AND_ROADMAP.md](KNOWN_ISSUES_AND_ROADMAP.md)

## 1. Trust boundaries

| Zone | Holds | Trusted? |
| --- | --- | --- |
| Browser (GitHub Pages) | public Supabase URL, **anon key**, the user's session | **No** - everything there is visible to the user |
| Supabase Auth / PostgREST / Storage | enforcement: JWT, RLS, storage policies | Yes |
| Edge Functions | service-role key, `WA_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN` (as secrets) | Yes |
| Meta | sends signed webhooks, receives Graph calls | External; verified by signature |

The anon key is **public by design** and is committed in `.github/workflows/deploy-web.yml` so that the Pages build can embed it
(the same value ends up in the JS bundle). It grants nothing beyond what RLS allows an unauthenticated caller, which is nothing
(no table grants for `anon`). The service-role key, `WA_*` secrets and the Supabase access token are **never** in the repository or
the browser; the audit found none in tracked files (a repository-wide secret scan was not run with a dedicated tool; see 8).

## 2. Secrets inventory (names only)

| Secret | Where stored | Used by | Notes |
| --- | --- | --- | --- |
| `WA_TOKEN` | Supabase Edge Function secret | send, mark-read, webhook media download, diagnostics | currently a temporary token (expires about daily) |
| `WA_APP_SECRET` | Supabase secret | webhook HMAC | missing -> webhook returns 503 |
| `WA_VERIFY_TOKEN` | Supabase secret + Meta form | webhook GET handshake | |
| `WA_PHONE_ID`, `WA_BUSINESS_ACCOUNT_ID` | Supabase secret | send / diagnostics | identifiers, not credentials, but treated as private |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` | injected by Supabase | functions | service role bypasses RLS: functions only |
| `STAFF_EMAIL_DOMAIN` | Supabase secret/env | `admin-staff` | synthetic login domain |
| Supabase access token (PAT) | the owner's own tooling; was given to the build session in chat | deployment/management only | **Recommend revoking and re-issuing** after the project settles; it was pasted into a conversation |
| Admin password | owner | login | was displayed once in a chat during development; **rotate it** and do not reuse |

Local `.env` and `web/.env` are git-ignored (verified with `git check-ignore`). Scripts read secrets from the environment and never print them.

## 3. Authentication

- Supabase Auth email + password. Staff log in with a **staff ID** that the app maps to a synthetic e-mail (`<ID>@<STAFF_EMAIL_DOMAIN>`); the UI does not show roles, "staff" or "admin".
- Sign-ups are disabled in `supabase/config.toml` (`enable_signup = false`; **hosted value unverified**). New users are created by the `admin-staff` function (admin only).
- A valid session is **not enough**: every policy and RPC also calls `is_active_staff()`, so a disabled user loses access on the next request.
- JWT expiry 3600 s locally; hosted value not verified.
- Hosted Auth settings observed: `password_min_length` **6** (weak; the local config says 8) and `site_url` `http://localhost:3000` (should be the Pages URL). Both are in the roadmap.
- No MFA, no login-attempt monitoring beyond Supabase defaults.

## 4. Authorisation matrix

| Capability | anon | authenticated, non-staff or disabled | active staff | admin | service role (functions) |
| --- | --- | --- | --- | --- | --- |
| Read conversations/messages/quick replies/staff list | no | no | **all** (shared inbox) | all | all |
| Read own flags and read positions | no | no | own only | own only | all |
| Send messages (`send-whatsapp`) | no | no | yes (rate-limited) | yes | - |
| Create/disable staff (`admin-staff`) | no | no | no | yes | - |
| Run diagnostics (`wa-diagnose`) | no | no | no | yes | - |
| Write tables directly | no | no | **no** | no | via RPCs |
| Webhook ingest | via signature only | | | | yes |

## 5. Controls by layer

**Database.** RLS on all six tables; `authenticated` has SELECT only; every write is a `SECURITY DEFINER` function with `search_path = ''`
that checks `is_active_staff()`; ingest/outgoing/status/reaction functions are executable by `service_role` only; no triggers. Verified from the live catalog.

**Storage.** Bucket `files` is private; read requires active staff; upload only into `outgoing/<own uid>/`; mime allow-list and 16 MiB limit at the bucket;
signed URLs: 1 h for the browser, 10 min for Meta. File names are sanitised (`safeFilename`) and stored under random/uuid names.

**Edge Functions.**
- Webhook: HMAC-SHA256 over the raw body, constant-time comparison, fails closed, 1 MiB cap, never logs bodies/numbers.
- `send-whatsapp`: JWT checked by code, active-staff check, strict input validation (16 KiB body, length caps), media path restricted to the caller's own folder, 24 h window, 20 msgs/min/user, CORS wildcard (see 7).
- `admin-staff` / `wa-diagnose`: admin only; diagnostics never return token values (only presence, expiry and scopes).
- Logs contain counts, ids and error codes; never tokens, message text or phone numbers.

**Frontend.** React escapes output; a search of `web/src` found **no** `dangerouslySetInnerHTML`; links to maps/files are built from validated values; only the anon key is bundled.

**Transport.** HTTPS everywhere (Supabase, GitHub Pages, Graph).

## 6. Threats considered

| Threat | Mitigation | Status |
| --- | --- | --- |
| Forged webhook | HMAC + fail closed | Tested locally |
| Replayed webhook | unique `wa_message_id`, idempotent status machine | Tested locally |
| Staff reads someone else's flags | RLS own-row | Tested locally (SQL, two users) |
| Direct table write from the browser | no policies/grants | Tested locally and live (401/403) |
| Malicious file name / path traversal | sanitised names, uuid paths, path-prefix check | Tested locally |
| Oversized body / file | caps at function, bucket and webhook | Tested locally |
| SQL injection | RPC parameters only; `%`, `_` and `\` escaped in `search_messages` (verified in the migration) | Implemented; no dedicated injection test beyond RPC use |
| Spam through the app | 20/min/user | Tested locally |
| Token leak | secrets only in Supabase; scripts redact | Implemented (no scanner run) |
| Clickjacking / sniffing | `web/public/_headers` sets `X-Frame-Options`, `nosniff`, `Referrer-Policy` **but GitHub Pages ignores `_headers`**, so these are **not applied** | Known gap |
| Brute-force login | Supabase built-in rate limits only | Configured, unverified |

## 7. Known weaknesses (summary; owners and order in the roadmap)

1. Temporary `WA_TOKEN` (expires); permanent System User token not configured - by decision, not an oversight.
2. Hosted `password_min_length` = 6, `site_url` = localhost:3000.
3. Security headers not delivered on GitHub Pages; no CSP.
4. Credentials (PAT, admin password) were exposed in chat during development - rotate them.
5. `rls_auto_enable()` exists on the hosted DB, executable by `anon`; origin unknown (see DATABASE doc).
6. CORS on functions is `Access-Control-Allow-Origin: *` (`_shared/http.ts`). The code comment argues this is safe because auth is a bearer JWT, not a cookie; that holds, but it means any website can call the functions if it has a valid token. Acceptable now; restrict to the Pages origin before production.
7. No monitoring/alerting, no verified backups, no audit log of staff actions beyond `sent_by` and `hidden_at`.
8. No dedicated secret scanning run; `run_secret_scanning` (GitHub) was not executed in this documentation task.
9. All active staff see all chats (shared-inbox design); there is no per-agent isolation.
10. Single-region, single-instance; no DDoS protections beyond Supabase/GitHub defaults.

## 8. Security checklist before real customer data

- [ ] Rotate admin password, revoke the Supabase PAT used during the build, set a System User token.
- [ ] Raise password policy to >= 8 (or 12) characters; set Auth `site_url` and redirect URLs to the Pages origin.
- [ ] Serve the app from a host that sends the headers in `_headers` (Cloudflare Pages, Netlify) or add a CSP `<meta>`.
- [ ] Review/justify or remove `rls_auto_enable`.
- [ ] Enable Supabase backups/PITR, test a restore; add log-based alerts for webhook 401/5xx and `send-whatsapp` failures.
- [ ] Run a secret scanner on the repository history.
- [ ] Restate the data-retention and privacy policy (messages are stored indefinitely; "Delete for me" does not erase data).
