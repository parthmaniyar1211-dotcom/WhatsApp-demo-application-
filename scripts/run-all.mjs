#!/usr/bin/env node
// Runs the whole simulated test (TEST_PLAN.md step 1) in one go.
//
//   node scripts/run-all.mjs
//
// Needs WA_DRY_RUN=true on the server for the image and document steps.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const steps = [
  ["verify-webhook.mjs"],
  ["simulate-bad-signature.mjs"],
  ["simulate-incoming.mjs", "text", "Hello from the harness"],
  ["simulate-incoming.mjs", "image", "A test photo"],
  ["simulate-incoming.mjs", "document", "test-document.pdf"],
  ["simulate-duplicate.mjs"],
];

let failed = 0;
for (const [script, ...args] of steps) {
  console.log(`\n=== ${script} ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [resolve(here, script), ...args], { stdio: "inherit" });
  if (result.status !== 0) failed++;
}
console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} step(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
