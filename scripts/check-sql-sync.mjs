#!/usr/bin/env node
// whatsapp_setup.sql (paste into the Supabase SQL editor) must be identical to the migration
// (used by `supabase db push`). Run with --fix to copy the migration over whatsapp_setup.sql.

import { copyFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(root, "supabase/migrations");
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
if (migrations.length !== 1) {
  console.error(`Expected exactly one migration, found ${migrations.length}. Update this check when adding more.`);
  process.exit(1);
}
const migration = resolve(migrationsDir, migrations[0]);
const setup = resolve(root, "whatsapp_setup.sql");

if (process.argv.includes("--fix")) {
  copyFileSync(migration, setup);
  console.log("whatsapp_setup.sql updated from the migration.");
} else if (readFileSync(migration, "utf8") === readFileSync(setup, "utf8")) {
  console.log("OK  whatsapp_setup.sql matches the migration.");
} else {
  console.error("FAIL  whatsapp_setup.sql differs from the migration. Run: node scripts/check-sql-sync.mjs --fix");
  process.exit(1);
}
