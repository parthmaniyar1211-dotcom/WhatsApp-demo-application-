#!/usr/bin/env node
// LOCAL STACK ONLY: creates the first admin login on a `supabase start` stack.
//
//   node scripts/local-create-admin.mjs ADMIN1 "a-password-of-8+-chars"
//
// It asks the Supabase CLI for the local service key at run time (nothing is stored)
// and refuses to run against anything that is not localhost.
// For the hosted project, create the first admin in the dashboard (see README.md).

import { execSync } from "node:child_process";

const [staffIdArg, password] = process.argv.slice(2);
const staffId = (staffIdArg ?? "").trim().toUpperCase();
if (!/^[A-Z0-9]{3,20}$/.test(staffId) || !password || password.length < 8) {
  console.error('Usage: node scripts/local-create-admin.mjs ADMIN1 "password (min 8 chars)"');
  process.exit(2);
}

const env = Object.fromEntries(
  execSync("supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split("\n")
    .map((line) => /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const url = env.API_URL;
const key = env.SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Could not read API_URL / SERVICE_ROLE_KEY from `supabase status`");
if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  throw new Error(`Refusing to run: ${url} is not a local stack`);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
const email = `${staffId.toLowerCase()}@company.demo`;

const created = await fetch(`${url}/auth/v1/admin/users`, {
  method: "POST",
  headers,
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (!created.ok) throw new Error(`Creating ${email} failed: HTTP ${created.status} ${await created.text()}`);
const user = await created.json();

const staff = await fetch(`${url}/rest/v1/staff`, {
  method: "POST",
  headers,
  body: JSON.stringify({ user_id: user.id, staff_id: staffId, display_name: "Admin", role: "admin" }),
});
if (!staff.ok) throw new Error(`Creating the staff row failed: HTTP ${staff.status} ${await staff.text()}`);
console.log(`Created local admin ${staffId} (${email}).`);
