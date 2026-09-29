/** Transient editor state only. Camera values remain in the ordinary project. */
import type { Project } from '../types';
import { get, writable } from 'svelte/store';
import { activeFigureId, embeddedProjectRoot, findElement, mutate, project, projectDir, selection } from '../store';
import { storeTenant } from '../tenancy';
import { editPreview, editSession } from '../interact/editSession';
import { selectionTargets } from '../interact/selectionTargets';
import { scene3dGeneration } from './store';
import { setModelView, type ModelViewPatch } from './viewOps';
import { pushToast, dismissToast } from '../toast';

export interface ModelPreview { phase: 'active' | 'settled'; time: number; revision: number; owner: symbol }
export const modelPreviews = writable<Record<string, ModelPreview>>({});
export const paintedModelPreviews = writable<ReadonlySet<string>>(new Set());
export const modelOrbit = writable<{ id: string; owner: string } | null>(null);
/** Truthy while Slides is picking an animation target: the pick's name
 *  ("Become", "Appear from", "Animate like") or true. Esc or finishing the
 *  pick clears it. */
export const modelOrbitBlocked = writable<boolean | string>(false);
/** The one phrasing of that refusal (orbit toast and Inspector tooltip). */
export function modelOrbitBlockedReason(blocked: boolean | string = get(modelOrbitBlocked)): string {
  return `Finish or cancel the ${typeof blocked === 'string' && blocked ? `${blocked} ` : ''}pick (Esc) first`;
}
// A refusal toast must not outlive its reason: when the pick ends, the
// "finish the pick" advice is stale and is withdrawn at once.
let blockedToast = 0;
modelOrbitBlocked.subscribe(blocked => { if (!blocked && blockedToast) { dismissToast(blockedToast); blockedToast = 0; } });
export const modelOrbitIssues = writable<Record<string, string>>({});
export function modelEditorOwner(input = { tenant: storeTenant(), root: get(embeddedProjectRoot) ?? get(projectDir), figure: get(activeFigureId), generation: get(scene3dGeneration) }): string {
  return JSON.stringify([input.tenant, input.root, input.figure, input.generation]);
}
let revision = 0;
editPreview.subscribe(event => {
  if (!event) return;
  const selected = new Set(event.ids), ids: string[] = [];
  for (const figure of get(project).figures) for (const element of figure.elements) {
    if (element.type === 'model3d' && selected.has(element.id)) ids.push(element.id);
  }
  if (!ids.length) return;
  modelPreviews.update(old => {
    const next = { ...old };
    for (const id of ids) {
      if (event.phase === 'settled' && next[id]?.owner !== event.owner) continue;
      next[id] = { ...event, revision: ++revision };
    }
    return next;
  });
});
export function markModelPreviewPainted(id: string) { paintedModelPreviews.update(old => new Set([...old, id])); }
export function retireModelPreview(id: string) {
  modelPreviews.update(old => { const next = { ...old }; delete next[id]; return next; });
  paintedModelPreviews.update(old => { const next = new Set(old); next.delete(id); return next; });
}
export function clearModelPreviews() { modelPreviews.set({}); paintedModelPreviews.set(new Set()); modelOrbitIssues.set({}); }
let current: ReturnType<typeof editSession> | null = null;
let originalProject: Project | undefined;
export function finishModelOrbit(cancel = false) {
  const session = current;
  current = null;
  if (session) (cancel ? session.cancel : session.finish)();
  modelOrbit.set(null);
}
/** Why orbit cannot start for this element right now, or null when it can.
 *  The same checks `beginModelOrbit` makes, phrased for the person asking. */
export function modelOrbitUnavailableReason(id: string): string | null {
  if (get(modelOrbitBlocked)) return modelOrbitBlockedReason();
  const issue = get(modelOrbitIssues)[id];
  if (issue) return issue;
  const found = findElement(get(project), id);
  if (!found || found.element.type !== 'model3d') return '3D model not found';
  if (!selectionTargets(found.figure, new Set([id]), { editable: true }).length) return 'Unlock and show the model to orbit it';
  return null;
}
/** Start orbiting, or say why not: a refused orbit must never be silent. */
export function requestModelOrbit(id: string): boolean {
  if (beginModelOrbit(id)) return true;
  const toastId = pushToast('info', 'Orbit is unavailable', { detail: modelOrbitUnavailableReason(id) ?? undefined });
  blockedToast = get(modelOrbitBlocked) ? toastId : 0;
  return false;
}
export function beginModelOrbit(id: string): boolean {
  if (modelOrbitUnavailableReason(id)) return false;
  const p = get(project), found = findElement(p, id);
  if (!found || found.element.type !== 'model3d') return false;
  finishModelOrbit();
  selection.set(new Set([id]));
  originalProject = p;
  modelOrbit.set({ id, owner: modelEditorOwner() });
  current = editSession({ handoff: 'finish', terminalOnConflict: true, onSettle: () => { current = null; modelOrbit.set(null); } });
  current.run(() => {});
  return true;
}
export function applyModelOrbit(patch: ModelViewPatch, time = performance.now()) {
  const orbit = get(modelOrbit), session = current;
  if (!orbit || !session) return;
  if (get(project) !== originalProject || modelEditorOwner() !== orbit.owner) { finishModelOrbit(); return; }
  session.run(() => mutate(p => setModelView(p, [orbit.id], patch)), time);
}
/** Actions such as Home use the same visit checkpoint. */
export function runModelOrbit(apply: Parameters<typeof mutate>[0], time = performance.now()) {
  const orbit = get(modelOrbit), session = current;
  if (!orbit || !session) return;
  if (get(project) !== originalProject || modelEditorOwner() !== orbit.owner) { finishModelOrbit(); return; }
  session.run(() => mutate(apply), time);
}
