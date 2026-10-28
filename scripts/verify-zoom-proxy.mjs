// 2026-09-16 — the zoom proxy (Canvas.svelte + interact/zoomProxy.ts): a
// ctrl-wheel zoom burst rides a raster of the scene on the compositor while the
// live scene is frozen and visually covered; the settle fold brings it back in
// one commit. Gated on the dense lazy-assets fixture against the dev server:
//   · at rest a decoded snapshot exists (an <img> with a blob src, opacity 0);
//   · during the burst the proxy is live, its scale follows zoom, the scene's
//     <g> and inline transform do NOT change (frozen), main-thread task time per
//     tick stays small (the live zoom read ~20 ms/tick), no long task;
//   · after the settle the proxy retreats, the scene is back with the fold applied
//     (g scale == zoom, residual 1);
//   · a model edit re-keys the snapshot: a new blob URL lands at idle;
//   · a pan does NOT re-key it (world-space snapshot);
//   · View-as changes sharp/coarse pixels during a burst without recapture;
//   · cooperative serialization preserves XML/pixels and cancels between slices;
//   · a sharper subset frees retired planes; reversal and offscreen edits stay fresh;
//   · transparent art/shadows composite once across the sharp/coarse seam and backdrop.
//   node scripts/verify-zoom-proxy.mjs
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { launch, gotoApp, clickMode, realErrors, waitFor, sleep, APP_URL, OUT } from "./lib/driver.mjs";
import { installDenseProject } from "./lib/lazyFixture.mjs";

const { browser, page } = await launch();
await gotoApp(page, { url: APP_URL + "?fixture=demo", settle: 2500 });
await clickMode(page, "Figure");
await waitFor(page, () => !!window.__flux?.fig && !!window.__flux?.bridge && !!document.querySelector(".canvas-host"), null, { timeout: 15000, label: "figure + dev handle" });
await page.evaluate(() => {
  window.__zpSceneCovered = () => {
    const scene = document.querySelector('.scene');
    if (getComputedStyle(scene).opacity !== '1') return false;
    const mask = document.querySelector('.zoom-proxy-backdrop'), host = document.querySelector('.canvas-host');
    if (!mask?.classList.contains('live')) return false;
    const style = getComputedStyle(mask), box = mask.getBoundingClientRect(), target = host.getBoundingClientRect();
    const color = document.createElement('canvas'); color.width = color.height = 1;
    const ctx = color.getContext('2d'); ctx.fillStyle = style.backgroundColor; ctx.fillRect(0, 0, 1, 1);
    return style.opacity === '1' && style.display !== 'none' && style.visibility === 'visible' &&
      ctx.getImageData(0, 0, 1, 1).data[3] === 255 &&
      [...document.querySelectorAll('.zoom-proxy.live,.zoom-proxy-coarse.live')].every(plane => getComputedStyle(plane).backgroundColor === style.backgroundColor) &&
      box.left <= target.left && box.top <= target.top && box.right >= target.right && box.bottom >= target.bottom;
  };
});
const checks = [];
const ok = (cond, msg) => { checks.push([!!cond, msg]); console.log(`${cond ? "✓" : "✗"} ${msg}`); };

// 8 panels ≈ 17.6k plot nodes: under the proxy's density cap (20k — above it a scene zooms live), and the
// owner's real figure is 14.8k, so this is the shape that must get the proxy.
const fx = await installDenseProject(page, { root: "/demo/zoom-proxy", figures: 1, panels: 8 });
await page.evaluate(async (root) => { await window.__flux.bridge.loadFigInto(root, "zoom-proxy"); }, fx.root);
await page.evaluate((id) => {
  const F = window.__flux.fig;
  const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
  F.activeCanvasId.set(fig.canvasId);
  F.activeFigureId.set(id);
  const zoom = 0.55;
  F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
}, fx.figIds[0]);
await waitFor(page, () => document.querySelectorAll("[data-editor-element-id] svg *").length > 8000, null, { timeout: 90000, label: "dense plot DOM mounted" });

// --- 1. a decoded snapshot at rest -------------------------------------------------------
await waitFor(page, () => { const i = document.querySelector(".zoom-proxy"); return !!i && !!i.dataset.snap && i.firstElementChild?.width > 0; }, null, { timeout: 20000, label: "snapshot" });
const rest = await page.evaluate(() => { const i = document.querySelector(".zoom-proxy"); return { src: i.dataset.snap, opacity: getComputedStyle(i).opacity, live: i.classList.contains("live"), w: i.firstElementChild.width, h: i.firstElementChild.height }; });
ok(!!rest.src && rest.w > 0 && !rest.live && Number(rest.opacity) < 0.05, `at rest a decoded snapshot exists (${rest.w}×${rest.h} image, opacity ${rest.opacity}, not live)`);

// --- 2. the burst rides the proxy ---------------------------------------------------------
const host = await page.$eval(".canvas-host", (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const cdp = await page.target().createCDPSession();
await cdp.send("Performance.enable");
const metric = async (name) => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === name)?.value ?? 0;
await page.evaluate(() => {
  const g = document.querySelector(".scene-svg > g"), sc = document.querySelector(".scene");
  window.__zp = { g0: g.getAttribute("transform"), st0: sc.style.transform, mid: [], lt: [], burstEnd: Infinity };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__zp.lt.push({ d: Math.round(e.duration), t: e.startTime }); }).observe({ type: "longtask" });
});
await page.mouse.move(host.x, host.y);
await page.keyboard.down("Control");
const t0 = await metric("TaskDuration");
const TICKS = 24;
for (let i = 0; i < TICKS; i++) {
  await page.mouse.wheel({ deltaY: -60 });
  await sleep(16);
  if (i === 8 || i === 16) await page.evaluate(() => {
    const g = document.querySelector(".scene-svg > g"), sc = document.querySelector(".scene"), p = document.querySelector(".zoom-proxy");
    const pm = p ? /matrix\(([-\d.e]+)/.exec(getComputedStyle(p).transform) : null;
    window.__zp.mid.push({ live: !!p?.classList.contains("live"), g: g.getAttribute("transform"), st: sc.style.transform, sceneCovered: window.__zpSceneCovered(), proxyScale: pm ? Number(pm[1]) : null, zoom: window.__flux.get(window.__flux.fig.viewport).zoom });
  });
}
await page.keyboard.up("Control");
await page.evaluate(() => { window.__zp.burstEnd = performance.now(); });
const t1 = await metric("TaskDuration");
const perTick = ((t1 - t0) * 1000) / TICKS;
const mid = await page.evaluate(() => window.__zp);
ok(mid.mid.length === 2 && mid.mid.every((m) => m.live), "mid-burst the zoom proxy is live");
ok(mid.mid.every((m) => m.g === mid.g0 && m.st === mid.st0), "mid-burst the live scene is frozen (no <g> or wrapper transform change)");
ok(mid.mid.every((m) => m.sceneCovered), "mid-burst an opaque matte mask covers the frozen scene without changing its opacity");
ok(mid.mid.every((m) => m.proxyScale !== null && Math.abs(m.proxyScale - m.zoom / 0.55) < 0.05 * (m.zoom / 0.55)), `mid-burst the proxy's scale follows zoom (${mid.mid.map((m) => m.proxyScale?.toFixed(3) + " vs " + (m.zoom / 0.55).toFixed(3)).join(", ")})`);
ok(perTick < 8, `main-thread task time per zoom tick over the dense figure: ${perTick.toFixed(1)} ms (<8; the live zoom read ~20)`);

// --- 3. settle: the fold, the scene back, the proxy retreats -------------------------------
await sleep(650);
const after = await page.evaluate(() => {
  const g = document.querySelector(".scene-svg > g"), sc = document.querySelector(".scene"), p = document.querySelector(".zoom-proxy");
  const z = window.__flux.get(window.__flux.fig.viewport).zoom;
  const gs = Number(/scale\(([-\d.e]+)/.exec(g.getAttribute("transform"))[1]);
  const m = /matrix\(([-\d.e]+)/.exec(getComputedStyle(sc).transform);
  return { live: !!p?.classList.contains("live"), gs, z, residual: m ? Number(m[1]) : null, opacity: getComputedStyle(sc).opacity, lt: window.__zp.lt, burstEnd: window.__zp.burstEnd };
});
ok(!after.live && after.opacity === "1", "after the settle the proxy retreats and the scene is visible again");
ok(Math.abs(after.gs - after.z) < 1e-9 && Math.abs(after.residual - 1) < 1e-9, `the fold landed: <g> scale ${after.gs} == zoom ${after.z}, residual ${after.residual}`);
// The settle FOLD repaints the whole scene at the new baked zoom once — the
// accepted "resolution catches up" cost; the gesture itself must stay clean.
const duringBurst = after.lt.filter((e) => e.t < after.burstEnd && e.d >= 50).map((e) => e.d);
ok(duringBurst.length === 0, `no long task ≥50 ms while the burst is live (${duringBurst.join(",") || "none"}; after it: ${after.lt.filter((e) => e.t >= after.burstEnd).map((e) => e.d).join(",") || "none"} = the fold)`);

// --- 4. re-keying: an edit refreshes the snapshot at idle; a pan does not ----------------
// Back to the rest zoom where the whole figure is mounted (at 4.8× culling is live and a
// pan legitimately changes the mounted set), then wait for the snapshot to settle.
await page.evaluate((id) => {
  const F = window.__flux.fig;
  const fig = window.__flux.get(F.project).figures.find((f) => f.id === id);
  const zoom = 0.55;
  F.viewport.set({ panX: 140 - fig.x * zoom, panY: 96 - fig.y * zoom, zoom });
}, fx.figIds[0]);
await sleep(700);
await waitFor(page, () => { const i = document.querySelector(".zoom-proxy"); if (!i || !(i.firstElementChild?.width > 0)) return false; if (window.__zpSrc !== i.dataset.snap) { window.__zpSrc = i.dataset.snap; window.__zpSince = Date.now(); return false; } return Date.now() - window.__zpSince > 3000; }, null, { interval: 150, timeout: 30000, label: "snapshot settled" });
const src1 = await page.$eval(".zoom-proxy", (i) => i.dataset.snap);
await page.evaluate(() => { const F = window.__flux; const v = F.get(F.fig.viewport); F.fig.viewport.set({ ...v, panX: v.panX - 120 }); });
await sleep(2500);
const srcAfterPan = await page.$eval(".zoom-proxy", (i) => i.dataset.snap);
// This render-only fixture is loaded independently of the shell's project root.
// Keep seeded mutations clean: persistence belongs to its own gates, and an
// unrelated cross-root autosave toast must not land over composited PNGs.
await page.evaluate(() => { const F = window.__flux.fig; F.commit((p) => { const fig = p.figures[0]; fig.elements.push({ type: "rect", id: "zp-mark", x: 20, y: 20, width: 80, height: 60, rotation: 0, fill: "#d62728", stroke: "#000", strokeWidth: 1, cornerRadius: 0 }); }); F.dirty.set(false); });
await waitFor(page, (s) => { const i = document.querySelector(".zoom-proxy"); return !!i && i.dataset.snap !== s && i.firstElementChild?.width > 0; }, srcAfterPan, { timeout: 15000, label: "resnapshot" });
const src2 = await page.$eval(".zoom-proxy", (i) => i.dataset.snap);
ok(srcAfterPan === src1 && src2 !== src1, `a pan keeps the world-space snapshot (${srcAfterPan === src1 ? "kept" : "CHANGED"}); an edit re-keys it and a fresh render lands at idle (${src2 !== src1 ? "renewed" : "NOT renewed"})`);

// --- 5. View-as preserves actual sharp AND coarse pixels, including a live toggle ---------
// A small, wide scene keeps both swatches mounted at capture. The green swatch
// lies beyond the sharp crop, so zooming out can only show it through the coarse
// backing. This catches filtering only the sharp layer or only the live SVG.
await page.setViewport({ width: 1000, height: 800 });
await page.select('[data-view-as]', 'none');
await page.evaluate(() => {
  const F = window.__flux.fig, width = document.querySelector('.canvas-host').clientWidth;
  F.clearSelection();
  F.selectedFrameId.set(null);
  window.__flux.settings.update(s => ({ ...s, showGrid: false, showRulers: false }));
  F.commit(p => {
    p.figures = [{ ...p.figures[0], x: 0, y: 0,
      width: width * 2.2, height: 600, background: '#ffffff', elements: [
        { id: 'zp-filter-sharp', x: width * 0.5, fill: '#d62728' },
        { id: 'zp-filter-coarse', x: width * 1.5 + 20, fill: '#16a34a' },
      ].map(e => ({ ...e, type: 'rect', y: 180, width: 80, height: 100,
        rotation: 0, stroke: 'none', strokeWidth: 0, cornerRadius: 0 })) }];
  });
  F.activeFigureId.set(window.__flux.get(F.project).figures[0].id);
  F.viewport.set({ zoom: 1, panX: 20, panY: 60 });
  F.dirty.set(false);
});
await waitFor(page, previous => {
  const sharp = document.querySelector('.zoom-proxy'), coarse = document.querySelector('.zoom-proxy-coarse');
  return sharp?.dataset.snap !== previous && sharp?.firstElementChild?.width > 0 &&
    coarse?.firstElementChild?.width > 0 && document.querySelector('[data-editor-element-id="zp-filter-coarse"]');
}, src2, { timeout: 20000, label: 'wide scene with sharp and coarse snapshots' });
const filterSnap = await page.$eval('.zoom-proxy', p => p.dataset.snap);
const filterHost = await page.$eval('.canvas-host', el => {
  const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(filterHost.x, filterHost.y);
await page.keyboard.down('Control');
await page.mouse.wheel({ deltaY: Math.log(1 / 0.4) / 0.0015 });
await page.keyboard.up('Control');
// Functional pixel captures may take longer than the 180ms settle timer. Keep
// an actual wheel burst alive, alternating tiny zoom steps around the overview.
// This is separate from the native/per-tick performance assertions above.
await page.evaluate(({ x, y }) => {
  const host = document.querySelector('.canvas-host'); let direction = 1;
  window.__zpFilterPulse = setInterval(() => {
    host.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: direction,
      clientX: x, clientY: y, bubbles: true, cancelable: true }));
    direction *= -1;
  }, 40);
}, filterHost);
const swatches = [[214, 39, 40], [22, 163, 74]];
const grey = rgb => {
  const linear = rgb.map(c => c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  const channel = Math.round(255 * (luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055));
  return [channel, channel, channel];
};
const near = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) <= 5);
async function screenPixels(points, label) {
  const image = await loadImage(await page.screenshot({ path: `${OUT}/zoom-proxy-${label}.png` }));
  const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return points.map(point => {
    const data = ctx.getImageData(Math.round(point.x) - 2, Math.round(point.y) - 2, 5, 5).data;
    const rgb = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) rgb[c] += data[i + c] / 25;
    return rgb.map(Math.round);
  });
}
async function filterPixels(label) {
  const points = await page.evaluate(() => {
    const F = window.__flux.fig, view = window.__flux.get(F.viewport), host = document.querySelector('.canvas-host').getBoundingClientRect();
    return window.__flux.get(F.project).figures[0].elements.map(e => ({
      x: host.x + view.panX + (e.x + e.width / 2) * view.zoom,
      y: host.y + view.panY + (e.y + e.height / 2) * view.zoom,
    }));
  });
  return screenPixels(points, `view-as-${label}`);
}
let proxyGrey;
try {
  await waitFor(page, () => document.querySelector('.zoom-proxy')?.classList.contains('live'), null, { timeout: 1000, label: 'filtered overview proxy active' });
  const coverage = await page.evaluate(() => {
    const F = window.__flux.fig, view = window.__flux.get(F.viewport), host = document.querySelector('.canvas-host').getBoundingClientRect();
    const sharp = document.querySelector('.zoom-proxy').getBoundingClientRect(), coarse = document.querySelector('.zoom-proxy-coarse').getBoundingClientRect();
    const points = window.__flux.get(F.project).figures[0].elements.map(e => ({ x: host.x + view.panX + (e.x + e.width / 2) * view.zoom, y: host.y + view.panY + (e.y + e.height / 2) * view.zoom }));
    const inside = (p, r) => p.x > r.left + 8 && p.x < r.right - 8 && p.y > r.top + 8 && p.y < r.bottom - 8;
    return inside(points[0], sharp) && points[1].x > sharp.right + 8 && inside(points[1], coarse);
  });
  ok(coverage, 'color samples exercise a sharp-covered swatch and a coarse-only swatch');
  const normal = await filterPixels('none');
  ok(normal.every((rgb, i) => near(rgb, swatches[i])), `unfiltered sharp/coarse pixels retain authored colors (${JSON.stringify(normal)})`);
  await page.select('[data-view-as]', 'greyscale');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  proxyGrey = await filterPixels('greyscale');
  ok(proxyGrey.every((rgb, i) => near(rgb, grey(swatches[i]))), `mid-burst View-as greyscale reaches sharp AND coarse pixels (${JSON.stringify(proxyGrey)})`);
  await page.select('[data-view-as]', 'none');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const restored = await filterPixels('restored');
  ok(restored.every((rgb, i) => near(rgb, swatches[i])), `mid-burst View-as none restores both authored colors (${JSON.stringify(restored)})`);
  ok(await page.$eval('.zoom-proxy', (p, serial) => p.dataset.snap === serial && p.classList.contains('live'), filterSnap), 'View-as toggles retain the same active unfiltered snapshot');
  await page.select('[data-view-as]', 'greyscale');
} finally {
  await page.evaluate(() => { clearInterval(window.__zpFilterPulse); delete window.__zpFilterPulse; });
}
await waitFor(page, () => getComputedStyle(document.querySelector('.scene')).opacity === '1' && !document.querySelector('.zoom-proxy').classList.contains('live'), null, { timeout: 2000, label: 'filtered scene settles sharply' });
const settledGrey = await filterPixels('settled-greyscale');
ok(settledGrey.every((rgb, i) => near(rgb, grey(swatches[i])) && near(rgb, proxyGrey[i])), 'settled live SVG matches the greyscale sharp/coarse proxy pixels');
await page.select('[data-view-as]', 'none');

// --- 6. cooperative dense capture: XML/pixel parity, cancellation and live-DOM safety -----
const serialization = await page.evaluate(async () => {
  const { serializeSceneSnapshot, serializeSceneSnapshotCooperative, snapshotFontCss } = await import('/src/lib/interact/zoomProxy.ts');
  const ns = 'http://www.w3.org/2000/svg', scene = document.createElementNS(ns, 'svg');
  const hosts = [];
  const attachIsolated = svg => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:-10000px';
    host.attachShadow({ mode: 'open' }).appendChild(svg);
    document.body.appendChild(host); hosts.push(host);
    return svg;
  };
  scene.setAttribute('width', '400'); scene.setAttribute('height', '240');
  scene.style.cssText = 'position:fixed;left:-10000px;top:-10000px;font-family:Gelasio,serif;font-size:16px;color:#202020;letter-spacing:0.2px';
  scene.innerHTML = `<g transform="scale(3)" xmlns:probe="urn:flux:serializer-test">
    <defs><clipPath id="zp-serial-clip"><rect x="0" y="0" width="130" height="90"/></clipPath>
      <path id="zp-serial-shape" d="M0 0H20V20H0Z" fill="#27a24d"/>
      <path id="zp-serial-textpath" d="M205 229 Q295 205 388 230"/></defs>
    <style>.zp-serial-cascade { font: italic 700 13px Gelasio, serif; fill: #1646a4; }</style>
    <rect class="figure-bg" x="0" y="0" width="400" height="240" fill="#fff"/>
    <g transform="translate(18 22) rotate(11 65 45)" clip-path="url(#zp-serial-clip)">
      <rect x="-20" y="-20" width="200" height="160" fill="#d62728"/>
      <svg x="12" y="8" width="90" height="65" viewBox="0 0 120 90"><g transform="translate(14 12) scale(1.4)"><use xlink:href="#zp-serial-shape" xmlns:xlink="http://www.w3.org/1999/xlink"/></g></svg>
    </g><g data-dense="true" transform="translate(170 15)"></g>
    <text class="figure-label" data-font-probe="label" x="15" y="185" fill="#202020"></text>
    <text class="zp-serial-cascade" data-font-probe="cascade" x="15" y="212">CSS shorthand<tspan data-font-probe="relative-span" dx="8" style="font-size:125%;font-style:normal;font-weight:400;fill:#733c98">mixed span</tspan></text>
    <text data-font-probe="path-parent" style="font-family:Gelasio,serif;font-size:15px;font-weight:700"><textPath data-font-probe="path" href="#zp-serial-textpath" style="font-style:italic;fill:#6c3078">Font on a curve</textPath></text>
  </g>`;
  const text = scene.querySelector('text'), authored = 'µm\u00a0& <control> "quoted" &nbsp;';
  text.textContent = authored;
  text.setAttribute('data-escaped', '& < > " \u00a0');
  text.setAttributeNS('urn:flux:serializer-test', 'probe:label', 'namespace & "value"');
  const cloud = scene.querySelector('[data-dense]'), fragment = document.createDocumentFragment();
  for (let i = 0; i < 6000; i++) {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(i % 200)); dot.setAttribute('cy', String(Math.floor(i / 200) * 4));
    dot.setAttribute('r', '.35'); dot.setAttribute('fill', '#2266cc'); fragment.appendChild(dot);
  }
  cloud.appendChild(fragment); attachIsolated(scene);
  const before = scene.outerHTML, mutations = [];
  const observer = new MutationObserver(records => mutations.push(...records));
  observer.observe(scene, { subtree: true, attributes: true, childList: true, characterData: true });
  try {
    const box = { bx: 0, by: 0, bw: 400, bh: 240 }, sync = serializeSceneSnapshot(scene, box, 1);
    let yields = 0;
    const cooperative = await serializeSceneSnapshotCooperative(scene, box, 1, { current: () => true, budgetMs: 1,
      yield: () => { yields++; return new Promise(resolve => setTimeout(resolve, 0)); } });
    const parse = svg => new DOMParser().parseFromString(svg, 'image/svg+xml');
    const textSelector = 'text,tspan,textPath', fontProperties = new Set(['font-family', 'font-size', 'font-weight', 'font-style']);
    // Resolve each output independently in isolated browser style scopes. The
    // reference is never rebaked using the production serializer's font loop.
    const fontTuples = svg => [...svg.querySelectorAll(textSelector)].map(node => {
      const style = getComputedStyle(node);
      return [node.getAttribute('data-font-probe'), style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle];
    });
    const liveFonts = fontTuples(scene);
    const canonical = node => {
      if (node.nodeType !== Node.ELEMENT_NODE) return [node.nodeType, node.nodeValue];
      return [node.namespaceURI, node.localName,
        [...node.attributes].filter(a => a.namespaceURI !== 'http://www.w3.org/2000/xmlns/')
          .flatMap(a => {
            if (a.localName !== 'style' || !node.matches(textSelector)) return [[a.namespaceURI, a.localName, a.value]];
            // These four declarations intentionally move from the cascade to
            // inline styles. Compare their computed meaning separately, while
            // retaining every nonfont declaration and priority structurally.
            const nonfont = Array.from(node.style).filter(key => !fontProperties.has(key))
              .map(key => [key, node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]).sort();
            return nonfont.length ? [[a.namespaceURI, a.localName, JSON.stringify(nonfont)]] : [];
          }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [...node.childNodes].map(canonical)];
    };
    const parsed = cooperative && parse(cooperative.svg), syncParsed = parse(sync.svg);
    const xml = !!parsed && !parsed.querySelector('parsererror') &&
      JSON.stringify(canonical(parsed.documentElement)) === JSON.stringify(canonical(syncParsed.documentElement));
    const referenceFonts = fontTuples(attachIsolated(document.importNode(syncParsed.documentElement, true)));
    const cooperativeFonts = parsed && !parsed.querySelector('parsererror')
      ? fontTuples(attachIsolated(document.importNode(parsed.documentElement, true))) : [];
    const fontParity = JSON.stringify(liveFonts) === JSON.stringify(referenceFonts) &&
      JSON.stringify(liveFonts) === JSON.stringify(cooperativeFonts);
    const variedFonts = liveFonts.length === 5 && new Set(liveFonts.map(f => f[2])).size >= 3 &&
      liveFonts.some(f => f[3] === '700' && f[4] === 'italic') && liveFonts.some(f => f[3] === '400' && f[4] === 'normal') &&
      liveFonts.find(f => f[0] === 'relative-span')?.[2] === '16.25px';
    const escaped = !!parsed && parsed.querySelector('text')?.textContent === authored &&
      parsed.querySelector('text')?.getAttribute('data-escaped') === text.getAttribute('data-escaped') &&
      parsed.querySelector('text')?.getAttributeNS('urn:flux:serializer-test', 'label') === 'namespace & "value"';
    const fontCss = await snapshotFontCss(sync.svg);
    const pixels = async svg => {
      const url = URL.createObjectURL(new Blob([svg.replace('>', `><style>${fontCss}</style>`)], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 240;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
        return ctx.getImageData(0, 0, 400, 240).data;
      } finally { URL.revokeObjectURL(url); }
    };
    let pixelDelta = null, colored = 0, textInk = 0, decodeError = null;
    if (cooperative && !parsed.querySelector('parsererror') && !syncParsed.querySelector('parsererror')) {
      try {
        const [a, b] = await Promise.all([pixels(sync.svg), pixels(cooperative.svg)]);
        pixelDelta = 0;
        for (let i = 0; i < a.length; i++) pixelDelta = Math.max(pixelDelta, Math.abs(a[i] - b[i]));
        for (let y = 0; y < 240; y++) for (let x = 0; x < 400; x++) {
          const i = (y * 400 + x) * 4;
          if (Math.max(b[i], b[i + 1], b[i + 2]) - Math.min(b[i], b[i + 1], b[i + 2]) > 30) colored++;
          if (y > 155 && b[i] < 100 && b[i + 1] < 100 && b[i + 2] < 100) textInk++;
        }
      } catch (error) { decodeError = String(error); }
    }
    let current = true, cancelYields = 0;
    const cancelled = await serializeSceneSnapshotCooperative(scene, box, 1, { current: () => current, budgetMs: 1,
      yield: async () => { cancelYields++; current = false; } });
    const refused = await serializeSceneSnapshotCooperative(scene, box, 1, { current: () => false });
    const boundedNodes = await serializeSceneSnapshotCooperative(scene, box, 1, { current: () => true, maxNodes: 64 });
    const boundedChars = await serializeSceneSnapshotCooperative(scene, box, 1, { current: () => true, maxChars: 64 });
    await Promise.resolve();
    return { yields, xml, escaped, fonts: fontCss.includes('data:font/woff2;base64,'), fontParity, variedFonts,
      liveFonts, referenceFonts, cooperativeFonts, pixelDelta, colored, textInk, decodeError,
      cancelled: cancelled === null && cancelYields === 1, refused: refused === null,
      limits: boundedNodes === null && boundedChars === null,
      untouched: scene.outerHTML === before && mutations.length === 0 };
  } finally { observer.disconnect(); for (const host of hosts) host.remove(); }
});
ok(serialization.yields > 0, `cooperative dense serializer actually yields (${serialization.yields} slices)`);
ok(serialization.xml && serialization.escaped, 'cooperative XML matches synchronous structure, nested transforms, clip references, namespaced attributes and escaped text');
ok(serialization.fontParity && serialization.variedFonts, `browser-computed live/reference/cooperative fonts agree for ordinary CSS shorthand, mixed relative-size tspans and textPath (${JSON.stringify(serialization.liveFonts)})`);
ok(serialization.fonts && serialization.colored > 500 && serialization.textInk > 30 && serialization.pixelDelta === 0,
  `cooperative standalone pixels match exactly with embedded fonts, clipped/nested artwork and text (${JSON.stringify(serialization)})`);
ok(serialization.cancelled && serialization.refused && serialization.limits, 'capture cancellation at the first yield and ownership/node/character bounds return no partial snapshot');
ok(serialization.untouched, 'cooperative completion and cancellation never mutate live scene DOM');

// --- 7. subset capture after a deep settle, reversal and offscreen edits ---------
// Both small frames mount initially, while the second lies outside the sharp
// region. A deep settle evicts its DOM. Without the Electron canvas overview the
// sharper subset brings only its own coarse copy: the old planes are freed, a
// wide reversal never shows freed or stale pixels, and the evicted frame
// paints from live DOM. (The Electron overview, which carries this reversal
// on the raster, is pinned by verify-dense-zoom-electron.cjs.)
const beforeRetention = await page.$eval('.zoom-proxy', p => p.dataset.snap);
const retainedFixture = await page.evaluate(() => {
  const F = window.__flux.fig, width = document.querySelector('.canvas-host').clientWidth;
  F.clearSelection(); F.selectedFrameId.set(null);
  const first = window.__flux.get(F.project).figures[0], otherId = `${first.id}-retained-other`;
  F.commit(p => {
    p.figures = [
      { ...first, x: 0, y: 0, width: 240, height: 320, elements: [{ id: 'zp-retain-red', type: 'rect',
        x: 50, y: 120, width: 80, height: 80, fill: '#d62728', rotation: 0, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }] },
      { ...first, id: otherId, name: 'Retained other', x: width * 1.5 + 40, y: 0, width: 240, height: 320,
        elements: [{ id: 'zp-retain-green', type: 'rect', x: 50, y: 120, width: 80, height: 80,
          fill: '#16a34a', rotation: 0, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }] },
    ];
  });
  F.activeFigureId.set(first.id); F.viewport.set({ zoom: 1, panX: 20, panY: 60 }); F.dirty.set(false);
  return { first: first.id, other: otherId };
});
await waitFor(page, ({ previous, other }) => {
  const proxy = document.querySelector('.zoom-proxy'), coarse = document.querySelector('.zoom-proxy-coarse');
  return proxy?.dataset.snap !== previous && proxy?.firstElementChild?.width > 0 && coarse?.firstElementChild?.width > 0 &&
    document.querySelector(`[data-annotation-figure="${CSS.escape(other)}"]`);
}, { previous: beforeRetention, other: retainedFixture.other }, { timeout: 20000, label: 'two-frame whole-scene coarse capture' });
await page.evaluate(() => {
  window.__zpRetainedCanvases = { sharp: document.querySelector('.zoom-proxy canvas'),
    coarse: document.querySelector('.zoom-proxy-coarse canvas'), serial: document.querySelector('.zoom-proxy').dataset.snap };
});
const redAnchor = await page.evaluate(() => {
  const host = document.querySelector('.canvas-host').getBoundingClientRect();
  return { x: host.x + 110, y: host.y + 220 };
});
await page.mouse.move(redAnchor.x, redAnchor.y);
await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -Math.log(8) / 0.0015 }); await page.keyboard.up('Control');
await waitFor(page, other => {
  const saved = window.__zpRetainedCanvases, proxy = document.querySelector('.zoom-proxy');
  return !document.querySelector(`[data-annotation-figure="${CSS.escape(other)}"]`) &&
    proxy?.dataset.snap !== saved.serial && !proxy.classList.contains('live') && proxy.firstElementChild?.width > 0;
}, retainedFixture.other, { timeout: 20000, label: 'deep zoom settles, culls second frame and retakes sharper subset' });
const released = await page.evaluate(() => {
  const saved = window.__zpRetainedCanvases, current = document.querySelector('.zoom-proxy canvas');
  return current !== saved.sharp && saved.sharp.width === 0 && saved.sharp.height === 0 && saved.coarse.width === 0 && saved.coarse.height === 0 &&
    document.querySelector('.zoom-proxy-coarse canvas') !== saved.coarse;
});
ok(released, 'the sharper subset capture frees both retired planes instead of keeping unvalidated pixels');
const otherPoint = () => page.evaluate(other => {
  const F = window.__flux.fig, view = window.__flux.get(F.viewport), figure = window.__flux.get(F.project).figures.find(f => f.id === other),
    element = figure.elements[0], host = document.querySelector('.canvas-host').getBoundingClientRect();
  return { x: host.x + view.panX + (figure.x + element.x + element.width / 2) * view.zoom,
    y: host.y + view.panY + (figure.y + element.y + element.height / 2) * view.zoom };
}, retainedFixture.other);
await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: Math.log(8 / 0.4) / 0.0015 }); await page.keyboard.up('Control');
await page.keyboard.down('Shift'); await page.mouse.wheel({ deltaY: 150 }); await page.keyboard.up('Shift');
await waitFor(page, other => !!document.querySelector(`[data-annotation-figure="${CSS.escape(other)}"]`), retainedFixture.other,
  { timeout: 5000, label: 'wide reversal mounts the evicted frame' });
const reversal = await page.evaluate(() => {
  const coarse = document.querySelector('.zoom-proxy-coarse');
  return { coversWhenLive: !document.querySelector('.zoom-proxy.live,.zoom-proxy-coarse.live') || window.__zpSceneCovered(),
    noFreedBacking: !coarse || coarse.firstElementChild?.width > 0 };
});
ok(Object.values(reversal).every(Boolean), `a wide reversal never shows freed or uncovered raster pixels (${JSON.stringify(reversal)})`);
const reversalPixels = await screenPixels([await otherPoint()], 'retained-coarse-reversal');
ok(near(reversalPixels[0], [22, 163, 74]), `the evicted frame paints correct pixels after reversal/pan (${JSON.stringify(reversalPixels[0])})`);
const edited = await page.evaluate(async other => {
  const F = window.__flux.fig;
  F.mutateFigure(other, p => { p.figures.find(f => f.id === other).elements[0].fill = '#246bdb'; });
  F.dirty.set(false);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return { retired: !document.querySelector('.zoom-proxy.live,.zoom-proxy-coarse.live'),
    liveVisible: getComputedStyle(document.querySelector('.scene')).opacity === '1',
    maskRetired: !document.querySelector('.zoom-proxy-backdrop')?.classList.contains('live'),
    otherMounted: !!document.querySelector(`[data-annotation-figure="${CSS.escape(other)}"]`) };
}, retainedFixture.other);
ok(Object.values(edited).every(Boolean), `a scoped edit to the other frame shows fresh live content (${JSON.stringify(edited)})`);
const editedPixels = await screenPixels([await otherPoint()], 'retained-offscreen-edit');
ok(near(editedPixels[0], [36, 107, 219]), `fresh scoped edit paints blue (${JSON.stringify(editedPixels[0])})`);
await page.evaluate(() => { delete window.__zpRetainedCanvases; });

// --- 8. full composited pixels: no live-scene bleed or double sharp/coarse alpha ----------
// Compare the WHOLE viewport PNG with an independent single-plane reference:
// inside the sharp rectangle use a screenshot with coarse/live art hidden;
// outside it use an unclipped coarse-only screenshot. This leaves both planes'
// real raster sampling intact, while independently checking their composition,
// backdrop and seam. Pixel-aligned boundaries make exact comparison meaningful.
await page.setViewport({ width: 1001, height: 800 });
const beforeComposite = await page.$eval('.zoom-proxy', p => p.dataset.snap);
await page.evaluate(() => {
  const F = window.__flux.fig, width = document.querySelector('.canvas-host').clientWidth;
  F.clearSelection(); F.selectedFrameId.set(null);
  F.commit(p => {
    p.figures = [{ ...p.figures[0], x: 0, y: 0, width: width * 2.2, height: 361, background: 'transparent', elements: [
      { id: 'zp-alpha-sharp', type: 'rect', x: 140, y: 120, width: 140, height: 100, cornerRadius: 11.5,
        fill: '#d62728', stroke: '#163d99', strokeWidth: 3.25, opacity: .38, rotation: 0 },
      // This translucent shape crosses the sharp/coarse boundary at overview.
      { id: 'zp-alpha-seam', type: 'rect', x: width * 1.5 - 70, y: 120, width: 160, height: 100, cornerRadius: 9.5,
        fill: '#16a34a', stroke: '#8b319c', strokeWidth: 2.5, opacity: .46, rotation: 0 },
    ] }];
  });
  F.activeFigureId.set(window.__flux.get(F.project).figures[0].id);
  // Host width may be odd. The sharp crop's right edge is 1.5*width-panX;
  // choosing this half-pixel pan makes that world edge integral and even.
  const cropRight = Math.floor((width * 1.5 - 20) / 2) * 2;
  F.viewport.set({ zoom: 1, panX: width * 1.5 - cropRight, panY: 60 });
  F.dirty.set(false);
});
await waitFor(page, serial => {
  const sharp = document.querySelector('.zoom-proxy'), coarse = document.querySelector('.zoom-proxy-coarse');
  return sharp?.dataset.snap !== serial && sharp?.firstElementChild?.width > 0 && coarse?.firstElementChild?.width > 0 &&
    !sharp.classList.contains('live');
}, beforeComposite, { timeout: 20000, label: 'transparent artwork with sharp and whole-scene planes' });
await page.mouse.move(5, 5); // no hover chrome in either composited reference
const compositeTarget = { zoom: .5, panX: 20, panY: 60.5 };
async function startCompositeBurst() {
  await page.evaluate(async target => {
    const F = window.__flux.fig, host = document.querySelector('.canvas-host'), rect = host.getBoundingClientRect();
    const wheel = deltaY => host.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY,
      clientX: rect.left + 20, clientY: rect.top + 60, bubbles: true, cancelable: true }));
    const current = window.__flux.get(F.viewport).zoom;
    wheel(current === target.zoom ? .01 : Math.log(current / target.zoom) / .0015);
    await Promise.resolve(); F.viewport.set(target);
    window.__zpCompositePulse = setInterval(() => {
      wheel(.01); queueMicrotask(() => F.viewport.set(target));
    }, 40);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, compositeTarget);
}
async function stopCompositeBurst() {
  await page.evaluate(() => { clearInterval(window.__zpCompositePulse); delete window.__zpCompositePulse; });
  // A refused proxy is already inactive while its zoom fold is still pending.
  // A real gesture press folds immediately, so the next theme starts a fresh
  // burst rather than inheriting the previous one's live-fallback decision.
  const point = await page.$eval('.canvas-host', host => {
    const r = host.getBoundingClientRect(); return { x: r.x + 8, y: r.y + 8 };
  });
  await page.mouse.click(point.x, point.y, { button: 'middle' });
  await waitFor(page, () => {
    const scene = document.querySelector('.scene');
    return !document.querySelector('.zoom-proxy')?.classList.contains('live') &&
      getComputedStyle(scene).willChange !== 'transform' && scene.getAnimations().length === 0;
  }, null, { timeout: 2000, label: 'composited proxy settles and live scene demotes to crisp rendering' });
}
async function compositeParity(label) {
  await startCompositeBurst();
  try {
    const state = await page.evaluate(() => {
      const host = document.querySelector('.canvas-host').getBoundingClientRect(), sharp = document.querySelector('.zoom-proxy'),
        box = sharp.getBoundingClientRect(), coarse = document.querySelector('.zoom-proxy-coarse');
      const data = sharp.firstElementChild.getContext('2d').getImageData(0, 0, sharp.firstElementChild.width, sharp.firstElementChild.height).data;
      let translucent = 0; for (let i = 3; i < data.length; i += 4) if (data[i] > 0 && data[i] < 255) translucent++;
      return { clip: { x: host.x, y: host.y, width: host.width, height: host.height },
        sharp: { left: box.left - host.left, right: box.right - host.left, top: box.top - host.top, bottom: box.bottom - host.top },
        active: sharp.classList.contains('live') && !!coarse?.classList.contains('live'), covered: window.__zpSceneCovered(),
        masked: !!document.querySelector('.zoom-proxy-backdrop')?.classList.contains('live'),
        sceneOpacity: getComputedStyle(document.querySelector('.scene')).opacity, translucent,
        filters: [...document.querySelectorAll('.zoom-proxy,.zoom-proxy-coarse')].map(plane => ({
          matte: getComputedStyle(plane).filter, art: getComputedStyle(plane.firstElementChild).filter,
        })), viewAs: document.querySelector('[data-view-as]').value };
    });
    ok(state.active && state.covered && state.masked && state.sceneOpacity === '1',
      `${label}: resolved opaque mattes cover the live scene while its opacity remains unchanged (${JSON.stringify(state)})`);
    ok(state.filters.every(filter => filter.matte === 'none' && (state.viewAs === 'none'
      ? filter.art === 'none' : filter.art.includes(`flux-view-as-${state.viewAs}`))),
      `${label}: View-as filters hosted artwork canvases and leaves matte backgrounds unfiltered`);
    ok(state.translucent > 500 && state.sharp.right > 0 && state.sharp.right < state.clip.width &&
      Object.values(state.sharp).every(n => Math.abs(n - Math.round(n)) < 1e-6),
      `${label}: translucent art/shadow straddles a pixel-aligned sharp/coarse boundary`);
    const shot = suffix => page.screenshot({ clip: state.clip, path: `${OUT}/zoom-proxy-composite-${label}-${suffix}.png` });
    const actual = await shot('full');
    const original = await page.evaluate(() => {
      const scene = document.querySelector('.scene'), sharp = document.querySelector('.zoom-proxy'), coarse = document.querySelector('.zoom-proxy-coarse'), mask = document.querySelector('.zoom-proxy-backdrop');
      const saved = { sceneOpacity: scene.style.opacity, sharpVisibility: sharp.style.visibility,
        coarseVisibility: coarse.style.visibility, coarseClip: coarse.style.clipPath, maskVisibility: mask.style.visibility,
        sharpBackground: sharp.style.backgroundColor, coarseBackground: coarse.style.backgroundColor };
      // The reference uses the REAL host/ancestor background under raw alpha
      // artwork, independently of the production matte-resolution algorithm.
      scene.style.opacity = '0'; mask.style.visibility = 'hidden'; coarse.style.visibility = 'hidden';
      sharp.style.backgroundColor = 'transparent'; return saved;
    });
    let onlySharp, onlyCoarse;
    try {
      onlySharp = await shot('sharp-only');
      await page.evaluate(() => {
        document.querySelector('.zoom-proxy').style.visibility = 'hidden';
        const coarse = document.querySelector('.zoom-proxy-coarse'); coarse.style.visibility = 'visible'; coarse.style.clipPath = 'none'; coarse.style.backgroundColor = 'transparent';
      });
      onlyCoarse = await shot('coarse-only');
    } finally {
      await page.evaluate(saved => {
        document.querySelector('.scene').style.opacity = saved.sceneOpacity;
        const sharp = document.querySelector('.zoom-proxy'); sharp.style.visibility = saved.sharpVisibility; sharp.style.backgroundColor = saved.sharpBackground;
        const coarse = document.querySelector('.zoom-proxy-coarse'); coarse.style.visibility = saved.coarseVisibility; coarse.style.clipPath = saved.coarseClip; coarse.style.backgroundColor = saved.coarseBackground;
        document.querySelector('.zoom-proxy-backdrop').style.visibility = saved.maskVisibility;
      }, original);
    }
    const decode = async bytes => {
      const image = await loadImage(bytes), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data;
    };
    const [a, s, c] = await Promise.all([decode(actual), decode(onlySharp), decode(onlyCoarse)]);
    let maximum = 0, mismatchedPixels = 0, seamPixels = 0;
    for (let y = 0; y < state.clip.height; y++) for (let x = 0; x < state.clip.width; x++) {
      const i = (y * state.clip.width + x) * 4, b = x + .5 >= state.sharp.left && x + .5 < state.sharp.right &&
        y + .5 >= state.sharp.top && y + .5 < state.sharp.bottom ? s : c;
      let delta = 0; for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(a[i + channel] - b[i + channel]));
      maximum = Math.max(maximum, delta);
      if (delta) { mismatchedPixels++; if (Math.abs(x + .5 - state.sharp.right) <= 1.5) seamPixels++; }
    }
    ok(maximum === 0 && mismatchedPixels === 0, `${label}: whole composited PNG matches single-plane references exactly, including alpha, shadow and seam (max ${maximum}, pixels ${mismatchedPixels}, seam ${seamPixels})`);
    ok(await page.$eval('.zoom-proxy', proxy => proxy.classList.contains('live')), `${label}: all full-composition references were captured during the same active burst`);
  } finally { await stopCompositeBurst(); }
}
await compositeParity('opaque');
const hostBackground = await page.$eval('.canvas-host', host => {
  const original = { host: host.style.backgroundColor, parent: host.parentElement.style.backgroundColor };
  host.parentElement.style.backgroundColor = '#203040';
  host.style.backgroundColor = 'rgba(37, 41, 47, 0.5)'; return original;
});
try {
  await compositeParity('translucent-host');
  await page.$eval('.canvas-host', host => { host.style.backgroundColor = '#173457'; });
  await page.select('[data-view-as]', 'greyscale');
  await compositeParity('colored-host-greyscale');
} finally {
  await page.select('[data-view-as]', 'none');
  await page.$eval('.canvas-host', (host, original) => {
    host.style.backgroundColor = original.host; host.parentElement.style.backgroundColor = original.parent;
  }, hostBackground);
}

// A gradient has no single correct matte. Keep the real scene live, with the
// same composed pixels; never hide it behind an approximation of its backdrop.
const gradient = await page.$eval('.canvas-host', host => {
  const original = host.style.backgroundImage; host.style.backgroundImage = 'linear-gradient(90deg,#173457,#853d29)';
  const r = host.getBoundingClientRect(); return { original, clip: { x: r.x, y: r.y, width: r.width, height: r.height } };
});
try {
  const before = await page.screenshot({ clip: gradient.clip, path: `${OUT}/zoom-proxy-gradient-live-before.png` });
  await startCompositeBurst();
  try {
    ok(await page.evaluate(() => !document.querySelector('.zoom-proxy').classList.contains('live') &&
      !document.querySelector('.zoom-proxy-backdrop').classList.contains('live') && getComputedStyle(document.querySelector('.scene')).opacity === '1'),
      'unsupported gradient background keeps the visible scene live instead of publishing an incorrect matte');
    const after = await page.screenshot({ clip: gradient.clip, path: `${OUT}/zoom-proxy-gradient-live-during.png` });
    const rgba = async bytes => {
      const image = await loadImage(bytes), canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, image.width, image.height).data;
    };
    const [a, b] = await Promise.all([rgba(before), rgba(after)]);
    ok(a.length === b.length && a.every((value, i) => value === b[i]), 'gradient live fallback preserves the whole composited viewport pixels exactly');
  } finally { await stopCompositeBurst(); }
} finally { await page.$eval('.canvas-host', (host, original) => { host.style.backgroundImage = original; }, gradient.original); }

// --- 9. trusted pointer input targets the displayed raster, then resumes live DOM -------
// At .6x, B's displayed centre falls over A's OLD live-DOM rectangle. At .25x,
// the far placement is visible in the retained raster but absent from live DOM.
async function pointerFixture(kind = 'rect') {
  const previous = await page.$eval('.zoom-proxy', p => p.dataset.snap);
  await page.evaluate(kind => {
    const F = window.__flux.fig, first = window.__flux.get(F.project).figures[0];
    F.clearSelection(); F.enteredGroupId.set(null); F.selectedFrameId.set(null); F.activeTool.set('select');
    window.__flux.settings.update(s => ({ ...s, snapGrid: false, snapPixel: false, showGrid: false, showRulers: false }));
    const rect = (id, x) => ({ id, type: 'rect', x, y: 150, width: 100, height: 100,
      fill: '#4385be', rotation: 0, stroke: 'none', strokeWidth: 0, cornerRadius: 0 });
    const b = kind === 'plot' ? { id: 'zp-pointer-b', type: 'plot', assetId: window.__flux.get(F.project).assets[0].id,
      x: 600, y: 150, width: 120, height: 100, rotation: 0, overrides: {} } : rect('zp-pointer-b', 600);
    F.commit(p => { p.figures = [{ ...first, x: 0, y: 0, width: 4000, height: 700,
      groups: kind === 'group' ? { 'zp-pointer-group': { id: 'zp-pointer-group', name: 'Pointer group' } } : {},
      elements: [{ ...rect('zp-pointer-a', 320), y: 80 }, kind === 'group' ? { ...b, groupId: 'zp-pointer-group' } : b, rect('zp-pointer-far', 3000)] }]; });
    F.activeFigureId.set(first.id); F.viewport.set({ zoom: 1, panX: 20, panY: 60 });
    // Selected artwork mounts before capture; clearing it afterward exercises
    // retained whole-scene pixels with the far live placement culled again.
    F.selection.set(new Set(['zp-pointer-a', 'zp-pointer-b', 'zp-pointer-far'])); F.dirty.set(false);
  }, kind);
  await waitFor(page, previous => {
    const p = document.querySelector('.zoom-proxy');
    return p?.dataset.snap !== previous && p?.firstElementChild?.width > 0 &&
      document.querySelector('.zoom-proxy-coarse canvas')?.width > 0 && !p.classList.contains('live');
  }, previous, { timeout: 20000, label: 'pointer whole-scene snapshot' });
  await page.evaluate(() => {
    window.__flux.fig.clearSelection();
    window.__zpPointer = { native: 0, routed: 0, down: 0, menus: 0, pointer: null };
    window.__zpPointerWindow ??= e => {
      if (!document.querySelector('.canvas-host')?.contains(e.target)) return;
      if (e.isTrusted) window.__zpPointer.native++; else window.__zpPointer.routed++;
      window.__zpPointer.pointer = e.pointerId;
    };
    window.__zpPointerHost ??= () => window.__zpPointer.down++;
    window.__zpPointerMenu ??= e => { if (document.querySelector('.canvas-host')?.contains(e.target)) { window.__zpPointer.menus++; e.preventDefault(); } };
    window.removeEventListener('pointerdown', window.__zpPointerWindow, true);
    window.addEventListener('pointerdown', window.__zpPointerWindow, true);
    const host = document.querySelector('.canvas-host');
    host.removeEventListener('pointerdown', window.__zpPointerHost, true); host.addEventListener('pointerdown', window.__zpPointerHost, true);
    window.removeEventListener('contextmenu', window.__zpPointerMenu, true); window.addEventListener('contextmenu', window.__zpPointerMenu, true);
    window.__flux.fig.dirty.set(false);
  });
  await waitFor(page, () => !document.querySelector('[data-editor-element-id="zp-pointer-far"]'), null, { timeout: 3000, label: 'far placement culled after capture' });
}
async function proxyPointer(id, ratio = .6, world = null, requireLive = true) {
  const anchor = await page.$eval('.canvas-host', host => { const b = host.getBoundingClientRect(); return { x: b.x + 30, y: b.y + 50 }; });
  await page.mouse.move(anchor.x, anchor.y); await page.keyboard.down('Control');
  await page.mouse.wheel({ deltaY: -Math.log(ratio) / .0015 }); await page.keyboard.up('Control');
  if (requireLive) await waitFor(page, () => document.querySelector('.zoom-proxy')?.classList.contains('live'), null, { timeout: 1000, label: 'pointer burst active' });
  return page.evaluate(({ id, world }) => {
    const F = window.__flux.fig, p = window.__flux.get(F.project), f = p.figures[0], e = f.elements.find(e => e.id === id),
      view = window.__flux.get(F.viewport), host = document.querySelector('.canvas-host').getBoundingClientRect(),
      point = world ?? { x: f.x + e.x + e.width / 2, y: f.y + e.y + e.height / 2 },
      x = host.x + view.panX + point.x * view.zoom, y = host.y + view.panY + point.y * view.zoom;
    return { x, y, zoom: view.zoom, oldHit: document.elementFromPoint(x, y)?.closest('[data-editor-element-id]')?.getAttribute('data-editor-element-id') ?? null,
      absent: !document.querySelector(`[data-editor-element-id="${CSS.escape(id)}"]`), active: document.querySelector('.zoom-proxy').classList.contains('live') };
  }, { id, world });
}
const pointerState = () => page.evaluate(() => {
  const F = window.__flux.fig, host = document.querySelector('.canvas-host');
  return { ...window.__zpPointer, selected: [...window.__flux.get(F.selection)], parts: window.__flux.get(F.partSelections),
    scope: window.__flux.get(F.enteredGroupId), captured: host.hasPointerCapture(window.__zpPointer.pointer),
    active: document.querySelector('.zoom-proxy').classList.contains('live'), elements: window.__flux.get(F.project).figures[0].elements.map(e => ({ id: e.id, x: e.x, y: e.y })) };
});
try {
  await pointerFixture();
  const b = await proxyPointer('zp-pointer-b');
  ok(b.active && b.oldHit === 'zp-pointer-a', 'pointer fixture places displayed B over the stale live hit A');
  await page.mouse.move(b.x, b.y); await page.mouse.down();
  const pressed = await pointerState();
  ok(pressed.selected.join() === 'zp-pointer-b' && pressed.captured && !pressed.active && pressed.native === 1 && pressed.routed === 1 && pressed.down === 1,
    `trusted proxy press selects B once and preserves native pointer capture (${JSON.stringify(pressed)})`);
  // Keep both moved edges/centres outside the ordinary smart-guide threshold.
  await page.mouse.move(b.x + 37, b.y + 43); await page.mouse.up();
  const dragged = await pointerState(), moved = dragged.elements.find(e => e.id === 'zp-pointer-b'), unmoved = dragged.elements.find(e => e.id === 'zp-pointer-a');
  ok(Math.abs(moved.x - (600 + 37 / b.zoom)) < .01 && Math.abs(moved.y - (150 + 43 / b.zoom)) < .01 && unmoved.x === 320 && !dragged.captured,
    `native movement/release after retarget moves only B by the exact world delta and releases capture (${JSON.stringify({ moved, zoom: b.zoom, captured: dragged.captured })})`);
  await pointerFixture();
  // Without the Electron overview this wide zoom-out leaves the subset raster's
  // coverage and mounts live (verify-dense-zoom-electron.cjs presses art shown
  // only by the overview); either way the press must land on the far placement.
  const far = await proxyPointer('zp-pointer-far', .1, null, false);
  await page.mouse.click(far.x, far.y);
  ok((await pointerState()).selected.join() === 'zp-pointer-far', 'a press after a wide zoom-out mounts and targets the formerly culled placement');
  await pointerFixture('group');
  const grouped = await proxyPointer('zp-pointer-b'); await page.mouse.click(grouped.x, grouped.y, { count: 2, delay: 40 });
  const doubled = await pointerState();
  ok(doubled.scope === 'zp-pointer-group' && doubled.selected.join() === 'zp-pointer-b' && doubled.native === 2 && !doubled.captured,
    `native double-click after retarget enters the displayed group through the existing last-press route (${JSON.stringify(doubled)})`);
  await pointerFixture();
  const secondary = await proxyPointer('zp-pointer-b'); await page.mouse.click(secondary.x, secondary.y, { button: 'right' });
  const menu = await pointerState();
  ok(menu.selected.join() === 'zp-pointer-b' && menu.menus === 1 && !menu.captured, 'secondary press and native context-menu event keep the current displayed target and release capture');
  await pointerFixture('plot');
  const part = await page.evaluate(() => {
    const F = window.__flux.fig, view = window.__flux.get(F.viewport), host = document.querySelector('.canvas-host').getBoundingClientRect();
    const node = [...document.querySelectorAll('[data-editor-element-id="zp-pointer-b"] g[id]')].find(n => n.id.endsWith('s0.points'))?.querySelector('circle');
    if (!node) throw Error('missing semantic point-cloud fixture');
    const b = node.getBoundingClientRect(); return { id: 's0.points', x: (b.x + b.width / 2 - host.x - view.panX) / view.zoom, y: (b.y + b.height / 2 - host.y - view.panY) / view.zoom };
  });
  const deep = await proxyPointer('zp-pointer-b', .6, part);
  await page.keyboard.down('Control'); await page.mouse.click(deep.x, deep.y); await page.keyboard.up('Control');
  const drilled = await pointerState();
  ok(drilled.parts.some(p => p.elementId === 'zp-pointer-b' && p.partId === part.id) && !drilled.captured,
    'Ctrl-click after proxy fold resolves the displayed semantic part from fresh SVG DOM');
} finally {
  await page.mouse.reset(); await page.keyboard.up('Control');
  await page.evaluate(() => {
    window.removeEventListener('pointerdown', window.__zpPointerWindow, true);
    document.querySelector('.canvas-host')?.removeEventListener('pointerdown', window.__zpPointerHost, true);
    window.removeEventListener('contextmenu', window.__zpPointerMenu, true);
    window.__flux.fig.clearSelection(); window.__flux.fig.enteredGroupId.set(null); window.__flux.fig.dirty.set(false);
  });
}

// A wide host's sharp half-host margin is wider than the 600px mount margin:
// art there may not be mounted when a subset is captured. Coming back to it,
// it must paint (from a covering raster or live), never as a masked blank.
await page.setViewport({ width: 3200, height: 1000 });
const marginPrevious = await page.$eval('.zoom-proxy', p => p.dataset.snap);
const marginFixture = await page.evaluate(() => {
  const F = window.__flux.fig, first = window.__flux.get(F.project).figures[0], width = document.querySelector('.canvas-host').clientWidth;
  const rect = (id, x, y, fill = '#4385be') => ({ id, type: 'rect', x, y, width: 80, height: 80,
    fill, rotation: 0, stroke: 'none', strokeWidth: 0, cornerRadius: 0 });
  const farX = width + 800;
  F.commit(p => { p.figures = [{ ...first, x: 0, y: 0, width: width * 2 + 1200, height: 700, groups: {},
    elements: [...Array.from({ length: 33 }, (_, i) => rect(`zp-margin-${i}`, 280 + i % 6 * 20, 160 + Math.floor(i / 6) * 20)),
      rect('zp-margin-far', farX, 150, '#16a34a')] }]; });
  F.viewport.set({ zoom: 1, panX: 20, panY: 60 }); F.selection.set(new Set(window.__flux.get(F.project).figures[0].elements.map(e => e.id))); F.dirty.set(false);
  return { width, farX };
});
await waitFor(page, previous => document.querySelector('.zoom-proxy')?.dataset.snap !== previous &&
  document.querySelector('.zoom-proxy-coarse canvas')?.width > 0 && !document.querySelector('.zoom-proxy').classList.contains('live'),
  marginPrevious, { timeout: 20000, label: 'wide-host complete coarse capture' });
const marginWhole = await page.$eval('.zoom-proxy', p => p.dataset.snap);
await page.evaluate(() => { window.__flux.fig.clearSelection(); });
const marginAnchor = await page.$eval('.canvas-host', host => { const b = host.getBoundingClientRect(); return { x: b.x + 370, y: b.y + 260 }; });
await page.mouse.move(marginAnchor.x, marginAnchor.y); await page.keyboard.down('Control');
await page.mouse.wheel({ deltaY: -Math.log(8) / .0015 }); await page.keyboard.up('Control');
await waitFor(page, previous => document.querySelector('.zoom-proxy')?.dataset.snap !== previous &&
  !document.querySelector('[data-editor-element-id="zp-margin-far"]') && !document.querySelector('.zoom-proxy').classList.contains('live'),
  marginWhole, { timeout: 20000, label: 'deep subset capture without the far margin art' });
await page.evaluate(() => { window.__flux.fig.viewport.set({ zoom: 1, panX: 20, panY: 60 }); });
ok(marginFixture.width > 1600, 'the wide host puts the far art inside the sharp margin but outside the mount margin');
const marginFar = await proxyPointer('zp-margin-far', .65, null, false);
try {
  await page.evaluate(() => {
    const host = document.querySelector('.canvas-host'); let sign = 1;
    window.__zpMarginPulse = setInterval(() => { host.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: sign * .01, clientX: 220, clientY: 140, bubbles: true, cancelable: true })); sign *= -1; }, 40);
  });
  const paint = await screenPixels([marginFar], 'margin-art-after-return');
  ok(near(paint[0], [22, 163, 74]), `far margin art paints green after the return, never masked by an opaque plane (${JSON.stringify(paint[0])})`);
} finally {
  await page.evaluate(() => { clearInterval(window.__zpMarginPulse); delete window.__zpMarginPulse; });
}

const errs = await realErrors(page);
ok(errs.length === 0, `clean console (${errs.length} errors${errs.length ? ": " + errs[0] : ""})`);
const errorToasts = await page.evaluate(() => window.__flux.get(window.__flux.toast.toasts).filter(toast => toast.level === 'error').map(toast => ({ msg: toast.msg, detail: toast.detail })));
ok(errorToasts.length === 0, `no error-toast overlays in the render-only fixture (${JSON.stringify(errorToasts)})`);
await browser.close();
const failed = checks.filter(([c]) => !c).length;
console.log(`##VERIFY## ${JSON.stringify({ script: "verify-zoom-proxy", ok: failed === 0, checks: checks.length, failed })}`);
console.log(failed ? `verify-zoom-proxy: FAIL (${failed}/${checks.length})` : `verify-zoom-proxy: PASS (${checks.length} checks)`);
process.exit(failed ? 1 : 0);
