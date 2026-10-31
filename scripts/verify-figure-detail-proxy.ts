import { DOMParser, parseHTML, Node as DOMNode } from 'linkedom';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { harness } from './lib/harness.mjs';
const h = harness('verify-figure-detail-proxy');
const { document } = parseHTML('<html><body></body></html>');
// XMLSerializer only needs serializeToString here; linkedom supplies the XML DOM.
class Serializer { serializeToString(n: Node) { return String(n); } }
Object.assign(globalThis, { DOMParser, document, XMLSerializer: Serializer, Node: DOMNode,
  getComputedStyle: () => ({ getPropertyValue: () => '' }) });
const proxy = await import(process.env.FLUX_DETAIL_BASE ? pathToFileURL(path.join(process.env.FLUX_DETAIL_BASE, 'src/lib/interact/zoomProxy.ts')).href : '../src/lib/interact/zoomProxy');
const exported = Object.keys(proxy).filter(k => k.startsWith('serialize')).sort();
const exercised = ['serializeFigureRegion', 'serializeSceneRegion', 'serializeSceneSnapshot', 'serializeSceneSnapshotCooperative'];
h.eq(exported, exercised, 'all exported serializers are exercised (new exports must extend this gate)');
const box = { bx: 0, by: 0, bw: 100, bh: 100 };
function scene(detail: boolean): SVGSVGElement {
  const svg = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg"><g><g><g data-annotation-figure="b"><rect width="100" height="100"/><g clip-path="url(#frame)"><g data-editor-element-id="p"><rect width="50" height="50"/></g>${detail ? '<image class="figure-raster figure-detail" data-figure-detail="b" href="blob:large-detail" width="100" height="100"/>' : ''}</g></g></g></g></svg>`, 'image/svg+xml').documentElement;
  document.body.appendChild(document.importNode(svg, true));
  return document.body.lastElementChild as unknown as SVGSVGElement;
}
try {
  const clean = scene(false), detailed = scene(true), original = String(detailed);
  h.ok(typeof proxy.captureExcluded === 'function' && proxy.captureExcluded(detailed.querySelector('image')!), 'detail predicate recognizes the live detail image');
  for (const name of exercised) {
    const serialize = async (s: SVGSVGElement) => {
      if (name === 'serializeFigureRegion') return proxy.serializeFigureRegion(s.querySelector('[data-annotation-figure]')! as SVGGElement, { width: 100, height: 100, background: '#fff' }, 1).svg;
      if (name === 'serializeSceneRegion') return proxy.serializeSceneRegion(s, box, 1, () => true, 1000)?.svg;
      if (name === 'serializeSceneSnapshotCooperative') return (await proxy.serializeSceneSnapshotCooperative(s, box, 1, { current: () => true, yield: async () => {}, maxNodes: clean.querySelectorAll('*').length }))?.svg;
      return proxy.serializeSceneSnapshot(s, box, 1).svg;
    };
    const withDetail = await serialize(detailed), withoutDetail = await serialize(clean);
    h.ok(!!withDetail && !withDetail.includes('figure-detail') && !withDetail.includes('blob:'), `${name}: detail absent from capture`);
    h.eq(withDetail, withoutDetail, `${name}: byte-identical to scene without detail`);
  }
  h.eq(String(detailed), original, 'serializers never mutate live detail DOM');
} catch (e) { h.fail(String(e)); }
await h.done();
