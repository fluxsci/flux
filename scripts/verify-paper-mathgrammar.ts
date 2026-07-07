// 2.1 gate — the ONE math grammar (science/mathGrammar.ts): Pandoc `$` inline rules
// (currency-safe), the `$$` display-block tracker, masking parity for citeNumbering.
// Run: npx tsx scripts/verify-paper-mathgrammar.ts
import { findInlineMath, maskInlineMath, MathBlockTracker } from "../src/shell/modes/paper/science/mathGrammar";
import { buildCitationOrdinals } from "../src/shell/modes/paper/scholar/citeNumbering";

let failures = 0;
function ok(cond: boolean, name: string, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}
const spans = (s: string) => findInlineMath(s).map((m) => m.tex);

// --- inline pairing --------------------------------------------------------------------
ok(JSON.stringify(spans("the energy $E = mc^2$ is famous")) === JSON.stringify(["E = mc^2"]), "basic $…$ span");
ok(JSON.stringify(spans("$a$ then $b$")) === JSON.stringify(["a", "b"]), "two spans, non-overlapping left-to-right");
ok(spans("costs $5 and $10 more").length === 0, "currency: closer followed by a digit never closes");
ok(spans("we paid $50. later").length === 0, "single unclosed $ stays prose");
ok(JSON.stringify(spans("mass $m$ costs $5")) === JSON.stringify(["m"]), "math then currency coexists");
ok(spans("a \\$5 bill and \\$10").length === 0, "escaped \\$ never opens");
ok(JSON.stringify(spans("escaped dollar in math $a \\$ b$ ok")) === JSON.stringify(["a \\$ b"]), "escaped \\$ inside math doesn't close");
ok(spans("not $ this$ (opener before space)").length === 0, "opener must be followed by non-space");
ok(spans("not $this $ either").length === 0, "closer must be preceded by non-space");
ok(spans("display $$x$$ is not inline").length === 0, "$$ never matches the inline rule");
ok(JSON.stringify(spans("$\\alpha_i^2$")) === JSON.stringify(["\\alpha_i^2"]), "TeX commands survive");
ok(spans("$   $").length === 0, "blank math is not a span");

// --- masking (citeNumbering parity) --------------------------------------------------------
{
  const line = "see [@smith2021] and $E_{@notacite}$ then [@jones2020]";
  const masked = maskInlineMath(line);
  ok(masked.length === line.length, "mask is length-preserving");
  ok(!masked.includes("@notacite") && masked.includes("[@smith2021]") && masked.includes("[@jones2020]"), "mask hides math content, keeps prose cites");
}
{
  // Ordinals: a cite-looking token INSIDE math must not number; real cites around it do.
  const body = ["Prose [@aaa2001] cites.", "", "Math $x_{[@zzz1999]}$ here.", "", "Then [@bbb2002]."].join("\n");
  const { map } = buildCitationOrdinals(body, () => true);
  ok(map.get("aaa2001") === 1 && map.get("bbb2002") === 2 && !map.has("zzz1999"), "citation ordinals skip cite-lookalikes inside inline math", JSON.stringify([...map]));
}

// --- display tracker -------------------------------------------------------------------------
{
  const t = new MathBlockTracker();
  const lines = ["$$", "E = mc^2", "$$ {#eq-mass}"];
  const blocks = lines.map((l, i) => t.feed(i + 1, l)).filter(Boolean);
  ok(blocks.length === 1, "one block from a 3-line labeled display");
  const b = blocks[0]!;
  ok(b.startLine === 1 && b.endLine === 3 && b.tex === "E = mc^2" && b.label === "eq-mass", "block range/tex/label", JSON.stringify(b));
}
{
  const t = new MathBlockTracker();
  const b = t.feed(5, "$$ a^2 + b^2 = c^2 $$ {#eq-pyth}");
  ok(!!b && b.startLine === 5 && b.endLine === 5 && b.tex === "a^2 + b^2 = c^2" && b.label === "eq-pyth", "single-line labeled display", JSON.stringify(b));
}
{
  const t = new MathBlockTracker();
  const b = t.feed(1, "$$ x = 1 $$");
  ok(!!b && b.tex === "x = 1" && !b.label, "single-line unlabeled display");
}
{
  const t = new MathBlockTracker();
  t.feed(1, "$$");
  t.feed(2, "\\sum_i x_i");
  t.feed(3, "+ y");
  const b = t.feed(4, "$$");
  ok(!!b && b.tex === "\\sum_i x_i\n+ y" && !b.label, "multi-line unlabeled joins content");
}
{
  const t = new MathBlockTracker();
  t.feed(1, "$$");
  t.feed(2, "x");
  ok(t.inMath, "unterminated block stays open (no block emitted — never eat the document)");
}
{
  const t = new MathBlockTracker();
  t.feed(1, "$$ \\frac{a}{b}"); // opener with content, closes later
  const b = t.feed(2, "= c $$");
  ok(!!b && b.tex === "\\frac{a}{b}\n= c", "content on opener + closing lines joins", JSON.stringify(b));
}

console.log(failures ? `\n${failures} FAILED` : "\nall green");
process.exit(failures ? 1 : 0);
