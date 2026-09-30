#!/usr/bin/env -S npx tsx
// Colour-system plan B3 (Flux half) — "View as": a colour-vision-deficiency simulation over the
// canvas as an SVG feColorMatrix filter.
//   • the matrices are fluxplot's Machado 2009 severity-1.0 tables to the digit
//     (scripts/fixtures/cvd_machado.json, copied from colorcheck._MACHADO), greyscale is Rec. 709;
//   • the feColorMatrix `values` string is the 4×5 form (identity alpha row, zero offsets), the
//     defs markup carries one linearRGB filter per kind, and the CSS filter references it;
//   • applying / clearing the view toggles the canvas root's filter and nothing else;
//   • the pure simulation agrees with the matrix (a pure red under deuteranopia loses its red).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseHTML } from 'linkedom';
import { harness } from './lib/harness.mjs';
import { CVD_KINDS, MACHADO_SEVERE, LUMINANCE, cvdMatrix, feColorMatrixValues, cvdFilterDefsMarkup, viewAsFilter, applyViewAs, simulateHex, filterId } from '../src/lib/color/cvd';

const h = harness('verify-cvd-filter');
const repo = resolve(import.meta.dirname, '..');
try {
  const fixture = JSON.parse(readFileSync(join(repo, 'scripts/fixtures/cvd_machado.json'), 'utf8')) as { matrices: Record<string, number[][]> };
  for (const kind of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
    h.eq(MACHADO_SEVERE[kind], fixture.matrices[kind], `${kind}: the matrix is fluxplot's severity-1.0 table to the digit`);
    h.eq(cvdMatrix(kind), MACHADO_SEVERE[kind], `${kind}: cvdMatrix returns it`);
    const values = feColorMatrixValues(kind).trim().split(/\s+/).map(Number);
    h.eq(values.length, 20, `${kind}: feColorMatrix has 20 values`);
    h.eq(values.slice(15), [0, 0, 0, 1, 0], `${kind}: the alpha row is identity`);
    h.eq([values[4], values[9], values[14]], [0, 0, 0], `${kind}: no offsets`);
    h.eq([values.slice(0, 3), values.slice(5, 8), values.slice(10, 13)], fixture.matrices[kind], `${kind}: the 3×3 rides in the first three rows`);
  }
  h.eq(cvdMatrix('none'), [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 'none is the identity');
  h.eq(cvdMatrix('greyscale'), [LUMINANCE, LUMINANCE, LUMINANCE], 'greyscale writes the luminance into every channel');
  h.ok(Math.abs(LUMINANCE.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'the luminance weights sum to 1 (Rec. 709)');

  const { document } = parseHTML(`<html><body><svg xmlns="http://www.w3.org/2000/svg"><defs>${cvdFilterDefsMarkup()}</defs></svg><div id="canvas"></div></body></html>`);
  const filters = Array.from(document.querySelectorAll('filter'));
  h.eq(filters.map(f => f.getAttribute('id')), CVD_KINDS.filter(k => k !== 'none').map(filterId), 'one filter per kind, none excluded');
  h.ok(filters.every(f => f.getAttribute('color-interpolation-filters') === 'linearRGB'), 'every filter states linearRGB (the space the matrices were fitted in)');
  h.ok(filters.every(f => f.querySelector('feColorMatrix')?.getAttribute('type') === 'matrix'), 'each holds one feColorMatrix type=matrix');
  h.eq(document.querySelector(`#${filterId('greyscale')} feColorMatrix`)?.getAttribute('values')?.trim().split(/\s+/).length, 20, 'greyscale values are the 4×5 form too');
  h.eq(viewAsFilter('none'), null, 'none has no CSS filter');
  h.eq(viewAsFilter('tritanopia'), `url(#${filterId('tritanopia')})`, 'a kind references its filter by id');
  const canvas = document.getElementById('canvas') as unknown as { style: { setProperty(p: string, v: string): void; removeProperty(p: string): void; getPropertyValue(p: string): string }; getAttribute(n: string): string | null };
  applyViewAs(canvas, 'deuteranopia');
  h.eq(canvas.style.getPropertyValue('filter'), `url(#${filterId('deuteranopia')})`, 'applying sets the root filter');
  applyViewAs(canvas, 'none');
  h.eq(canvas.style.getPropertyValue('filter') || '', '', 'none removes it');

  h.eq(simulateHex('#ffffff', 'deuteranopia'), '#ffffff', 'white stays white (rows sum to 1)');
  h.eq(simulateHex('#000000', 'protanopia'), '#000000', 'black stays black');
  const red = simulateHex('#ff0000', 'deuteranopia');
  h.ok(red !== '#ff0000' && parseInt(red.slice(1, 3), 16) < 0xff && parseInt(red.slice(3, 5), 16) > 0x40, `pure red under deuteranopia is dulled toward yellow-brown (${red})`);
  h.eq(simulateHex('#808080', 'greyscale'), '#808080', 'a grey is unchanged in greyscale');
  const g = simulateHex('#00ff00', 'greyscale');
  h.ok(g.slice(1, 3) === g.slice(3, 5) && g.slice(3, 5) === g.slice(5, 7), 'greyscale output is neutral');
} catch (e) { h.fail(e instanceof Error ? e.stack ?? e.message : String(e)); }
await h.done();
