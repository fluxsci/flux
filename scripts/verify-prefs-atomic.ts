#!/usr/bin/env -S npx tsx
// Machine-global write crash-safety gate (A4). preferences.json holds the
// fluxConfigPath pointer that resolves FluxConfig/FluxLib; textstyles.json holds
// the user's named text styles. Both are written from the Electron main process,
// which runs as plain CJS with no bundler/lint/execution gate — so a regression
// back to a non-atomic `fs.writeFileSync` (truncatable on crash or a two-process
// race → readPrefs silently adopts the WRONG library) would only surface as data
// loss in the field. This is a SOURCE-SHAPE guard (the verify-electron-no-undef
// precedent): it pins that these writers stay atomic and that readPrefs treats a
// corrupt file as corruption, not as "first run".
//   npx tsx scripts/verify-prefs-atomic.ts

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-prefs-atomic");
const root = path.join(import.meta.dirname, "..");
const src = await fs.readFile(path.join(root, "electron", "main.cjs"), "utf8");

/** Extract a top-level `function name(...) { ... }` body by brace matching. */
function fnBody(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return "";
  let i = src.indexOf("{", start);
  let depth = 0;
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(from, i + 1);
  }
  return "";
}

// 1. The sync atomic helper exists and is genuinely atomic (tmp + fsync + rename).
const aws = fnBody("atomicWriteSync");
h.ok(!!aws, "atomicWriteSync(p, str) is defined in main.cjs");
h.ok(/\.tmp-/.test(aws) && /openSync\(/.test(aws), "atomicWriteSync writes to a .tmp- file");
h.ok(/fsyncSync\(/.test(aws), "atomicWriteSync fsyncs before rename (durability)");
h.ok(/renameSync\(/.test(aws), "atomicWriteSync renames tmp → target (atomic swap)");

// 2. writePrefs goes through the atomic helper — never a raw writeFileSync.
const wp = fnBody("writePrefs");
h.ok(!!wp, "writePrefs is defined");
h.ok(/atomicWriteSync\(/.test(wp), "writePrefs writes via atomicWriteSync");
h.ok(!/writeFileSync\(/.test(wp), "writePrefs does NOT use a raw writeFileSync");

// 3. textstyles:set (the other machine-global write) is atomic too.
const tsSet = src.slice(src.indexOf('ipcMain.handle("textstyles:set"'));
const tsHandler = tsSet.slice(0, tsSet.indexOf("});") + 3);
h.ok(/atomicWriteSync\(/.test(tsHandler), "textstyles:set writes via atomicWriteSync");
h.ok(!/writeFileSync\(/.test(tsHandler), "textstyles:set does NOT use a raw writeFileSync");

// 4. readPrefs distinguishes a missing file (first run) from a corrupt one, and
//    preserves the corrupt file rather than silently resolving to the fallback.
const rp = fnBody("readPrefs");
h.ok(!!rp, "readPrefs is defined");
h.ok(/ENOENT/.test(rp), "readPrefs special-cases ENOENT (missing = first run, not corruption)");
h.ok(/\.corrupt-/.test(rp) && /copyFileSync\(/.test(rp), "readPrefs backs up a corrupt prefs file before defaulting");

await h.done();
