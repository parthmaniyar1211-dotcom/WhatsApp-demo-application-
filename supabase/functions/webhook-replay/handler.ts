// webhook-replay: after a routing problem is fixed (for example the right Phone Number ID was attached to a connection),
// a platform admin replays the quarantined events of that Phone Number ID through the NORMAL webhook path
// (review finding F8). The events were kept, not dropped; replaying stores them under the tenant that now owns the number.
//
// Admin only (JWT, active platform admin that has already chosen their own password). The response contains counts only:
// the quarantined payloads hold customer data and are never returned to anyone. A payload is erased as soon as its
// replay succeeds; events still unroutable stay quarantined until they expire (7 days).
//
// Request:  { "phone_number_id": "<Meta phone number id>", "limit": 100? }
// Response: { "claimed": n, "replayed": n, "still_unroutable": n, "failed": n, "tally": { stored, duplicates, ... } }

import { bearerToken, corsHeaders, HttpError, json, logError, parseJsonObject, readBody } from "../_shared/http.ts";
import type { AuditEntry } from "../admin-staff/handler.ts";
import { replayQuarantined, type WebhookDeps } from "../whatsapp-webhook/handler.ts";

export interface ReplayStaff {
  staff_id: string;
  role: string;
  disabled: boolean;
  must_change_password: boolean;
}

export interface ReplayAdminStore {
  getUserId(jwt: string): Promise<string | null>;
  getStaff(userId: string): Promise<ReplayStaff | null>;
  audit(entry: AuditEntry): Promise<void>;
}

export interface ReplayDeps {
  admin: ReplayAdminStore;
  webhook: WebhookDeps;
}

const PHONE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function createReplayHandler(deps: ReplayDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed");
      return await handle(req, deps);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status, corsHeaders);
      logError("webhook-replay failed", err);
      return json({ error: "Internal error" }, 500, corsHeaders);
    }
  };
}

async function handle(req: Request, { admin, webhook }: ReplayDeps): Promise<Response> {
  const jwt = bearerToken(req);
  const callerId = jwt ? await admin.getUserId(jwt) : null;
  if (!callerId) throw new HttpError(401, "Not signed in", "unauthenticated");
  const caller = await admin.getStaff(callerId);
  if (!caller || caller.disabled || caller.role !== "admin") throw new HttpError(403, "Admin access required", "forbidden");
  if (caller.must_change_password) {
    throw new HttpError(403, "Choose your own password before using the administration functions", "password_change_required");
  }

  const input = parseJsonObject(await readBody(req, 2048));
  const phoneNumberId = input.phone_number_id;
  if (typeof phoneNumberId !== "string" || !PHONE_ID.test(phoneNumberId)) {
    throw new HttpError(400, "phone_number_id must be the Meta phone number id", "invalid");
  }
  const limit = input.limit === undefined ? 100 : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, "limit must be 1-500", "invalid");

  const summary = await replayQuarantined(webhook, phoneNumberId, limit);
  try {
    await admin.audit({
      tenantId: null,
      actorUserId: callerId,
      action: "webhook.replay",
      target: phoneNumberId,
      detail: { claimed: summary.claimed, replayed: summary.replayed, still_unroutable: summary.still_unroutable, failed: summary.failed },
    });
  } catch (err) {
    logError("webhook-replay: audit failed", err);
  }
  console.log(`webhook-replay: ${caller.staff_id} replayed ${summary.replayed}/${summary.claimed} (still unroutable ${summary.still_unroutable}, failed ${summary.failed})`);
  return json(summary, 200, corsHeaders);
}
