# Known issues and roadmap

> Status labels: see [README.md](README.md#status-labels-used-in-all-documents). **Nothing below is marked complete unless code or a test
> supports it** (the "Evidence" column says which). Nothing here has been started as part of the documentation task.
> Related: [SECURITY_DOCUMENTATION.md](SECURITY_DOCUMENTATION.md) · [TESTING_AND_QA.md](TESTING_AND_QA.md) · [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md)

Each item lists: **status now**, **why it is useful**, **dependencies**, **complexity** (S/M/L) and **order** within its priority.
Complexity is a rough author estimate, not a measurement.

## Priority 1 - Must do to make the live system dependable

| # | Item | Status now (evidence) | Why useful | Depends on | Complexity | Order |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 | Valid `WA_TOKEN` (new temporary token, later a System User token) | **Pending.** Sends fail with error 190 (live diagnostic). Permanent token deliberately **not** configured (owner decision) | Sending, mark-read and media download all need it | Owner access to Meta | S (temporary) / M (System User) | 1 |
| 1.2 | Real-phone acceptance run: photo, PDF, voice, video, location, reaction, quote, template, blue ticks | **Pending.** Only simulated payloads tested; see TESTING section B | Turns "Tested locally" into "Tested live" for the most visible features | 1.1, a phone on the allow-list | S | 2 |
| 1.3 | Rotate the admin password and revoke the Supabase access token that was shared in chat | **Pending** | Both appeared in conversation text | Owner | S | 3 |
| 1.4 | Hosted Auth settings: `password_min_length` 6 -> >= 8, `site_url` localhost:3000 -> Pages URL | **Pending** (observed live) | Weak passwords; wrong redirect base | Owner approval (settings change) | S | 4 |
| 1.5 | Backups: confirm plan, enable PITR/daily backups, test one restore | **Unverified** | Message history is the product's data | Owner/plan | M | 5 |

## Priority 2 - Important for production readiness

| # | Item | Status now | Why useful | Depends on | Complexity | Order |
| --- | --- | --- | --- | --- | --- | --- |
| 2.1 | Production WhatsApp number, business verification, app Live mode | **Pending** (out of scope: test number kept on purpose) | Removes the allowed-recipient restriction | Business docs, Meta review | L (mostly waiting) | 1 |
| 2.2 | Approved message templates + template picker beyond `hello_world` | **Pending**: code supports a fixed allow-list with only `hello_world` (`send-whatsapp`) | Only way to start chats after 24 h | 2.1 (or test-number templates) | M | 2 |
| 2.3 | Security headers / CSP (GitHub Pages ignores `_headers`) | **Pending**: `_headers` exists but is not applied | Clickjacking/sniffing defence | Host change (Cloudflare/Netlify) or `<meta>` CSP | M | 3 |
| 2.4 | Monitoring and alerts (webhook 401/5xx, send failures, token expiry) | **Pending**: none verified; log API scripting failed | Token expiry is currently discovered by a user seeing failures | Log access | M | 4 |
| 2.5 | Restrict CORS on functions to the Pages origin | **Pending**: wildcard today (`_shared/http.ts`) | Defence in depth | Know the final origin | S | 5 |
| 2.6 | Explain/remove `rls_auto_enable()` (anon-executable, not in migrations) | **Pending**, origin unverified | Unknown anon-callable definer function | Supabase support/docs check | S | 6 |
| 2.7 | Migration history on the hosted project (`migration repair`) | **Pending**; no history table | Allows safe `db push` | CLI access | S | 7 |
| 2.8 | Re-run all suites in CI (GitHub Actions) | **Pending**: the workflow only builds and deploys; tests are run by hand | Catches regressions before deploy | Local Supabase in CI | M | 8 |
| 2.9 | Status events that arrive before the message row exists are dropped | **Pending / known gap** (webhook counts them `ignored`) | Rare lost ticks on slow sends | none | M | 9 |

## Priority 3 - Product improvements

| # | Item | Status now | Why useful | Depends on | Complexity | Order |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 | Delete whole chat / clear chat for me | **Pending**; not in code | Matches WhatsApp; same per-user flag pattern | none (new migration) | M | 1 |
| 3.2 | Send location, contacts, stickers | **Pending**; incoming only | Parity with WhatsApp Web | Graph payload work | M | 2 |
| 3.3 | Message edit/revoke events (coexistence only) | **Unsupported by API** for this setup | - | Meta | - | - |
| 3.4 | Delete for everyone | **Unsupported by API** | - | Meta adding an endpoint | - | - |
| 3.5 | Typing indicator with read receipt | **Pending**; Cloud API supports it, not implemented | Nicer customer experience | none | S | 3 |
| 3.6 | Multi-agent features (assignment, labels, notes) | **Partially present in DB only** (`assigned_to`, `notes`, `labels`, `take/release`, `update_conversation_info`); **no UI by owner's request** | Teams | Owner decision (owner asked for no staff UI) | M | 4 |
| 3.7 | Contact import/export, merging, avatar photos | **Pending** | Contacts are rows keyed by phone | none | M | 5 |
| 3.8 | Bulk actions (multi-select delete/star) | **Pending** | Convenience | 3.1 | M | 6 |
| 3.9 | Full-text search with ranking (`pg_trgm`/tsvector) | **Pending**: ILIKE today (adequate for small data, slow on large) | Scale | migration | M | 7 |
| 3.10 | Cleanup of unused code: `take/release`, labels, `hidden` UI | **Pending**; see FRONTEND doc "unused but present" | Less surface | Owner decision | S | 8 |

## Priority 4 - Longer term / nice to have

| # | Item | Status now | Why useful | Depends on | Complexity | Order |
| --- | --- | --- | --- | --- | --- | --- |
| 4.1 | Accessibility audit (WCAG 2.1 AA), screen-reader pass | **Pending**; not audited | Inclusive use | none | M | 1 |
| 4.2 | Internationalisation | **Pending**; English only | Wider use | none | M | 2 |
| 4.3 | Retention policy and data export / erasure on request | **Pending**; messages kept forever, "Delete for me" is a view setting | Privacy compliance | Legal input | L | 3 |
| 4.4 | Audit log of staff actions | **Pending**; only `sent_by` and `hidden_at` exist | Accountability | migration | M | 4 |
| 4.5 | Performance: pagination of very long chats, virtualised lists | **Pending**; untested at scale (no load test) | Large histories | measurement first | M | 5 |
| 4.6 | Staging environment | **Pending**; none exists | Safe live testing | second Supabase project | M | 6 |
| 4.7 | Mobile apps / PWA install and push notifications | **Pending**; browser notifications only | Reach | HTTPS origin, service worker | L | 7 |
| 4.8 | Chatbot / auto-replies / broadcast | **Pending**; not started | Automation | 2.1, 2.2, policy | L | 8 |

## Known issues (observed, not features)

| Issue | Impact | Workaround | Status |
| --- | --- | --- | --- |
| Temporary token expires about daily | Sends and media download fail with "token expired" | Replace `WA_TOKEN` | Open (by decision) |
| Test number can only message allowed recipients (131030) | Cannot message arbitrary numbers | Add recipients in Meta | Open (by design of test number) |
| `_headers` not applied on GitHub Pages | No security headers | none | Open |
| Hosted password min length 6, `site_url` localhost | Weak policy, wrong redirects | Owner changes in dashboard | Open |
| Doc discrepancy: reported 25 SQL checks vs 19 `pass()` calls in file | Unclear test count | Re-run `npm run test:sql` | Open |
| Deployed functions not byte-compared with the repo | Unknown drift | Re-deploy from repo with approval, or diff via CLI | Unverified |
| No migration history table on hosted | `db push` unsafe | `migration repair` | Open |
| Webhook status before row exists is ignored | Rare missing ticks | none | Open |
| Account-level Meta errors only logged as codes | Hard to diagnose | read function logs | Open |

## Items that cannot be completed by documentation or code alone

Meta business verification, template approval, production-number registration, payment setup, and backup plan choices need the owner in Meta's and Supabase's dashboards.

## Phase 2.1 status (2026-11-18)

Closed locally, awaiting your approval to deploy: F1 (server-side mandatory password change), F3 (ledger/quarantine retention), F8 (no silent webhook loss). Still open: F2 (require WABA id on connections), F4, F5, F6, F7 (accepted), F12 (hosted `rls_auto_enable()` investigation). The hosted project does not yet have the Phase 2 or Phase 2.1 migrations.
