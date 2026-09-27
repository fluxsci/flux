// Interrupted PDF publications are reconciled by exact content identity. Recovery
// never replaces PDF or annotation bytes and never guesses from a directory mtime.
import type { SourceInfo } from './items';
export interface ItemRecoveryIO {
  readText(name: string): Promise<string | null>;
  pdfSha256(): Promise<string | null>;
  writeText(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  assertOwned(): Promise<void>;
}
export type ItemRecoveryResult = 'none' | 'completed' | 'rolled-back';
function source(value: unknown, key: string): SourceInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const s = value as SourceInfo;
  return s.key === key && typeof s.source === 'string' && typeof s.fetchedAt === 'string'
    && typeof s.sha256 === 'string' && /^[a-f0-9]{64}$/.test(s.sha256) ? s : null;
}
/** Caller holds the per-item operation lease. Unknown/conflicting bytes stay intact. */
export async function recoverItemPublication(key: string, io: ItemRecoveryIO): Promise<ItemRecoveryResult> {
  const raw = await io.readText('source.pending.json');
  if (raw === null) return 'none';
  let pending: {version: number; source: unknown; link?: {path: string; linkedAt: string}; previousLink?: string | null};
  try { pending = JSON.parse(raw); }
  catch { throw new Error(`Pending PDF generation for ${key} has malformed recovery metadata; retain these files and attach the chosen PDF again.`); }
  if (pending?.version === 1 && pending.link) {
    const link=pending.link,proposed=pending.source as SourceInfo;
    if(typeof link.path!=="string"||!link.path||link.path.includes("\0")||typeof link.linkedAt!=="string"||!proposed||proposed.key!==key||proposed.source!=="zotero-link"||proposed.url!==link.path||typeof proposed.fetchedAt!=="string"||!(pending.previousLink===null||typeof pending.previousLink==="string")) throw new Error(`Pending PDF generation for ${key} has invalid linked-source recovery metadata.`);
    const linkRaw=await io.readText("paper.link.json"),expected=JSON.stringify(link,null,2)+"\n";
    // Deferred links never need an upfront read of the external PDF. The exact
    // serialized pointer is this transaction's authoritative published artifact.
    if(await io.pdfSha256()!==null)throw new Error(`Pending PDF generation for ${key} conflicts with a stored PDF; retain both and attach the chosen PDF again.`);
    const action=linkRaw===expected?"completed":linkRaw===pending.previousLink?"rolled-back":null;
    if(!action)throw new Error(`Pending PDF generation for ${key} does not match its linked-source pointer; retain these files and attach the chosen PDF again.`);
    for(const name of ["fulltext.txt","fulltext.source.json"]){await io.assertOwned();await io.remove(name);}
    if(action==="completed"){await io.assertOwned();await io.writeText("source.json",JSON.stringify(proposed,null,2)+"\n");}
    if(await io.readText("paper.link.json")!==linkRaw||await io.readText("source.pending.json")!==raw||await io.pdfSha256()!==null)throw new Error(`PDF generation for ${key} changed during linked-source recovery; retry.`);
    await io.assertOwned();await io.remove("source.pending.json");return action;
  }
  const proposed = pending?.version === 1 && source(pending.source, key);
  if (!proposed) throw new Error(`Pending PDF generation for ${key} has no verified source identity; retain these files and attach the chosen PDF again.`);
  const hash = await io.pdfSha256();
  let action: ItemRecoveryResult;
  if (hash === proposed.sha256) action = 'completed';
  else {
    const oldRaw = await io.readText('source.json');
    let previous: SourceInfo | null = null;
    try { previous = oldRaw === null ? null : source(JSON.parse(oldRaw), key); } catch { /* cannot prove prior generation */ }
    if (!hash || previous?.sha256 !== hash) throw new Error(`Pending PDF generation for ${key} does not match current PDF bytes; retain these files and attach the chosen PDF again.`);
    action = 'rolled-back';
  }
  // The old extraction may precede either generation, including a crash between
  // metadata and text publication. Rebuild it; annotations are user data, untouched.
  for (const name of ['fulltext.txt', 'fulltext.source.json']) { await io.assertOwned(); await io.remove(name); }
  if (action === 'completed') { await io.assertOwned(); await io.writeText('source.json', JSON.stringify(proposed, null, 2) + '\n'); }
  // Detect noncooperating replacement during the recovery read/write interval.
  if (await io.pdfSha256() !== hash || await io.readText('source.pending.json') !== raw) throw new Error(`PDF generation for ${key} changed during recovery; retry after the other writer finishes.`);
  await io.assertOwned(); await io.remove('source.pending.json');
  return action;
}
