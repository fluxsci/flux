/** Durable Quarto rewrite recovery, shared by renderer and Node adapters.
 * Call only while owning the project's `export` operation lease. */
export interface ExportRecoveryIO {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  stat?(path: string): Promise<{ atimeMs?: number; mtimeMs: number } | null>;
  setTimes?(path: string, times: { atimeMs: number; mtimeMs: number }): Promise<void>;
  /** Host-side realpath/confinement validation, including directory symlinks. */
  validatePath?(path: string): Promise<void>;
  fsyncDir?(path: string): Promise<void>;
  assertOwned?(): Promise<void>;
}
export const EXPORT_RECOVERY_FILE = ".meta/export-source-transaction.json";
export interface ExportRecoveryJournal {
  version: 1;
  id: string;
  generated?: { path: string; content: string }[];
  files: { path: string; original: string; transformed: string; times?: { atimeMs: number; mtimeMs: number } }[];
}
const canonicalRoot = (root: string) => root.replace(/\\/g, "/").replace(/\/$/, "");
function recoveryPath(root: string, relative: string): string {
  if (!relative || /^(?:[/\\]|[a-z]+:)/i.test(relative) || relative.includes("\\") || relative.split("/").some(p => !p || p === "." || p === "..") || relative.includes("\0")) throw new Error("Invalid export recovery source path");
  return `${canonicalRoot(root)}/${relative}`;
}
export function exportJournalPath(root: string): string { return recoveryPath(root, EXPORT_RECOVERY_FILE); }
export function planExportRecovery(root: string, id: string, files: Iterable<readonly [string, string, string]>): ExportRecoveryJournal {
  const prefix = `${canonicalRoot(root)}/`;
  return { version: 1, id, files: Array.from(files, ([path, original, transformed]) => {
    const normalized = path.replace(/\\/g, "/");
    if (!normalized.startsWith(prefix)) throw new Error("Export include is outside the project");
    const relative = normalized.slice(prefix.length);
    recoveryPath(root, relative);
    return { path: relative, original, transformed };
  }) };
}
function parseJournal(text: string, root: string): ExportRecoveryJournal {
  const value = JSON.parse(text);
  if (value?.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.files)) throw new Error("Unsupported export recovery journal; original source retained");
  const seen = new Set<string>();
  for (const file of value.files) {
    if (typeof file?.path !== "string" || typeof file.original !== "string" || typeof file.transformed !== "string") throw new Error("Malformed export recovery journal; original source retained");
    recoveryPath(root, file.path);
    if (file.times && (!Number.isFinite(file.times.atimeMs) || !Number.isFinite(file.times.mtimeMs))) throw new Error("Invalid export source timestamps");
    if (seen.has(file.path)) throw new Error("Duplicate export recovery source path");
    seen.add(file.path);
  }
  if (value.generated !== undefined && !Array.isArray(value.generated)) throw new Error("Malformed generated resource recovery plan");
  for (const file of value.generated ?? []) { if (typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Malformed generated resource"); recoveryPath(root,file.path); }
  return value;
}
/** Idempotent compare-and-restore. Unexpected newer bytes ALWAYS win. */
export async function recoverExportSources(io: ExportRecoveryIO, root: string): Promise<void> {
  const path = exportJournalPath(root);
  await io.validatePath?.(path);
  const text = await io.readText(path);
  if (text === null) return;
  const journal = parseJournal(text, root);
  const failures: string[] = [];
  // Validate the entire journal before the first restoration write.
  for (const file of journal.files) await io.validatePath?.(recoveryPath(root, file.path));
  for (const file of journal.generated ?? []) await io.validatePath?.(recoveryPath(root, file.path));
  for (const file of journal.files) {
    const source = recoveryPath(root, file.path);
    try {
      const current = await io.readText(source);
      if (current === file.original) { if (file.times && io.setTimes) { await io.assertOwned?.(); await io.setTimes(source, file.times); } continue; }
      if (current !== file.transformed) { failures.push(`${file.path}: changed or missing; newer content retained`); continue; }
      await io.assertOwned?.(); await io.writeText(source, file.original);
      if (file.times && io.setTimes) { await io.assertOwned?.(); await io.setTimes(source, file.times); }
      await io.fsyncDir?.(source.slice(0,source.lastIndexOf("/")));
    } catch (error) { failures.push(`${file.path}: ${String(error)}`); }
  }
  for (const file of journal.generated ?? []) {
    const generated = recoveryPath(root, file.path);
    try {
      await io.validatePath?.(generated);
      const current = await io.readText(generated);
      if (current === null) continue;
      if (current !== file.content) { failures.push(`${file.path}: generated resource changed; newer content retained`); continue; }
      await io.assertOwned?.(); await io.removeFile(generated); await io.fsyncDir?.(generated.slice(0, generated.lastIndexOf("/")));
    } catch (error) { failures.push(`${file.path}: ${String(error)}`); }
  }
  if (failures.length) throw new Error(`Export recovery needs attention (${path} retains original text): ${failures.join("; ")}`);
  await io.assertOwned?.(); await io.removeFile(path);
  await io.fsyncDir?.(path.slice(0,path.lastIndexOf("/")));
}
export async function publishExportRecovery(io: ExportRecoveryIO, root: string, journal: ExportRecoveryJournal): Promise<void> {
  await recoverExportSources(io, root);
  for (const file of journal.files) {
    const source = recoveryPath(root, file.path);
    await io.validatePath?.(source);
    if (await io.readText(source) !== file.original) throw new Error(`${file.path} changed while preparing export; retry`);
    const stat = await io.stat?.(source);
    if (stat && io.setTimes) file.times = { atimeMs: stat.atimeMs ?? stat.mtimeMs, mtimeMs: stat.mtimeMs };
  }
  if (journal.files.length) { await io.assertOwned?.(); await io.writeText(exportJournalPath(root), JSON.stringify(journal)); await io.fsyncDir?.(`${canonicalRoot(root)}/.meta`); }
}

/** Register an owned ephemeral resource durably before creating its bytes. */
export async function publishExportResource(io: ExportRecoveryIO, root: string, id: string, relative: string, content: string): Promise<void> {
  const target = recoveryPath(root, relative), path = exportJournalPath(root);
  await io.validatePath?.(target);
  if (await io.readText(target) !== null) throw new Error(`Export temporary resource already exists: ${relative}`);
  const previous = await io.readText(path);
  const journal: ExportRecoveryJournal = previous === null ? { version: 1, id, files: [] } : parseJournal(previous, root);
  journal.generated ??= []; journal.generated.push({ path: relative, content });
  await io.assertOwned?.(); await io.writeText(path, JSON.stringify(journal)); await io.fsyncDir?.(`${canonicalRoot(root)}/.meta`);
  await io.assertOwned?.(); await io.writeText(target, content);
}
