#!/usr/bin/env -S npx tsx
// Main-process undefined-identifier gate. The Electron main modules run as
// plain CJS with no bundler and no lint pass, so a reference to a name that
// no longer exists (e.g. a helper deleted in a refactor while its call site
// stayed behind) only explodes at runtime — as an uncaught ReferenceError
// dialog storm when the code path fires (the WS-9.4b subsystemFor regression:
// every chokidar event popped a modal). verify-w10-matrix exercises only the
// renderer half of the watcher, so nothing executed these files.
//
// This runs the TypeScript checker over electron/**/*.cjs (allowJs+checkJs,
// noEmit) and fails ONLY on "Cannot find name" diagnostics (TS2304/TS2552) —
// the exact static signature of a runtime ReferenceError. All other checkJs
// noise (type mismatches on untyped JS) is deliberately ignored.
//   npx tsx scripts/verify-electron-no-undef.ts [dirOverride]

import * as path from "node:path";
import { promises as fs } from "node:fs";
import ts from "typescript";
import { harness } from "./lib/harness.mjs";

const h = harness("verify-electron-no-undef");
const root = path.join(import.meta.dirname, "..");
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, "electron");

const files: string[] = [];
for (const ent of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
  if (ent.isFile() && ent.name.endsWith(".cjs")) files.push(path.join(ent.parentPath, ent.name));
}
h.ok(files.length >= 10, `found ${files.length} .cjs modules under ${path.relative(root, dir) || dir}`);

const program = ts.createProgram(files, {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  skipLibCheck: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  types: ["node"],
  typeRoots: [path.join(root, "node_modules", "@types")],
});

// TS2304 "Cannot find name 'X'" / TS2552 "... Did you mean 'Y'?" — a bare
// identifier the checker can bind to nothing, i.e. a guaranteed runtime
// ReferenceError if that line ever executes.
const UNDEF_CODES = new Set([2304, 2552]);
const own = new Set(files.map((f) => path.resolve(f)));
const bad = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => UNDEF_CODES.has(d.code) && d.file && own.has(path.resolve(d.file.fileName)));

for (const d of bad) {
  const { line, character } = ts.getLineAndCharacterOfPosition(d.file!, d.start!);
  const msg = ts.flattenDiagnosticMessageText(d.messageText, " ");
  h.fail(`${path.relative(root, d.file!.fileName)}:${line + 1}:${character + 1} — ${msg} (TS${d.code})`);
}
h.ok(bad.length === 0, "no undefined identifiers in electron main-process modules");
await h.done();
