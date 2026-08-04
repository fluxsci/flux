#!/usr/bin/env -S npx tsx
// Export-prep twin-engine parity (src/lib/exportPrep.ts).
//
// Quarto renders from DISK, so every export rewrites the manuscript tree in
// place and restores it afterwards. That dance used to exist twice — once in
// flux-core `compile`, once in PaperMode — each with its own include walker.
// It now lives in ONE shared core, and this gate pins that:
//   • the Node adapter (real fs) and an in-memory adapter (standing in for the
//     renderer's file bridge) produce BYTE-IDENTICAL trees from the same input
//   • restore() puts every source back byte-identical, and is idempotent
//   • a document the transform doesn't change is never rewritten (no mtime
//     churn — the §3 byte-identical-write invariant)
//   • a failing write mid-restore still restores the remaining files
//   Run: npx tsx scripts/verify-export-prep.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareExport, type ExportPrepIO } from "../src/lib/exportPrep";
import { BUILTIN_FAMILIES } from "../src/lib/figfamily";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

const [FIG, SUP] = BUILTIN_FAMILIES;
const ctx = {
  captions: new Map([["fig-growth", "Growth over time. **a**, Control."]]),
  figures: new Map([
    ["fig-growth", { family: FIG, number: 1 }],
    ["fig-dose", { family: SUP, number: 2 }],
  ]),
};

// A tree with an include, refs the transform rewrites, and one file it must
// leave completely alone.
const SOURCES: Record<string, string> = {
  "manuscript/main.qmd": [
    "---",
    "title: Test",
    "---",
    "",
    "See @fig-growth-a and @fig-dose.",
    "",
    "![](../fig/renders/growth.svg){#fig-growth width=91%}",
    "",
    "{{< include sections/methods.qmd >}}",
    "",
  ].join("\n"),
  "manuscript/sections/methods.qmd": "# Methods\n\nPanels @fig-growth-a-c here.\n",
  "manuscript/sections/untouched.qmd": "# Prose\n\nNo embeds, no refs at all.\n",
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-exportprep-"));
try {
  for (const [rel, text] of Object.entries(SOURCES)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  }
  const entryDisk = path.join(root, "manuscript/main.qmd");

  // --- engine 1: the Node adapter (what flux-core compile passes) -----------
  const diskIO: ExportPrepIO = {
    readText: (abs) => fs.readFile(abs, "utf8").catch(() => null),
    writeText: (abs, text) => fs.writeFile(abs, text),
    resolveFrom: (f, rel) => path.resolve(path.dirname(f), rel),
  };
  const diskPrep = await prepareExport(diskIO, { entry: entryDisk, ctx });
  const afterDisk = new Map<string, string>();
  for (const rel of Object.keys(SOURCES)) {
    afterDisk.set(rel, await fs.readFile(path.join(root, rel), "utf8"));
  }

  // --- engine 2: an in-memory adapter (stands in for the file bridge) -------
  // Keyed with POSIX-style absolute paths, exactly as the renderer builds them
  // (`${pm.root}/${activeDocPath}`), exercising the shared pure resolver.
  const mem = new Map<string, string>();
  for (const [rel, text] of Object.entries(SOURCES)) mem.set(`/proj/${rel}`, text);
  const memIO: ExportPrepIO = {
    readText: async (abs) => mem.get(abs) ?? null,
    writeText: async (abs, text) => void mem.set(abs, text),
  };
  const memPrep = await prepareExport(memIO, { entry: "/proj/manuscript/main.qmd", ctx });

  // --- parity ---------------------------------------------------------------
  for (const rel of Object.keys(SOURCES)) {
    assert(afterDisk.get(rel) === mem.get(`/proj/${rel}`),
      `both engines produce identical bytes for ${rel}`);
  }
  assert(
    JSON.stringify(diskPrep.files.map((f) => path.relative(root, f).split(path.sep).join("/"))) ===
      JSON.stringify(memPrep.files.map((f) => f.replace("/proj/", ""))),
    "both engines walk the same files in the same order",
  );
  assert(diskPrep.expanded === memPrep.expanded,
    "both engines expand the include tree identically");
  assert(diskPrep.expanded.includes("@fig-growth-a-c") && !diskPrep.expanded.includes("Fig. 1a–c"),
    "expanded text is the PRE-transform source (authored @fig- refs, not literalized)");
  assert(diskPrep.expanded.includes("{#fig-growth"),
    "expanded text keeps undemoted embed ids — what callers scan for embeds");

  // --- the transform actually ran ------------------------------------------
  assert(afterDisk.get("manuscript/main.qmd")!.includes("Fig. 1a and Fig. S2"),
    "refs literalized with family templates in the entry document");
  assert(afterDisk.get("manuscript/sections/methods.qmd")!.includes("Fig. 1a–c"),
    "refs literalized inside an INCLUDED file too");
  assert(afterDisk.get("manuscript/main.qmd")!.includes("{#x-fig-growth width=91%}"),
    "embed id demoted, attributes preserved");

  // --- untouched files are never rewritten ---------------------------------
  assert(afterDisk.get("manuscript/sections/untouched.qmd") === SOURCES["manuscript/sections/untouched.qmd"],
    "a file with nothing to transform is left byte-identical");
  const changedRel = diskPrep.changed.map((f) => path.relative(root, f).split(path.sep).join("/"));
  assert(!changedRel.includes("manuscript/sections/untouched.qmd"),
    "an unchanged file is not reported as changed (no mtime churn)");
  assert(changedRel.length === 2, `only the two transformed files were written (got ${changedRel.length})`);

  // --- restore --------------------------------------------------------------
  await diskPrep.restore();
  for (const [rel, text] of Object.entries(SOURCES)) {
    assert((await fs.readFile(path.join(root, rel), "utf8")) === text,
      `restore() puts ${rel} back byte-identical`);
  }
  await diskPrep.restore(); // second call must be a harmless no-op
  assert((await fs.readFile(entryDisk, "utf8")) === SOURCES["manuscript/main.qmd"],
    "restore() is idempotent — calling it twice does not re-apply anything");

  // --- a mid-restore failure must not abandon the remaining files -----------
  // The whole point of the export is that sources survive it; one bad write
  // may not strand the rest of the tree in transformed form.
  // Re-running the prep over ALREADY-transformed text must be a no-op: refs are
  // literalized and ids demoted once, so a second pass finds nothing to do.
  // (This is what makes an unrestored transform recoverable rather than
  // compounding — and it is why the flaky fixture below must start from the
  // pristine sources, not from `mem`, which the parity pass already rewrote.)
  const rerun = await prepareExport(memIO, { entry: "/proj/manuscript/main.qmd", ctx });
  assert(rerun.changed.length === 0, "transforming an already-transformed tree writes nothing");

  const flaky = new Map<string, string>();
  for (const [rel, text] of Object.entries(SOURCES)) flaky.set(`/proj/${rel}`, text);
  let failedOnce = false;
  const flakyPrep = await prepareExport(
    {
      readText: async (abs) => flaky.get(abs) ?? null,
      writeText: async (abs, text) => {
        // Fail the FIRST restore write only (the transform pass must succeed).
        if (!failedOnce && text === SOURCES["manuscript/main.qmd"]) {
          failedOnce = true;
          throw new Error("simulated write failure");
        }
        flaky.set(abs, text);
      },
    },
    { entry: "/proj/manuscript/main.qmd", ctx },
  );
  await flakyPrep.restore();
  assert(failedOnce, "the simulated restore failure actually fired");
  assert(flaky.get("/proj/manuscript/sections/methods.qmd") === SOURCES["manuscript/sections/methods.qmd"],
    "a failed write on one file still restores the others");

  console.log("\nEXPORT-PREP VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
