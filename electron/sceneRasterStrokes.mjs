// resvg does not implement non-scaling-stroke. For scene chrome below only
// translations, move each leaf's geometry into output-pixel coordinates and
// cancel that scale on the leaf. Geometry stays put; stroke/dash metrics are
// then genuine pixels, including independent rounding of the raster axes.
const number = '[-+]?(?:\\d*\\.\\d+|\\d+\\.?\\d*)(?:[eE][-+]?\\d+)?';
const translation = new RegExp(`^(?:\\s*translate\\(\\s*${number}(?:[ ,]+${number})?\\s*\\)\\s*)*$`);
const property = (node, name) => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(node.getAttribute('style') ?? '')?.[1].trim() ?? node.getAttribute(name);
const removeStyle = (node, name) => node.setAttribute('style', (node.getAttribute('style') ?? '').replace(new RegExp(`(?:^|;)\\s*${name}\\s*:[^;]*`, 'gi'), ''));
function inheritedProperty(node, name) {
  for (let n = node; n?.nodeType === 1; n = n.parentNode) {
    const value = property(n, name);
    if (value && value !== 'inherit') return value;
  }
  return '';
}
function globalRules(root) {
  return Array.from(root.getElementsByTagName('style')).some(style => {
    const css = (style.textContent ?? '').replace(/@font-face\s*\{[^}]*\}/gi, '');
    // Prepared plot sheets are confined to nested data-plot-scope roots;
    // supported scene chrome cannot be below a nested SVG, so those selectors
    // cannot change it or a clip wrapper. Other cascades need the live engine.
    const remaining = css.replace(/([^{}]+)\{[^{}]*\}/g, (rule, selectors) => selectors.split(',').every(selector => /^\s*\[data-plot-scope=(?:"[^"]*"|'[^']*')\]\s+/.test(selector)) ? '' : rule);
    return !!remaining.trim();
  });
}
const inverse = (node, original, sx, sy) => node.setAttribute('transform', `${original} scale(${1 / sx} ${1 / sy})`.trim());
function scaledPath(d, sx, sy) {
  let axis = 0, command = '';
  return d.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g, token => {
    if (/^[a-zA-Z]$/.test(token)) { command = token.toUpperCase(); axis = 0; if (!'MLHVCSQTZ'.includes(command)) throw Error('Unsupported non-scaling stroke path'); return token; }
    if (!command || command === 'Z') throw Error('Invalid non-scaling stroke path');
    const scale = command === 'H' ? sx : command === 'V' ? sy : axis++ % 2 === 0 ? sx : sy;
    return String(Number(token) * scale);
  });
}
export function sceneStrokePlans(root) {
  const plans = [];
  const stylesheetDependent = globalRules(root);
  for (const node of [root, ...Array.from(root.getElementsByTagName('*'))]) {
    if (property(node, 'vector-effect') !== 'non-scaling-stroke') continue;
    if (stylesheetDependent) throw Error('Stylesheet-dependent non-scaling strokes require the live renderer');
    for (let n = node; n; n = n.parentNode) {
      if (n.nodeType !== 1) continue;
      if (n.hasAttribute('data-plot-scope')) throw Error('Plot-scoped non-scaling strokes require the live renderer');
      if (n !== root && n.localName === 'svg' || !translation.test(n.getAttribute('transform') ?? '') || /(?:^|;)\s*transform\s*:/i.test(n.getAttribute('style') ?? '')) throw Error('Complex non-scaling strokes require the live renderer');
      if (n === root) break;
    }
    for (const name of ['fill', 'stroke', 'marker-start', 'marker-mid', 'marker-end'])
      if (/url\s*\(/i.test(inheritedProperty(node, name))) throw Error('Referenced non-scaling stroke paints require the live renderer');
    for (const name of ['mask', 'filter']) {
      const value = property(node, name);
      if (value && value !== 'none') throw Error('Non-scaling stroke masks/filters require the live renderer');
    }
    let original = node.getAttribute('transform') ?? '';
    const tag = node.localName, clip = property(node, 'clip-path');
    if (clip && clip !== 'none') {
      if (/!important/i.test(clip)) throw Error('Unsupported non-scaling stroke clip priority');
      // A leaf's inverse scale must not also scale its user-space clip. Keep
      // the original transform and clipping together outside that inverse.
      const wrapper = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
      if (original) wrapper.setAttribute('transform', original);
      wrapper.setAttribute('clip-path', clip);
      node.parentNode.insertBefore(wrapper, node); wrapper.appendChild(node);
      node.removeAttribute('clip-path'); removeStyle(node, 'clip-path');
      node.removeAttribute('transform'); original = '';
    }
    const fields = tag === 'rect' ? { x: 'x', y: 'y', width: 'x', height: 'y', rx: 'x', ry: 'y' }
      : tag === 'line' ? { x1: 'x', y1: 'y', x2: 'x', y2: 'y' } : null;
    if (fields) {
      const values = Object.entries(fields).filter(([key]) => node.hasAttribute(key)).map(([key, axis]) => [key, axis, Number(node.getAttribute(key))]);
      if (tag === 'rect' && node.hasAttribute('rx') && !node.hasAttribute('ry')) values.push(['ry', 'y', Number(node.getAttribute('rx'))]);
      if (tag === 'rect' && node.hasAttribute('ry') && !node.hasAttribute('rx')) values.push(['rx', 'x', Number(node.getAttribute('ry'))]);
      if (values.some(([, , value]) => !Number.isFinite(value))) throw Error('Unsupported non-scaling stroke geometry');
      plans.push((sx, sy) => { for (const [key, axis, value] of values) node.setAttribute(key, String(value * (axis === 'x' ? sx : sy))); inverse(node, original, sx, sy); });
    } else if (tag === 'path') {
      const d = node.getAttribute('d') ?? ''; scaledPath(d, 1, 1);
      plans.push((sx, sy) => { node.setAttribute('d', scaledPath(d, sx, sy)); inverse(node, original, sx, sy); });
    } else if (tag === 'polyline' || tag === 'polygon') {
      const points = node.getAttribute('points') ?? '';
      plans.push((sx, sy) => { let i = 0; node.setAttribute('points', points.replace(new RegExp(number, 'g'), n => String(Number(n) * (i++ % 2 ? sy : sx)))); inverse(node, original, sx, sy); });
    } else throw Error('Unsupported non-scaling stroke shape');
    node.setAttribute('vector-effect', 'none');
    node.setAttribute('style', (node.getAttribute('style') ?? '').replace(/(?:^|;)\s*vector-effect\s*:[^;]*/gi, '') + ';vector-effect:none');
  }
  return plans;
}
