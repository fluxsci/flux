#!/usr/bin/env -S npx tsx
// The verify manifest's own consistency (2026-10-02): every tier member and every
// group member has an `execution` contract and a script file, and every execution
// key names a real script. The runner refuses to PLAN a tier when one member lacks
// a contract ("Missing/invalid execution contract") — which aborted the whole pure
// tier for every worker on 2026-10-02 after two 09-30 gates landed without one —
// so this gate turns that silent planning abort into an ordinary red check.
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-manifest-contracts.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import { executionSpec } from "./lib/verifyRuntime.mjs";

const h = harness("verify-manifest-contracts");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "scripts/verify-manifest.json"), "utf8")) as {
  tiers: Record<string, string[]>; groups: Record<string, string[]>; execution: Record<string, unknown>;
};
// The runner's OWN validator decides what a valid contract is (verifyRuntime.mjs
// executionSpec); this gate only makes sure every planned script would pass it.
const valid = (name: string) => { try { executionSpec(manifest, name); return true; } catch { return false; } };
for (const [tier, list] of Object.entries(manifest.tiers)) {
  h.section(`tier ${tier}`);
  for (const name of list) {
    h.ok(valid(name), `${tier}: ${name} has a valid execution contract`);
    h.ok(existsSync(path.join(root, "scripts", name)), `${tier}: ${name} exists under scripts/`);
  }
}
h.section("groups");
for (const [group, list] of Object.entries(manifest.groups)) {
  for (const name of list) h.ok(valid(name) && existsSync(path.join(root, "scripts", name)), `group ${group}: ${name} has a valid contract and a file`);
}
h.section("execution");
for (const name of Object.keys(manifest.execution ?? {})) h.ok(existsSync(path.join(root, "scripts", name)), `execution key ${name} names a real script`);
await h.done();
