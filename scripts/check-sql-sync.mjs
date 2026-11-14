#!/usr/bin/env node
// whatsapp_setup.sql (paste into the Supabase SQL editor) must be all migrations
// (used by `supabase db push`) concatenated in order.
// Run with --fix to rebuild whatsapp_setup.sql from the migrations.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(root, "supabase/migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
if (migrations.length === 0) {
  console.error("No migrations found.");
  process.exit(1);
}
const expected = migrations
  .map((file) => `-- >>> supabase/migrations/${file}\n\n${readFileSync(resolve(migrationsDir, file), "utf8")}`)
  .join("\n");
const setup = resolve(root, "whatsapp_setup.sql");

if (process.argv.includes("--fix")) {
  writeFileSync(setup, expected);
  console.log(`whatsapp_setup.sql rebuilt from ${migrations.length} migration(s).`);
} else if (expected === readFileSync(setup, "utf8")) {
  console.log(`OK  whatsapp_setup.sql matches the ${migrations.length} migration(s).`);
} else {
  console.error("FAIL  whatsapp_setup.sql differs from the migrations. Run: node scripts/check-sql-sync.mjs --fix");
  process.exit(1);
}
