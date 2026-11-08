// ---------------------------------------------------------------------------
// THE minimal front-matter editor (2026-11-08). The title pill's Save used to
// `yaml.load` the whole block, rebuild `author:` as `{name}` only and
// `yaml.dump` everything back — deleting affiliations, `corresponding`,
// `email`, `orcid`, `equal-contributor`, `lead-contact` (exactly what the
// journal export reads) and every comment, and re-quoting the title.
//
// This module edits the front matter as TEXT. It reads js-yaml 5's event
// stream (scalar source ranges + styles) to locate the bytes it owns, plans
// span edits that touch only those bytes — the `title` scalar, each author's
// name scalar, whole author entries when one is added/removed/moved, a
// top-level scalar key such as `csl:` — keeps every other key, nesting,
// ordering, quoting style and comment byte-identical, and then PROVES it: the
// edited YAML is re-parsed and every key it did not own must deep-equal the
// original (and every surviving author keeps every field but its name). A
// shape the minimal path cannot express falls back to re-writing ONLY the
// author key with its data intact; anything else refuses (throws
// `FrontMatterEditError`) rather than lose a byte the user wrote.
//
// Pure: no Svelte, no DOM, no Node. js-yaml is injected (`…With`) or loaded
// lazily (async wrappers), so this loads in both engines (guide §2) and in
// the pure gate `verify-frontmatter-edit.ts`.
// ---------------------------------------------------------------------------

import { frontMatterBounds } from "./frontmatter";

type YamlMod = typeof import("js-yaml");

/** One document change in DOCUMENT offsets (CodeMirror `changes` shape). */
export interface FmChange {
  from: number;
  to: number;
  insert: string;
}

export interface TitleAuthorsEdit {
  /** New title; `undefined` leaves the title alone. */
  title?: string;
  /** New author names in order; `undefined` leaves the authors alone. */
  authors?: string[];
}

export class FrontMatterEditError extends Error {}

const EV_SEQ = 2, EV_MAP = 3, EV_SCALAR = 4, EV_ALIAS = 5, EV_POP = 6;
const PLAIN = 1, SINGLE = 2, DOUBLE = 3, LITERAL = 4, FOLDED = 5;

interface YScalar {
  kind: "scalar";
  style: number;
  /** Token range (quotes / block header included); -1 when null and unplaced. */
  start: number;
  end: number;
  /** Content range as js-yaml reports it (block scalars: the content lines). */
  vStart: number;
  vEnd: number;
  value: string;
  isNull: boolean;
  decorated: boolean;
}
interface YSeq { kind: "seq"; flow: boolean; start: number; end: number; items: YNode[]; decorated: boolean }
interface YMap { kind: "map"; flow: boolean; start: number; end: number; pairs: { key: YNode; value: YNode }[]; decorated: boolean }
interface YAlias { kind: "alias"; start: number; end: number }
type YNode = YScalar | YSeq | YMap | YAlias;

interface Edit { from: number; to: number; insert: string }

// ------------------------------------------------------------------ tree

function blockHeaderStart(src: string, vStart: number): number {
  // The header (`|`, `>-`, `|2+` …) ends the line before the content.
  const lineEnd = src.lastIndexOf("\n", vStart - 1);
  const lineStart = src.lastIndexOf("\n", lineEnd - 1) + 1;
  const line = src.slice(lineStart, lineEnd).replace(/\r$/, "");
  const m = /[|>][1-9+-]*(?=\s*(?:#.*)?$)/.exec(line.replace(/\s+#.*$/, ""));
  return m ? lineStart + m.index : vStart;
}

function closeOfFlow(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ",") i++;
    else if (c === "#") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else break;
  }
  return src[i] === "]" || src[i] === "}" ? i + 1 : i;
}

function buildTree(yaml: YamlMod, src: string): YNode | null {
  const events = yaml.parseEvents(src, {}) as unknown as Array<Record<string, number> & { type: number }>;
  type Open = { node: YSeq | YMap; children: YNode[] };
  const stack: Open[] = [];
  let root: YNode | null = null;
  const push = (n: YNode) => {
    if (stack.length) stack[stack.length - 1].children.push(n);
    else if (!root) root = n;
  };
  for (const e of events) {
    if (e.type === EV_SCALAR) {
      const style = e.style;
      const vStart = e.valueStart, vEnd = e.valueEnd;
      let start = vStart, end = vEnd;
      if (vStart >= 0 && (style === SINGLE || style === DOUBLE)) { start = vStart - 1; end = vEnd + 1; }
      if (vStart >= 0 && (style === LITERAL || style === FOLDED)) {
        start = blockHeaderStart(src, vStart);
        end = vEnd;
        while (end > vStart && (src[end - 1] === "\n" || src[end - 1] === "\r")) end--;
        if (end <= start) end = vEnd;
      }
      const value = yaml.getScalarValue(src, e as never);
      push({
        kind: "scalar", style, start, end, vStart, vEnd, value,
        isNull: vStart < 0,
        decorated: e.tagStart >= 0 || e.anchorStart >= 0,
      });
    } else if (e.type === EV_SEQ || e.type === EV_MAP) {
      const flow = e.style === 2;
      const node: YSeq | YMap = e.type === EV_SEQ
        ? { kind: "seq", flow, start: e.start, end: e.start, items: [], decorated: e.tagStart >= 0 || e.anchorStart >= 0 }
        : { kind: "map", flow, start: e.start, end: e.start, pairs: [], decorated: e.tagStart >= 0 || e.anchorStart >= 0 };
      stack.push({ node, children: [] });
    } else if (e.type === EV_ALIAS) {
      push({ kind: "alias", start: e.anchorStart - 1, end: e.anchorEnd });
    } else if (e.type === EV_POP) {
      const open = stack.pop();
      if (!open) continue;
      const { node, children } = open;
      if (node.kind === "seq") node.items = children;
      else {
        for (let i = 0; i + 1 < children.length; i += 2) {
          const key = children[i], value = children[i + 1];
          if (value.kind === "scalar" && value.isNull && key.end >= 0) {
            // A null value has no range: place it right after the key's colon.
            let j = key.end;
            while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
            if (src[j] === ":") j++;
            value.start = value.end = j;
          }
          node.pairs.push({ key, value });
        }
      }
      const lastEnd = children.length ? Math.max(...children.map((c) => c.end)) : node.start + 1;
      node.end = node.flow ? closeOfFlow(src, children.length ? lastEnd : node.start + 1) : lastEnd;
      push(node);
    }
  }
  return root;
}

const keyOf = (n: YNode) => (n.kind === "scalar" ? n.value : null);
function pairOf(map: YMap, key: string) {
  return map.pairs.find((p) => keyOf(p.key) === key);
}

// ------------------------------------------------------------------ text helpers

const lineStart = (s: string, pos: number) => s.lastIndexOf("\n", pos - 1) + 1;
/** Offset just past the newline ending the line that holds `pos`. */
function lineEndIncl(s: string, pos: number): number {
  const nl = s.indexOf("\n", pos);
  return nl < 0 ? s.length : nl + 1;
}

function applyEdits(text: string, edits: Edit[]): string {
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.from - b.e.from || a.i - b.i);
  let out = "", cursor = 0;
  for (const { e } of sorted) {
    if (e.from < cursor) throw new FrontMatterEditError("overlapping front-matter edits");
    out += text.slice(cursor, e.from) + e.insert;
    cursor = e.to;
  }
  return out + text.slice(cursor);
}

/** Trim an edit to the bytes that actually differ. */
function minimize(text: string, e: Edit): Edit | null {
  const old = text.slice(e.from, e.to);
  if (old === e.insert) return null;
  let p = 0;
  const max = Math.min(old.length, e.insert.length);
  while (p < max && old[p] === e.insert[p]) p++;
  let q = 0;
  while (q < max - p && old[old.length - 1 - q] === e.insert[e.insert.length - 1 - q]) q++;
  return { from: e.from + p, to: e.to - q, insert: e.insert.slice(p, e.insert.length - q) };
}

// ------------------------------------------------------------------ scalars

function plainOk(yaml: YamlMod, v: string, flow: boolean): boolean {
  if (!v || v !== v.trim() || /[\n\r\t]/.test(v)) return false;
  if (flow && /[,[\]{}]/.test(v)) return false;
  try {
    const r = yaml.load(flow ? `[${v}]` : `k: ${v}`) as unknown;
    return flow ? Array.isArray(r) && r.length === 1 && r[0] === v : !!r && (r as { k?: unknown }).k === v;
  } catch {
    return false;
  }
}

const doubleQuoted = (v: string) => JSON.stringify(v);

/** `v` rendered as a scalar token in `style` when that style can carry it. */
function emitScalar(yaml: YamlMod, v: string, style: number, flow: boolean): string {
  if (style === PLAIN && plainOk(yaml, v, flow)) return v;
  if (style === SINGLE && !/[\n\r\t]/.test(v) && !/[\u0000-\u001f\u007f]/.test(v)) return `'${v.replace(/'/g, "''")}'`;
  return doubleQuoted(v);
}

/** The edit that makes scalar `n` read `v`, in its own style. */
function scalarEdit(yaml: YamlMod, src: string, n: YScalar, v: string, flow: boolean): Edit {
  if (n.decorated) throw new FrontMatterEditError("tagged/anchored scalar");
  if (n.start < 0) throw new FrontMatterEditError("unplaced null scalar");
  if (n.isNull) {
    const t = emitScalar(yaml, v, PLAIN, flow);
    return { from: n.start, to: n.end, insert: flow ? t : ` ${t}` };
  }
  if (n.style === LITERAL || n.style === FOLDED) {
    if (!/[\n\r]/.test(v) && v !== "" && v === v.trimEnd()) {
      const first = src.slice(n.vStart, n.vEnd);
      const indent = /^[ \t]*/.exec(first)?.[0] || "  ";
      const contentEnd = n.end > n.vStart ? n.end : n.vEnd;
      return { from: n.vStart, to: contentEnd, insert: indent + v };
    }
    return { from: n.start, to: n.end, insert: doubleQuoted(v) };
  }
  return { from: n.start, to: n.end, insert: emitScalar(yaml, v, n.style, flow) };
}

// ------------------------------------------------------------------ authors

const nameOfJs = (r: unknown): string => {
  // Mirrors journalManuscript.readAuthors: what the export will print.
  if (typeof r === "string") return r.trim();
  if (!r || typeof r !== "object") return "";
  const nm = (r as Record<string, unknown>).name;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
  if (typeof nm === "string") return nm.trim();
  if (typeof nm === "number") return String(nm);
  if (nm && typeof nm === "object") {
    const n = nm as Record<string, unknown>;
    return s(n.literal) || [s(n.given), s(n.family)].filter(Boolean).join(" ");
  }
  return "";
};

function nameOfNode(n: YNode): string {
  if (n.kind === "scalar") return n.isNull ? "" : n.value.trim();
  if (n.kind !== "map") return "";
  const p = pairOf(n, "name");
  if (!p) return "";
  const v = p.value;
  if (v.kind === "scalar") return v.isNull ? "" : v.value.trim();
  if (v.kind === "map") {
    const sv = (k: string) => {
      const q = pairOf(v, k);
      return q && q.value.kind === "scalar" && !q.value.isNull ? q.value.value.trim() : "";
    };
    return sv("literal") || [sv("given"), sv("family")].filter(Boolean).join(" ");
  }
  return "";
}

/** The author key a document uses: `author` wins (the export reads `author ?? authors`). */
function authorKeyOf(obj: Record<string, unknown>): "author" | "authors" | null {
  if ("author" in obj) return "author";
  if ("authors" in obj) return "authors";
  return null;
}

type Slot = { old: number; rename?: string } | { fresh: string };

/** Map the new name list onto the old entries: exact names keep their entry,
 *  then leftover new names RENAME leftover old entries in order (a typo fix
 *  keeps the affiliations), the rest are new/removed. Unnamed entries (the
 *  dialog never showed them) keep their index. */
function planSlots(oldNames: string[], newNames: string[]): Slot[] {
  const visible = oldNames.map((n, i) => (n ? i : -1)).filter((i) => i >= 0);
  const used = new Set<number>();
  const assign: (number | null)[] = newNames.map((nm) => {
    const hit = visible.find((i) => !used.has(i) && oldNames[i] === nm.trim());
    if (hit === undefined) return null;
    used.add(hit);
    return hit;
  });
  const spare = visible.filter((i) => !used.has(i));
  const queue: Slot[] = newNames.map((nm, j) => {
    const a = assign[j];
    if (a !== null) return { old: a };
    const s = spare.shift();
    return s === undefined ? { fresh: nm.trim() } : { old: s, rename: nm.trim() };
  });
  const out: Slot[] = [];
  for (let k = 0; k < oldNames.length; k++) {
    if (!oldNames[k]) out.push({ old: k });
    else if (queue.length) out.push(queue.shift()!);
  }
  return out.concat(queue);
}

function splitName(oldGiven: string, oldFamily: string, next: string): { given: string; family: string } {
  if (oldFamily && next.endsWith(` ${oldFamily}`)) return { given: next.slice(0, -oldFamily.length - 1).trim(), family: oldFamily };
  if (oldGiven && next.startsWith(`${oldGiven} `)) return { given: oldGiven, family: next.slice(oldGiven.length + 1).trim() };
  const sp = next.lastIndexOf(" ");
  return sp < 0 ? { given: "", family: next } : { given: next.slice(0, sp).trim(), family: next.slice(sp + 1).trim() };
}

/** Edits renaming one author entry in place (every other byte kept). */
function renameEdits(yaml: YamlMod, src: string, item: YNode, next: string, flow: boolean): Edit[] {
  if (item.kind === "scalar") return [scalarEdit(yaml, src, item, next, flow)];
  if (item.kind !== "map" || item.decorated) throw new FrontMatterEditError("author entry shape");
  const p = pairOf(item, "name");
  if (!p) throw new FrontMatterEditError("author entry without a name");
  const v = p.value;
  if (v.kind === "scalar") return [scalarEdit(yaml, src, v, next, item.flow)];
  if (v.kind === "map" && !v.decorated) {
    const lit = pairOf(v, "literal");
    if (lit && lit.value.kind === "scalar") return [scalarEdit(yaml, src, lit.value, next, v.flow)];
    const g = pairOf(v, "given"), f = pairOf(v, "family");
    if (g && f && g.value.kind === "scalar" && f.value.kind === "scalar" && !g.value.isNull && !f.value.isNull) {
      const parts = splitName(g.value.value.trim(), f.value.value.trim(), next);
      if (parts.given) {
        const out: Edit[] = [];
        if (parts.given !== g.value.value.trim()) out.push(scalarEdit(yaml, src, g.value, parts.given, v.flow));
        if (parts.family !== f.value.value.trim()) out.push(scalarEdit(yaml, src, f.value, parts.family, v.flow));
        return out;
      }
    }
  }
  throw new FrontMatterEditError("structured author name");
}

// ------------------------------------------------------------------ verification

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function withoutName(r: unknown): unknown {
  // A bare-string author and `{name}` carry the same data (no other fields).
  if (typeof r === "string") return {};
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const { name: _n, ...rest } = r as Record<string, unknown>;
  void _n;
  return rest;
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

function loadMap(yaml: YamlMod, text: string): Record<string, unknown> {
  const r = yaml.load(text);
  if (r == null) return {};
  if (typeof r !== "object" || Array.isArray(r)) throw new FrontMatterEditError("front matter is not a mapping");
  return r as Record<string, unknown>;
}

// ------------------------------------------------------------------ planning

interface FmPlan {
  edits: Edit[];
  /** Which author key the plan writes (for verification). */
  authorKey: string | null;
  /** The old JS entry each output slot came from (null = fresh). */
  slotSources: (number | null)[];
}

function planAuthorsFallback(yaml: YamlMod, fm: string, root: YMap, oldObj: Record<string, unknown>, key: string, slots: Slot[], eol: string): Edit[] {
  const oldList = asList(oldObj[key]);
  const items = slots.map((s) => {
    if ("fresh" in s) return { name: s.fresh };
    const src = oldList[s.old];
    if (s.rename === undefined) return src;
    if (typeof src === "string" || src == null) return s.rename;
    return { ...(src as Record<string, unknown>), name: s.rename };
  });
  const pair = pairOf(root, key)!;
  const from = lineStart(fm, pair.key.start);
  const to = lineEndIncl(fm, Math.max(pair.value.end, pair.key.end) - 1);
  if (!items.length) return [{ from, to, insert: "" }];
  const dumped = yaml.dump({ [key]: items }, { lineWidth: -1 }).replace(/\r?\n/g, eol);
  return [{ from, to, insert: dumped.endsWith(eol) ? dumped : dumped + eol }];
}

function planOnFm(yaml: YamlMod, fm: string, edit: TitleAuthorsEdit, eol: string, fallback: boolean): FmPlan {
  let tree: YNode | null;
  try {
    tree = buildTree(yaml, fm);
  } catch (err) {
    throw new FrontMatterEditError(`The front matter is not valid YAML (${(err as Error).message.split("\n")[0]})`);
  }
  if (tree && (tree.kind !== "map" || tree.flow)) throw new FrontMatterEditError("front matter is not a block mapping");
  const root: YMap = (tree as YMap | null) ?? { kind: "map", flow: false, start: 0, end: 0, pairs: [], decorated: false };
  const oldObj = loadMap(yaml, fm);
  const edits: Edit[] = [];
  const freshTop: string[] = [];

  // ---- title
  const titlePair = pairOf(root, "title");
  if (edit.title !== undefined) {
    if (titlePair) {
      const v = titlePair.value;
      if (v.kind === "scalar") {
        if ((v.isNull ? "" : v.value) !== edit.title) edits.push(scalarEdit(yaml, fm, v, edit.title, false));
      } else {
        edits.push({ from: titlePair.key.end, to: v.end, insert: `: ${doubleQuoted(edit.title)}` });
      }
    } else if (edit.title !== "") {
      freshTop.push(`title: ${emitScalar(yaml, edit.title, PLAIN, false)}${eol}`);
    }
  }

  // ---- authors
  let authorKey: string | null = null;
  let slotSources: (number | null)[] = [];
  if (edit.authors !== undefined) {
    const names = edit.authors.map((a) => a.trim()).filter(Boolean);
    authorKey = authorKeyOf(oldObj);
    const pair = authorKey ? pairOf(root, authorKey) : undefined;
    if (!pair) {
      authorKey = "author";
      if (names.length) {
        const block = `author:${eol}${names.map((n) => `  - name: ${emitScalar(yaml, n, PLAIN, false)}${eol}`).join("")}`;
        if (titlePair) edits.push({ from: lineEndIncl(fm, Math.max(titlePair.value.end, titlePair.key.end) - 1), to: lineEndIncl(fm, Math.max(titlePair.value.end, titlePair.key.end) - 1), insert: block });
        else freshTop.push(block);
      }
      slotSources = names.map(() => null);
    } else {
      const v = pair.value;
      const nodes: YNode[] = v.kind === "seq" ? v.items : v.kind === "scalar" && v.isNull ? [] : [v];
      const oldNames = nodes.map(nameOfNode);
      const jsNames = asList(oldObj[authorKey!]).map(nameOfJs);
      if (jsNames.length !== oldNames.length) throw new FrontMatterEditError("author list did not parse consistently");
      const slots = planSlots(oldNames, names);
      slotSources = slots.map((s) => ("old" in s ? s.old : null));
      const identity = slots.length === nodes.length && slots.every((s, i) => "old" in s && s.old === i);
      const mapStyle = nodes.some((n) => n.kind === "map");
      if (fallback) {
        edits.push(...planAuthorsFallback(yaml, fm, root, oldObj, authorKey!, slots, eol));
      } else if (identity) {
        slots.forEach((s, i) => {
          if ("old" in s && s.rename !== undefined && s.rename !== oldNames[i]) {
            edits.push(...renameEdits(yaml, fm, nodes[i], s.rename, v.kind === "seq" && v.flow));
          }
        });
      } else if (!slots.length) {
        // Every author removed: the key goes (its line block only).
        edits.push({ from: lineStart(fm, pair.key.start), to: lineEndIncl(fm, Math.max(v.end, pair.key.end) - 1), insert: "" });
      } else if (v.kind === "seq" && v.flow) {
        const text = (s: Slot) => {
          if ("fresh" in s) return emitScalar(yaml, s.fresh, PLAIN, true);
          const n = nodes[s.old];
          const local = s.rename !== undefined ? renameEdits(yaml, fm, n, s.rename, true) : [];
          return applyEdits(fm.slice(n.start, n.end), local.map((e) => ({ ...e, from: e.from - n.start, to: e.to - n.start })));
        };
        edits.push({ from: v.start, to: v.end, insert: `[${slots.map(text).join(", ")}]` });
      } else if (v.kind === "seq") {
        // Block sequence: whole entries move as line blocks, verbatim.
        const dash = (n: YNode) => {
          let j = n.start - 1;
          while (j >= 0 && (fm[j] === " " || fm[j] === "\t")) j--;
          if (fm[j] !== "-" || n.start < 0) throw new FrontMatterEditError("author entry layout");
          return j;
        };
        const dashes = nodes.map(dash);
        // An entry owns the lines between the previous entry's last line and
        // its own dash (a `# joined in 2025` comment travels with its author).
        const segStart = dashes.map((d, i) => (i === 0 ? lineStart(fm, d) : lineEndIncl(fm, Math.max(nodes[i - 1].end, nodes[i - 1].start + 1) - 1)));
        const segEnd = nodes.map((n, i) => (i + 1 < nodes.length ? segStart[i + 1] : lineEndIncl(fm, Math.max(n.end, n.start + 1) - 1)));
        const indent = fm.slice(segStart[0], dashes[0]);
        const segment = (s: Slot) => {
          if ("fresh" in s) return `${indent}- ${mapStyle ? "name: " : ""}${emitScalar(yaml, s.fresh, PLAIN, false)}${eol}`;
          const i = s.old;
          let t = fm.slice(segStart[i], segEnd[i]);
          if (s.rename !== undefined && s.rename !== oldNames[i]) {
            const local = renameEdits(yaml, fm, nodes[i], s.rename, false);
            t = applyEdits(t, local.map((e) => ({ ...e, from: e.from - segStart[i], to: e.to - segStart[i] })));
          }
          return t.endsWith("\n") ? t : t + eol;
        };
        const regionEnd = segEnd[nodes.length - 1];
        let body = slots.map(segment).join("");
        if (!fm.slice(segStart[0], regionEnd).endsWith("\n")) body = body.replace(/\r?\n$/, "");
        edits.push({ from: segStart[0], to: regionEnd, insert: body });
      } else if (v.kind === "scalar" && v.isNull) {
        edits.push({
          from: pair.key.end,
          to: v.end,
          insert: `:${eol}${slots.map((s) => `  - name: ${emitScalar(yaml, "fresh" in s ? s.fresh : s.rename ?? oldNames[s.old], PLAIN, false)}`).join(eol)}`,
        });
      } else if (v.kind === "scalar" && !v.decorated) {
        // `author: Jane Doe` with more than one name now: a block list of names.
        edits.push({
          from: pair.key.end,
          to: v.end,
          insert: `:${eol}${slots.map((s) => `  - name: ${"fresh" in s ? emitScalar(yaml, s.fresh, PLAIN, false) : s.rename !== undefined ? emitScalar(yaml, s.rename, v.style, false) : fm.slice(v.start, v.end)}`).join(eol)}`,
        });
      } else {
        edits.push(...planAuthorsFallback(yaml, fm, root, oldObj, authorKey!, slots, eol));
      }
    }
  }

  if (freshTop.length) edits.unshift({ from: 0, to: 0, insert: freshTop.join("") });
  return { edits, authorKey, slotSources };
}

function verifyPlan(yaml: YamlMod, fm: string, next: string, edit: TitleAuthorsEdit, plan: FmPlan): string | null {
  const before = loadMap(yaml, fm);
  let after: Record<string, unknown>;
  try {
    after = loadMap(yaml, next);
  } catch (err) {
    return `edited YAML does not parse: ${(err as Error).message.split("\n")[0]}`;
  }
  const owned = new Set<string>();
  if (edit.title !== undefined) owned.add("title");
  if (edit.authors !== undefined && plan.authorKey) owned.add(plan.authorKey);
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (owned.has(k)) continue;
    if (!deepEqual(before[k], after[k])) return `key "${k}" changed`;
  }
  if (Object.keys(before).filter((k) => !owned.has(k)).join("\n") !== Object.keys(after).filter((k) => !owned.has(k)).join("\n")) return "key order changed";
  if (edit.title !== undefined) {
    const t = after.title;
    const got = t == null ? "" : String(t);
    const want = edit.title;
    if (got !== want && !(typeof t !== "string" && before.title === t)) return `title reads ${JSON.stringify(got)}`;
  }
  if (edit.authors !== undefined && plan.authorKey) {
    const want = edit.authors.map((a) => a.trim()).filter(Boolean);
    const list = asList(after[plan.authorKey]);
    const oldList = asList(before[plan.authorKey]);
    const names = list.map(nameOfJs).filter(Boolean);
    if (names.join("\u0000") !== want.join("\u0000")) return `authors read ${JSON.stringify(names)}`;
    if (list.length !== plan.slotSources.length) return "author entry count";
    for (let i = 0; i < list.length; i++) {
      const src = plan.slotSources[i];
      if (src === null) continue;
      if (!deepEqual(withoutName(oldList[src]), withoutName(list[i]))) return `author ${i + 1} lost a field`;
      const on = (oldList[src] as Record<string, unknown> | null)?.name;
      const nn = (list[i] as Record<string, unknown> | null)?.name;
      if (on && typeof on === "object" && nn && typeof nn === "object") {
        const { given: _g, family: _f, literal: _l, ...restOld } = on as Record<string, unknown>;
        const { given: _g2, family: _f2, literal: _l2, ...restNew } = nn as Record<string, unknown>;
        void _g; void _f; void _l; void _g2; void _f2; void _l2;
        if (!deepEqual(restOld, restNew)) return `author ${i + 1} name fields changed`;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ public API

/** The title + author names exactly as the editor and the export read them. */
export function readTitleAuthorsWith(yaml: YamlMod, src: string): { title: string; authors: string[] } {
  const b = frontMatterBounds(src);
  if (!b.has) return { title: "", authors: [] };
  let obj: Record<string, unknown> = {};
  try {
    obj = loadMap(yaml, b.fmText);
  } catch {
    return { title: "", authors: [] };
  }
  const key = authorKeyOf(obj);
  const t = obj.title;
  return {
    title: t == null ? "" : typeof t === "string" ? t : String(t),
    authors: key ? asList(obj[key]).map(nameOfJs).filter(Boolean) : [],
  };
}

/** Plan the byte-minimal changes (DOCUMENT offsets) that set the title and/or
 *  the author names. Throws `FrontMatterEditError` rather than lose data. */
export function planTitleAuthorsEditWith(yaml: YamlMod, src: string, edit: TitleAuthorsEdit): FmChange[] {
  const b = frontMatterBounds(src);
  const eol = /\r\n/.test(b.has ? b.fmText : src.slice(0, 2000)) ? "\r\n" : "\n";
  if (!b.has) {
    if (b.open) throw new FrontMatterEditError("The front matter has no closing ---");
    const lines: string[] = [];
    if (edit.title) lines.push(`title: ${emitScalar(yaml, edit.title, PLAIN, false)}`);
    const names = (edit.authors ?? []).map((a) => a.trim()).filter(Boolean);
    if (names.length) lines.push("author:", ...names.map((n) => `  - name: ${emitScalar(yaml, n, PLAIN, false)}`));
    if (!lines.length) return [];
    return [{ from: 0, to: 0, insert: `---${eol}${lines.join(eol)}${eol}---${eol}${eol}` }];
  }
  const fm = b.fmText;
  let plan: FmPlan | null = null;
  let why = "";
  for (const fallback of [false, true]) {
    if (fallback && edit.authors === undefined) break;
    let p: FmPlan;
    try {
      p = planOnFm(yaml, fm, edit, eol, fallback);
    } catch (err) {
      if (!(err instanceof FrontMatterEditError) || /not valid YAML|not a (block )?mapping|closing/.test(err.message)) throw err;
      why = err.message;
      continue;
    }
    const failure = verifyPlan(yaml, fm, applyEdits(fm, p.edits), edit, p);
    if (!failure) {
      plan = p;
      break;
    }
    why = failure;
  }
  if (!plan) throw new FrontMatterEditError(`Could not update the front matter without changing other fields (${why}).`);
  const out: FmChange[] = [];
  for (const e of plan.edits) {
    const m = minimize(fm, e);
    if (m) out.push({ from: b.fmStart + m.from, to: b.fmStart + m.to, insert: m.insert });
  }
  out.sort((a, c) => a.from - c.from);
  // Same-position inserts merge (CodeMirror orders them; one change is unambiguous).
  const merged: FmChange[] = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (last && last.from === c.from && last.to === last.from && c.to === c.from) last.insert += c.insert;
    else merged.push({ ...c });
  }
  return merged;
}

/** Plan setting (or, with `null`, removing) one TOP-LEVEL scalar key — `csl:`
 *  and friends — keeping its quoting style and every other byte. */
export function planSetScalarKeyWith(yaml: YamlMod, src: string, key: string, value: string | null): FmChange[] {
  const b = frontMatterBounds(src);
  const eol = /\r\n/.test(b.has ? b.fmText : src.slice(0, 2000)) ? "\r\n" : "\n";
  if (!b.has) {
    if (b.open) throw new FrontMatterEditError("The front matter has no closing ---");
    if (value === null) return [];
    return [{ from: 0, to: 0, insert: `---${eol}${key}: ${emitScalar(yaml, value, PLAIN, false)}${eol}---${eol}${eol}` }];
  }
  const fm = b.fmText;
  let tree: YNode | null;
  try {
    tree = buildTree(yaml, fm);
  } catch (err) {
    throw new FrontMatterEditError(`The front matter is not valid YAML (${(err as Error).message.split("\n")[0]})`);
  }
  if (tree && (tree.kind !== "map" || tree.flow)) throw new FrontMatterEditError("front matter is not a block mapping");
  const root = tree as YMap | null;
  const pair = root ? pairOf(root, key) : undefined;
  let e: Edit | null = null;
  if (pair) {
    if (value === null) e = { from: lineStart(fm, pair.key.start), to: lineEndIncl(fm, Math.max(pair.value.end, pair.key.end) - 1), insert: "" };
    else if (pair.value.kind === "scalar") e = (pair.value.isNull ? "" : pair.value.value) === value ? null : scalarEdit(yaml, fm, pair.value, value, false);
    else e = { from: pair.key.end, to: pair.value.end, insert: `: ${emitScalar(yaml, value, PLAIN, false)}` };
  } else if (value !== null) {
    e = { from: fm.length, to: fm.length, insert: `${fm.length && !fm.endsWith("\n") ? eol : ""}${key}: ${emitScalar(yaml, value, PLAIN, false)}${eol}` };
  }
  if (!e) return [];
  const next = applyEdits(fm, [e]);
  const before = loadMap(yaml, fm), after = loadMap(yaml, next);
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === key) continue;
    if (!deepEqual(before[k], after[k])) throw new FrontMatterEditError(`Could not set ${key} without changing "${k}".`);
  }
  if (value === null ? key in after : after[key] !== value) throw new FrontMatterEditError(`Could not set ${key}.`);
  const m = minimize(fm, e);
  return m ? [{ from: b.fmStart + m.from, to: b.fmStart + m.to, insert: m.insert }] : [];
}

/** Apply `FmChange`s (document offsets) to a string — the gate's and any
 *  headless caller's twin of CodeMirror's dispatch. */
export function applyFmChanges(src: string, changes: FmChange[]): string {
  return applyEdits(src, changes);
}

const loadYaml = () => import("js-yaml") as Promise<YamlMod>;
export async function planTitleAuthorsEdit(src: string, edit: TitleAuthorsEdit): Promise<FmChange[]> {
  return planTitleAuthorsEditWith(await loadYaml(), src, edit);
}
export async function readTitleAuthors(src: string): Promise<{ title: string; authors: string[] }> {
  return readTitleAuthorsWith(await loadYaml(), src);
}
export async function planSetScalarKey(src: string, key: string, value: string | null): Promise<FmChange[]> {
  return planSetScalarKeyWith(await loadYaml(), src, key, value);
}
