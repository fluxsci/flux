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

import { planExportRecovery, publishExportRecovery, recoverExportSources, type ExportRecoveryIO } from "./project/exportRecovery";
import { readQmdTree, resolveInclude, transformQmdForExport, type ExportQmdCtx } from "./exportQmd";
import { reorderForExport, type RoleAliases } from "./manuscript/sections";
import { markCitations } from "./references/zoteroFields";

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
  signal?: AbortSignal;
  /** Production callers own the export lease and provide durable atomic IO. */
  recovery?: { root: string; id: string; io: ExportRecoveryIO };
  /** Figure captions + family identity for the transform. */
  ctx: ExportQmdCtx;
  /** Venue section order + the alias table that assigns roles. Applied to the
   *  ENTRY document only — includes are fragments, not orderable documents.
   *  Omit (or pass an empty order) for no reordering at all. */
  structure?: { order: readonly string[]; aliases: RoleAliases };
  /** Bracket each citation with markers naming its citekeys, so the exported .docx can
   *  be post-processed into live Zotero fields (see references/zoteroFields.ts). Off by
   *  default: the markers are meaningless to any other consumer. */
  markCitations?: boolean;
  /** Slide preparation shares its grammar/rendering with the document editor. */
  transformSlides?: (text: string, file: string) => Promise<string>;
  finishSlides?: (entryText: string) => Promise<string>;
  /** Redirect only the registered project bibliography to owned captured bytes.
   * Explicit additional/custom bibliography files retain their authored meaning. */
  capturedBibliography?: { originalPath: string; replacement: string };
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
  /** Headings the venue's order moved in the EXPORTED text (never the source).
   *  Surfaced so the move is visible rather than silent. */
  movedSections: string[];
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
 * Callers MUST invoke `restore()` in a `finally`. Production callers additionally
 * publish exact original/temporary bytes in a durable journal before any rewrite.
 */
export async function prepareExport(
  io: ExportPrepIO,
  opts: ExportPrepOpts,
): Promise<ExportPrepResult> {
  opts.signal?.throwIfAborted();
  const { files, texts, expanded } = await readQmdTree(opts.entry, io);
  if (opts.recovery) {
    for (const file of files) {
      if (!texts.has(file)) throw new Error(`Export include is unreadable: ${file}`);
      planExportRecovery(opts.recovery.root, opts.recovery.id, [[file, texts.get(file)!, texts.get(file)!]]);
      await opts.recovery.io.validatePath?.(file);
    }
  }
  const originals = new Map<string, string>(), transformed = new Map<string, string>();
  const written = new Set<string>();
  async function restore() {
    if (opts.recovery) { await recoverExportSources(opts.recovery.io, opts.recovery.root); written.clear(); return; }
    const failures: string[] = [];
    for (const f of [...written]) {
      try {
        // An edit made during export always wins. Never restore stale source over it.
        if (await io.readText(f) !== transformed.get(f)) { failures.push(`${f}: changed during export; newer content retained`); written.delete(f); continue; }
        await io.writeText(f, originals.get(f)!);
        written.delete(f);
      } catch (error) { failures.push(`${f}: ${String(error)}`); }
    }
    if (failures.length) throw new Error(`Export source restoration: ${failures.join("; ")}`);
  }

  let movedSections: string[] = [];
  for (const f of files) {
    opts.signal?.throwIfAborted();
    const text = texts.get(f);
    if (text == null) continue;
    let next = transformQmdForExport(text, opts.ctx);
    if (f === opts.entry && opts.capturedBibliography) {
      const { frontMatterBounds } = await import("../shell/modes/paper/frontmatter");
      const yaml = await import("js-yaml");
      const b = frontMatterBounds(next);
      const meta = b.has ? yaml.load(b.fmText) : {};
      if (meta == null || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Export front matter must be a mapping");
      const fields = meta as Record<string, unknown>;
      const captured = opts.capturedBibliography;
      const redirect = (value: unknown) => typeof value === "string" && (io.resolveFrom ?? resolveInclude)(f, value) === captured.originalPath ? captured.replacement : value;
      fields.bibliography = fields.bibliography === undefined ? captured.replacement : Array.isArray(fields.bibliography) ? fields.bibliography.map(redirect) : redirect(fields.bibliography);
      next = "---\n" + yaml.dump(fields, { lineWidth: -1 }) + "---\n" + (b.has ? next.slice(b.bodyStart) : next);
    }
    if (opts.transformSlides) next = await opts.transformSlides(next, f);
    if (opts.markCitations) next = markCitations(next);
    // Section order applies to the entry document only: an included fragment
    // has no top-level structure of its own to reorder.
    if (f === opts.entry && opts.structure?.order.length) {
      const r = reorderForExport(next, opts.structure.order, opts.structure.aliases);
      next = r.text;
      movedSections = r.moved;
    }
    if (next === text) continue;
    originals.set(f, text);
    transformed.set(f, next);
  }
  if (opts.finishSlides) {
    const original = texts.get(opts.entry);
    if (original != null) {
      const next = await opts.finishSlides(transformed.get(opts.entry) ?? original);
      if (next !== original) { originals.set(opts.entry, original); transformed.set(opts.entry, next); }
    }
  }
  // Seal the full recovery plan durably before the first authoring-file write.
  if (opts.recovery && transformed.size) {
    const { root, id, io: recoveryIO } = opts.recovery;
    await publishExportRecovery(recoveryIO, root, planExportRecovery(root, id, [...transformed].map(([f, next]) => [f, originals.get(f)!, next] as const)));
  }
  // All source and asset validation completes before the first document write.
  try {
    for (const [f, next] of transformed) {
      opts.signal?.throwIfAborted();
      if (await io.readText(f) !== originals.get(f)) throw new Error(`${f} changed while preparing export; retry`);
      await io.writeText(f, next);
      written.add(f);
    }
  } catch (error) {
    try { await restore(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Export preparation and source restoration failed"); }
    throw error;
  }
  return { files, expanded, changed: [...transformed.keys()], movedSections, restore };
}
