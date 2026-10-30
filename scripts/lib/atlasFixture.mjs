import { gotoApp, clickMode, APP_URL, waitFor } from './driver.mjs';
import { installDenseProject } from './lazyFixture.mjs';

export async function atlasFixture(page, figures = 12) {
  await page.evaluateOnNewDocument(() => { window.__name ??= f => f; });
  await gotoApp(page, { url: APP_URL + '?fixture=demo', settle: 100 });
  await clickMode(page, 'Figure');
  await waitFor(page, () => !!window.__flux?.fig && !!document.querySelector('.canvas-host'), null, { timeout: 20000, label: 'Figure ready' });
  const fixture = await installDenseProject(page, { root: `/demo/atlas-${figures}`, figures, layout: 'grid', columns: figures > 12 ? 10 : 4,
    figureW: 600, figureH: 400, gap: 45, plotsPerFigure: 3, nodesPerPlot: 1500 });
  await page.evaluate(async root => {
    const F = window.__flux;
    await F.bridge.loadFigInto(root, 'atlas');
    F.fig.selectedFrameId.set(null); F.fig.selection.set(new Set());
    F.settings.update(s => ({ ...s, snapGrid: false, snapPixel: false, smartGuides: false }));
    const figs = F.figures(), host = document.querySelector('.canvas-host');
    const width = Math.max(...figs.map(f => f.x + f.width)), height = Math.max(...figs.map(f => f.y + f.height));
    const zoom = Math.min((host.clientWidth - 80) / width, (host.clientHeight - 100) / height);
    F.fig.viewport.set({ zoom, panX: (host.clientWidth - width * zoom) / 2, panY: (host.clientHeight - height * zoom) / 2 + 15 });
  }, fixture.root);
  return fixture;
}
export async function settledAtlas(page, count = 12, timeout = 10000) {
  return waitFor(page, n => {
    const F = window.__flux, active = F.get(F.fig.activeFigureId);
    return document.querySelectorAll('[data-figure-raster]').length === n - 1 &&
      [...document.querySelectorAll('[data-editor-element-id]')].every(node => node.closest('[data-annotation-figure]')?.getAttribute('data-annotation-figure') === active);
  }, count, { timeout, interval: 30, label: `${count - 1} raster figures and only the active figure live` });
}
export function figurePoint(page, figureId, elementId = null, local = null) {
  return page.evaluate(({ figureId, elementId, local }) => {
    const F = window.__flux, f = F.figures().find(f => f.id === figureId), el = f.elements.find(e => e.id === elementId) ?? f.elements[0];
    const v = F.get(F.fig.viewport), host = document.querySelector('.canvas-host').getBoundingClientRect();
    const point = local ?? { x: el.x + el.width / 2, y: el.y + el.height / 2 };
    return { x: host.x + v.panX + (f.x + point.x) * v.zoom, y: host.y + v.panY + (f.y + point.y) * v.zoom,
      zoom: v.zoom, elementId: el.id, ex: el.x, ey: el.y };
  }, { figureId, elementId, local });
}
export async function clickFigure(page, figureId) {
  const p = await figurePoint(page, figureId); await page.mouse.click(p.x, p.y);
  await waitFor(page, id => window.__flux.get(window.__flux.fig.activeFigureId) === id, figureId, { label: 'raster press activates figure' });
  return p;
}
export function atlasState(page) {
  return page.evaluate(() => {
    const F = window.__flux, active = F.get(F.fig.activeFigureId), groups = [...document.querySelectorAll('[data-annotation-figure]')];
    return { active, selected: [...F.get(F.fig.selection)], stats: { ...F.atlas?.stats },
      mounted: groups.map(g => ({ id: g.getAttribute('data-annotation-figure'), mode: g.getAttribute('data-atlas-mode'), elements: g.querySelectorAll('[data-editor-element-id]').length,
        plotNodes: [...g.querySelectorAll('[data-editor-element-id] svg')].reduce((n, svg) => n + svg.querySelectorAll('*').length, 0),
        rasters: g.querySelectorAll('[data-figure-raster]').length })) };
  });
}
