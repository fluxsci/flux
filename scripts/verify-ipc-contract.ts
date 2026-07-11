#!/usr/bin/env -S npx tsx
// WS-9.4 (fortify plan) — the IPC channel contract: main registrations, preload
// exposure, and main→renderer pushes must all agree with the declarative table
// in electron/ipc/contract.cjs. Fails on missing/extra/undeclared channels and
// kind mismatches — the config-invariant drift killer (a rename can no longer
// silently orphan one side).
//   npx tsx scripts/verify-ipc-contract.ts

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const { CHANNELS } = require2("../electron/ipc/contract.cjs") as {
  CHANNELS: { channel: string; kind: "invoke" | "send" | "push"; scope: string }[];
};

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};

const root = path.join(import.meta.dirname, "..");
const mainSrc = await fs.readFile(path.join(root, "electron", "main.cjs"), "utf8");
// app:flush is pushed by the flush coordinator (appLifecycle.cjs) — pushes may
// originate in any main-process module that holds webContents. (bridgeServer's
// .send()s go to WebSocket clients, not renderers — deliberately excluded.)
const lifecycleSrc = await fs.readFile(path.join(root, "electron", "appLifecycle.cjs"), "utf8");
const preloadSrc = await fs.readFile(path.join(root, "electron", "preload.cjs"), "utf8");

const declared = new Map(CHANNELS.map((c) => [c.channel, c]));
const extract = (src: string, re: RegExp) => {
  const out = new Set<string>();
  for (const m of src.matchAll(re)) out.add(m[2] ?? m[1]);
  return out;
};

// Main side (newline-tolerant — win:isMaximized registers across lines).
const mainHandle = extract(mainSrc, /ipcMain\.handle\(\s*"([^"]+)"/g);
const mainOn = extract(mainSrc, /ipcMain\.on\(\s*"([^"]+)"/g);
const mainPush = extract(mainSrc + lifecycleSrc, /\.send\(\s*"([^"]+)"/g); // webContents/wc/sender sends
// ipcRenderer.send lines don't exist in main; every .send( here is a push site.

// Preload side.
const preInvoke = extract(preloadSrc, /ipcRenderer\.invoke\(\s*"([^"]+)"/g);
const preSend = extract(preloadSrc, /ipcRenderer\.send\(\s*"([^"]+)"/g);
const preOn = extract(preloadSrc, /ipcRenderer\.on\(\s*"([^"]+)"/g);

// ---- 1. every main-side registration is declared with the matching kind --------
let bad = 0;
for (const ch of mainHandle) {
  const d = declared.get(ch);
  if (!d) { fail(`main handles UNDECLARED channel "${ch}"`); bad++; }
  else if (d.kind !== "invoke") { fail(`"${ch}" declared ${d.kind} but main registers handle()`); bad++; }
}
for (const ch of mainOn) {
  const d = declared.get(ch);
  if (!d) { fail(`main listens on UNDECLARED channel "${ch}"`); bad++; }
  else if (d.kind !== "send") { fail(`"${ch}" declared ${d.kind} but main registers on()`); bad++; }
}
for (const ch of mainPush) {
  const d = declared.get(ch);
  if (!d) { fail(`main PUSHES undeclared channel "${ch}"`); bad++; }
  else if (d.kind !== "push") { fail(`"${ch}" declared ${d.kind} but main .send()s it`); bad++; }
}
if (!bad) ok(`main side: ${mainHandle.size} handle + ${mainOn.size} on + ${mainPush.size} push channels all declared with matching kinds`);

// ---- 2. every preload usage is declared with the matching kind ------------------
bad = 0;
for (const ch of preInvoke) {
  const d = declared.get(ch);
  if (!d) { fail(`preload invokes UNDECLARED channel "${ch}"`); bad++; }
  else if (d.kind !== "invoke") { fail(`"${ch}" declared ${d.kind} but preload invoke()s it`); bad++; }
}
for (const ch of preSend) {
  const d = declared.get(ch);
  if (!d) { fail(`preload sends UNDECLARED channel "${ch}"`); bad++; }
  else if (d.kind !== "send") { fail(`"${ch}" declared ${d.kind} but preload send()s it`); bad++; }
}
for (const ch of preOn) {
  const d = declared.get(ch);
  if (!d) { fail(`preload listens on UNDECLARED channel "${ch}"`); bad++; }
  else if (d.kind !== "push") { fail(`"${ch}" declared ${d.kind} but preload on()s it`); bad++; }
}
if (!bad) ok(`preload side: ${preInvoke.size} invoke + ${preSend.size} send + ${preOn.size} on channels all declared with matching kinds`);

// ---- 3. every declaration is live on BOTH sides ----------------------------------
bad = 0;
for (const c of CHANNELS) {
  const mainSide = c.kind === "invoke" ? mainHandle : c.kind === "send" ? mainOn : mainPush;
  const preSide = c.kind === "invoke" ? preInvoke : c.kind === "send" ? preSend : preOn;
  if (!mainSide.has(c.channel)) { fail(`declared "${c.channel}" (${c.kind}) has NO main-side site`); bad++; }
  if (!preSide.has(c.channel)) { fail(`declared "${c.channel}" (${c.kind}) has NO preload site`); bad++; }
}
if (!bad) ok(`all ${CHANNELS.length} declared channels are live on both sides (no orphans)`);

// ---- 4. the registration wrapper is actually in force ----------------------------
if (/wrapIpcMain\(rawIpcMain\)/.test(mainSrc) && /assertAllRegistered\(\)/.test(mainSrc))
  ok("main routes registration through the contract wrapper + asserts completeness at ready");
else fail("main does not route ipcMain through the contract wrapper");

// ---- 5. scope sanity: every entry carries a known scope ---------------------------
const badScope = CHANNELS.filter((c) => !["read", "write", "spawn"].includes(c.scope));
if (badScope.length) fail(`unknown scope on: ${badScope.map((c) => c.channel).join(", ")}`);
else ok("every channel declares a known scope (read/write/spawn)");

console.log(failures ? `\nIPC CONTRACT: FAIL (${failures})` : "\nIPC CONTRACT: PASS");
process.exit(failures ? 1 : 0);
