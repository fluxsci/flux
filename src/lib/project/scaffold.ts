// GUI half of the project scaffolder. The tree itself lives in ONE shared source —
// scaffoldTree.ts (AGT-15) — consumed identically by flux-core's `flux new`, so
// GUI- and CLI-created projects can never drift again. This file only supplies the
// I/O (the file bridge) and the FluxLib bootstrap.

import { fileBridge, joinPath } from "./types";
import { buildScaffoldTree, type ScaffoldOptions } from "./scaffoldTree";
import { ensureFluxLib } from "../references/fluxlibBridge";
import { createDeck as createStarterDeck } from "../slide/ops";

export type { ScaffoldOptions } from "./scaffoldTree";

/**
 * Create a new project at `root` (a directory path that may not exist yet).
 * Writes the full barebones tree. Returns the root.
 */
export async function scaffoldProject(
  root: string,
  opts: ScaffoldOptions,
): Promise<string> {
  const fig = fileBridge();
  if (!fig) throw new Error("No file bridge available (not running in the app).");

  // Seed a starter deck (the Slide pillar) so a fresh project opens with a deck.
  const tree = buildScaffoldTree(opts, createStarterDeck({ title: opts.title }));
  for (const d of tree.dirs) await fig.mkdir(joinPath(root, d));
  for (const [rel, text] of tree.files) await fig.writeText(joinPath(root, rel), text);

  // Guarantee the machine-global FluxLib exists (best-effort; never blocks the
  // new-project flow). The project bib fills as references are cited.
  try {
    await ensureFluxLib();
  } catch {
    /* FluxLib bootstrap is non-fatal for project creation */
  }

  return root;
}
