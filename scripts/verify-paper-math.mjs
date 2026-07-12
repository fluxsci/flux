// 2.1 gate — math in Paper, held to the paper editing invariants: display `$$` blocks are
// block-widgets AFTER navigable source lines (one keypress per line, goal column safe,
// zero layout shift on caret moves after first render); inline `$…$` is an atomic chip
// that reveals ONLY when the selection touches it; `@eq` chips number labeled equations;
// currency stays prose; the export renders KaTeX + `(n)` and gates its CSS on math.
//   Run (dev server on :1420): node scripts/verify-paper-math.mjs
import { launch, gotoApp, clickNew, sleep, realErrors } from "./lib/driver.mjs";

let fails = 0;
const ok = (cond, msg) => (cond ? console.log("  ✓ " + msg) : (fails++, console.log("  ✗ " + msg)));

const DOC = [
  "# Math",
  "",
  "Inline $E = mc^2$ math and costs $5 and $10 more.",
  "",
  "$$",
  "\\sum_{i=1}^{n} x_i = X",
  "$$ {#eq-sum}",
  "",
  "See @eq-sum here.",
  "",
  "Tail prose line.",
].join("\n");

const { browser, page } = await launch();
await gotoApp(page);
await clickNew(page);
await sleep(1200);
await page.waitForFunction(() => window.__fluxView, { timeout: 15000 });

await page.evaluate((doc) => {
  const v = window.__fluxView;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc }, selection: { anchor: 0 } });
}, DOC);
await sleep(1500); // let KaTeX lazy-load + refresh

// --- rendering: chips + block + number -----------------------------------------------------
const r1 = await page.evaluate(() => {
  const katexInline = document.querySelectorAll(".flux-math .katex").length;
  const block = document.querySelector(".flux-mathblock");
  const num = block?.querySelector(".mb-num")?.textContent ?? "";
  const eqChip = [...document.querySelectorAll(".flux-figref")].map((e) => e.textContent).find((t) => /Eq\./.test(t || ""));
  const rawDollars = document.querySelector(".cm-content")?.textContent?.includes("$5 and $10");
  return { katexInline, hasBlock: !!block, blockKatex: !!block?.querySelector(".katex"), num, eqChip, rawDollars };
});
ok(r1.katexInline >= 1, `inline $…$ renders as a KaTeX chip (${r1.katexInline})`);
ok(r1.hasBlock && r1.blockKatex, "display $$ block renders a KaTeX block widget");
ok(r1.num === "(1)", `labeled equation numbered (${r1.num})`);
ok(r1.eqChip === "Eq. 1", `@eq-sum chip shows "Eq. 1" (got ${JSON.stringify(r1.eqChip)})`);
ok(r1.rawDollars === true, "currency $5 and $10 stays raw prose");

// --- feel: one keypress per line through the $$ block; scrollHeight stable ------------------
const nav = await page.evaluate(async () => {
  const v = window.__fluxView;
  const lineOf = () => v.state.doc.lineAt(v.state.selection.main.head).number;
  v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 2 } }); // inline-math line
  await new Promise((r) => setTimeout(r, 120));
  const h0 = v.scrollDOM.scrollHeight;
  const steps = [];
  for (let i = 0; i < 7; i++) {
    const before = lineOf();
    const ev = new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true });
    v.contentDOM.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 60));
    steps.push(lineOf() - before);
  }
  const h1 = v.scrollDOM.scrollHeight;
  return { steps, heightStable: h0 === h1, h0, h1 };
});
ok(nav.steps.every((s) => s === 1), `ArrowDown advances exactly one line each through the math block (${nav.steps.join(",")})`);
ok(nav.heightStable, `scrollHeight stable across caret moves (${nav.h0} → ${nav.h1})`);

// --- reveal: inline chip reveals ONLY when the selection touches it ---------------------------
const reveal = await page.evaluate(async () => {
  const v = window.__fluxView;
  const line3 = v.state.doc.line(3);
  const mathAt = line3.text.indexOf("$E");
  // Caret elsewhere on the SAME line: the chip must stay rendered.
  v.dispatch({ selection: { anchor: line3.from } });
  await new Promise((r) => setTimeout(r, 100));
  const renderedAway = document.querySelectorAll(".flux-math").length;
  // Caret inside the span: raw TeX must reveal (chip gone).
  v.dispatch({ selection: { anchor: line3.from + mathAt + 2 } });
  await new Promise((r) => setTimeout(r, 100));
  const renderedInside = document.querySelectorAll(".flux-math").length;
  return { renderedAway, renderedInside };
});
ok(reveal.renderedAway >= 1, "chip stays rendered with the caret elsewhere on its line");
ok(reveal.renderedInside === 0, "raw TeX reveals when the selection touches the span");

// --- export parity (the same doc through the real renderer) -----------------------------------
const exp = await page.evaluate(async (doc) => {
  const { renderManuscript } = await import("/src/shell/modes/paper/render/renderManuscript.ts");
  const { full } = await renderManuscript("---\ntitle: m\n---\n\n" + doc, {});
  const plain = (await renderManuscript("---\ntitle: p\n---\n\nno math here", {})).full;
  return {
    katex: full.includes('class="katex'),
    eqId: full.includes('id="eq-sum"'),
    num: full.includes('<span class="eq-num">(1)</span>'),
    eqRef: />Eq\. 1</.test(full),
    currency: full.includes("$5 and $10"),
    cssGated: (full.match(/data:/g) || []).length >= 20 && (plain.match(/data:/g) || []).length === 0,
  };
}, DOC.replace(/^# Math\n\n/, ""));
ok(exp.katex && exp.eqId && exp.num, "export renders KaTeX + eq-block id + (1)");
ok(exp.eqRef, "export links @eq-sum as 'Eq. 1'");
ok(exp.currency, "export keeps currency as prose");
ok(exp.cssGated, "KaTeX CSS (20 inlined fonts) rides only math documents");

const errs = realErrors(page);
ok(errs.length === 0, errs.length ? `console errors: ${errs.join(" | ").slice(0, 300)}` : "zero console errors");
await browser.close();
console.log(fails ? `\nPAPER-MATH VERIFY: FAIL — ${fails}` : "\nPAPER-MATH VERIFY: PASS");
process.exit(fails ? 1 : 0);
