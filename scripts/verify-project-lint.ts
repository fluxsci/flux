#!/usr/bin/env -S npx tsx
// Project lint + compile summary (moma feedback #12/#13).
//
// #13: `validate` warns (non-fatally) about EMPTY figures (they still occupy
// an order slot and shift figure numbers), figures embedded in no document,
// and overlapping canvas frames — the problems only a whole-canvas render
// used to expose, after the fact.
//
// #12: `compile` reports the produced artifact path and a compact
// figures/citations resolution summary (with the unresolved keys named).
// Requires `quarto` on PATH — same precedent as verify-an-manuscript.
//
// Run: npx tsx scripts/verify-project-lint.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-lint-"));
try {
  await core.scaffold(root, { title: "Lint" });
  const plotsDir = path.join(root, "plots");
  await fs.mkdir(plotsDir, { recursive: true });
  const plot = path.join(plotsDir, "p.svg");
  await fs.writeFile(
    plot,
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" fill="#dde"/></svg>`,
  );

  // A filled figure (embedded below), an EMPTY figure, and an overlapping pair.
  await core.composeFigure(root, [plot], { id: "figa", captionStub: false });
  await core.createFigure(root, { id: "figempty" });
  await core.composeFigure(root, [plot], { id: "figb", captionStub: false });
  await core.composeFigure(root, [plot], { id: "figc", captionStub: false });
  // Force figb/figc to the same spot on the canvas.
  await core.setFigureLayout(root, "figb", { x: 100, y: 100 });
  await core.setFigureLayout(root, "figc", { x: 150, y: 150 });

  await fs.appendFile(path.join(root, "references", "library.bib"), "@article{realkey2020,\n  title={T},\n  author={A},\n  year={2020},\n}\n");
  await fs.writeFile(
    path.join(root, "manuscript", "main.qmd"),
    `---\ntitle: "Lint"\nauthor: []\nbibliography: ../references/library.bib\n---\n\nSee @fig-figa, @realkey2020, and @missingkey1999.\n\n![](../fig/renders/figa.svg){#fig-figa}\n`,
  );

  // ---- #13 validate lint
  const v = await core.validate(root);
  assert(v.ok, "schema validation still passes (lint is non-fatal)");
  const warns = v.warnings ?? [];
  assert(warns.some((w) => w.includes("figempty") && w.includes("EMPTY")), "empty figure warned");
  assert(warns.some((w) => w.includes("figb") && !w.includes("EMPTY") && w.includes("not embedded")), "unembedded figure warned");
  assert(!warns.some((w) => w.includes("figa") && w.includes("not embedded")), "embedded figure NOT warned");
  assert(warns.some((w) => w.includes("OVERLAP") && w.includes("figb") && w.includes("figc")), "overlapping frames warned");

  // ---- #12 compile summary (skip cleanly when quarto is absent)
  let hasQuarto = true;
  try {
    execSync("quarto --version", { stdio: "ignore" });
  } catch {
    hasQuarto = false;
  }
  if (hasQuarto) {
    const r = await core.compile(root, "html");
    assert(r.code === 0, `quarto compiled (exit ${r.code})`);
    assert(!!r.output && (await fs.stat(r.output).then(() => true, () => false)), `output path reported and exists (${r.output})`);
    assert(r.figures?.embedded === 1 && r.figures.resolved === 1, `figures 1/1 resolved (got ${r.figures?.resolved}/${r.figures?.embedded})`);
    assert(r.citations?.keys === 2 && r.citations.resolved === 1, `citations 1/2 resolved (got ${r.citations?.resolved}/${r.citations?.keys})`);
    assert(r.citations!.missing.join() === "missingkey1999", `unresolved key named (got ${r.citations?.missing.join()})`);
  } else {
    console.log("  (skip: quarto not on PATH — compile summary not exercised)");
  }

  console.log("\nALL PROJECT-LINT TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
