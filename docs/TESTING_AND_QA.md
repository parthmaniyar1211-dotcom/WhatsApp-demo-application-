# Testing and QA

> Status labels: see [README.md](README.md#status-labels-used-in-all-documents).
> This document separates **three kinds of evidence**, because they are not equally strong:
> **A. automated tests that exist in the repository and can be re-run**, **B. real-world tests done against live systems**, and
> **C. results that were reported earlier in the project but could not be re-checked in this documentation session**.
> Related: [TEST_PLAN.md](../TEST_PLAN.md) · [REAL_TEST_PLAN.md](../REAL_TEST_PLAN.md) · [MESSAGE_DELETION_DOCUMENTATION.md](MESSAGE_DELETION_DOCUMENTATION.md)

## A. Automated tests (in the repository)

| Suite | Command | Where | Needs | Size (counted from the files) |
| --- | --- | --- | --- | --- |
| Backend unit tests (Deno) | `npm run test:functions` | `supabase/functions/tests/*.ts` | Deno only; no network, no database (dependencies injected) | **90** `Deno.test` cases: webhook 37, send-whatsapp 34, admin-staff 9, mark-read 6, graph 2, wa_errors 2 |
| SQL tests | `npm run test:sql` | `supabase/tests/message_delete.sql` | the **local** Supabase DB at `127.0.0.1:54322`; one transaction rolled back, no data left | 19 `pass(...)` assertions in the file |
| Browser tests (Playwright 1.63.0) | `npm run test:e2e` | `web/e2e/{inbox,features,contacts,delete}.spec.ts` | local Supabase + Edge Functions served locally with `WA_DRY_RUN=true`, Vite dev server, a fake microphone | 36 test declarations x 2 projects (`desktop` 1280x800, `phone` Pixel 7), some parameterised |
| Type check, lint, build | `npm run typecheck`, `npm run lint`, `npm run build` | `web/` | Node >= 20.12 | - |
| Function check | `npm run check:functions` | `supabase/functions` | Deno | `deno check` + `deno lint` |
| SQL sync | `npm run check:sql` | `whatsapp_setup.sql` vs migrations | Node | fails if the concatenated file drifted |
| Simulation harness | `npm run sim:all` | `scripts/*.mjs` | a running webhook, `WA_APP_SECRET` in the environment, `WA_DRY_RUN=true` for media | verify handshake, bad signature, text/image/document/audio/video/sticker/location/contacts, duplicate |

What the Deno tests cover (by file, verified by name and count only; contents read during the backend audit): webhook signature, handshake,
every message type, duplicates, statuses and the state machine, media download failures; send flow with window, rate limit, templates, media
rules, reactions, replies and error mapping; staff creation/disable rules; mark-read; Graph retry/backoff; error-code mapping.

What the browser tests cover: login, adding a contact, sending/receiving (simulated webhook calls), ticks, replies, reactions, stars, search,
quick replies, voice recording, photo/PDF attachment, dark mode, notifications, the 24 h banner, every "Delete for me" path, layout on a phone.
They use **simulated Meta payloads**; no real WhatsApp message is involved.

**Not covered by any automated test:** real Graph API calls; real delivery to a phone; token-expiry behaviour on live Meta (only the mapped error text is
unit-tested); the Pages deployment itself; multi-user concurrency; Realtime reconnection beyond one browser test; accessibility audits; load/performance; backups/restores.

### Results in this documentation session
**None of the suites above was executed during the documentation task** (the task was read-only; the local database was also not running). The
counts in the table come from reading the files. Re-run them before relying on them:
`npm run typecheck && npm run lint && npm run check:sql && npm run check:functions && npm run test:functions`, then start local Supabase and run
`npm run test:sql` and `npm run test:e2e`.

### Phase 2.1 results (2026-11-18, local stack; evidence in `docs/evidence/phase21/`)

| Suite | Result |
| --- | --- |
| Deno (`npm run test:functions`) | **148 passed, 0 failed** (adds routing for two Phone Number IDs, every quarantine reason, replay, log hygiene, 500 on quarantine failure, `complete-password-change`, `webhook-replay`, locked-admin refusals) |
| SQL `phase21_security.sql` | **38 PASS** (F1 and F8 at database level, privileges, purge, diagnostics) |
| SQL `multi_tenant.sql` / `message_delete.sql` | **92 PASS** / **25 PASS** (unchanged by Phase 2.1) |
| `scripts/probe-temp-password-local.mjs` | **23/23** (real Auth + REST + Edge Functions: a temporary-password session reads nothing and cannot unlock itself) |
| `scripts/verify-multi-tenant-local.mjs` | **117/117** (tenant isolation, multi-Phone-Number-ID routing, quarantine, replay, diagnostics) |
| Rollback rehearsal `supabase/rollbacks/rehearse_phase21_local.sh` | see `docs/PHASE2_1_SECURITY_REPORT.md` |

## B. Real-world tests (against live systems)

| Test | Result | Evidence quality |
| --- | --- | --- |
| Webhook handshake and signed delivery with Meta, real inbound text from a phone | worked earlier in the project; messages appeared in the inbox | observed by the owner/author, not re-run now |
| Real outgoing text to an allowed recipient; delivered/read ticks | worked earlier while the temporary token was valid | same |
| `wa-diagnose` (callback URL, `messages` field, WABA subscription, token check) | callback matched; `messages` subscribed; WABA subscribed to the app after `POST subscribed_apps`; token **expired** (error 190) | run live in this project; the output is not stored in the repo |
| Deploy of the web app to GitHub Pages and loading the live site | worked | observed |
| "Delete for me" on the live site and database | see C and [MESSAGE_DELETION_DOCUMENTATION.md](MESSAGE_DELETION_DOCUMENTATION.md) | scratch script outside the repo |
| Real photo, document, voice note, video, location, reaction, quote, template (`hello_world`) delivery on a phone | **not done / not verified** | - |
| Real blue ticks after the mark-read call | **not verified** after the first working period | - |
| Media download from Meta with a valid token | partly exercised earlier; not re-verified | - |

## C. Results reported earlier but not re-verified here

These figures were stated at the end of the implementation sessions. They are recorded as claims, not as facts established by this audit:

| Reported result | Where it came from | Why it is unverified now |
| --- | --- | --- |
| **78** browser checks passing (desktop + phone) | Playwright run at the end of the deletion work | the suites were not re-run; the count of declarations (36) times 2 projects is 72 plus parameterised cases, which is plausible but not proven |
| **25** SQL checks passing | `npm run test:sql` against the local DB | the file contains 19 `pass(...)` calls; the discrepancy is unexplained and the DB was down |
| **90** backend tests passing | `npm run test:functions` | the **count of 90 matches** the files, but a pass was not re-run now |
| **24** live deletion checks passing | a scratch script outside the repository, run against the hosted project | script not in the repo; cannot be re-run from the repo |

## D. How to test safely

- Never point `test:sql`, the simulators or the e2e tests at the hosted project; they write data. Use `supabase start` locally (`scripts/local-create-admin.mjs` creates a local login).
- Keep `WA_DRY_RUN=true` locally so nothing reaches Meta.
- For anything live, use the test number and an allowed recipient, and note what you created so it can be cleaned up with approval.
- Do not paste tokens into test output; the harness reads them from the environment and redacts.

## E. Regression checklist before any change is merged

1. `npm run typecheck`, `npm run lint`, `npm run build`
2. `npm run check:sql` (and `--fix` only if you changed a migration; then document it)
3. `npm run check:functions`, `npm run test:functions`
4. Local DB up: `npm run test:sql`
5. `npm run test:e2e` (desktop and phone)
6. If the change touches deletion, search, previews or flags: read [MESSAGE_DELETION_DOCUMENTATION.md](MESSAGE_DELETION_DOCUMENTATION.md) and re-run the delete suites
7. If it touches the webhook or sending: `npm run sim:all` against a local function
8. Only then ask for approval to deploy ([DEPLOYMENT_AND_OPERATIONS.md](DEPLOYMENT_AND_OPERATIONS.md))

## E2. Update after Phase 2 (2026-11-16)
- **The "25 SQL checks" figure is explained:** `npm run test:sql` produces **25 result rows** for the delete suite; counting `select pg_temp.pass(` lines with a text search gave 19 because some calls span several lines. It was re-run on the migrated schema: 25/25.
- New automated suites, all run locally in Phase 2: `supabase/tests/multi_tenant.sql` (92 checks, one rolled-back transaction), Deno tests now **134** (was 90), `scripts/verify-multi-tenant-local.mjs` (100 real-HTTP checks), `web/e2e/tenancy.spec.ts` (4 tests x 2 projects). Full browser suite: 86 tests, first run 85 passed, 1 failed with a transient "name resolution failed" from the local Edge runtime; the same test passed 3 of 3 reruns. Details: [PHASE2_IMPLEMENTATION_REPORT.md](PHASE2_IMPLEMENTATION_REPORT.md), [MULTI_TENANT_SECURITY.md](MULTI_TENANT_SECURITY.md).
- Local testing needs Docker (`dockerd`), the Supabase CLI and Deno; see the danger note in [AI_DEVELOPER_CONTEXT.md](AI_DEVELOPER_CONTEXT.md) about the hosted `.env` files.

## F. Real-world acceptance script (for the owner, with a valid token)

Send from the app to an allowed number: text; photo; PDF; voice note; reply; reaction; `hello_world` after 24 h. From the phone, send text,
photo, voice, location, contact, reaction; check the ticks; delete one message for me and Undo; reload. Record each result with a date; until
this has been done, those features stay "Tested locally" and not "Tested live".
