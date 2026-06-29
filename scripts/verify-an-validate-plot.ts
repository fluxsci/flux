#!/usr/bin/env -S npx tsx
// WS7: the FluxPlot contract — the shipped reference fixture validates, and the
// two common authoring bugs (a manifest id with no SVG element; a manifest missing
// specVersion) are caught. Run: npx tsx scripts/verify-an-validate-plot.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const REPO = path.resolve(import.meta.dirname, "..");
const fixture = path.join(REPO, "fixtures", "plots", "growth.svg");

// 1. the shipped reference fixture is a valid, fully-addressable FluxPlot.
let r = await core.validatePlot(fixture);
assert(r.ok, `reference fixture validates (${r.matched}/${r.references} ids matched)`);
assert(r.references >= 10 && r.matched === r.references, "every manifest id is present in the SVG");

// 2. a manifest id with no matching SVG element is caught.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "flux-plot-"));
try {
  const svg = await fs.readFile(fixture, "utf8");
  const manifest = await fs.readFile(fixture.replace(/\.svg$/, ".fluxplot.json"), "utf8");
  // remove one referenced id from the SVG
  const brokenSvg = svg.replace('id="control.point.1"', 'id="oops.renamed"');
  await fs.writeFile(path.join(tmp, "g.svg"), brokenSvg);
  await fs.writeFile(path.join(tmp, "g.fluxplot.json"), manifest);
  r = await core.validatePlot(path.join(tmp, "g.svg"));
  assert(!r.ok && r.errors.some((e) => e.includes("control.point.1")), "missing SVG id is caught");

  // 3. a manifest missing specVersion fails the schema.
  await fs.writeFile(path.join(tmp, "g.fluxplot.json"), JSON.stringify({ series: [] }));
  r = await core.validatePlot(path.join(tmp, "g.svg"));
  assert(!r.ok && r.errors.some((e) => e.includes("specVersion")), "manifest missing specVersion is caught");

  // 4. a plot with no manifest sidecar is flagged (not a semantic plot).
  await fs.rm(path.join(tmp, "g.fluxplot.json"));
  r = await core.validatePlot(path.join(tmp, "g.svg"));
  assert(!r.ok && r.errors.some((e) => /missing manifest/.test(e)), "no-manifest plot is flagged");

  console.log("\nALL FLUXPLOT-CONTRACT (WS7) TESTS PASSED");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
