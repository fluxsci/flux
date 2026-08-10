#!/usr/bin/env -S npx tsx
// Pure gate (hermetic): every non-network FluxLib writer must honor `libPath` on BOTH halves
// of its work — the library write as well as the project/attachment write.
//
// Why this exists (2026-08-10): `addReference(root, bibtex)` sandboxes only the PROJECT half.
// Its library half went to the machine-global FluxLib, so verify-f1-core.ts — a `pure`-tier
// script, run on every `npm test` — filed its `A study` (2020) fixture into the developer's
// real ~/FluxConfig/FluxLib/library.bib on every single run. Thirteen of them accumulated in
// the owner's 1669-entry library before anyone noticed, each one deliberately re-keyed
// (smith2020, anonStudy2020, anonStudy2020a…k) because a DOI-less fixture can never dedupe.
// `importReferences` had the same defect in a subtler form: it threaded libPath to the PDF and
// fulltext writes but dropped it on the bib write, so a sandboxed import split in two.
//
// The manifest's own tier contract says pure means "no real ~/FluxLib mutation". This gate is
// what makes that claim enforceable rather than aspirational.
//   Run: npx tsx scripts/verify-hermetic-fluxlib.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let fails = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !extra ? "" : ` — ${extra}`}`);
  if (!cond) fails++;
};

// --- hermetic env: HOME + XDG into a scratch dir BEFORE flux-core loads ------------------
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "flux-hermetic-lib-"));
const home = path.join(scratch, "home");
fs.mkdirSync(path.join(home, ".config"), { recursive: true });
const realEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FLUX_NO_MIGRATE: process.env.FLUX_NO_MIGRATE };
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.FLUX_NO_MIGRATE = "1";

// The machine-global library this whole gate exists to keep clean. `scaffold`/`ensureFluxConfig`
// legitimately create an EMPTY skeleton here, so the contract is "no ENTRY lands in it".
const globalBib = path.join(home, "FluxConfig", "FluxLib", "library.bib");
const globalEntries = () =>
  fs.existsSync(globalBib) ? (fs.readFileSync(globalBib, "utf8").match(/^@/gm) ?? []).length : 0;
const entriesIn = (lib: string) => {
  const p = path.join(lib, "library.bib");
  return fs.existsSync(p) ? (fs.readFileSync(p, "utf8").match(/^@/gm) ?? []).length : 0;
};
const tempLib = (name: string) => path.join(scratch, `lib-${name}`);

const BIB = (key: string, title: string) => `@article{${key}, title={${title}}, author={Testerson, T}, year={2020}}`;

const run = async () => {
  const core = await import("../flux-core/index");

  // --- addReference: library half + project half, both sandboxed -------------------------
  {
    const lib = tempLib("addref");
    const proj = path.join(scratch, "proj-addref");
    await core.scaffold(proj, { title: "Hermetic", author: "Me" });
    await core.addReference(proj, BIB("hermeticAddRef2020", "A sandboxed add-reference"), { libPath: lib });
    ok(entriesIn(lib) === 1, "addReference: entry lands in the libPath FluxLib", `got ${entriesIn(lib)}`);
    ok(
      fs.readFileSync(path.join(proj, "references/library.bib"), "utf8").includes("hermeticAddRef2020"),
      "addReference: entry also materializes into the project's cited subset",
    );
    ok(globalEntries() === 0, "addReference: machine-global FluxLib gains NO entry", `got ${globalEntries()}`);
  }

  // --- addToLibrary: library-only writer --------------------------------------------------
  {
    const lib = tempLib("addlib");
    await core.addToLibrary(BIB("hermeticAddLib2020", "A sandboxed library add"), { libPath: lib });
    ok(entriesIn(lib) === 1, "addToLibrary: entry lands in the libPath FluxLib", `got ${entriesIn(lib)}`);
    ok(globalEntries() === 0, "addToLibrary: machine-global FluxLib gains NO entry", `got ${globalEntries()}`);
  }

  // --- importReferences: the bib write must honor libPath, not just the attachment writes --
  {
    const lib = tempLib("import");
    const bib = [BIB("hermeticImportA2020", "A sandboxed bulk import"), BIB("hermeticImportB2020", "Another sandboxed import")].join("\n");
    const report = await core.importReferences(bib, { libPath: lib });
    ok(report.added.length === 2, "importReferences: reports 2 added", `got ${report.added.length}`);
    ok(entriesIn(lib) === 2, "importReferences: BOTH entries land in the libPath FluxLib", `got ${entriesIn(lib)}`);
    ok(globalEntries() === 0, "importReferences: machine-global FluxLib gains NO entry", `got ${globalEntries()}`);
  }

  // The standing invariant, restated once at the end over everything above.
  ok(globalEntries() === 0, "no writer put an entry in the machine-global library.bib", `got ${globalEntries()}`);
};

run()
  .catch((e) => {
    console.error("✗ threw:", e instanceof Error ? e.message : e);
    fails++;
  })
  .finally(() => {
    process.env.HOME = realEnv.HOME;
    if (realEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = realEnv.XDG_CONFIG_HOME;
    if (realEnv.FLUX_NO_MIGRATE === undefined) delete process.env.FLUX_NO_MIGRATE;
    else process.env.FLUX_NO_MIGRATE = realEnv.FLUX_NO_MIGRATE;
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* scratch is in tmp either way */
    }
    console.log(`\n##VERIFY## ${JSON.stringify({ name: "hermetic-fluxlib", pass: fails === 0, fails })}`);
    process.exit(fails ? 1 : 0);
  });
