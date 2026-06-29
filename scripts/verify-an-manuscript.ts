#!/usr/bin/env -S npx tsx
// WS1 (Paper side): the manuscript/documents/compile verbs over Node fs.
// Run: npx tsx scripts/verify-an-manuscript.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-manu-"));
try {
  await core.scaffold(root, { title: "My Paper" });

  // get / set manuscript
  const stub = await core.getManuscript(root);
  assert(stub.includes("# Introduction"), "getManuscript returns the scaffold stub");
  await core.setManuscript(root, "---\ntitle: \"My Paper\"\n---\n\n# Results\n\nFresh prose.\n");
  assert((await core.getManuscript(root)).includes("Fresh prose."), "setManuscript round-trips");

  // documents: main + a new supplementary
  let docs = await core.listDocuments(root);
  assert(docs.length === 1 && docs[0].isMain && docs[0].title === "My Paper", "listDocuments sees the main doc with its title");
  const created = await core.createDocument(root, "Supplementary Methods");
  assert(created.path === "manuscript/supplementary-methods.qmd", `createDocument path (${created.path})`);
  const manifest = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  assert(manifest.supplementary.some((s: { path: string }) => s.path === created.path), "new doc registered in manifest");
  docs = await core.listDocuments(root);
  assert(docs.length === 2 && !docs.find((d) => d.path === created.path)!.isMain, "listDocuments now sees 2 docs");

  // figure cross-ref insertion resolves figId → @fig-<label>
  await core.createFigure(root, { id: "growth", name: "Growth" });
  const r = await core.insertFigureRef(root, "growth");
  assert(r.ref === "@fig-growth", `insertFigureRef returns ${r.ref}`);
  assert((await core.getManuscript(root)).includes("See @fig-growth."), "manuscript now references the figure");

  // compile + citeDoi exist and fail gracefully without quarto / network.
  assert(typeof core.compile === "function" && typeof core.citeDoi === "function", "compile + citeDoi exported");
  try {
    const c = await core.compile(root, "html");
    console.log("  ok: compile ran (quarto present), exit", c.code);
  } catch (e) {
    assert(String((e as Error).message).includes("quarto"), "compile errors clearly when quarto is absent");
  }

  console.log("\nALL MANUSCRIPT VERB TESTS PASSED");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
