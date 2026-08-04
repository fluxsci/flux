#!/usr/bin/env -S npx tsx
// THE WRITER-NEUTRALITY GATE.
//
// Flux's writer has its own conventions and they never change with the selected
// journal. Everything venue-specific happens at export (and in the preview,
// which exists to prove the export). This gate is what stops a future change
// from quietly leaking journal styling back into the editing surface.
//
// Why this is safe rather than a divergence: NUMBERING and (family, number)
// IDENTITY stay computed by the shared cores in both paths, so the editor and
// the output can differ in PRESENTATION without ever disagreeing about which
// figure or which reference something is. That distinction is the whole basis
// for the decision — see src/lib/style/journalStyle.ts.
//   Run: npx tsx scripts/verify-writer-neutral.ts
import { readFileSync } from "node:fs";
import { BUILTIN_FAMILIES, familyById, formatCaptionLabel, formatFamilyRef } from "../src/lib/figfamily";
import { resolveJournalStyle, styledFamilyDef } from "../src/lib/style/journalStyle";
import { BUILTIN_JOURNAL_STYLES } from "../src/lib/style/journalPresets";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const nature = resolveJournalStyle("nature", BUILTIN_JOURNAL_STYLES);

// --- 1. the shared cores are style-blind ------------------------------------
// figfamily.ts is what the EDITOR renders from. It must produce house forms no
// matter what style exists, because it never receives one.
{
  for (const f of BUILTIN_FAMILIES) {
    const before = formatFamilyRef(f, 3, "a,b");
    const beforeCap = formatCaptionLabel(f, 3);
    // Resolve a style, then re-render from the same unstyled def.
    styledFamilyDef(nature, f);
    assert(formatFamilyRef(f, 3, "a,b") === before,
      `resolving a style does not mutate the ${f.id} family definition (refs)`);
    assert(formatCaptionLabel(f, 3) === beforeCap,
      `…nor its caption template`);
  }
  assert(formatFamilyRef(familyById("supplementary"), 1) === "Fig. S1",
    "the writer's supplementary form stays 'Fig. S1' with Nature resolved");
  assert(formatFamilyRef(styledFamilyDef(nature, familyById("supplementary")), 1) === "Supplementary Fig. 1",
    "…while the EXPORT projection of the same figure reads 'Supplementary Fig. 1'");
}

// --- 2. identity is shared even when presentation differs -------------------
// The failure class that would matter is the editor saying figure 3 while the
// export says figure 4. Numbers must be identical across the two paths.
{
  for (const f of BUILTIN_FAMILIES) {
    for (const n of [1, 2, 7, 12]) {
      const house = formatFamilyRef(f, n);
      const styled = formatFamilyRef(styledFamilyDef(nature, f), n);
      const num = (s: string) => (s.match(/\d+/) ?? [""])[0];
      assert(num(house) === num(styled) && num(house) === String(n),
        `${f.id} ${n}: writer and export agree on the NUMBER (${house} / ${styled})`);
    }
  }
}

// --- 3. no style import reaches the editor's rendering path ------------------
// A source pin, because this is the class of regression that is invisible in
// review: someone threads a style into a chip or into figureRefs "for
// consistency" and the writer silently starts restyling per venue.
{
  const editorOwned = [
    "src/shell/modes/paper/science/chips.ts",
    "src/shell/modes/paper/science/widgets.ts",
    "src/shell/modes/paper/science/citeNumbers.ts",
    "src/shell/modes/paper/scholar/citeNumbering.ts",
    "src/shell/modes/paper/scholar/numberingFacet.ts",
    "src/shell/modes/paper/scholar/figText.ts",
  ];
  for (const rel of editorOwned) {
    const src = readFileSync(rel, "utf8");
    assert(!/lib\/style\/journal|journalStyle|journalPresets|ResolvedJournalStyle/.test(src),
      `${rel.split("/").pop()} imports NO journal-style module (editor stays venue-blind)`);
  }

  // figures.ts is the one editor-side module that MAY know about styles,
  // because it hosts the export-only projection — but only there.
  const figures = readFileSync("src/shell/modes/paper/scholar/figures.ts", "utf8");
  const exportFn = figures.slice(figures.indexOf("export function exportCtxFigures"));
  assert(/styledFamilyDef/.test(exportFn),
    "exportCtxFigures (the EXPORT projection) applies the style");
  // Match CALLS (trailing paren), not the import binding at the top of the file.
  const beforeExportFn = figures.slice(0, figures.indexOf("export function exportCtxFigures"));
  assert(!/styledFamilyDef\s*\(/.test(beforeExportFn),
    "…and nothing ABOVE it calls it — figureRefs, which the editor renders, stays unstyled");
  assert(/display: formatFamilyRef\(def,/.test(figures),
    "figureRefs' display still comes from the UNSTYLED family def");
}

console.log("\nWRITER-NEUTRAL VERIFY: PASS");
