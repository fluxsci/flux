#!/usr/bin/env -S npx tsx
// Structural gate (2026-09-26): no renderer surface may render a native `<input type="color">`.
// Chromium's colour popup carries an eyedropper button that invokes EyeDropperView, which
// SEGFAULTS Electron on Linux/Wayland — a native crash JavaScript cannot catch. The F-menu
// picker was moved to the desktop-portal dropper on 2026-09-21; the figure/slide Background
// fields and the palette "+" kept the native input and crashed the app (owner report
// 2026-09-26). Every colour field goes through src/lib/ColorField.svelte or ColorPicker.svelte.
//   Run: npx tsx scripts/verify-no-native-color-input.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const offenders: string[] = [];
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(svelte|ts|js)$/.test(e.name)) {
      const text = fs.readFileSync(p, "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
      // A rendered tag, not the CSS selector `input[type="color"]` and not prose.
      const tag = /<input\b[^>]*\btype\s*=\s*["'`]?color\b/i;
      const showPicker = /\bshowPicker\s*\(/; // programmatic open of the same native popup
      if (tag.test(text) || showPicker.test(text)) offenders.push(path.relative(root, p));
    }
  }
}
walk(root);
if (offenders.length) {
  console.error("FAIL: native <input type=\"color\"> (or showPicker) in the renderer — use ColorField.svelte:\n  " + offenders.join("\n  "));
  process.exit(1);
}
console.log("verify-no-native-color-input: no native colour inputs in src/");
