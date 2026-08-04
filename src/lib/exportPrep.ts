// The ONE export preparation core — shared by the GUI (Paper mode) and
// headless flux-core `compile`.
//
// Quarto renders from DISK, and Flux's canonical manuscript is not what Quarto
// should see: canonical embeds carry an empty alt (the figure model owns
// captions) and refs are `@fig-…` labels that Quarto would number its own way.
// So every export transforms the source tree in place, renders, and restores
// the originals byte-identically in a `finally`.
//
// Both engines used to carry their own copy of that dance (and their own
// include walker, and their own INCLUDE_RE). They now call `prepareExport`,
// which returns the restore closure. IO is injected — flux-core passes node:fs
// with atomic writes, the renderer passes its file bridge — so this module
// stays pure (no Svelte, no DOM, no Node) and both worlds load it.
//
// Twin-engine shared core (flux-core → src/lib); gated by
// scripts/verify-export-prep.ts.

import { readQmdTree, transformQmdForExport, type ExportQmdCtx } from "./exportQmd";

export interface ExportPrepIO {
  /** Read a file; resolve to null when it can't be read. */
  readText(abs: string): Promise<string | null>;
  /** Write a file. flux-core supplies an ATOMIC write; the GUI its bridge. */
  writeText(abs: string, text: string): Promise<void>;
  /** Resolve an include target; defaults to the shared pure resolver. */
  resolveFrom?: (includingFile: string, rel: string) => string;
}

export interface ExportPrepOpts {
  /** Absolute path of the entry document. */
  entry: string;
  /** Figure captions + family identity for the transform. */
  ctx: ExportQmdCtx;
}

export interface ExportPrepResult {
  /** Every file in the include tree, traversal order, entry first. */
  files: string[];
  /** The ORIGINAL (pre-transform) tree with includes spliced in — what callers
   *  scan for authored `{#fig-…}` embeds and `@citekey` citations, which the
   *  transform rewrites. Computing it post-transform would miss every embed. */
  expanded: string;
  /** Files this prep actually rewrote (a no-op transform writes nothing). */
  changed: string[];
  /** Restore every rewritten file to its original bytes. Always safe to call,
   *  and safe to call twice — the second call is a no-op. */
  restore(): Promise<void>;
}

/**
 * Transform an entire include tree for a Quarto render and hand back the undo.
 *
 * Byte-identical results are never written: a document with no embeds and no
 * `@fig-` refs is left completely untouched, so an export cannot churn mtimes
 * (the §3 persistence invariant) or trip the divergence watcher.
 *
 * Callers MUST invoke `restore()` in a `finally`. Note that even an unrestored
 * transform leaves a valid, readable manuscript — the transform only bakes
 * captions and literalizes references.
 */
export async function prepareExport(
  io: ExportPrepIO,
  opts: ExportPrepOpts,
): Promise<ExportPrepResult> {
  const { files, texts, expanded } = await readQmdTree(opts.entry, io);
  const originals = new Map<string, string>();

  for (const f of files) {
    const text = texts.get(f);
    if (text == null) continue;
    const transformed = transformQmdForExport(text, opts.ctx);
    if (transformed === text) continue;
    originals.set(f, text);
    await io.writeText(f, transformed);
  }

  let restored = false;
  return {
    files,
    expanded,
    changed: [...originals.keys()],
    async restore() {
      if (restored) return;
      restored = true;
      // Restore every file even if one write fails — a partial restore is far
      // worse than a failed one, so no single error may abort the loop.
      for (const [f, text] of originals) {
        try {
          await io.writeText(f, text);
        } catch {
          /* best effort: keep restoring the rest */
        }
      }
    },
  };
}
