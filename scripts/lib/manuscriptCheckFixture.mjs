// Shared fixtures for the Manuscript Check gates (verify-manuscript-check.ts,
// verify-manuscript-check-gui.mjs).

/** The verify-scale-paper.mjs construct mix (embeds, tables, display math,
 *  citations every 25 lines, realistic paragraphs) plus abbreviations — the
 *  20k-line document the checks are budgeted against. */
export function scaleDoc(lines) {
  const out = ["---", 'title: "Scale probe"', "author: Flux", "---", ""];
  let embeds = 0, tables = 0, maths = 0;
  const embedEvery = Math.max(60, Math.floor(lines / 20)), tableEvery = Math.max(90, Math.floor(lines / 10)), mathEvery = Math.max(110, Math.floor(lines / 10));
  while (out.length < lines - 14) {
    const i = out.length;
    if (i % embedEvery === 37) out.push(`![](../fig/renders/f${embeds}.svg){#fig-scale${embeds++}}`);
    else if (i % tableEvery === 62) {
      out.push(`| Group | Mean ${tables} | SD |`, "|---|---|---|", "| control | 1.2 | 0.3 |", `| treated t${tables} | 2.4 | 0.5 |`);
      tables++;
    } else if (i % mathEvery === 87) {
      out.push("$$", `E_{${maths}} = m c^2 + \\alpha_{${maths}}`, "$$");
      maths++;
    } else if (i % 25 === 5) out.push(`See @fig-scale${i % 7} and [@smith${i % 40}2020; @lee2021] for $E=mc^2$ context with long-term potentiation (LTP).`);
    else if (i % 5 === 4) out.push("");
    else out.push(`Prose line ${i} — the quick brown fox jumps over the lazy dog again (n = 5) with LTP and DNA.`);
  }
  out.push("", "Typing anchor KEYPOINT sits in plain prose here.", "");
  while (out.length < lines) out.push(`Tail line ${out.length} of filler.`, "");
  return out.slice(0, lines).join("\n");
}

/** Seeded defects appended to the demo fixture's manuscript (which cites
 *  @fig-growth — panels a, b — and @smith2021). */
export const DEMO_DEFECTS = [
  "",
  "See @fig-missing and @fig-growht and [@ghost2020]. TODO: stats [??] [??].",
  "LTP rose. We measured long-term potentiation (LTP) twice.",
  "",
].join("\n");
