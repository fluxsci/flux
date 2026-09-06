// Shared document discovery and file mutations. IO adapters keep GUI and CLI
// on one policy; project files remain the source of truth, including empty folders.
import type { ProjectManifest } from './types';
import { slugify } from './types';
import { commentsMainPath, commentsSidecarRel, sortDocuments, type DocRow } from './docOrder';
import { CONTEXT_DOC_RELS } from './contextTemplates';
import { isConflictPath, isSyncTempPath } from './conflictRules';
import { frontMatterField } from '../../shell/modes/paper/frontmatter';
import { parser } from '@lezer/markdown';

export interface DocumentIO {
  exists(rel: string): Promise<boolean>;
  read(rel: string): Promise<string>;
  write(rel: string, text: string): Promise<void>;
  create(rel: string, text: string): Promise<void>;
  mkdir(rel: string): Promise<void>;
  entries(rel: string): Promise<{ name: string; dir: boolean }[]>;
  remove(rel: string): Promise<void>;
}
export const parentDir = (rel: string) => rel.slice(0, Math.max(0, rel.lastIndexOf('/')));
export const fileName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
export const documentRoot = (m: ProjectManifest) => m.documentRoot ?? (m.manuscript.config ? parentDir(m.manuscript.config) : parentDir(m.manuscript.path));
// Keep intentional empty folders recognizable without a second tree in the
// manifest. Older, unmarked ordinary folders are still discovered from disk.
const USER_FOLDER_MARKER = '.flux-folder';
const QUARTO_OUTPUT_DIRS = new Set(['_freeze', '_site', '_book', 'site_libs']);
async function generatedFolder(io: DocumentIO, rel: string, name: string, sourceStems: Set<string>): Promise<boolean> {
  const companion = /^(.*)_(files|cache)$/.exec(name);
  if (!QUARTO_OUTPUT_DIRS.has(name) && !companion) return false;
  if (await io.exists(`${rel}/${USER_FOLDER_MARKER}`)) return false;
  if (QUARTO_OUTPUT_DIRS.has(name) || (companion && sourceStems.has(companion[1]))) return true;
  // Recognize leftover render output after its source is moved or renamed. A
  // suffix alone must not hide an existing authored folder such as source_files.
  const signatures = companion?.[2] === 'cache' ? ['html', 'latex', 'docx']
    : ['libs/quarto-html', 'figure-html', 'figure-pdf', 'figure-docx', 'figure-latex', 'figure-epub', 'figure-typst'];
  return (await Promise.all(signatures.map(p => io.exists(`${rel}/${p}`)))).some(Boolean);
}
export function validDocumentFolder(m: ProjectManifest, rel: string): void {
  const root = documentRoot(m);
  if (rel === "" && root === "") return;
  if (!rel || rel.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.') || /[\\\x00-\x1f:*?"<>|]/.test(p)) ||
      !([root, 'paper', 'manuscript', 'Context'].some(r => rel === r || (!!r && rel.startsWith(r + '/')))) ||
      /^Context\/(Transcripts|Dispatches)(\/|$)/.test(rel)) throw new Error('Choose a folder within Documents or Context.');
}

export async function discoverDocuments(m: ProjectManifest, io: DocumentIO): Promise<{ docs: DocRow[]; folders: string[] }> {
  const rels = new Set<string>();
  const folders = new Set<string>();
  const visited = new Set<string>();
  const roots = new Set([documentRoot(m), 'paper', 'manuscript']);
  const scan = async (dir: string) => {
    if (visited.has(dir)) return;
    visited.add(dir);
    if (!(await io.exists(dir))) return;
    const docsBefore = rels.size, foldersBefore = folders.size;
    let entries: { name: string; dir: boolean }[];
    try { entries = await io.entries(dir); }
    catch (error) { if (!(await io.exists(dir))) return; throw error; }
    const sourceStems = new Set(entries.filter(e => !e.dir && /\.(qmd|md|rmd|ipynb|html)$/i.test(e.name)).map(e => e.name.replace(/\.[^.]+$/, '')));
    for (const e of entries) {
      if (e.name.startsWith('.') || isConflictPath(e.name) || isSyncTempPath(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (/^Context\/(Transcripts|Dispatches)(\/|$)/.test(rel)) continue;
      if (e.dir) {
        if ((dir || e.name === 'sections') && !await generatedFolder(io, rel, e.name, sourceStems)) await scan(rel);
      }
      else if (/\.(qmd|md)$/i.test(e.name)) rels.add(rel);
    }
    // Older scaffolds included an unused sections/. Keep it when it contains
    // documents or intentional subfolders, or was explicitly created in Paper.
    const emptyScaffold = fileName(dir) === 'sections' && roots.has(parentDir(dir)) &&
      rels.size === docsBefore && folders.size === foldersBefore && !entries.some(e => e.name === USER_FOLDER_MARKER && !e.dir);
    if (dir && !emptyScaffold) folders.add(dir);
  };
  for (const root of new Set([...roots, 'Context'])) await scan(root);
  for (const rel of [m.manuscript.path, ...(m.supplementary ?? []).map(s => s.path)]) {
    if (rel && !isConflictPath(rel) && await io.exists(rel)) rels.add(rel);
  }
  const out: DocRow[] = [];
  for (const rel of rels) {
    const isMain = !m.documentRoot && rel === m.manuscript.path;
    const fallback = fileName(rel).replace(/\.(qmd|md)$/i, '');
    let title = isMain ? m.title || fallback : fallback;
    try { title = frontMatterField(await io.read(rel), 'title') || title; }
    catch { if (!(await io.exists(rel))) continue; } // keep unreadable files visible by name
    out.push({ path: rel, title, isMain, ...(rel.startsWith('Context/') ? { isContext: true } : {}) });
  }
  return { docs: sortDocuments(out, m.documentOrder), folders: [...folders].sort() };
}

export async function createDocumentFile(m: ProjectManifest, io: DocumentIO, name: string, folder = documentRoot(m)): Promise<string> {
  validDocumentFolder(m, folder);
  const slug = slugify(name);
  let rel = `${folder ? folder + "/" : ""}${slug}.qmd`;
  for (let n = 2; await io.exists(rel); n++) rel = `${folder ? folder + "/" : ""}${slug}-${n}.qmd`;
  await io.mkdir(folder);
  const bibliography = m.references?.library ? `\nbibliography: ${JSON.stringify(relativeDocumentPath(rel, m.references.library))}` : '';
  await io.create(rel, `---\ntitle: ${JSON.stringify(name)}${bibliography}\n---\n\n`);
  const next = structuredClone(m);
  next.supplementary = [...(next.supplementary ?? []), { path: rel }];
  if (next.documentRoot && !next.manuscript.path && !rel.startsWith('Context/')) next.manuscript.path = rel;
  try { await io.write('project.json', JSON.stringify(next, null, 2) + '\n'); }
  catch (e) { await io.remove(rel); throw e; }
  Object.assign(m, next);
  return rel;
}
export async function createDocumentFolder(m: ProjectManifest, io: DocumentIO, parent: string, name: string): Promise<string> {
  const rel = `${parent ? parent + "/" : ""}${name.trim()}`;
  validDocumentFolder(m, rel);
  if (!name.trim() || name.includes('/') || name.includes('\\')) throw new Error('Enter one folder name.');
  if (await io.exists(rel)) {
    // An invisible, unused legacy scaffold can become an intentional folder.
    // Otherwise the picker would report a collision with a folder it hides.
    let unusedScaffold = false;
    if (name.trim() === 'sections' && [documentRoot(m), 'paper', 'manuscript'].includes(parent)) {
      const entries = await io.entries(rel);
      unusedScaffold = entries.every(e => !e.dir && e.name.startsWith('.') && e.name !== USER_FOLDER_MARKER);
    }
    if (!unusedScaffold) throw new Error('A file or folder with that name already exists.');
  }
  await io.mkdir(rel);
  await io.create(`${rel}/${USER_FOLDER_MARKER}`, 'Created in the Paper file browser.\n');
  return rel;
}

function normalize(parts: string[]): string[] {
  const out: string[] = [];
  for (const p of parts) { if (p === '..') { if (out.length && out.at(-1) !== '..') out.pop(); else out.push(p); } else if (p && p !== '.') out.push(p); }
  return out;
}
/** A project-relative resource expressed beside a particular document. */
export function relativeDocumentPath(document: string, resource: string): string {
  const a = normalize(parentDir(document).split('/')), b = normalize(resource.split('/'));
  while (a.length && b.length && a[0] === b[0]) { a.shift(); b.shift(); }
  return [...a.map(() => '..'), ...b].join('/');
}
/** Update actual Markdown destinations, Quarto includes and common YAML file
 * fields. Code fences are excluded by the parser, and URLs/anchors stay intact. */
export function relocateDocumentLinks(src: string, from: string, to: string, movedFrom = from, movedTo = to): string {
  const rebase = (value: string): string => {
    if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/|#|\{)/i.test(value)) return value;
    const suffixAt = value.search(/[?#]/);
    const target = suffixAt < 0 ? value : value.slice(0, suffixAt);
    const suffix = suffixAt < 0 ? '' : value.slice(suffixAt);
    let decoded = target;
    try { decoded = decodeURI(target); } catch { /* keep malformed literal destinations */ }
    const abs = normalize([...parentDir(from).split('/'), ...decoded.split('/')]).join('/');
    const dest = abs === movedFrom ? movedTo : abs;
    if (from === to && abs !== movedFrom) return value;
    const relative = relativeDocumentPath(to, dest);
    return (decoded !== target ? encodeURI(relative) : relative) + suffix;
  };
  const edits = new Map<string, { from: number; to: number; text: string }>();
  const add = (from: number, to: number) => {
    const old = src.slice(from, to), text = rebase(old);
    if (old !== text) edits.set(`${from}:${to}`, { from, to, text });
  };
  const protectedRanges: {from:number;to:number}[] = [];
  parser.parse(src).iterate({ enter(n) {
    if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(n.name)) { protectedRanges.push({from:n.from,to:n.to}); return false; }
    if (n.name === 'URL') {
      const angle = src[n.from] === '<'; add(n.from + (angle ? 1 : 0), n.to - (angle ? 1 : 0));
    }
  }});
  for (const m of src.matchAll(/\{\{<\s*include\s+(?:"([^"]+)"|'([^']+)'|([^\s>]+))\s*>\}\}/g)) {
    if (protectedRanges.some(r => r.from <= m.index! && r.to > m.index!)) continue;
    const value = m[1] ?? m[2] ?? m[3];
    const pos = m.index! + m[0].indexOf(value); add(pos, pos + value.length);
  }
  const fm = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(src)?.[0];
  if (fm) {
    let arrayIndent = -1;
    let offset = 0;
    const scalar = (value: string, at: number) => {
      const match = /^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s#\[\]{},]+))/.exec(value);
      if (!match) return;
      const path = match[2] ?? match[3] ?? match[4];
      const quoted = match[2] != null || match[3] != null;
      const start = at + match[1].length + (quoted ? 1 : 0);
      add(start, start + path.length);
    };
    for (const line of fm.split(/(?<=\n)/)) {
      const field = /^(\s*)(?:bibliography|csl|include-in-header|include-before-body|include-after-body|reference-doc|css):[ \t]*(.*)/.exec(line);
      if (field) {
        const at = offset + line.indexOf(':') + 1;
        const rest = line.slice(line.indexOf(':') + 1).trim();
        arrayIndent = !rest || rest.startsWith('#') ? field[1].length : -1;
        if (rest.startsWith('[')) {
          const begin = line.indexOf('[') + 1;
          for (const token of line.slice(begin).matchAll(/(?:"[^"]*"|'[^']*'|[^,\[\]]+)(?=,|\])/g)) scalar(token[0], offset + begin + token.index!);
        } else scalar(line.slice(line.indexOf(':') + 1), at);
      } else if (arrayIndent >= 0) {
        const item = /^(\s*)-[ \t]+(.*)/.exec(line);
        if (item && item[1].length >= arrayIndent) scalar(item[2], offset + line.indexOf('-') + 1 + (line.slice(line.indexOf('-') + 1).length - line.slice(line.indexOf('-') + 1).trimStart().length));
        else if (line.trim() && !line.trim().startsWith('#')) arrayIndent = -1;
      }
      offset += line.length;
    }
  }
  for (const e of [...edits.values()].sort((a,b) => b.from - a.from)) src = src.slice(0,e.from) + e.text + src.slice(e.to);
  return src;
}

/** Preflight everything; write destinations before removing sources. Roll back
 * completed writes on IO failure. Never overwrite an existing destination. */
export async function moveDocumentFile(m: ProjectManifest, io: DocumentIO, rel: string, folder: string): Promise<{ path: string; changed: string[] }> {
  validDocumentFolder(m, folder);
  const { docs } = await discoverDocuments(m, io);
  if (!docs.some(d => d.path === rel)) throw new Error('Document not found.');
  if (CONTEXT_DOC_RELS.includes(rel)) throw new Error('The standard Context documents stay in their original locations.');
  const dest = `${folder ? folder + "/" : ""}${fileName(rel)}`;
  if (dest === rel) return { path: rel, changed: [] };
  if (!(await io.exists(folder))) throw new Error('Destination folder no longer exists.');
  const next = structuredClone(m);
  if (next.manuscript.path === rel) next.manuscript.path = dest;
  next.supplementary = (next.supplementary ?? []).map(s => s.path === rel ? { ...s, path: dest } : s);
  if (!next.supplementary.some(s => s.path === dest) && next.manuscript.path !== dest) next.supplementary.push({ path: dest });
  if (next.documentOrder) next.documentOrder = next.documentOrder.map(p => p === rel ? dest : p);
  const sourceSidecar = commentsSidecarRel(commentsMainPath(m), rel);
  const destSidecar = commentsSidecarRel(commentsMainPath(next), dest);
  const copies = [{ from: rel, to: dest }];
  if (await io.exists(sourceSidecar)) copies.push({ from: sourceSidecar, to: destSidecar });
  // Legacy mains can also have a document-named review sidecar.
  const named = commentsSidecarRel('', rel), namedDest = commentsSidecarRel('', dest);
  if (named !== sourceSidecar && await io.exists(named)) copies.push({ from: named, to: namedDest });
  for (const c of copies) if (await io.exists(c.to)) throw new Error(`A file named ${fileName(c.to)} already exists in that folder.`);
  const before = new Map<string, string | null>();
  const writes = new Map<string, string>();
  for (const c of copies) { before.set(c.from, await io.read(c.from)); before.set(c.to, null); writes.set(c.to, before.get(c.from)!); }
  for (const d of docs) {
    const old = d.path === rel ? before.get(rel)! : await io.read(d.path);
    const target = d.path === rel ? dest : d.path;
    const text = relocateDocumentLinks(old, d.path, target, rel, dest);
    if (text !== old) { if (!before.has(target)) before.set(target, old); writes.set(target, text); }
  }
  before.set('project.json', await io.read('project.json'));
  writes.set('project.json', JSON.stringify(next, null, 2) + '\n');
  const touched: string[] = [];
  try {
    for (const [p, text] of writes) {
      if (before.get(p) === null) {
        await io.create(p, text); // a competing creator cannot be overwritten or rolled back
        touched.push(p);
      } else {
        if (await io.read(p) !== before.get(p)) throw new Error(`${p} changed during the move. Try again.`);
        touched.push(p); await io.write(p, text);
      }
    }
    for (const c of copies) {
      if (await io.read(c.from) !== before.get(c.from)) throw new Error(`${c.from} changed during the move. Try again.`);
      touched.push(c.from); await io.remove(c.from);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const p of touched.reverse()) {
      try { const text = before.get(p); if (text == null) await io.remove(p); else await io.write(p, text); } catch { failures.push(p); }
    }
    if (failures.length) throw new Error(`Move failed; recovery could not restore ${failures.join(', ')}. ${String(error)}`);
    throw error;
  }
  Object.assign(m, next);
  return { path: dest, changed: [...writes.keys()].filter(p => p !== 'project.json') };
}
