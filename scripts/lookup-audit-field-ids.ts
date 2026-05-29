#!/usr/bin/env tsx
/**
 * Lookup GHL custom-field IDs for the Tier-Fit Audit fields.
 *
 * READ-ONLY: calls GET /locations/{locationId}/customFields and filters to
 * the 10 fields whose key starts with "audit_". Prints a markdown table.
 *
 * Standalone — does not require the dev server. Loads .env from repo root.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1);
    if (key && !(key in process.env)) {
      process.env[key] = raw.replace(/^(['"])(.*)\1$/s, "$2");
    }
  }
}

import { ghlRequest } from "../server/src/services/ghl/index.js";

const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";

interface GhlField {
  id: string;
  name?: string;
  fieldKey?: string;
  dataType?: string;
  picklistOptions?: Array<{ label?: string; value?: string } | string>;
  picklistImageOptions?: unknown[];
  [k: string]: unknown;
}

interface GhlFieldsResponse {
  customFields?: GhlField[];
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function formatOptions(opts: GhlField["picklistOptions"]): string {
  if (!opts || opts.length === 0) return "—";
  return opts
    .map((o) => {
      if (typeof o === "string") return o;
      return o.value ?? o.label ?? "";
    })
    .filter(Boolean)
    .join(", ");
}

async function main() {
  console.log(`Fetching custom fields for location ${LOCATION_ID} ...`);
  const res = await ghlRequest<GhlFieldsResponse>(
    "GET",
    `/locations/${LOCATION_ID}/customFields`,
  );
  const all = res.customFields ?? [];
  console.log(`Total custom fields on location: ${all.length}`);

  // GHL returns fieldKey with a `contact.` (or object-name) prefix.
  // Match on the bare key portion so callers can paste `audit_*` directly.
  const bareKey = (fk: string | undefined) => (fk ?? "").split(".").pop() ?? "";
  const audit = all.filter((f) => bareKey(f.fieldKey).startsWith("audit_"));
  console.log(`Fields matching audit_* prefix: ${audit.length}\n`);

  if (audit.length === 0) {
    console.log("No audit_* fields found. Showing first 10 fields for sanity:");
    for (const f of all.slice(0, 10)) {
      console.log(`  ${f.fieldKey ?? "(no key)"}  →  ${f.id}  (${f.dataType ?? "?"})`);
    }
    return;
  }

  // Sort by fieldKey for stable display
  audit.sort((a, b) => (a.fieldKey ?? "").localeCompare(b.fieldKey ?? ""));

  console.log("| Field Name | Field Key | Field ID | Type | Options |");
  console.log("|---|---|---|---|---|");
  for (const f of audit) {
    const name = escapePipes(f.name ?? "(unnamed)");
    const key = f.fieldKey ?? "(no key)";
    const id = f.id;
    const type = f.dataType ?? "?";
    const opts = escapePipes(formatOptions(f.picklistOptions));
    console.log(`| ${name} | ${key} | ${id} | ${type} | ${opts} |`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
