# Documentation index

Technical knowledge base for the **WhatsApp Web-style application** in this repository: a web chat app that sends and
receives WhatsApp messages through Meta's official WhatsApp Business **Cloud API**, with Supabase as the backend.

These documents were written from an audit of the repository and of the deployed system (read-only) on 2026-11-15/16.
Every file path, function name, column and constant named here was checked against the source or the live database.
Where something could not be verified, the text says so.

## Status labels used in all documents

| Label | Meaning |
| --- | --- |
| **Implemented** | The code exists in the repository. |
| **Tested locally** | Covered by an automated test that ran against a local Supabase stack (see [TESTING_AND_QA.md](TESTING_AND_QA.md)). |
| **Tested live** | Observed working on the deployed site / hosted Supabase project / real WhatsApp. |
| **Configured, unverified** | Set up, but nobody has proven it works end to end. |
| **Pending** | Not done. |
| **Unsupported by API** | The Meta Cloud API does not offer it. |

## The documents

| # | Document | Read it to learn... |
| --- | --- | --- |
| 1 | [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | What the app is, in plain language; status, what is done and pending. |
| 2 | [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | How all the parts fit together, with seven flow diagrams. |
| 3 | [FRONTEND_DOCUMENTATION.md](FRONTEND_DOCUMENTATION.md) | The React app: components, hooks, state, features. |
| 4 | [BACKEND_DOCUMENTATION.md](BACKEND_DOCUMENTATION.md) | The five Edge Functions: inputs, outputs, errors, environment. |
| 5 | [DATABASE_DOCUMENTATION.md](DATABASE_DOCUMENTATION.md) | Tables, security policies, SQL functions, migrations, ER diagram. |
| 6 | [WHATSAPP_API_INTEGRATION.md](WHATSAPP_API_INTEGRATION.md) | The Meta side: app, test number, tokens, permissions, error codes. |
| 7 | [WEBHOOK_DOCUMENTATION.md](WEBHOOK_DOCUMENTATION.md) | How Meta's webhook is verified and processed; debugging. |
| 8 | [MESSAGE_AND_MEDIA_DOCUMENTATION.md](MESSAGE_AND_MEDIA_DOCUMENTATION.md) | Every message type, media flow, what has been tested. |
| 9 | [MESSAGE_DELETION_DOCUMENTATION.md](MESSAGE_DELETION_DOCUMENTATION.md) | Delete for me (built) and Delete for everyone (not possible). |
| 10 | [SECURITY_DOCUMENTATION.md](SECURITY_DOCUMENTATION.md) | Controls that exist and controls that are missing. |
| 11 | [TESTING_AND_QA.md](TESTING_AND_QA.md) | Test suites, commands, verified results, what is only reported. |
| 12 | [DEPLOYMENT_AND_OPERATIONS.md](DEPLOYMENT_AND_OPERATIONS.md) | Local setup, deploying, token renewal, rollback, troubleshooting. |
| 13 | [KNOWN_ISSUES_AND_ROADMAP.md](KNOWN_ISSUES_AND_ROADMAP.md) | Current problems and a prioritised improvement plan. |
| 14 | [AI_DEVELOPER_CONTEXT.md](AI_DEVELOPER_CONTEXT.md) | One-file briefing for a future AI coding agent, with rules. |

### Multi-tenant platform and Android (Phase 2 onward, 2026-11-16)

| # | Document | Read it to learn... |
| --- | --- | --- |
| 15 | [MULTI_TENANT_ANDROID_PLAN.md](MULTI_TENANT_ANDROID_PLAN.md) | The Phase 0 audit, Phase 1 plan, phases and decisions. |
| 16 | [MULTI_TENANT_ARCHITECTURE.md](MULTI_TENANT_ARCHITECTURE.md) | The multi-tenant system as built: data model, routing, tokens, admin and staff. |
| 17 | [MULTI_TENANT_MIGRATIONS.md](MULTI_TENANT_MIGRATIONS.md) | The four new migrations, data-preservation proof, hosted deployment plan. |
| 18 | [MULTI_TENANT_SECURITY.md](MULTI_TENANT_SECURITY.md) | Security model, every attack tested, Vault limits, key backup and recovery. |
| 19 | [META_TECH_PROVIDER_REQUIREMENTS.md](META_TECH_PROVIDER_REQUIREMENTS.md) | What Meta requires (read from Meta's pages): Tech Provider, Embedded Signup v5, Coexistence, edit/revoke. |
| 20 | [FIREBASE_AND_NOTIFICATIONS.md](FIREBASE_AND_NOTIFICATIONS.md) | Push architecture and exactly what you must configure. |
| 21 | [ANDROID_DEVICE_TEST_CHECKLIST.md](ANDROID_DEVICE_TEST_CHECKLIST.md) | The checklist for your physical-phone tests. |
| 22 | [PHASE2_IMPLEMENTATION_REPORT.md](PHASE2_IMPLEMENTATION_REPORT.md) | What Phase 2 delivered, results, limits, what needs your approval. |

### Phase 2 review pack (2026-11-16)

| # | Document | Read it to learn... |
| --- | --- | --- |
| 23 | [PHASE2_WALKTHROUGH.md](PHASE2_WALKTHROUGH.md) | Admin and Staff dashboards with screenshots, the onboarding flow, and how connections are isolated. |
| 24 | [MIGRATION_AND_POLICY_REVIEW.md](MIGRATION_AND_POLICY_REVIEW.md) | Review of the four migrations and every policy; ranked findings F1-F12. |
| 25 | [VAULT_BOUNDARY_AND_RECOVERY.md](VAULT_BOUNDARY_AND_RECOVERY.md) | The Vault boundary and token recovery strategy, sourced from Supabase's documentation. |
| 26 | [BACKUP_AND_ROLLBACK_PLAN.md](BACKUP_AND_ROLLBACK_PLAN.md) | Backup plan, the tested down-migration, decision tree and window runbook. |
| 27 | [REAL_CLIENT_ONBOARDING_READINESS.md](REAL_CLIENT_ONBOARDING_READINESS.md) | Every blocker to real clients, and which features need which Meta approval. |
| 28 | [PHASE3_PLAN_EMBEDDED_SIGNUP_COEXISTENCE.md](PHASE3_PLAN_EMBEDDED_SIGNUP_COEXISTENCE.md) | The Phase 3 plan (not started). |
| 29 | [PHASE2_FINAL_REVIEW.md](PHASE2_FINAL_REVIEW.md) | **The consolidated Phase 2 review**: status register (verified / not fully tested / pending / blocked by Meta / needs your action), evidence from fresh runs in `docs/evidence/`, screenshots, security, migrations, Vault, rollback, blockers, Phase 3 plan. |
| 30 | [PHASE2_1_SECURITY_REPORT.md](PHASE2_1_SECURITY_REPORT.md) | **Phase 2.1 security report**: F1 and F8 fixed locally, evidence, rollback rehearsal, what is not done. |
| 31 | [SCRATCH_PROJECT_REHEARSAL.md](SCRATCH_PROJECT_REHEARSAL.md) | How to rehearse migrations and rollbacks on a separate hosted scratch project (guarded script). |
| 32 | [META_VERIFICATION_PREPARATION.md](META_VERIFICATION_PREPARATION.md) | Business Verification, Tech Provider and App Review readiness checklist (nothing submitted). |
| 33 | [ONBOARDING_PAGE_DESIGN.md](ONBOARDING_PAGE_DESIGN.md) | Design of our branded HTTPS page that launches Meta's Embedded Signup (not built). |
| 34 | [PRIVACY_RETENTION_AND_CONSENT_POLICY.md](PRIVACY_RETENTION_AND_CONSENT_POLICY.md) | Retention, history-sync consent and deletion policy. |
| 35 | [BILLING_ARCHITECTURE.md](BILLING_ARCHITECTURE.md) | Manual billing now; per-client / per-number billing later. |

## Which document first?

| You want to... | Start with |
| --- | --- |
| Understand the project without technical background | 1 PROJECT_OVERVIEW |
| Change the code as a developer or AI agent | **14 AI_DEVELOPER_CONTEXT**, then 2 and the area you touch |
| Fix a UI problem | 3 FRONTEND |
| Fix sending, receiving or an Edge Function | 4 BACKEND, 7 WEBHOOK |
| Change the database | 5 DATABASE (and migrations rules in 14) |
| Messages are not arriving / sending fails | 12 DEPLOYMENT (troubleshooting), 7 WEBHOOK, 6 WHATSAPP_API |
| Work on photos, voice notes, documents | 8 MESSAGE_AND_MEDIA |
| Work on deleting messages | 9 MESSAGE_DELETION |
| Review security | 10 SECURITY |
| Run or add tests | 11 TESTING |
| Deploy, renew the token, roll back | 12 DEPLOYMENT |
| Plan the next features or go to production | 13 KNOWN_ISSUES_AND_ROADMAP, 6 (production migration) |

## Other documentation in the repository (not replaced by `docs/`)

| File | Content |
| --- | --- |
| `README.md` | Setup from zero, commands, hosting notes, backend contract for a future Android app. |
| `TEST_PLAN.md` | Manual test without a phone (simulated webhook, dry run). |
| `REAL_TEST_PLAN.md` | Manual test with a real phone. |
| `DECISIONS.md` | Chronological log of design decisions and bugs fixed (parts 1-5). |

## Security note

No credential appears in these documents. Identifiers that are secrets (tokens, App Secret, verify token, passwords,
the service role key) are never written down; identifiers such as the Meta Phone Number ID and the Supabase project
reference are shown as placeholders like `<PHONE_NUMBER_ID>` and `<PROJECT_REF>`.
