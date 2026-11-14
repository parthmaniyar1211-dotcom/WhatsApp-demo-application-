// Turns Meta / WhatsApp Cloud API error codes into messages staff can act on.
//
// Source: Meta "WhatsApp error codes" (documentation/business-messaging/whatsapp/support/error-codes)
// and the Graph API error reference. Meta's advice is to rely on the numeric code, never the title.
// The code is always appended, e.g. "... (code 131047)", so it can be looked up.

const MESSAGES: Record<number, string> = {
  // Authorization
  0: "WhatsApp access token is invalid. An admin must set a new WA_TOKEN.",
  190: "WhatsApp access token has expired or is invalid. An admin must set a new WA_TOKEN.",
  3: "The WhatsApp access token is not allowed to do this. Check the app's permissions.",
  10: "The WhatsApp access token is missing a permission (whatsapp_business_messaging).",
  // Throttling
  4: "WhatsApp rate limit reached. Wait a minute and try again.",
  80007: "WhatsApp rate limit reached for this business account. Wait a minute and try again.",
  130429: "WhatsApp rate limit reached. Wait a minute and try again.",
  131048: "WhatsApp is limiting this number because of spam reports. Try again later.",
  131056: "Too many messages to this customer in a short time. Wait a little and try again.",
  // Integrity / account
  368: "This WhatsApp account is temporarily blocked for policy violations.",
  130497: "This business account may not message customers in that country.",
  131031: "The WhatsApp business account is locked. An admin must check it in Meta Business Manager.",
  131042: "WhatsApp payment problem on the business account. An admin must check billing in Meta.",
  131045: "The WhatsApp phone number is not registered correctly (certificate problem).",
  131057: "The WhatsApp business account is in maintenance mode. Try again in a few minutes.",
  133010: "The business phone number is not registered on the WhatsApp Business Platform.",
  // Sending
  131000: "WhatsApp had a temporary problem. Try again.",
  131005: "WhatsApp refused access. Check the token's permissions.",
  131008: "WhatsApp rejected the message: a required field is missing.",
  131009: "WhatsApp rejected the message: a value is not valid.",
  131016: "WhatsApp is temporarily unavailable. Try again in a few minutes.",
  131021: "The customer's number is the same as the business number.",
  131026: "Message could not be delivered. The number may not be on WhatsApp, or the customer must update WhatsApp or accept its terms.",
  131030: "This number is not in the allowed list of the Meta test number. Add it under WhatsApp > API Setup.",
  131047: "The 24-hour window is closed. Send a template message; free text works again after the customer replies.",
  131049: "WhatsApp did not deliver this message to protect the customer from too many business messages. Try again in 24 hours.",
  131050: "The customer has stopped marketing messages from this business.",
  131051: "WhatsApp does not support this message type.",
  131052: "WhatsApp could not download the file. Send it again.",
  131053: "WhatsApp rejected the file: the type is not supported or the file is too large.",
  // Templates
  132000: "Template problem: the number of variables does not match the template.",
  132001: "The template does not exist in this language or is not approved yet.",
  132005: "Template problem: the text is too long after filling in the variables.",
  132007: "The template breaks a WhatsApp policy and cannot be sent.",
  132012: "Template problem: a variable has the wrong format.",
  132015: "The template is paused because of low quality and cannot be sent.",
  132016: "The template is disabled because of low quality and cannot be sent.",
  // Generic Graph API
  1: "WhatsApp had a temporary problem. Try again.",
  2: "WhatsApp is temporarily unavailable. Try again in a few minutes.",
  33: "WhatsApp does not know this phone number ID. Check WA_PHONE_ID.",
  100: "WhatsApp rejected the request: a value is not valid.",
};

/**
 * A staff-facing sentence for a Meta error. `detail` is Meta's own text, used when
 * the code is unknown and added in brackets for "invalid value" style errors.
 */
export function staffMessage(code: unknown, detail: unknown): string {
  const numeric = typeof code === "number" ? code : Number.parseInt(String(code ?? ""), 10);
  const text = typeof detail === "string" ? detail.trim().slice(0, 200) : "";
  if (!Number.isFinite(numeric)) return (text || "WhatsApp reported an error").slice(0, 300);
  // Codes 200-299 are all "permission missing" on the Graph API.
  const known = MESSAGES[numeric] ?? (numeric >= 200 && numeric <= 299 ? MESSAGES[10] : undefined);
  if (!known) return `${text || "WhatsApp reported an error"} (code ${numeric})`.slice(0, 300);
  const addDetail = [100, 131008, 131009].includes(numeric) && text;
  return `${known}${addDetail ? ` [${text}]` : ""} (code ${numeric})`.slice(0, 300);
}

/** True for errors where trying again with a new token is the fix (used by real-check). */
export function isTokenError(code: unknown): boolean {
  return [0, 190].includes(Number(code));
}
