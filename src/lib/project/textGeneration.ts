// Small recoverable transaction for source SVG/sidecars + owning compositions.
// The caller holds the project lease. Index remains last; a durable journal makes
// overwritten assets recoverable too. Recovery never overwrites unexpected edits.
export interface TextGenerationIO {
  read(rel: string): Promise<string | null>;
  write(rel: string, text: string): Promise<void>;
  remove(rel: string): Promise<void>;
  /** Host-specific project confinement, including existing directory symlinks. */
  validatePath?(rel: string): Promise<void>;
  /** Flush renamed/unlinked directory entries before advancing publication. */
  fsyncDir?(rel: string): Promise<void>;
  readBytes?(rel: string): Promise<Uint8Array | null>;
  writeBytes?(rel: string, bytes: Uint8Array): Promise<void>;
}
export type GenerationWrite = string | null | { base64: string };
export function bytesToBase64(bytes: Uint8Array): string {
  let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
}
function fromBase64(value: string): Uint8Array {return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
const JOURNAL = '.meta/figure-source-generation.json';
const parent = (rel: string) => { const slash=rel.lastIndexOf('/');return slash<0?'.':rel.slice(0,slash)||'.'; };
interface Entry { path: string; before: string | null; after: string | null; encoding?: 'base64' }
async function readEntry(io: TextGenerationIO, entry: Pick<Entry,'path'|'encoding'>) {
  if(!entry.encoding)return io.read(entry.path);
  if(!io.readBytes)throw Error('Binary figure recovery requires byte reads');
  const bytes=await io.readBytes(entry.path);return bytes===null?null:bytesToBase64(bytes);
}
async function writeEntry(io: TextGenerationIO, entry: Entry, value: string | null) {
  if(value===null)return io.remove(entry.path);
  if(!entry.encoding)return io.write(entry.path,value);
  if(!io.writeBytes)throw Error('Binary figure recovery requires byte writes');
  return io.writeBytes(entry.path,fromBase64(value));
}
function safe(rel: unknown): asserts rel is string {
  if (typeof rel !== 'string' || !rel || /[\\\x00]/.test(rel) || rel.startsWith('/') || /^[a-z]:/i.test(rel) || rel.split('/').some(p => !p || p === '.' || p === '..') || (!rel.startsWith('fig/') && !rel.startsWith('slides/') && !rel.endsWith('.json') && rel !== JOURNAL)) throw new Error(`Invalid source recovery path: ${String(rel)}`);
}
export async function recoverTextGeneration(io: TextGenerationIO, assertOwner: () => Promise<void> = async () => {}): Promise<void> {
  await io.validatePath?.(JOURNAL);
  const text = await io.read(JOURNAL); if (text === null) return;
  const journal = JSON.parse(text);
  if (![1,2].includes(journal?.version) || !Array.isArray(journal.files)) throw new Error('Invalid source recovery journal');
  const seen = new Set<string>();
  for (const entry of journal.files) {
    safe(entry?.path);
    if (seen.has(entry.path) || entry.path === JOURNAL || ![entry.before,entry.after].every(v => v === null || typeof v === 'string')) throw new Error('Invalid source recovery entry');
    seen.add(entry.path);
    if(entry.encoding!==undefined&&entry.encoding!=='base64')throw Error('Invalid recovery encoding');
    if(entry.encoding==='base64')for(const value of [entry.before,entry.after])if(value!==null)fromBase64(value);
  }
  // Reject the entire untrusted journal before restoring even a valid sibling.
  for (const entry of journal.files) await io.validatePath?.(entry.path);
  const errors: string[] = [];
  for (const entry of [...journal.files].reverse() as Entry[]) {
    try {
      const current = await readEntry(io,entry);
      if (current === entry.before) continue;
      if (current !== entry.after) { errors.push(`${entry.path}: changed outside transaction`); continue; }
      await assertOwner(); await writeEntry(io,entry,entry.before);
      await io.fsyncDir?.(parent(entry.path));
    } catch (error) { errors.push(`${entry.path}: ${String(error)}`); }
  }
  if (errors.length) throw new Error(`Source recovery retained at ${JOURNAL}: ${errors.join('; ')}`);
  await assertOwner(); await io.remove(JOURNAL);
  await io.fsyncDir?.(parent(JOURNAL));
}
export async function commitTextGeneration(io: TextGenerationIO, writes: ReadonlyMap<string, GenerationWrite>, assertOwner: () => Promise<void> = async () => {}): Promise<void> {
  await io.validatePath?.(JOURNAL);
  for (const rel of writes.keys()) {
    safe(rel);if(rel===JOURNAL)throw new Error('Source recovery journal cannot be a transaction target');
    await io.validatePath?.(rel);
  }
  await recoverTextGeneration(io, assertOwner);
  const files: Entry[] = [];
  for (const [rel, value] of writes) {
    safe(rel); const encoding = value!==null && typeof value==='object' ? 'base64' as const : undefined;
    const after=encoding?(value as {base64:string}).base64:value as string|null;
    if(encoding)fromBase64(after!);
    const before = await readEntry(io,{path:rel,encoding});
    if (before !== after) files.push({path: rel, before, after, ...(encoding?{encoding}:{})});
  }
  if (!files.length) return;
  await assertOwner();
  await io.write(JOURNAL, JSON.stringify({version:2, files}));
  // The undo record must survive a crash before any source is overwritten.
  await io.fsyncDir?.(parent(JOURNAL));
  try {
    for (const entry of files) {
      if (await readEntry(io,entry) !== entry.before) throw new Error(`Source generation diverged: ${entry.path}`);
      await assertOwner();
      await writeEntry(io,entry,entry.after);
      // In particular, make canvas/asset renames durable BEFORE the index.
      await io.fsyncDir?.(parent(entry.path));
    }
    await assertOwner(); await io.remove(JOURNAL);
    await io.fsyncDir?.(parent(JOURNAL));
  } catch (error) {
    try { await recoverTextGeneration(io, assertOwner); }
    catch (recovery) { throw new AggregateError([error, recovery], 'Source update failed; recovery retained'); }
    throw error;
  }
}
