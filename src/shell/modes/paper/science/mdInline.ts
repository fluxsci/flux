// Minimal synchronous inline-markdown → DOM for widget captions: bold, italic,
// inline code, backslash escapes. The full markdown-it pipeline is deliberately
// dynamic-imported off the editor hot path (render/renderManuscript.ts), and
// captions only need this tiny subset — built as real DOM nodes, no innerHTML.
// Bold maps to <strong> so `.flux-embed-cap b { … }` keeps styling ONLY the
// "Figure N." prefix the widget builds itself.

const INLINE_RE = /(\*\*|__)(.+?)\1|([*_])([^*_]+?)\3|`([^`]+)`|\\([\\`*_[\]()])/g;

export function mdInlineFragment(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of src.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) frag.appendChild(document.createTextNode(src.slice(last, i)));
    if (m[2] !== undefined) {
      const el = document.createElement("strong");
      el.appendChild(mdInlineFragment(m[2]));
      frag.appendChild(el);
    } else if (m[4] !== undefined) {
      const el = document.createElement("em");
      el.appendChild(mdInlineFragment(m[4]));
      frag.appendChild(el);
    } else if (m[5] !== undefined) {
      const el = document.createElement("code");
      el.textContent = m[5];
      frag.appendChild(el);
    } else {
      frag.appendChild(document.createTextNode(m[6]));
    }
    last = i + m[0].length;
  }
  if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
  return frag;
}
