#!/usr/bin/env -S npx tsx
// Colour-system plan A7.6 / A7.7 — `set-plot-color-scale` / `get-plot-color-scales`, the headless
// twins of the live colour-scale editor:
//   • a CLI edit persists exactly what the shared op (ops.setPlotColorScale ⊕ colorScalePatch)
//     produces; a named colormap lands as its table so documents never depend on the lazy LUTs;
//   • invalid edits (log minimum ≤ 0, unknown scale, a norm kind outside editable.normKinds, a
//     colormap fluxplot does not ship, min ≥ max) are refused and leave the saved bytes unchanged;
//   • get lists the scale, its editability and the live view; --reset deletes the view;
//   • --regenerate writes the COMPLETE v2 `__fluxplot__[scale]` control into the recipe, re-runs it
//     (a hermetic stub stands in for fluxplot; FLUX_COLORSCALE_FLUXPLOT=<checkout> runs the real
//     generator), refreshes the figure copy and clears the live override;
//   • a deckId/slideId target edits Design, --beat writes state.colorScale on that step's Change,
//     later beats inherit the resolved endpoint, --reset at a beat writes a sparse deletion;
//   • the real MCP registry twin persists the same bytes as the CLI.
import { mkdtemp, readFile, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { harness } from './lib/harness.mjs';
import { tsxRun } from './lib/tsxRun.mjs';
import * as core from '../flux-core/index';
import { loadFigModel } from '../flux-core/model';
import { setPlotColorScale } from '../src/lib/ops';
import { colorScalePatch, controlFromView } from '../src/lib/plot/colorScaleControls';
import { colormapLut, ensureColormapLuts } from '../src/lib/color/colormapLuts';
import { createDeck, addSlide, addBeat, addElement } from '../src/lib/slide/ops';
import type { FluxPlotManifest } from '../src/lib/plot/types';

const h = harness('verify-colorscale-verb'), root = await mkdtemp(join(tmpdir(), 'flux-colorscale-verb-'));
const run = promisify(execFile), repo = resolve(import.meta.dirname, '..');
const fixtures = join(repo, 'scripts/fixtures/colorscale');
const cli = (...args: string[]) => run(...tsxRun(join(repo, 'flux-cli.ts'), [...args, '--root', root]), { cwd: repo, timeout: 90000 });
const rejects = async (args: string[], why: string) => { try { await cli(...args); h.fail(`${why} rejected`); } catch { h.ok(true, `${why} rejected`); } };
let client: Client | undefined;
try {
  await ensureColormapLuts();
  await core.scaffold(root, { title: 'Colour scales' });
  await mkdir(join(root, 'plots'), { recursive: true });
  for (const ext of ['svg', 'fluxplot.json']) await copyFile(join(fixtures, `hexmatrix.${ext}`), join(root, `plots/hexmatrix.${ext}`));
  const fixtureRecipe = JSON.parse(await readFile(join(fixtures, 'hexmatrix.recipe.json'), 'utf8'));
  const real = process.env.FLUX_COLORSCALE_FLUXPLOT;
  const recipe = real
    ? { ...fixtureRecipe, command: join(real, '.venv/bin/python3'), cwd: real, args: [join(fixtures, 'make_fixtures.py')] }
    : { ...fixtureRecipe, command: process.execPath, cwd: '.', args: [join(fixtures, 'stub_recipe.mjs'), join(root, 'plots'), fixtures] };
  if (real) process.env.FLUX_COLORSCALE_OUT = join(root, 'plots');
  await writeFile(join(root, 'plots/hexmatrix.recipe.json'), JSON.stringify(recipe, null, 2) + '\n');
  await core.createFigure(root, { id: 'fig-cs', name: 'Colour' });
  await core.importPlots(root, 'fig-cs', [join(root, 'plots/hexmatrix.svg')]);
  const read = async () => { const m = await loadFigModel(root); return { m, el: m.project.figures.find(f => f.id === 'fig-cs')!.elements.find(e => e.type === 'plot')! }; };
  const figEl = (p: typeof original.m.project) => p.figures.find(f => f.id === 'fig-cs')!.elements.find(e => e.id === id);
  const original = await read();
  if (original.el.type !== 'plot') throw Error('plot fixture missing');
  const id = original.el.id;
  const manifest = JSON.parse(await readFile(join(root, 'plots/hexmatrix.fluxplot.json'), 'utf8')) as FluxPlotManifest;
  const scale = manifest.colorScales![0];
  h.eq(scale.id, 'rates', 'the fixture scale is keyed by its series root');

  // 1. a live edit through the CLI is exactly the shared op's result
  const expected = structuredClone(original.m.project);
  setPlotColorScale(expected, id, 'rates', colorScalePatch(scale, undefined, { cmap: 'magma', vmax: 20 }, colormapLut), scale);
  await cli('set-plot-color-scale', 'fig-cs', id, '--cmap', 'magma', '--vmax', '20');
  const live = (await read()).el;
  h.eq(live, figEl(expected), 'CLI writes exactly the shared GUI op result');
  const cmap = live.type === 'plot' ? live.colorScale?.rates?.cmap : undefined;
  h.eq(typeof cmap === 'object' ? cmap?.name : null, 'magma', 'a named colormap is resolved to its table at write time');
  h.eq(typeof cmap === 'object' ? cmap?.lut.length : 0, 256, 'the table carries the full LUT (documents never depend on the lazy table)');

  // 2. invalid edits are refused and leave the saved bytes unchanged
  const beforeInvalid = JSON.stringify((await read()).el);
  await rejects(['set-plot-color-scale', 'fig-cs', id, '--vmin', '0'], 'a log minimum at 0');
  await rejects(['set-plot-color-scale', 'fig-cs', id, '--scale', 'nope', '--vmax', '5'], 'an unknown scale id');
  await rejects(['set-plot-color-scale', 'fig-cs', id, '--norm', 'twoslope'], 'a norm kind outside editable.normKinds');
  await rejects(['set-plot-color-scale', 'fig-cs', id, '--cmap', 'not-a-map'], 'a colormap fluxplot does not ship');
  await rejects(['set-plot-color-scale', 'fig-cs', id, '--vmin', '30'], 'a minimum above the maximum');
  await rejects(['set-plot-color-scale', 'fig-cs', id, '--reset', '--vmax', '9'], 'reset combined with an edit');
  h.eq(JSON.stringify((await read()).el), beforeInvalid, 'invalid edits leave saved bytes unchanged');

  // 3. get: the scale, its editability, the live view, the effective paint
  const listed = JSON.parse((await cli('get-plot-color-scales', 'fig-cs', id)).stdout);
  h.eq(listed.scales.map((s: { id: string }) => s.id), ['rates'], 'get lists the plot\'s scales');
  h.eq(listed.scales[0].view?.norm?.vmax, 20, 'get reports the live limit');
  h.eq(listed.scales[0].effective?.colormap, 'magma', 'get reports the effective colormap');
  h.eq(listed.scales[0].recolor, 'live', 'get reports the recolor mode');
  h.ok(listed.scales[0].normKinds.includes('log') && listed.scales[0].normKinds.includes('linear') && !listed.scales[0].normKinds.includes('twoslope'), 'get lists the switchable norm kinds');
  h.eq(listed.scales[0].generated?.colormap?.name, 'viridis', 'get reports the generated colormap (without its LUT)');
  h.eq(listed.scales[0].generated?.colormap?.lut, undefined, 'get omits the 256-entry LUT');

  // 4. reset
  await cli('set-plot-color-scale', 'fig-cs', id, '--reset');
  h.ok(!('colorScale' in (await read()).el), 'figure reset deletes the colour scale');

  // 5. regenerate: the complete v2 control reaches the recipe, the source regenerates, the override clears
  const result = JSON.parse((await cli('set-plot-color-scale', 'fig-cs', id, '--cmap', 'magma', '--vmax', '20', '--regenerate')).stdout);
  const control = { cmap: 'magma', vmin: 1, vmax: 20, norm: { kind: 'log' }, extend: 'neither' };
  h.eq(result.regenerated?.control, control, 'the verb reports the complete v2 control it wrote');
  h.eq(result.scale, null, 'after regeneration the live override is gone from the result');
  const storedRecipe = JSON.parse(await readFile(join(root, 'plots/hexmatrix.recipe.json'), 'utf8'));
  h.eq(storedRecipe.params.__fluxplot__.rates, control, 'the recipe persists the control (fluxplot regenerates these colours from now on)');
  if (!real) h.eq(JSON.parse(await readFile(join(root, 'plots/hexmatrix.stub-params.json'), 'utf8')).__fluxplot__.rates, control, 'FLUX_PARAMS carried the control to the generator');
  const regenerated = JSON.parse(await readFile(join(root, 'plots/hexmatrix.fluxplot.json'), 'utf8')) as FluxPlotManifest;
  h.eq(regenerated.colorScales![0].colormap.name, 'magma', 'plots/ source regenerated with the new colormap');
  h.eq(regenerated.colorScales![0].norm.vmax, 20, 'plots/ source regenerated with the new maximum');
  const after = await read();
  h.ok(after.el.type === 'plot' && !after.el.colorScale, 'the element no longer carries a live override');
  const copy = JSON.parse(await readFile(join(root, `fig/assets/${after.el.assetId}.fluxplot.json`), 'utf8'));
  h.eq(copy.colorScales[0].colormap.name, 'magma', 'the figure copy refreshed from plots/');
  h.eq(result.regenerated?.refreshed, 1, 'one panel asset refreshed');
  h.eq(controlFromView(regenerated.colorScales![0], undefined, colormapLut), control, 'the regenerated scale restates the same control (round trip)');

  // 6. deck: Design, then Change endpoints on beats (the tween path of A7.7)
  const deck = createDeck({ id: 'talk', title: 'Colour', withTitleSlide: false }), slide = addSlide(deck, { layout: 'blank' });
  addElement(deck, slide.id, structuredClone(original.el));
  const first = addBeat(deck, slide.id, { label: 'First' })!, second = addBeat(deck, slide.id, { label: 'Warm' })!;
  await core.saveDeck(root, deck);
  await cli('set-plot-color-scale', `talk/${slide.id}`, id, '--vmax', '50');
  await cli('set-plot-color-scale', `talk/${slide.id}`, id, '--vmax', '30', '--beat', first.id);
  await cli('set-plot-color-scale', `talk/${slide.id}`, id, '--cmap', 'plasma', '--beat', second.id);
  const disk = JSON.parse(await readFile(join(root, 'slides/talk/deck.json'), 'utf8')), s = disk.slides[0];
  h.eq(s.elements.find((e: { id: string }) => e.id === id).colorScale.rates.norm.vmax, 50, 'deck Design form persists the live view');
  h.eq(s.beats[1].tracks[0].to.state.colorScale.rates.norm.vmax, 30, 'a beat writes state.colorScale on its Change');
  h.eq(s.beats[2].tracks[0].to.state.colorScale.rates.norm.vmax, 30, 'a later beat inherits the previous endpoint before patching');
  h.eq(s.beats[2].tracks[0].to.state.colorScale.rates.cmap.name, 'plasma', 'the later beat carries its own colormap');
  const atBeat = JSON.parse((await cli('get-plot-color-scales', `talk/${slide.id}`, id, '--beat', first.id)).stdout);
  h.eq(atBeat.scales[0].view?.norm?.vmax, 30, 'get --beat reports the resolved endpoint');
  await cli('set-plot-color-scale', `talk/${slide.id}`, id, '--reset', '--beat', second.id);
  const reset = JSON.parse(await readFile(join(root, 'slides/talk/deck.json'), 'utf8'));
  h.eq(reset.slides[0].beats[2].tracks[0].to.state.colorScale, null, 'beat reset writes a sparse deletion');
  h.eq(reset.slides[0].elements.find((e: { id: string }) => e.id === id).colorScale.rates.norm.vmax, 50, 'Design survives a beat reset');
  await rejects(['set-plot-color-scale', `talk/${slide.id}`, id, '--vmax', '5', '--regenerate'], 'deck --regenerate (a deck holds copies)');

  // 7. the real MCP registry twin
  const [cmd, args] = tsxRun('flux-mcp.ts', [root, '--toolset', 'full']);
  const transport = new StdioClientTransport({ command: cmd, args, cwd: repo, env: { ...process.env, FLUX_NO_MIGRATE: '1', FLUX_MCP_TOOLSET: 'full' } as Record<string, string> });
  client = new Client({ name: 'colorscale-verifier', version: '1' }); await client.connect(transport);
  const expectedMcp = structuredClone((await read()).m.project);
  setPlotColorScale(expectedMcp, id, 'rates', colorScalePatch(regenerated.colorScales![0], undefined, { vmax: 40 }, colormapLut), regenerated.colorScales![0]);
  const response = await client.callTool({ name: 'set_plot_color_scale', arguments: { target: 'fig-cs', elementId: id, vmax: 40 } });
  h.ok(!response.isError, 'real MCP registry twin executes');
  h.eq((await read()).el, figEl(expectedMcp), 'MCP and CLI persist identical views');
  const got = await client.callTool({ name: 'get_plot_color_scales', arguments: { target: 'fig-cs', elementId: id } });
  const gotText = (got.content as { text: string }[])[0]?.text ?? '{}';
  h.eq(JSON.parse(gotText).scales?.[0]?.view?.norm?.vmax, 40, 'get_plot_color_scales MCP twin reports the live view');
  const nulled = await client.callTool({ name: 'set_plot_color_scale', arguments: { target: 'fig-cs', elementId: id, vmax: null } });
  h.ok(!nulled.isError && !('colorScale' in (await read()).el), 'null restores one field\'s generated value (MCP form)');
  h.ok(core.setPlotColorScale === setPlotColorScale && core.colorScalePatch === colorScalePatch && core.controlFromView === controlFromView, 'headless exports share the authoring implementation');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done(async () => { await client?.close(); await rm(root, { recursive: true, force: true }); });
