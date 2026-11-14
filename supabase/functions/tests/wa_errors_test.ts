import { staffMessage } from "../_shared/wa_errors.ts";
import { assert, assertEquals } from "./helpers.ts";

Deno.test("staffMessage: the cases staff will actually meet", () => {
  assert(staffMessage(190, "Session has expired").startsWith("WhatsApp access token has expired"));
  assert(staffMessage(131030, "x").includes("allowed list"));
  assert(staffMessage(131047, "x").includes("24-hour window is closed"));
  assert(staffMessage(132001, "x").includes("not approved"));
  assert(staffMessage(131053, "x").includes("rejected the file"));
  assert(staffMessage(131052, "x").includes("could not download the file"));
  assert(staffMessage(130429, "x").includes("rate limit"));
  assert(staffMessage(131056, "x").includes("Too many messages to this customer"));
  assert(staffMessage(131026, "x").includes("could not be delivered"));
});

Deno.test("staffMessage: the code is always shown; unknown codes keep Meta's text", () => {
  assertEquals(staffMessage(139999, "Brand new problem"), "Brand new problem (code 139999)");
  assertEquals(staffMessage("131047", "x").endsWith("(code 131047)"), true);
  assertEquals(staffMessage(undefined, "Delivery failed"), "Delivery failed");
  assertEquals(staffMessage(undefined, undefined), "WhatsApp reported an error");
  assertEquals(staffMessage(200, "Permissions error").includes("missing a permission"), true);
  assertEquals(
    staffMessage(131009, "Parameter value is not valid"),
    "WhatsApp rejected the message: a value is not valid. [Parameter value is not valid] (code 131009)",
  );
});
