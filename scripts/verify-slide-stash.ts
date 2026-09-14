// Editor visibility is a transient selection policy, never canonical hiding.
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import * as store from '../src/lib/store';
import { bringInside } from '../src/lib/ops';
import { editorStashedElements, editorStashedParts, type EditorCanvasPresentation } from '../src/lib/editorPresentation';
import type { Project, RectElement } from '../src/lib/types';
import type { FluxPlotManifest } from '../src/lib/plot/types';

let checks = 0;
const check = (value: unknown, message: string) => { assert.ok(value, message); checks++; console.log('  ✓ ' + message); };
const rect = (id: string, x: number, extra: Partial<RectElement> = {}): RectElement => ({ id, type: 'rect', x, y: 20, width: 40, height: 30, rotation: 0, fill: '#000', stroke: 'none', strokeWidth: 0, cornerRadius: 0, ...extra });
const fixture = (): Project => ({ version: 2, name: 'Scratch stash', canvases: [{ id: 'canvas', name: 'Canvas' }], assets: [], palette: [],
  figures: [{ id: 'slide', canvasId: 'canvas', name: 'Figure 1', x: 0, y: 0, width: 200, height: 150, background: '#fff',
    groups: { group: { id: 'group', name: 'Mixed group' } },
    elements: [rect('visible', 250, { groupId: 'group' }), rect('stashed', 310, { groupId: 'group' }), rect('plot', 20)] }] });

const presentation: EditorCanvasPresentation = { ghostHidden: false, hiddenElementIds: ['stashed', 'unborn'], unbornElementIds: ['unborn'],
  partStates: {
    plot: { hidden: { visible: false, opacity: .5 }, zero: { opacity: 0 }, visible: { opacity: .2 } },
    unborn: { hidden: { opacity: 0 } },
  } };
assert.deepEqual([...editorStashedElements(presentation)], ['stashed']); check(true, 'Show hidden off excludes disappeared objects while unborn identities retain their separate policy');
assert.deepEqual([...editorStashedParts(presentation).get('plot')!], ['hidden', 'zero']); check(!editorStashedParts(presentation).has('unborn'), 'parts use effective visibility and unborn exclusion');
check(editorStashedElements({ ...presentation, ghostHidden: true }).size === 0 && editorStashedParts({ ...presentation, ghostHidden: true }).size === 0, 'Show hidden overrides editor stashing');
check(editorStashedElements().size === 0 && editorStashedParts().size === 0, 'ordinary Figure mode has no presentation exclusions');
const plotElements = [{ id: 'plot', type: 'plot' as const, assetId: 'asset', x: 0, y: 0, width: 100, height: 100, rotation: 0, overrides: {} }];
const manifests = { asset: { parts: { id: 'root', role: 'figure', children: [{ id: 'series', role: 'group', members: ['leaf', 'sibling'] }] } } as FluxPlotManifest };
const hiddenLeaf: EditorCanvasPresentation = { ghostHidden: false, partStates: { plot: { leaf: { opacity: 0 } } } };
const leafPolicy = editorStashedParts(hiddenLeaf, plotElements, manifests).get('plot')!;
check(leafPolicy.has('leaf') && leafPolicy.has('series') && leafPolicy.has('root') && !leafPolicy.has('sibling'), 'a hidden semantic leaf blocks mutation through its ancestors without blocking a visible sibling');
const hiddenGroup: EditorCanvasPresentation = { ghostHidden: false, partStates: { plot: { series: { opacity: 0 } } } };
const groupPolicy = editorStashedParts(hiddenGroup, plotElements, manifests).get('plot')!;
check(groupPolicy.has('series') && groupPolicy.has('leaf') && groupPolicy.has('sibling'), 'a hidden semantic parent blocks all descendants');

store.loadProject(fixture(), null); store.resetHistory(); store.dirty.set(false);
store.selection.set(new Set(['visible', 'stashed'])); store.partSelection.set({ elementId: 'plot', partId: 'hidden' }); store.hoverId.set('stashed');
const before = JSON.stringify(get(store.project)), history = JSON.stringify(store.historyStats());
const ids = new Set(['stashed']), parts = new Map([['plot', new Set(['hidden', 'child'])]]);
store.setEditorSelectionExclusions(ids, parts);
assert.deepEqual([...get(store.selection)], ['visible']); check(get(store.partSelection) === null && get(store.hoverId) === null, 'stashing synchronously prunes selected objects, selected parts and hover');
ids.clear(); parts.get('plot')!.clear();
store.selection.set(new Set(['stashed'])); store.partSelection.set({ elementId: 'plot', partId: 'hidden' });
check(get(store.selection).size === 0 && get(store.partSelection) === null, 'policy defensively copies supplied sets and blocks later direct selection');
store.setEditorSelectionExclusions(new Set(['stashed']), new Map([['plot', leafPolicy]]));
check(store.isEditorTargetExcluded('plot', 'series') && !store.isEditorTargetExcluded('plot', 'sibling'), 'direct X-ray actions use the same ancestor exclusion policy');
store.selection.update(set => { set.add('visible'); set.add('stashed'); return set; });
assert.deepEqual([...get(store.selection)], ['visible']); check(true, 'in-place selection updates cannot bypass the stash');
store.partSelection.update(() => ({ elementId: 'stashed', partId: 'anything' }));
check(get(store.partSelection) === null, 'whole-object stash also rejects that object through the part route');
assert.deepEqual([...store.expandGroups(get(store.project), new Set(['visible']))], ['visible']);
assert.deepEqual([...store.expandGroups(get(store.project), new Set(['stashed']))], []);
check(true, 'group expansion cannot enter through a stashed identity or add stashed siblings');
check(JSON.stringify(get(store.project)) === before && JSON.stringify(store.historyStats()) === history && !get(store.dirty), 'selection policy does not change the model, Undo history or dirty state');
store.setEditorSelectionExclusions(new Set());
store.selection.set(new Set(['stashed'])); store.partSelection.set({ elementId: 'plot', partId: 'hidden' });
check(get(store.selection).has('stashed') && get(store.partSelection)?.partId === 'hidden', 'clearing policy restores ordinary object and part selection');
assert.deepEqual([...store.expandGroups(get(store.project), new Set(['visible']))].sort(), ['stashed', 'visible']); check(true, 'ordinary Figure group expansion is unchanged after Slide releases ownership');

const stashedProject = fixture();
bringInside(stashedProject, 'slide', ['visible'], new Set(['stashed']));
check(stashedProject.figures[0].elements[0].x === 160 && stashedProject.figures[0].elements[1].x === 310, 'Bring inside clamps only visible group geometry while preserving the stashed sibling');
const ordinaryProject = fixture(); bringInside(ordinaryProject, 'slide', ['visible']);
check(ordinaryProject.figures[0].elements[0].x === 100 && ordinaryProject.figures[0].elements[1].x === 160, 'Bring inside without exclusions still translates the complete group rigidly');

console.log(`##VERIFY## ${JSON.stringify({ script: 'verify-slide-stash', ok: true, checks, failed: 0 })}`);
