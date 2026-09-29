import ts from 'typescript';
import { parse } from 'svelte/compiler';

const sensitive = ['flux principal', 'flux dispatch', 'flux attend', 'flux agents'];
const insensitive = [
  'PRINCIPAL.md', 'WORKERS.md', 'AGENTS-CONFIG.md', 'agents.json',
  'principal agent', 'dispatched worker', 'Add & send', 'review pass',
  'Context/Transcripts', 'Context/Dispatches', 'Project/MISSION.qmd',
  'Snapshot & annotate', 'Note to agent', 'flux note', 'flux feedback',
  'add-annotation', 'list_annotations', 'Syncthing',
];
const pattern = (token: string) => new RegExp('(?<![\\w])' + token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll(' ', '\\s+') + '(?![\\w])', sensitive.includes(token) ? 'g' : 'gi');
export interface Hit { file: string; line: number; token: string }
interface Chunk { text: string; offsets: number[] }

// Keep source offsets while decoding strings: generated docs contain escaped
// newlines on one physical line, whereas template literals span many lines.
function chunk(raw: string, start = 0, script = false): Chunk {
  let text = '';
  const offsets: number[] = [];
  for (let i = 0; i < raw.length;) {
    const at = i;
    let value = raw[i++];
    if (script && value === '\\') {
      const escape = /^(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|\r?\n|.)/i.exec(raw.slice(i));
      if (escape) {
        i += escape[0].length;
        value = escape[1] || escape[2] || escape[3] ? String.fromCodePoint(parseInt(escape[1] || escape[2] || escape[3], 16))
          : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0', '\n': '', '\r\n': '' } as Record<string, string>)[escape[0]] ?? escape[0];
      }
    } else if (!script && value === '&') {
      const entity = /^(amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/i.exec(raw.slice(i));
      if (entity) {
        i += entity[0].length;
        const key = entity[1];
        value = key[0] === '#' ? String.fromCodePoint(parseInt(key.slice(/^#x/i.test(key) ? 2 : 1), /^#x/i.test(key) ? 16 : 10))
          : ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: '\u00a0' })[key.toLowerCase()]!;
      }
    }
    text += value;
    for (let n = 0; n < value.length; n++) offsets.push(start + at);
  }
  return { text, offsets };
}

function scriptChunks(source: string, file: string): Chunk[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: Chunk[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const start = node.getStart(tree) + 1;
      const end = node.end - (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ? 2 : 1);
      out.push(chunk(source.slice(start, end), start, true));
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return out;
}

function svelteChunks(source: string, file: string): Chunk[] {
  const ast = parse(source, { filename: file, modern: true });
  const out: Chunk[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (['Comment', 'Line', 'Block', 'StyleSheet'].includes(node.type)) return;
    if (node.type === 'Text') out.push(chunk(source.slice(node.start, node.end), node.start));
    else if (node.type === 'Literal' && typeof node.value === 'string') out.push(chunk(source.slice(node.start + 1, node.end - 1), node.start + 1, true));
    else if (node.type === 'TemplateElement') out.push(chunk(source.slice(node.start, node.end), node.start, true));
    else for (const [key, value] of Object.entries(node)) {
      if (['comments', 'leadingComments', 'trailingComments', 'loc', 'metadata', 'css'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  };
  visit(ast);
  return out;
}

export function scannedFile(file: string): boolean {
  if (file === 'docs/for_agents/migrate-to-flux-connect.md' || /^docs\/V020_/.test(file)) return false;
  return file === 'README.md' || /^docs\/.*\.qmd$/.test(file) || file.startsWith('docs/for_agents/')
    || file.startsWith('resources/flux-context/') || file.startsWith('resources/agent-skills/')
    || file === 'electron/fluxContextDocs.gen.cjs' || /^src\/lib\/project\/(contextTemplates|scaffoldTree)\.ts$/.test(file)
    || /^src\/.*\.svelte$/.test(file) || /^src\/shell\/command\/[^/]+\.ts$/.test(file);
}

export function scan(file: string, source: string, tokens = [...sensitive, ...insensitive]): Hit[] {
  const chunks = file.endsWith('.svelte') ? svelteChunks(source, file)
    : /\.(?:ts|cjs)$/.test(file) ? scriptChunks(source, file) : [chunk(source)];
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const part of chunks) for (const token of tokens) for (const match of part.text.matchAll(pattern(token))) {
    const offset = part.offsets[match.index!], key = `${offset}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ file, line: source.slice(0, offset).split('\n').length, token: match[0].replace(/\s+/g, ' ') });
  }
  return hits.sort((a, b) => a.line - b.line || a.token.localeCompare(b.token));
}
