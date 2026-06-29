#!/usr/bin/env -S npx tsx
// WS2: JSON schemas shipped into .meta/schema/, a valid project passes, and a
// malformed write is caught. Run: npx tsx scripts/verify-an-validate.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-validate-"));
try {
  await core.scaffold(root, { title: "Validate Test" });

  // schemas shipped + AGENTS.md refreshed
  const schemas = await fs.readdir(path.join(root, ".meta", "schema"));
  assert(schemas.length >= 6 && schemas.includes("canvas.schema.json"), `6 schemas shipped (${schemas.length})`);
  const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
  assert(agents.includes("compose-figure") && agents.includes("Live bridge") && agents.includes(".meta/schema/"),
    "AGENTS.md documents the two-tier verbs, live bridge, and schemas");

  // a freshly scaffolded project validates clean
  let res = await core.validate(root);
  assert(res.ok && res.checked >= 2, `scaffold validates clean (${res.checked} checked)`);

  // compose a figure → canvas file is written → still valid
  const plots = path.join(root, "plots");
  await fs.mkdir(plots, { recursive: true });
  for (let i = 0; i < 3; i++)
    await fs.writeFile(path.join(plots, `p${i}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150" viewBox="0 0 200 150"><rect width="200" height="150" fill="#eef"/></svg>`);
  await core.composeFigure(root, [0, 1, 2].map((i) => path.join(plots, `p${i}.svg`)), { id: "fig1", rows: 1 });
  res = await core.validate(root);
  assert(res.ok, `valid after compose-figure (${res.checked} checked)`);

  // single-file validation
  res = await core.validate(root, "fig/index.json");
  assert(res.ok && res.checked === 1, "single-file validate (fig/index.json) ok");

  // corrupt a canvas file: drop an element's required `id` → must be caught
  const canvasFiles = await fs.readdir(path.join(root, "fig", "canvases"));
  const cpath = path.join(root, "fig", "canvases", canvasFiles[0]);
  const cf = JSON.parse(await fs.readFile(cpath, "utf8"));
  delete cf.figures[0].elements[0].id;
  await fs.writeFile(cpath, JSON.stringify(cf, null, 2));
  res = await core.validate(root);
  assert(!res.ok && res.errors.some((e) => /canvases/.test(e) && /id/.test(e)),
    `malformed canvas element caught (${res.errors[0] ?? ""})`);

  // a manifest missing specVersion fails single-file validation
  await fs.writeFile(path.join(plots, "bad.fluxplot.json"), JSON.stringify({ series: [] }));
  res = await core.validate(root, "plots/bad.fluxplot.json");
  assert(!res.ok && res.errors.some((e) => /specVersion/.test(e)), "manifest missing specVersion caught");

  console.log("\nALL VALIDATE (WS2) TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
