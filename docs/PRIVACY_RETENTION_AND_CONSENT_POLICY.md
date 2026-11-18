# Privacy, retention, consent and deletion policy (design and what is implemented)

**Status legend:** **Implemented** = in code and tested locally. **Designed** = specified here, built in Phase 3. **Needs legal review** = wording and
jurisdiction questions that are for a lawyer, not for engineering. This document is an engineering policy, not legal advice.

## 1. Roles

| Party | Role for end-customer chat data |
| --- | --- |
| The client business (tenant) | Data controller: decides why the chats are processed. |
| This platform | Data processor for the client; controller for its own account, audit and security data. |
| Meta (WhatsApp Cloud API) | Independent processor/controller under its own terms. |
| Supabase | Sub-processor (hosting, storage). |

Needs legal review: processor agreement text, sub-processor list, data-subject-request handling per country (India DPDP Act, and any client in the EU/UK).

## 2. What is stored, where, and for how long

| Data | Where | Who can read | Retention (default) | Status |
| --- | --- | --- | --- | --- |
| Messages, conversations, contact names and numbers | `wa_messages`, `conversations` | The tenant's own logins; platform admin only through audited admin functions, no bulk message view | Until the client deletes them or the contract ends (then section 5) | Implemented |
| Media files | private Storage bucket, path per tenant | Tenant's own logins via signed URLs | Same as the message that owns them | Implemented |
| WhatsApp access tokens | Supabase Vault, one secret per connection; reference column hidden from clients | Edge Functions with the service role only; never returned to any browser | Deleted on disconnect/revoke | Implemented |
| Routing ledger (`webhook_events`) | table, metadata only: ids, outcome, reason | Platform admin (diagnostics) | **30 days**, purged hourly | Implemented (Phase 2.1) |
| **Quarantined webhook events** (events that could not be routed) | `webhook_quarantine`, contains the original payload = customer data | **Nobody except the service role**: no admin or client SELECT, diagnostics show counts only | **7 days**; payload erased the moment a replay succeeds | Implemented (Phase 2.1) |
| Audit log | `audit_logs`, insert-only | Platform admin (all), tenant (its own) | 2 years (Designed; a purge job is Phase 3 work) | Implemented, retention Designed |
| Push device tokens | `push_devices` | Owner of the device row | Until sign-out/uninstall or 60 days unseen (Designed) | Implemented, purge Designed |
| Logs (Edge Function logs) | Supabase | Platform operator | Supabase's own window | Implemented: logs carry ids and reasons, **never message text or customer numbers** (tested) |

Suspended clients (finding F9): inbound messages for a suspended tenant are **not discarded and not stored in the tenant's inbox**; they go to the quarantine (7 days, service-role only) so a reactivation within a week can replay them, after which they are erased automatically.

## 3. Consent for chat-history synchronization (Coexistence) — Designed, Phase 3

When a client links a number that is already used in the WhatsApp Business app, Meta can send up to 180 days of history through the Coexistence synchronization. Meta also requires that the business owner chooses whether to share it during onboarding. The platform adds its own, separate, explicit consent:

1. **Default is OFF.** History is never requested unless the client ticks the consent box on our onboarding page, and Meta's own sync choice is also made by the client in Meta's flow.
2. **Plain-language text**, shown before launching Meta's flow, stating: what is copied (up to 180 days of chats and contacts of this number), where (the platform's Supabase project, region X), who can read it (the client's own team; the platform operator only as support when asked, and the access is logged), how long it is kept, and how to delete it.
3. **Consent record** (`consent_records` table, Designed): tenant id, connection id, the signed-in user id who agreed, timestamp, the exact text version, and the choice (`history_sync = granted|declined`). Insert-only; withdrawal is a new row.
4. **Enforcement in code, not just text:** the history-sync webhook handler checks the latest consent row for the connection; with no `granted` row it **drops those history events immediately**, records a ledger reason `history_not_consented` and stores nothing. The 24-hour Meta deadline for requesting sync is therefore a client decision made at onboarding, not something support can do later without them.
5. **Declining is valid:** the number works for new messages without any history.
6. **Withdrawal:** the client can withdraw in Settings. New history is no longer accepted; already imported history is deleted on request (section 5) or kept if the client prefers, and the choice is recorded.

## 4. Principles applied in the code today

* **Minimization:** the routing diagnostics and logs hold ids, counts and reasons only (verified by tests that search diagnostics and logs for message text and customer numbers).
* **Isolation:** every row carries a `tenant_id`; policies derive the tenant from `auth.uid()` in the database (tested: 117 integration checks, 92 + 25 + 38 SQL checks).
* **No credentials in the browser or in logs:** tokens live in Vault; the service-role key lives only in Edge Function secrets.
* **Temporary passwords cannot reach data** until the user chooses their own (Phase 2.1, F1).

## 5. Deletion

| Request | What happens | Status |
| --- | --- | --- |
| Client deletes a message "for me" | Hidden for that login only (existing feature) | Implemented |
| Client asks to delete a customer's chat | Tenant-scoped delete of conversation, messages and their files | Designed (admin function, audited) |
| Client disconnects a number | Token deleted from Vault at once; data stays unless deletion is requested | Implemented (token); data deletion Designed |
| Client leaves the platform | 30-day grace period (export available), then tenant data and files are hard-deleted, audit rows are kept without personal content | Designed |
| End customer asks the client to erase their data | Client uses the chat deletion above; the platform completes it within 30 days | Designed |
| Quarantined and ledger data | Automatic: 7 and 30 days | Implemented |
| Backups | Supabase backups age out on their own schedule (documented in `BACKUP_AND_ROLLBACK_PLAN.md`); deleted data can persist in backups until they expire | Needs legal review for the stated period |

Deletion is verified by a test per path before it ships (the quarantine and ledger purge are covered by `phase21_security.sql`).

## 6. Things I will not do without your decision

Choosing the retention periods in the table as final, the 2-year audit period, the 30-day grace period, and the region. They are proposals.
