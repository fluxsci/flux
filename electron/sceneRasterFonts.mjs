// Font requests must be read AFTER XML entity decoding: the semicolon in
// &quot; used to truncate every quoted family stack to "&quot" (2026-10-30).
import { DOMParser } from '@xmldom/xmldom';

export function cssWeight(value, parent = 400) {
  if (value === 'bolder') return parent < 350 ? 400 : parent < 550 ? 700 : 900;
  if (value === 'lighter') return parent < 550 ? 100 : parent < 750 ? 400 : 700;
  if (value === 'bold') return 700;
  if (value === 'normal' || value === 'initial') return 400;
  const number = Number(value);
  return number >= 1 && number <= 1000 ? number : parent;
}
const initial = { family: 'sans-serif', weight: 400, style: 'normal' };
function declarations(style) {
  // Quotes protect semicolons in a family name. XML has already decoded entities.
  return style.match(/(?:[^;'"()]|'[^']*'|"[^"]*"|\([^)]*\))+/g) ?? [];
}
export function nodeFont(node, inherited = initial) {
  const font = { ...inherited };
  const apply = (name, raw) => {
    const value = raw.trim().replace(/\s*!important\s*$/i, '');
    if (value === 'inherit' || value === 'unset') return;
    if (name === 'font-family') font.family = value === 'initial' ? initial.family : value;
    if (name === 'font-weight') font.weight = cssWeight(value, inherited.weight);
    if (name === 'font-style') font.style = /^(?:italic|oblique)\b/.test(value) ? 'italic' : 'normal';
    if (name === 'font') {
      // A size has a unit (or is a CSS size keyword); a numeric weight is NOT a size.
      const match = /^(.*?)\b(?:\d*\.?\d+(?:px|pt|pc|in|cm|mm|em|rem|ex|ch|%)|xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)(?:\s*\/\s*(?:\d*\.?\d+(?:[a-z%]+)?|normal))?\s+(.+)$/i.exec(value);
      if (match) {
        font.family = match[2]; font.style = /\b(?:italic|oblique)\b/.test(match[1]) ? 'italic' : 'normal';
        font.weight = cssWeight(/\b(?:bold|bolder|lighter|[1-9]\d{0,2}|1000)\b/.exec(match[1])?.[0] ?? 'normal', inherited.weight);
      }
    }
  };
  for (const name of ['font-family', 'font-weight', 'font-style']) if (node.hasAttribute(name)) apply(name, node.getAttribute(name));
  for (const declaration of declarations(node.getAttribute('style') ?? '')) {
    const colon = declaration.indexOf(':'); if (colon >= 0) apply(declaration.slice(0, colon).trim().toLowerCase(), declaration.slice(colon + 1));
  }
  return font;
}
/** Every font request a scene makes. Pass the already-parsed Document when there is one:
 *  a second xmldom parse of a multi-MB figure costs hundreds of ms (QA-P6a). */
export function svgFontRequests(svg) {
  const doc = typeof svg === 'string' ? new DOMParser({ errorHandler: { warning() {}, error() {}, fatalError() {} } }).parseFromString(svg, 'image/svg+xml') : svg;
  const requests = new Map(), inherited = new WeakMap();
  const add = font => { const key = JSON.stringify(font); if (!requests.has(key)) { if (requests.size >= 128) throw Error('Too many scene font requests'); requests.set(key, font); } };
  const elements = [doc.documentElement, ...Array.from(doc.documentElement.getElementsByTagName('*'))];
  const sheetFamilies = new Set(), weights = new Set([400]), styles = new Set(['normal']);
  for (const node of elements) {
    const font = nodeFont(node, inherited.get(node.parentNode)); inherited.set(node, font);
    if (['text', 'tspan', 'textPath'].includes(node.localName)) add(font);
    if (node.localName === 'style') {
      // Loading a superset is safe: resvg owns the selector cascade. Include sheet
      // faces with inherited inline weights/styles rather than guessing selectors.
      for (const body of (node.textContent ?? '').matchAll(/\{([^{}]*)\}/g)) {
        const proxy = doc.createElement('g'); proxy.setAttribute('style', body[1]);
        const f = nodeFont(proxy); sheetFamilies.add(f.family); weights.add(f.weight); styles.add(f.style);
        if (/\b(?:bolder|lighter)\b/.test(body[1])) { weights.add(100); weights.add(700); weights.add(900); }
      }
    }
    weights.add(font.weight); styles.add(font.style);
  }
  if (sheetFamilies.size) {
    for (const req of requests.values()) sheetFamilies.add(req.family);
    for (const family of sheetFamilies) for (const weight of weights) for (const style of styles) add({ family, weight, style });
  }
  if (!requests.size) add({ ...initial });
  return [...requests.values()];
}
