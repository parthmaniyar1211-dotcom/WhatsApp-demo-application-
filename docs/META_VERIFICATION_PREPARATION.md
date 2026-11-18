# Preparing for Meta Business Verification, Tech Provider eligibility and App Review

**Status: preparation only.** I have **not changed any Meta setting, submitted anything, or contacted Meta.** Every action below that changes
Meta's side is marked **YOU** and waits for your explicit approval. Facts come from Meta's pages read on 2026-11-16
(`docs/evidence/09_sources_read.txt`; details in `META_TECH_PROVIDER_REQUIREMENTS.md`). Meta changes these pages: re-read them on the day you submit.

## 1. The path (what Meta requires)

1. **Business Verification** of your business in Meta Business Suite/Settings (legal name, address, phone, email, website; documents if Meta cannot match the business). It must be complete **before** App Review.
2. **App settings for review**: app icon, **privacy policy URL**, app category, and (for Embedded Signup) the domain registered in the app.
3. **App Review for Advanced access** to `whatsapp_business_messaging` and `whatsapp_business_management`: a written explanation of how each permission is used for onboarded clients, plus **screen-recorded videos** (a message created and sent from the app and received in WhatsApp; creating a message template).
4. **Tech Provider onboarding** (App Dashboard > Use cases > WhatsApp > Customize > Tech Provider onboarding). Limit until fully approved: 10 new business customers per rolling 7 days (Meta's number on the pages read).
5. Your clients add **their own payment method** (no credit line for Tech Providers).
6. The existing **Meta Test Number cannot be onboarded through Embedded Signup**; it stays a test connection (as you decided).

## 2. Readiness checklist

| Item | Needed for | State | Owner |
| --- | --- | --- | --- |
| Legal business name, registration number, address, phone, email that **match your official documents exactly** | Business Verification | Unknown to me | YOU |
| Official documents (registration certificate, utility bill/bank statement as Meta asks) | Business Verification | Unknown | YOU |
| A business **website on your own domain**, showing the business name and address, over HTTPS | Business Verification, App Review | Not created (current site is a GitHub Pages demo) | YOU (domain), me (pages) |
| **Privacy policy** page at a public URL describing this platform | App settings, App Review | Draft content exists (`PRIVACY_RETENTION_AND_CONSENT_POLICY.md`), **not published**, needs legal review | YOU + lawyer, me (page) |
| **Terms of service** page | App Review (recommended), client contracts | Not written | YOU + lawyer |
| **Data deletion instructions** URL or callback | App settings | Designed (`PRIVACY_...` section 5) | me after your approval |
| App icon (1024x1024), app name, category | App settings | Branding decided; icon file not prepared for Meta | me (asset), YOU (upload) |
| Domain for the onboarding page and its HTTPS | Embedded Signup | Not chosen | YOU |
| Test accounts / a working demo of the app for the review videos | App Review | The inbox app works (tested); a clean demo script is needed | me (script), YOU (record or approve me preparing it) |
| Written permission-use explanations | App Review | Draft below | me, YOU approve |
| Meta Business portfolio admin access for the person submitting | All | Unknown | YOU |

## 3. Draft permission-use explanations (for your review; not submitted)

* **`whatsapp_business_messaging`:** "Our platform lets each of our client businesses send and receive WhatsApp messages with their own customers from a shared team inbox. After a client connects their own WhatsApp Business number through Embedded Signup, the client's staff read incoming customer messages and reply, send approved template messages, and send media. Each client's data is isolated from every other client."
* **`whatsapp_business_management`:** "We use it to onboard a client's WhatsApp Business Account through Embedded Signup, subscribe our webhook to that account, read the connected phone number's status and quality information, and manage message templates on behalf of the client, so the client can operate their number from our inbox."

Do not request more than these; Meta states unnecessary permissions are a common rejection reason.

## 4. What the video must show (script I can prepare after your approval)

1. A client business account in the platform, with the onboarding page (Embedded Signup launch), the consent screen, and the connected state.
2. An incoming WhatsApp message appearing in the inbox, and a reply sent from the inbox arriving on a real phone.
3. A message template being created (in WhatsApp Manager, which Meta accepts) and used.
4. The privacy policy, data-deletion path, and tenant isolation explained in the narration.

Because the Test Number's temporary token is expired, recording needs a fresh token or a real number: **YOU**, after you decide.

## 5. Risks and honest unknowns

* Business Verification can be rejected or need resubmission; timelines are Meta's, not ours. Meta's stated App Review turnaround (about 24 hours on the page I read) is not a promise.
* **Access Verification** is named on the pages I read only as a condition for raising the limit from 10 to 200 new customers per 7 days; its definition was not on those pages. Check the live dashboard.
* Whether Coexistence is available in your clients' countries/numbers must be checked against Meta's current requirements at onboarding time.
* Whether your business structure qualifies as a Tech Provider vs. a Solution Partner is Meta's decision; I only prepare the evidence.

## 6. Proposed order (nothing starts without your approval)

1. You: confirm legal entity details and the domain. 2. Me: publish privacy policy/terms/deletion pages on that domain (after legal review) and prepare the icon and demo script. 3. You: start Business Verification. 4. You: configure the app (domain, privacy URL) in the Meta dashboard. 5. Me: prepare the review submission text and videos. 6. You: submit App Review. 7. Phase 3 build runs in parallel behind `FEATURE_EMBEDDED_SIGNUP=false`, tested against Meta's test tools.
