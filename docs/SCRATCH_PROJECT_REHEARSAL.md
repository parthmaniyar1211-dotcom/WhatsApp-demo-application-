# Scratch project: rehearsing migrations and rollbacks before production

**Status:** script and runbook **Implemented**, guards **Tested locally**. The rehearsal itself has **not** run on a hosted scratch project:
creating one needs your decision (see section 6). Nothing here touches the production project.

## 1. Why a separate project

Everything in Phase 2 and 2.1 was rehearsed on a local Docker Supabase. That proves the SQL, but not the hosted platform:
the managed Vault key, the pooler, the extension versions, the roles Supabase manages for you, and the Edge Function runtime
can behave differently. A throw-away hosted project closes that gap **without risking the production database**.

## 2. What the scratch project is for

| Question | How it is answered |
| --- | --- |
| Do all migrations apply cleanly on a hosted Postgres of the same version? | `scripts/rehearse-on-scratch-project.sh` applies them in order to an empty project. |
| Do the SQL suites pass there (92 + 25 + 38 checks)? | The script runs all three. |
| Does the Phase 2.1 rollback work, refuse when it should, and roll forward to the identical schema? | The script runs the down script twice and compares schema signatures. |
| Does Vault work on the hosted platform (create, read, delete a secret from a service-role function)? | Manual step 4 below. |
| Do the Edge Functions run there against the migrated schema? | Manual step 5 below (deploy to the scratch project only). |
| Does a restore of production-like data into the migrated schema preserve it? | Manual step 6 below, needs your approval because it copies data. |

## 3. Safety rules (enforced by the script, not by memory)

* The script refuses unless both `SCRATCH_DB_URL` and `SCRATCH_PROJECT_REF` are set and `--i-confirm-this-is-a-scratch-project` is passed.
* It refuses if the ref equals the production project ref (hard-coded, plus the ref in `supabase/.temp/linked-project.json`), or if the URL mentions production at all.
* It refuses if the URL does not belong to the stated ref, or if the target already has application tables (it only builds into an **empty** project).
* All guards run before any connection is opened. Evidence of each refusal: `docs/evidence/phase21/07_scratch_script_guards.txt`.
* The database password stays in your shell environment. The script never prints it or writes it to a file. Its report folder (`scratch-rehearsal-report/`) holds schema signatures only.

## 4. Runbook

1. **Create the project (you).** In the Supabase dashboard create a new, empty project named like `whatsapp-inbox-scratch`, in the same region and with the same Postgres version as production. Do **not** link this repository to it (`supabase link` would overwrite `supabase/.temp/linked-project.json`). Note its ref and the database password.
2. **Dry run.**
   `SCRATCH_DB_URL=… SCRATCH_PROJECT_REF=… scripts/rehearse-on-scratch-project.sh --i-confirm-this-is-a-scratch-project --dry-run` shows what it would apply and proves the guards accept your project and still refuse production.
3. **Rehearse the migrations and rollbacks.** Same command without `--dry-run`. Expected: every line `PASS`, final line `SCRATCH REHEARSAL: ALL CHECKS PASSED`.
4. **Vault on the hosted platform.** In the scratch project's SQL editor run `select public.store_connection_token(...)` through a service-role request (or the admin-connections function once deployed there) and confirm that a secret is created, replaced and deleted, and that `anon` and `authenticated` cannot read `vault.decrypted_secrets`. Record the result in the report.
5. **Functions.** `supabase functions deploy <name> --project-ref <scratch-ref>` for the Phase 2.1 functions, with scratch-only secrets (`WA_DRY_RUN=true`, a dummy `WA_APP_SECRET`). Run `scripts/verify-multi-tenant-local.mjs` and `scripts/probe-temp-password-local.mjs` after pointing them at the scratch URL (they refuse anything that is not `127.0.0.1`/`localhost`; add a deliberate, reviewed override for the scratch ref if you want to run them there, and never for production).
6. **Production-like data (optional, needs your explicit approval).** Take a logical dump of production's `public` schema and `storage.objects` metadata only (not `auth` secrets), restore it into the scratch project **before** the Phase 2 migrations, then run steps 3-5. This proves the backfill of the Owner (test) tenant on a copy of the real data. Vault secrets are encrypted with a per-project key: a restored secret cannot be decrypted in another project (see `docs/VAULT_BOUNDARY_AND_RECOVERY.md`), which is correct and expected for a rehearsal. Delete the scratch project afterwards, because it then holds a copy of customer data.
7. **Tear down.** Delete the scratch project when finished. It costs nothing while paused, but it must not live on holding copied customer data.

## 5. What a pass means, and what it does not

A pass means the SQL, the guards and the rollback are correct on the hosted platform. It does not prove Meta behavior (the scratch project has no WhatsApp connection), load behavior, or the Phase 3 flows.

## 6. What I need from you

Either (a) create the scratch project and give me its ref and a database connection string through the secure credential prompt (never in chat), or (b) tell me to wait. Until then the rehearsal evidence is local only (`docs/evidence/phase21/`).
