# Android device test checklist (for you, on your physical phone)

> The APK does not exist yet (Phase 5). This checklist is prepared now so the tests are agreed before the build. **Nothing here has been run.** A cloud session has no phone, camera, microphone or push-capable device, so
> every result below must be recorded by a person on a real device. Until a line is ticked with a date, the feature stays "Implemented in code, **not verified on a device**".
> Use the **Meta test number and allowed test recipients only**; do not message real customers; do not onboard a real client.
> Related: [TESTING_AND_QA.md](TESTING_AND_QA.md) · [FIREBASE_AND_NOTIFICATIONS.md](FIREBASE_AND_NOTIFICATIONS.md) · [MULTI_TENANT_SECURITY.md](MULTI_TENANT_SECURITY.md)

**Setup:** phone model and Android version: ______ ; app build / version / date: ______ ; backend: local or staging (never production data you cannot lose); a second client login for isolation tests; a valid WhatsApp token for the test number (the temporary one expires about daily).

Mark each: **P** pass, **F** fail (write what you saw), **N/A**. Record a screenshot for every fail.

## A. Install and sign in
| # | Check | Result |
| --- | --- | --- |
| A1 | Install the debug APK (allow installing from this source). App name, icon and splash show the CosmiConnect brand, not WhatsApp's | |
| A2 | Sign in with **Staff ID + temporary password**; forced "Choose your password" screen appears; short or mismatched passwords are refused | |
| A3 | After changing the password the inbox opens; sign out and sign in again with the new password | |
| A4 | Wrong Staff ID and wrong password give the **same** message | |
| A5 | Disabled login (disable it from the admin console): cannot sign in; an open session stops reading and sending | |
| A6 | Admin login: console opens (or inbox with an Administration menu entry); a client login has **no** Administration entry | |
| A7 | Switch accounts: sign out as client A, sign in as client B on the same phone: **no data of A is visible**, no A notifications arrive | |

## B. Permissions (the app must ask only when needed, and work when refused)
| # | Check | Result |
| --- | --- | --- |
| B1 | Camera permission asked on first camera use; **Deny** shows a clear message and the rest of the app works | |
| B2 | Microphone permission asked on first recording; Deny shows a clear message | |
| B3 | Notification permission (Android 13+) asked after sign-in; Deny explained | |
| B4 | **No location permission** is requested anywhere; Settings -> Apps -> permissions lists **no Location** | |
| B5 | After "Don't ask again", the app points to system settings instead of failing silently | |

## C. Messages (test number, allowed recipient)
| # | Check | Result |
| --- | --- | --- |
| C1 | Add a contact by number; the chat opens; first message uses the template when outside the 24-hour window | |
| C2 | Send text and an emoji; it appears with one grey tick, then two, then blue when read on the other phone | |
| C3 | Receive text from the other phone: appears live with the app open; unread badge increments | |
| C4 | Reply (quote), react with an emoji, star, copy, search; **Delete for me** + Undo; reload: still deleted | |
| C5 | "Delete for everyone" is shown as unavailable and explains why (the Cloud API has no such operation) | |

## D. Camera, gallery, files
| # | Check | Result |
| --- | --- | --- |
| D1 | Camera photo: capture, preview, add caption, send; the other phone receives it; thumbnail correct in both | |
| D2 | Camera video (short): capture, preview, send (10 MB limit); plays on the other phone | |
| D3 | Gallery photo and video; several at once where supported; captions | |
| D4 | PDF, DOCX, XLSX attach: file name, size and type shown; unsupported type and oversize (photo > 5 MB, other > 10 MB) refused **before** upload with a clear message | |
| D5 | Open and download a received document and photo; media never opens via a public link | |

## E. Voice notes (highest priority)
| # | Check | Result |
| --- | --- | --- |
| E1 | Press-and-hold records; timer and waveform move; release sends (or lock to continue) | |
| E2 | Cancel while recording discards it; preview before send; delete the recording | |
| E3 | Sent voice note **plays on the other phone as a voice note** (OGG/Opus accepted by Meta) | |
| E4 | Receive a voice note: play, pause, progress bar, duration | |
| E5 | Ordinary audio file attachment is separate from a voice note | |
| E6 | Interruptions: incoming call, switching apps and rotating the phone during recording do not lose or corrupt the recording | |

## F. Notifications
| # | Check | Result |
| --- | --- | --- |
| F1 | App in background: a customer message shows a notification (no message text unless previews are enabled); tapping opens **that** conversation | |
| F2 | App killed (swiped away): notification still arrives and opens the chat | |
| F3 | Phone locked: lock screen shows no private content | |
| F4 | Client B's phone gets **nothing** for client A's messages | |
| F5 | Token-expiry / disconnected-number alert reaches the owner (once built) | |

## G. Lifecycle and resilience
| # | Check | Result |
| --- | --- | --- |
| G1 | Background and foreground: the list and open chat catch up (nothing missed) | |
| G2 | Restart the phone, then open the app: still signed in, data present | |
| G3 | Airplane mode while open: offline banner; sent messages show failed or wait as designed; turn it off: everything syncs | |
| G4 | Weak network (mobile data, then Wi-Fi switch) while sending | |
| G5 | Back button: closes dialogs, then leaves a chat, then the app; never signs out by accident | |
| G6 | Install a newer APK over the old one (upgrade): data and sign-in kept | |
| G7 | Battery saver on: notifications and sync still work (note any manufacturer restrictions) | |
| G8 | Light and dark theme; text readable; large font setting does not break layouts | |

## H. Coexistence (only when real onboarding is approved, not before)
| # | Check | Result |
| --- | --- | --- |
| H1 | Business Phone in the WhatsApp Business app (version 2.24.17 or newer): client completes Embedded Signup; contacts and history sync within 24 hours | |
| H2 | A message sent from the WhatsApp Business app appears in the app (echo); a message sent from the app appears in the Business app | |
| H3 | A customer edits (within 15 minutes) or deletes (within two days) a message: the app reflects it (needs Phase 4) | |

**Sign-off:** tester ______ ; date ______ ; build ______ ; open failures ______ .
