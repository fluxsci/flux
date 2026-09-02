// Document DELETION — the pure contract behind the Paper rail's × (and the
// `delete-doc` / `delete_document` verb): src/lib/project/docOrder.ts's
// removal half, plus flux-core's deleteDocument executed against a scratch
// project, plus the real CLI.
//
// What must hold, and why:
//   • the policy is ONE for both engines: the main manuscript and the Context
//     documents are refused, an unlisted path is refused, everything else may
//     go — the rail hides its × by the same predicate the verb refuses with
//   • deleting a document removes exactly its .qmd and its comments sidecar,
//     and the manifest forgets it (supplementary + documentOrder)
//   • NOTHING ELSE MOVES: fig/ (index + canvases + captions + assets),
//     references/, and every other document are byte-identical afterwards —
//     a document only references figures, it owns none of them
//   • a refusal is a no-op on disk, not a half-delete
//   Run: npx tsx scripts/verify-doc-delete.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "../flux-core/index";
import { harness } from "./lib/harness.mjs";
import {
  commentsSidecarRel,
  documentRemovalBlocker,
  pruneDocumentFromManifest,
  type DocRow,
} from "../src/lib/project/docOrder";

const h = harness("verify-doc-delete");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const M = "manuscript/main.qmd";
const S = "manuscript/supp.qmd";
const A = "manuscript/alpha.qmd";
const NB = "Context/NOTEBOOK.md";

const row = (p: string, title: string, extra: Partial<DocRow> = {}): DocRow => ({ path: p, title, isMain: false, ...extra });
const rows = (): DocRow[] => [
  row(M, "My Paper", { isMain: true }),
  row(S, "Supplementary Material"),
  row(A, "Alpha"),
  row(NB, "Notebook", { isContext: true }),
];

// --- the policy --------------------------------------------------------------
h.section("what may be deleted");
{
  h.eq(documentRemovalBlocker(rows(), S), null, "a supplementary document may be deleted");
  h.eq(documentRemovalBlocker(rows(), A), null, "…and so may a scanned section document");
  h.eq(documentRemovalBlocker(rows(), M)?.code, "main", "the main manuscript is refused");
  h.eq(documentRemovalBlocker(rows(), NB)?.code, "context", "a Context document is refused");
  h.eq(documentRemovalBlocker(rows(), "manuscript/ghost.qmd")?.code, "unknown", "an unlisted path is refused");
  h.ok(
    !!documentRemovalBlocker(rows(), M)?.reason && !!documentRemovalBlocker(rows(), NB)?.reason,
    "every refusal carries words for the user",
  );
}

// --- the sidecar -------------------------------------------------------------
h.section("the comments sidecar it takes with it");
{
  h.eq(commentsSidecarRel(M, M), "manuscript/comments.json", "the main manuscript keeps the historical comments.json");
  h.eq(commentsSidecarRel(M, S), "manuscript/supp.comments.json", "another document's sidecar is <base>.comments.json beside it");
  h.eq(commentsSidecarRel(M, NB), "Context/NOTEBOOK.comments.json", "…for .md documents too");
  h.eq(commentsSidecarRel("main.qmd", "supp.qmd"), "supp.comments.json", "…and with no directory at all");
}

// --- the manifest ------------------------------------------------------------
h.section("the manifest forgets it");
{
  const m = { supplementary: [{ path: S }, { path: A }], documentOrder: [A, M, S] };
  h.eq(pruneDocumentFromManifest(m, S), true, "pruning a registered, ordered document reports a change");
  h.eq(m.supplementary, [{ path: A }], "…it left supplementary");
  h.eq(m.documentOrder, [A, M], "…and the user's order, which keeps the rest intact");
  h.eq(pruneDocumentFromManifest(m, S), false, "pruning it again changes nothing");
  h.eq(pruneDocumentFromManifest({ supplementary: [{ path: A }] }, "manuscript/scanned.qmd"), false, "a scanned (unregistered) document has nothing to prune");
  const bare: { supplementary?: { path: string }[]; documentOrder?: string[] } = {};
  h.eq(pruneDocumentFromManifest(bare, S), false, "a manifest without either field is left alone");
  h.eq(Object.keys(bare), [], "…and gains no fields");
}

// --- flux-core, for real -----------------------------------------------------
h.section("flux-core deletes exactly the document");

/** Every file under `dir`, path → bytes, so "nothing else moved" is a byte check. */
async function snapshot(dir: string, skip: (rel: string) => boolean = () => false): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) await walk(p);
      else out.set(rel, (await fs.readFile(p)).toString("base64"));
    }
  };
  await walk(dir);
  return out;
}
function sameSnapshot(a: Map<string, string>, b: Map<string, string>): string[] {
  const diff: string[] = [];
  for (const [k, v] of a) if (b.get(k) !== v) diff.push(k);
  for (const k of b.keys()) if (!a.has(k)) diff.push(k);
  return diff;
}

const scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), "flux-doc-delete-home-"));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-doc-delete-"));
try {
  // A real project: scaffold gives fig/ + references/ + Context/, then three
  // documents, a comments sidecar for one, and a user order naming them all.
  process.env.HOME = scratchHome;
  process.env.XDG_CONFIG_HOME = path.join(scratchHome, ".config");
  await core.scaffold(root, { title: "My Paper" });
  const write = (rel: string, text: string) => fs.writeFile(path.join(root, rel), text, "utf8");
  await core.createDocument(root, "Supplementary Material");
  await core.createDocument(root, "Alpha");
  await write("manuscript/supplementary-material.qmd", `---\ntitle: "Supplementary Material"\n---\n\nSee @fig-one and [@smith2020].\n`);
  const SUPP = "manuscript/supplementary-material.qmd";
  const ALPHA = "manuscript/alpha.qmd";
  await write(commentsSidecarRel(M, SUPP), JSON.stringify({ version: 1, threads: [] }) + "\n");
  {
    const m = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
    m.documentOrder = [ALPHA, M, SUPP];
    await write("project.json", JSON.stringify(m, null, 2) + "\n");
  }
  const listed = (await core.listDocuments(root)).map((d) => d.path);
  h.ok(listed.includes(SUPP) && listed.includes(ALPHA), `the scratch project lists both documents (${listed.join(" · ")})`);
  h.ok(await core.exists(path.join(root, "fig", "index.json")), "…and has a fig/ tree to keep intact");

  const isDeleted = (rel: string) => rel === SUPP || rel === commentsSidecarRel(M, SUPP);
  const isBookkeeping = (rel: string) => rel === "project.json" || rel.startsWith(".meta");
  const before = await snapshot(root, (rel) => isDeleted(rel) || isBookkeeping(rel));

  const r = await core.deleteDocument(root, SUPP);
  h.eq(r.path, SUPP, "deleteDocument answers with the path it removed");
  h.eq(r.removed, [SUPP, commentsSidecarRel(M, SUPP)], "…and names the two files that went: the .qmd and its comments sidecar");
  h.ok(!(await core.exists(path.join(root, SUPP))), "the .qmd is gone");
  h.ok(!(await core.exists(path.join(root, commentsSidecarRel(M, SUPP)))), "its comments sidecar is gone");
  const m = JSON.parse(await fs.readFile(path.join(root, "project.json"), "utf8"));
  h.ok(!(m.supplementary ?? []).some((s: { path: string }) => s.path === SUPP), "the manifest no longer registers it");
  h.eq(m.documentOrder, [ALPHA, M], "…and the user's order forgets it, keeping the rest");
  h.eq((await core.listDocuments(root)).map((d) => d.path).includes(SUPP), false, "listDocuments no longer lists it");
  h.ok((await core.listDocuments(root)).map((d) => d.path).includes(ALPHA), "…while the other document is still listed");

  const after = await snapshot(root, (rel) => isDeleted(rel) || isBookkeeping(rel));
  const moved = sameSnapshot(before, after);
  h.eq(moved, [], `NOTHING ELSE MOVED — fig/, references/, Context/, the other documents are byte-identical${moved.length ? ` (changed: ${moved.join(", ")})` : ""}`);
  const journal = await fs.readFile(path.join(root, ".meta", "journal.ndjson"), "utf8").catch(() => "");
  h.ok(journal.split("\n").some((l) => l.includes('"delete_document"') && l.includes(SUPP)), "the journal records the deletion");

  // --- refusals are no-ops ---------------------------------------------------
  h.section("a refusal touches nothing");
  const pristine = await snapshot(root, (rel) => rel.startsWith(".meta"));
  const refuse = async (rel: string, code: string, why: string) => {
    let err: unknown = null;
    try {
      await core.deleteDocument(root, rel);
    } catch (e) {
      err = e;
    }
    const got = (err as { code?: string } | null)?.code;
    h.eq(got, code, `${why} → refused as "${code}"${err ? ` (${(err as Error).message})` : " — NOT refused"}`);
  };
  await refuse(M, "invalid", "the main manuscript");
  await refuse(NB, "invalid", "a Context document");
  await refuse("manuscript/ghost.qmd", "not-found", "an unlisted path");
  await refuse("../outside.qmd", "not-found", "a path outside the project");
  const still = sameSnapshot(pristine, await snapshot(root, (rel) => rel.startsWith(".meta")));
  h.eq(still, [], "…and the project is byte-identical after all four refusals");

  // --- the real CLI ----------------------------------------------------------
  h.section("the CLI verb executes it");
  {
    const tsx = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const env = { ...process.env, HOME: scratchHome, XDG_CONFIG_HOME: path.join(scratchHome, ".config") };
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [tsx, path.join(repoRoot, "flux-cli.ts"), ...args], { cwd: repoRoot, encoding: "utf8", env });
    const ok = run("delete-doc", ALPHA, "--root", root);
    h.eq(ok.status, 0, `delete-doc exits 0 (${ok.status})${ok.status ? ` — ${ok.stderr.slice(0, 300)}` : ""}`);
    h.ok(/✓ deleted manuscript\/alpha\.qmd/.test(ok.stderr), `…and reports it (${ok.stderr.trim().split("\n").pop()})`);
    h.ok(!(await core.exists(path.join(root, ALPHA))), "the CLI removed the file");
    const refused = run("delete-doc", M, "--root", root);
    h.ok(refused.status !== 0, `delete-doc on the main manuscript fails (${refused.status})`);
    h.ok(/main manuscript/.test(refused.stderr), "…with the shared policy's words");
    h.ok(await core.exists(path.join(root, M)), "…and the main manuscript is still there");
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(scratchHome, { recursive: true, force: true });
}

await h.done();
