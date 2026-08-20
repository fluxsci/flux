// Document ORDER — the pure contract behind the Paper rail's drag-to-reorder
// Documents list (src/lib/project/docOrder.ts), and the parity that makes it
// safe: BOTH engines list a project's documents (the GUI's
// paper/documents/documents.ts and flux-core's manuscript.ts, which the
// `documents` verb renders), so the order has to be decided in one place or an
// agent and the user end up looking at different lists.
//
// What must hold, and why:
//   • with no `documentOrder`, the order is EXACTLY the historical default
//     (main first, then title; the Context group last, mission→notebook→rules)
//     — an existing project must not shuffle the day this ships
//   • a recorded order wins, and it is order ONLY: no file is renamed or moved
//   • it self-heals a scan: a path that no longer exists is ignored, and a
//     document the order has never seen sorts last within its group
//   • a move lands where the drag pointed, clamps at the ends, and the two
//     groups (Documents / Context) never bleed into each other
//   • flux-core's twin produces the same list as the GUI's, for the same order
//   Run: npx tsx scripts/verify-doc-order.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";
import { harness } from "./lib/harness.mjs";
import { reorderDocuments, sortDocuments, type DocRow } from "../src/lib/project/docOrder";

const h = harness("verify-doc-order");

const row = (p: string, title: string, extra: Partial<DocRow> = {}): DocRow => ({
  path: p,
  title,
  isMain: false,
  ...extra,
});

const paths = (rows: DocRow[]) => rows.map((r) => r.path);

// main + three siblings, deliberately NOT in alphabetical order in the array.
const four = (): DocRow[] => [
  row("manuscript/zeta.qmd", "Zeta"),
  row("manuscript/main.qmd", "My Paper", { isMain: true }),
  row("manuscript/supp.qmd", "Supplementary Material"),
  row("manuscript/alpha.qmd", "Alpha"),
];

const M = "manuscript/main.qmd";
const A = "manuscript/alpha.qmd";
const S = "manuscript/supp.qmd";
const Z = "manuscript/zeta.qmd";

// --- the default, unchanged --------------------------------------------------
h.section("no recorded order = the historical default");
{
  h.eq(paths(sortDocuments(four())), [M, A, S, Z], "main first, then the rest by title");
  h.eq(paths(sortDocuments(four(), [])), [M, A, S, Z], "an empty order is the same as none");
  const rows = [
    row("Context/RULES.md", "Rules", { isContext: true }),
    row("manuscript/main.qmd", "My Paper", { isMain: true }),
    row("Context/Project/MISSION.qmd", "Mission", { isContext: true }),
    row("Context/NOTEBOOK.md", "Notebook", { isContext: true }),
    row("manuscript/alpha.qmd", "Alpha"),
  ];
  h.eq(
    paths(sortDocuments(rows)),
    [M, A, "Context/Project/MISSION.qmd", "Context/NOTEBOOK.md", "Context/RULES.md"],
    "the Context group is last, in mission → notebook → rules order",
  );
}

// --- a recorded order wins ---------------------------------------------------
h.section("the user's order");
{
  h.eq(paths(sortDocuments(four(), [Z, S, A, M])), [Z, S, A, M], "the list follows documentOrder");
  h.eq(
    paths(sortDocuments(four(), [Z])),
    [Z, M, A, S],
    "a partly-covering order ranks what it names and defaults the rest after it",
  );
  h.eq(
    paths(sortDocuments(four(), [Z, "manuscript/gone.qmd", A])),
    [Z, A, M, S],
    "a path that no longer exists is ignored (the list is a scan)",
  );
  h.eq(paths(sortDocuments(four(), [Z, Z, A])), [Z, A, M, S], "a duplicated path is ranked once");
  const rows = four();
  const before = JSON.stringify(rows);
  sortDocuments(rows, [Z, A]);
  h.eq(JSON.stringify(rows), before, "sorting never mutates the caller's array");
}

// --- moving one row ----------------------------------------------------------
h.section("one row");
{
  const rows = four(); // display order: main, Alpha, supp, Zeta
  h.eq(reorderDocuments(rows, undefined, [Z], 0), [Z, M, A, S], "drag the last row to the top");
  h.eq(reorderDocuments(rows, undefined, [M], 3), [A, S, Z, M], "drag the main document to the end");
  h.eq(reorderDocuments(rows, undefined, [A], 2), [M, S, A, Z], "drag one row down by one");
  h.eq(reorderDocuments(rows, undefined, [A], 1), [M, A, S, Z], "moving a row onto itself is a no-op");
  h.eq(reorderDocuments(rows, undefined, [Z], 99), [M, A, S, Z], "an out-of-range target clamps to the end");
  h.eq(reorderDocuments(rows, undefined, [M], -5), [M, A, S, Z], "a negative target clamps to the front");
  h.eq(reorderDocuments(rows, undefined, ["manuscript/ghost.qmd"], 0), [M, A, S, Z], "an unknown path changes nothing");
  h.eq(reorderDocuments(rows, undefined, [], 0), [M, A, S, Z], "an empty pick changes nothing");
}
{
  // A second move composes on the first — the recorded order is the input.
  const rows = four();
  const once = reorderDocuments(rows, undefined, [Z], 0);
  h.eq(reorderDocuments(rows, once, [S], 0), [S, Z, M, A], "a second drag builds on the recorded order");
}
{
  const rows = four();
  const out = reorderDocuments(rows, undefined, [Z], 0);
  h.eq(out.length, rows.length, "the result names EVERY document, not just the moved one");
  h.eq(
    paths(sortDocuments(rows, out)),
    out,
    "…so re-sorting by it reproduces the arrangement exactly (a retitle can't reshuffle it)",
  );
}

// --- several rows ------------------------------------------------------------
h.section("a multi-row pick moves as one block");
{
  const rows = four();
  h.eq(reorderDocuments(rows, undefined, [S, Z], 0), [S, Z, M, A], "a contiguous pair moves as one block");
  h.eq(reorderDocuments(rows, undefined, [Z, S], 0), [S, Z, M, A], "the pick's own order is irrelevant — list order is kept");
  h.eq(reorderDocuments(rows, undefined, [M, S], 1), [A, M, S, Z], "a non-adjacent pick lands contiguous, relative order kept");
  h.eq(reorderDocuments(rows, undefined, [M, A, S, Z], 0), [M, A, S, Z], "picking everything is a no-op");
}

// --- the two groups are separate lists ---------------------------------------
h.section("Documents and Context never bleed together");
{
  const rows = [
    row("manuscript/main.qmd", "My Paper", { isMain: true }),
    row("manuscript/alpha.qmd", "Alpha"),
    row("Context/Project/MISSION.qmd", "Mission", { isContext: true }),
    row("Context/NOTEBOOK.md", "Notebook", { isContext: true }),
  ];
  h.eq(
    reorderDocuments(rows, undefined, [A], 1),
    [M, A, "Context/Project/MISSION.qmd", "Context/NOTEBOOK.md"],
    "a document move leaves the Context group untouched, still last",
  );
  h.eq(
    reorderDocuments(rows, undefined, ["Context/NOTEBOOK.md"], 0),
    [M, A, "Context/NOTEBOOK.md", "Context/Project/MISSION.qmd"],
    "a Context row reorders inside its own group, below the documents",
  );
  h.eq(
    reorderDocuments(rows, undefined, [A, "Context/NOTEBOOK.md"], 0),
    [A, M, "Context/Project/MISSION.qmd", "Context/NOTEBOOK.md"],
    "a foreign-group path in the pick is ignored, not dragged across",
  );
  const ctxFirst = reorderDocuments(rows, undefined, ["Context/NOTEBOOK.md"], 0);
  h.ok(
    sortDocuments(rows, ctxFirst).every((r, i, all) => i === 0 || !all[i - 1].isContext || r.isContext),
    "…and no ordering can lift a Context document above a manuscript one",
  );
}

// --- order only --------------------------------------------------------------
h.section("order only");
{
  const rows = four();
  const before = new Map(rows.map((r) => [r.path, JSON.stringify(r)]));
  const out = reorderDocuments(rows, undefined, [Z], 0);
  h.ok(
    sortDocuments(rows, out).every((r) => JSON.stringify(r) === before.get(r.path)),
    "every row is the same row — path, title and main-ness are untouched (no file is renamed or moved)",
  );
}

// --- both engines list it the same way ---------------------------------------
h.section("flux-core's twin lists the same order");
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-doc-order-"));
  try {
    await fs.mkdir(path.join(root, "manuscript"), { recursive: true });
    await fs.mkdir(path.join(root, "references"), { recursive: true });
    const write = (rel: string, title: string) =>
      fs.writeFile(path.join(root, rel), `---\ntitle: "${title}"\n---\n\nbody\n`, "utf8");
    await write("manuscript/main.qmd", "My Paper");
    await write("manuscript/alpha.qmd", "Alpha");
    await write("manuscript/supp.qmd", "Supplementary Material");
    await write("manuscript/zeta.qmd", "Zeta");
    const manifest = {
      schemaVersion: "0.1.0",
      id: "p1",
      slug: "p1",
      title: "My Paper",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
      authors: [],
      manuscript: { path: "manuscript/main.qmd" },
      supplementary: [{ path: "manuscript/supp.qmd" }],
      references: { library: "references/library.bib" },
      figures: [],
      slides: [],
      capabilities: {},
    } as Record<string, unknown>;
    const writeManifest = () =>
      fs.writeFile(path.join(root, "project.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await writeManifest();

    h.eq(
      (await core.listDocuments(root)).map((d) => d.path),
      [M, A, S, Z],
      "with no recorded order, the CLI's list is the default one",
    );
    manifest.documentOrder = [Z, M, S, A];
    await writeManifest();
    h.eq(
      (await core.listDocuments(root)).map((d) => d.path),
      [Z, M, S, A],
      "…and it follows documentOrder once the user has arranged the rail",
    );
    // The GUI twin reads the same manifest field through the same core, so the
    // check that matters is that the two agree for the same input.
    const rows = (await core.listDocuments(root)).map((d) => ({ ...d }));
    h.eq(
      paths(sortDocuments(rows, manifest.documentOrder as string[])),
      [Z, M, S, A],
      "the GUI's sort over flux-core's rows gives the identical list",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await h.done();
