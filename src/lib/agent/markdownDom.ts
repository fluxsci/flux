// Inert Markdown → DOM for agent prose. The model's text is DATA: nothing it
// writes ever reaches innerHTML. Every node is built with createElement /
// createTextNode, so `<img src=x onerror=…>` in an answer renders as the
// literal characters (verify-ask-gui pins that; verify-transcript pins this
// module). Supports the subset an agent actually writes — paragraphs,
// headings, bullet / numbered / task lists (nested by indent), fenced code with
// a language label, inline code, bold / italic / strikethrough, links
// (http(s) only; anything else stays text), block quotes, pipe tables and
// rules. Synchronous and small, so a streaming answer can be re-rendered on
// every frame. Takes the Document to build in, so linkedom can gate it.

export interface MarkdownOptions {
  /** Anchors get this attribute set to "" (the surface intercepts clicks and opens externally). */
  linkAttr?: string;
}

type Doc = Document;

const SAFE_URL = /^https?:\/\/[^\s<>"')]+$/i;

// ---- inline --------------------------------------------------------------------------

const INLINE_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(([^\s)]+)\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*\*|__)(?=\S)([\s\S]*?\S)\7|(\*|_)(?=\S)([^*_\n]*?\S)\9|~~(?=\S)([\s\S]*?\S)~~|\\([\\`*_{}[\]()#+\-.!~|>])/g;

function inlineInto(doc: Doc, parent: Node, src: string, opts: MarkdownOptions, inLink = false): void {
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) parent.appendChild(doc.createTextNode(src.slice(last, i)));
    last = i + m[0].length;
    if (m[2] !== undefined) {
      const code = doc.createElement("code"); code.textContent = m[2].trim(); parent.appendChild(code);
    } else if (m[3] !== undefined || m[5] !== undefined || m[6] !== undefined) {
      // No anchor inside an anchor: link text renders as text.
      if (inLink) parent.appendChild(doc.createTextNode(m[0]));
      else if (m[3] !== undefined) appendLink(doc, parent, m[3], m[4], opts);
      else appendLink(doc, parent, (m[5] ?? m[6])!, (m[5] ?? m[6])!, opts);
    } else if (m[8] !== undefined) {
      const el = doc.createElement("strong"); inlineInto(doc, el, m[8], opts, inLink); parent.appendChild(el);
    } else if (m[10] !== undefined) {
      // An underscore inside a word (snake_case) is text, not emphasis.
      const before = src[i - 1] ?? "", after = src[last] ?? "";
      if (m[9] === "_" && (/[\p{L}\p{N}]/u.test(before) || /[\p{L}\p{N}]/u.test(after))) parent.appendChild(doc.createTextNode(m[0]));
      else { const el = doc.createElement("em"); inlineInto(doc, el, m[10], opts, inLink); parent.appendChild(el); }
    } else if (m[11] !== undefined) {
      const el = doc.createElement("s"); inlineInto(doc, el, m[11], opts, inLink); parent.appendChild(el);
    } else if (m[12] !== undefined) {
      parent.appendChild(doc.createTextNode(m[12]));
    }
  }
  if (last < src.length) parent.appendChild(doc.createTextNode(src.slice(last)));
}

function appendLink(doc: Doc, parent: Node, text: string, url: string, opts: MarkdownOptions): void {
  if (!SAFE_URL.test(url)) { parent.appendChild(doc.createTextNode(text === url ? url : `${text} (${url})`)); return; }
  const a = doc.createElement("a");
  a.setAttribute("href", url);
  a.setAttribute("rel", "noopener noreferrer");
  a.setAttribute("title", url);
  if (opts.linkAttr) a.setAttribute(opts.linkAttr, "");
  if (text === url) a.textContent = url; else inlineInto(doc, a, text, opts, true);
  parent.appendChild(a);
}

// ---- blocks --------------------------------------------------------------------------

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w.+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ROW = /^\s*\|.*\|\s*$/;

interface ListItem { marker: string; indent: number; text: string[]; children: ListItem[]; task?: boolean | null }

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = []; let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") { cur += "|"; i++; }
    else if (ch === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Render `src` into a fragment of `doc`. */
export function renderMarkdown(src: string, doc: Doc = document, opts: MarkdownOptions = {}): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = doc.createElement("p");
    // Soft breaks join with a space; a backslash or two trailing spaces is a hard break.
    const parts = para.map(l => l.trim());
    parts.forEach((part, k) => {
      const hard = /(\\|\s{2,})$/.test(para[k]) && k < parts.length - 1;
      inlineInto(doc, p, hard ? part.replace(/\\$/, "") : part, opts);
      if (k < parts.length - 1) p.appendChild(hard ? doc.createElement("br") : doc.createTextNode(" "));
    });
    frag.appendChild(p); para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = line.match(FENCE))) {
      flushPara();
      const fence = m[2], lang = m[3];
      const body: string[] = []; i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(3)) && lines[i].trim().replace(/[`~]/g, "") === "")) body.push(lines[i++]);
      if (i >= lines.length && body[body.length - 1] === "") body.pop(); // unclosed while streaming: drop the dangling newline
      i++; // closing fence (or EOF while streaming)
      const pre = doc.createElement("pre"); const code = doc.createElement("code");
      if (lang) { pre.setAttribute("data-lang", lang); code.setAttribute("class", `language-${lang}`); }
      code.textContent = body.join("\n"); pre.appendChild(code); frag.appendChild(pre);
      continue;
    }
    if ((m = line.match(HEADING))) {
      flushPara();
      const h = doc.createElement(`h${m[1].length}`); inlineInto(doc, h, m[2], opts); frag.appendChild(h); i++; continue;
    }
    if (RULE.test(line)) { flushPara(); frag.appendChild(doc.createElement("hr")); i++; continue; }
    if (QUOTE.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && (m = lines[i].match(QUOTE))) { inner.push(m[1]); i++; }
      const bq = doc.createElement("blockquote"); bq.appendChild(renderMarkdown(inner.join("\n"), doc, opts)); frag.appendChild(bq); continue;
    }
    if (ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map(c => c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : "");
      i += 2;
      const table = doc.createElement("table"), thead = doc.createElement("thead"), tr = doc.createElement("tr");
      head.forEach((c, k) => { const th = doc.createElement("th"); if (aligns[k]) th.setAttribute("style", `text-align:${aligns[k]}`); inlineInto(doc, th, c, opts); tr.appendChild(th); });
      thead.appendChild(tr); table.appendChild(thead);
      const tbody = doc.createElement("tbody");
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        const row = doc.createElement("tr");
        splitRow(lines[i]).forEach((c, k) => { const td = doc.createElement("td"); if (aligns[k]) td.setAttribute("style", `text-align:${aligns[k]}`); inlineInto(doc, td, c, opts); row.appendChild(td); });
        tbody.appendChild(row); i++;
      }
      table.appendChild(tbody); frag.appendChild(table); continue;
    }
    if ((m = line.match(LIST))) {
      flushPara();
      const items: ListItem[] = [];
      const stack: ListItem[] = [];
      const ordered = /^\d/.test(m[2]);
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) {
          // A blank line inside a list only ends it when the next non-blank line is neither
          // a top-level item of the same list type nor indented continuation.
          const next = lines[i + 1], nm = next?.match(LIST);
          if (nm && (nm[1].length > 0 || /^\d/.test(nm[2]) === ordered)) { i++; continue; }
          if (next !== undefined && !nm && /^\s{2,}\S/.test(next)) { i++; continue; }
          break;
        }
        const lm = l.match(LIST);
        if (lm) {
          const indent = lm[1].replace(/\t/g, "  ").length;
          const item: ListItem = { marker: lm[2], indent, text: [lm[3]], children: [], task: null };
          const tm = lm[3].match(TASK);
          if (tm) { item.task = tm[1] !== " "; item.text = [tm[2]]; }
          while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
          if (stack.length) stack[stack.length - 1].children.push(item); else items.push(item);
          stack.push(item); i++;
        } else if (stack.length && /^\s+\S/.test(l)) { stack[stack.length - 1].text.push(l.trim()); i++; }
        else break;
      }
      frag.appendChild(listNode(doc, items, opts));
      continue;
    }
    para.push(line); i++;
  }
  flushPara();
  return frag;
}

function listNode(doc: Doc, items: ListItem[], opts: MarkdownOptions): HTMLElement {
  const ordered = /^\d/.test(items[0].marker);
  const list = doc.createElement(ordered ? "ol" : "ul");
  if (ordered) { const start = parseInt(items[0].marker, 10); if (start !== 1) list.setAttribute("start", String(start)); }
  for (const item of items) {
    const li = doc.createElement("li");
    if (item.task !== null && item.task !== undefined) {
      li.setAttribute("data-task", item.task ? "done" : "open");
      const box = doc.createElement("span"); box.setAttribute("class", "md-task"); box.setAttribute("aria-hidden", "true"); box.textContent = item.task ? "☑" : "☐"; li.appendChild(box);
      li.appendChild(doc.createTextNode(" "));
    }
    inlineInto(doc, li, item.text.join(" "), opts);
    if (item.children.length) li.appendChild(listNode(doc, item.children, opts));
    list.appendChild(li);
  }
  return list;
}

/** Plain text of the markdown (for previews and clipboard fallbacks). */
export function markdownText(src: string): string {
  return src.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*\n?/g, "")).replace(/[*_~`#>]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
}
