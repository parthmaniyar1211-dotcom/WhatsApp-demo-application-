# Billing architecture: manual at launch, ready for per-client or per-number billing

**Decision (yours):** billing is **manual for the initial launch**; the architecture must allow **monthly billing per client or per connected number** later.
**Status: Designed. No billing code or tables exist. Nothing here changes the running system.**

## 1. Two separate money flows (do not mix them)

| Flow | Who pays whom | How it works |
| --- | --- | --- |
| **WhatsApp conversation/message charges** | The client pays **Meta** | Tech Providers have no credit line: each onboarded client adds **their own payment method** to their WhatsApp Business account (a Meta requirement, in the onboarding guide). The platform does not invoice these. |
| **Platform subscription** (this software) | The client pays **you** | Manual at launch: you invoice outside the system (bank/UPI/accounting tool). |

## 2. Manual launch: what the system does and does not do

* The admin console already shows, per client: status (active/suspended), number of connections and their state, message counts. A **billing status** is added as a plain label **only if you want it** (Designed: `tenants.billing_status = trial | active | overdue | cancelled`, edited by the platform admin, shown in the admin console, audited). It does not block anything by itself.
* Non-payment is handled by the existing, tested **suspend** control (`tenants.status`): a suspended client's login reads nothing and its inbound events are quarantined for 7 days, so a quick reactivation loses nothing.

## 3. Data model that makes later billing additive

All of this is **additive** (new tables/columns, tested down scripts); no existing table needs redesign because tenants and connections already exist as first-class rows with ids, creation dates and status history in the audit log.

| Table (Designed) | Purpose |
| --- | --- |
| `plans` | id, name, `billing_unit` (`tenant` or `connection`), `price_minor`, `currency`, `interval` (`month`), `included_connections`, `active` |
| `tenant_subscriptions` | tenant_id, plan_id, `started_at`, `ends_at`, `status`, `price_override_minor` (negotiated price), `notes` |
| `billing_events` (insert-only) | tenant_id, connection_id?, `kind` (`connection_added`, `connection_removed`, `plan_changed`, `suspended`, `reactivated`, `invoice_marked_paid`), `at`, actor, no card data |
| `usage_daily` (optional) | tenant_id, connection_id, date, inbound_count, outbound_count, counted from existing message tables by a job |

**Per client:** one subscription row per tenant, price from the plan or override. **Per connected number:** the billable quantity is the count of `whatsapp_connections` with `status in ('connected', ...)` during the period, derived from `billing_events` (`connection_added`/`removed`) so mid-month changes are provable and prorating is a policy choice, not a data problem. Both models read the same tables; switching a client between them is a plan change.

## 4. Later automation (not now)

* A monthly job produces a **draft invoice summary** (client, plan, connected numbers, period) for you to review: still no automatic charging.
* Payment collection through a processor (for example Razorpay/Stripe) can be added behind the same tables: the processor's customer/subscription ids are stored on `tenant_subscriptions`, webhooks from the processor write `billing_events`. **No card data is ever stored by this platform.** Choosing a processor, tax (GST) handling and invoice numbering rules are your decisions and need accounting advice.
* A hard entitlement check (for example "one connection per plan") would be enforced where connections are created (`admin-connections` and, in Phase 3, onboarding), reading `plans.included_connections`: one place, already server-side.

## 5. What I need from you (only when billing is wanted)

Per client or per number (or both); currency and tax treatment; whether non-payment auto-suspends or only flags; whether you want the simple `billing_status` label before launch.
