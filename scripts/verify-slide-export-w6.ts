#!/usr/bin/env -S npx tsx
// W6 export polish: KaTeX (~1 MB) is inlined ONLY when the deck has an equation
// (C12), and the exported file carries the presenter panel + motion-on default
// (C1/C15). The node half checks the KaTeX gate + writes a no-math file; the live
// half opens that file offline and drives the presenter panel.
// Run: npx tsx scripts/verify-slide-export-w6.ts
import { writeFile } from "node:fs/promises";
import * as ops from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { ExportPayload } from "../src/lib/slide/export/runtime";

function assert(c: unknown, m: string) { if (!c) throw new Error("FAIL: " + m); console.log("  ok:", m); }

// --- deck WITHOUT math ----------------------------------------------------------
const plain = ops.createDeck({ id: "plain", title: "No Equations Here" });
const p0 = plain.slides[0].id;
ops.addTextBox(plain, p0, { text: "Just words", x: 100, y: 250, width: 900, height: 160, fontSize: 60 });
const s1 = ops.addSlide(plain, { name: "Two", layout: "blank" }).id;
plain.slides[1].notes = "Speaker note for slide two.";
ops.addTextBox(plain, s1, { x: 100, y: 120, width: 900, height: 200, blocks: [ops.makeBlock("SECOND")] });
const plainOut = await exportDeckHtml({ deck: plain } as ExportPayload);

// --- deck WITH math -------------------------------------------------------------
const mathy = ops.createDeck({ id: "mathy", title: "Has An Equation" });
ops.addMath(mathy, mathy.slides[0].id, { tex: "e^{i\\pi}+1=0", x: 100, y: 250, width: 900, height: 160, display: true });
const mathOut = await exportDeckHtml({ deck: mathy } as ExportPayload);

// The runtime IIFE always bundles KaTeX *JS* (the import); C12 gates the ~1 MB
// CSS + fonts, whose signature is the "KaTeX_" @font-face family (CSS-only).
assert(!plainOut.html.includes("KaTeX_"), "C12: a no-math deck does NOT inline the KaTeX CSS/fonts");
assert(mathOut.html.includes("KaTeX_"), "C12: a deck WITH an equation DOES inline the KaTeX CSS/fonts");
assert(plainOut.bytes < mathOut.bytes - 250_000, `C12: dropping KaTeX saves ~350 KB (plain ${(plainOut.bytes / 1024) | 0} KB vs math ${(mathOut.bytes / 1024) | 0} KB)`);

// write the no-math file for the live pass
const file = "/tmp/flux-export-w6.html";
await writeFile(file, plainOut.html, "utf8");
console.log(`  wrote ${(plainOut.bytes / 1024) | 0} KB → ${file}`);

// --- live: open offline, drive the presenter panel (C1) + motion toggle (C15) ---
const { launch, sleep } = await import("./lib/driver.mjs");
const { browser, page } = await launch();
try {
  await page.goto("file://" + file, { waitUntil: "networkidle0" });
  await sleep(600);
  await page.evaluate(() => document.getElementById("flux-stage")?.focus());
  // S opens the presenter panel; it should show the next-slide preview
  await page.keyboard.press("KeyS");
  await sleep(400);
  const panel = await page.evaluate(() => {
    const stage = document.getElementById("flux-stage");
    // the panel is the flex div we appended; find one showing the shortcut hint
    const nodes = [...(stage?.querySelectorAll("div") ?? [])];
    const hint = nodes.map((n) => n.textContent || "").find((t) => /motion (on|off)/.test(t)) || "";
    const hasNextPreview = !!stage?.querySelector('[data-el-type], .sl-el');
    const secondText = (stage?.textContent || "").includes("SECOND");
    return { hint, hasNextPreview, secondText };
  });
  // M toggles motion
  await page.keyboard.press("KeyM");
  await sleep(200);
  const afterM = await page.evaluate(() => {
    const stage = document.getElementById("flux-stage");
    return [...(stage?.querySelectorAll("div") ?? [])].map((n) => n.textContent || "").find((t) => /motion (on|off)/.test(t)) || "";
  });

  const fails = [];
  const chk = (c, m) => { if (!c) fails.push(m); };
  chk(/motion on/.test(panel.hint), `C15: exported file defaults motion ON (hint: "${panel.hint}")`);
  chk(panel.secondText, "C1: presenter panel renders the next slide's content (SECOND)");
  chk(/motion off/.test(afterM), `C15: M toggles motion in the exported file (hint: "${afterM}")`);

  console.log(JSON.stringify({ panel, afterM, fails }, null, 2));
  if (fails.length) { console.error("\nW6 EXPORT LIVE FAILED:\n" + fails.join("\n")); process.exitCode = 1; }
  else console.log("\nSLIDE EXPORT W6 (C12 katex-gate + C1/C15 presenter/motion) PASSED");
} finally {
  await browser.close();
}
