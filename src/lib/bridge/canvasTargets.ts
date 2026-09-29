import { get } from "svelte/store";
import { project, selection, partSelections, activeFigureId, selectedFrameId, viewport } from "../store";
import { storeTenant } from "../tenancy";
import { plotManifests, plotGen } from "../plot/store";
import { resolvePartId } from "../plot/partStyle";
import { buildPartIndex, partDomId } from "../plot/parse";
import { boundsOf, registerTargetResolver, type TargetHit } from "./targetResolvers";
import { describeTarget, type TargetRef } from "../project/targets";
import type { Element as ModelElement, Figure } from "../types";
import { slideContext } from "./contextStamp";

/** Index once at capture, then O(DOM depth) per hover, regardless of scene size. */
export const canvasTargetStats = { modelVisits: 0, partIndexBuilds: 0, domScans: 0 };
export function canvasAnnotationTargets(root: HTMLElement) {
  const elements = new Map<string, { figure: Figure; element: ModelElement }>();
  const figures = new Map<string, Figure>();
  const indexes = new Map<string, ReturnType<typeof buildPartIndex>>();
  const groupBounds = new Map<string, ReturnType<typeof boundsOf>>();
  function prepare(hover = false) {
    elements.clear(); figures.clear();
    for (const figure of get(project).figures) {
      figures.set(figure.id, figure);
      for (const element of figure.elements) { canvasTargetStats.modelVisits++; elements.set(element.id, { figure, element }); }
    }
    if (!hover) return;
    indexes.clear(); groupBounds.clear();
    const manifests = get(plotManifests);
    for (const { element } of elements.values()) if (element.type === "plot" && !indexes.has(element.assetId)) {
      indexes.set(element.assetId, buildPartIndex(manifests[element.assetId])); canvasTargetStats.partIndexBuilds++;
    }
    canvasTargetStats.domScans++;
    for (const node of root.querySelectorAll('[data-editor-element-id]')) {
      const found = elements.get(node.getAttribute('data-editor-element-id')!);
      if (!found) continue;
      let id = found.element.groupId;
      if (!id) continue;
      const b = boundsOf(node);
      while (id) {
        const key = found.figure.id + '/' + id, prev = groupBounds.get(key);
        if (!prev) groupBounds.set(key, b);
        else { const x = Math.min(prev.x,b.x), y = Math.min(prev.y,b.y); groupBounds.set(key,{ x,y,w:Math.max(prev.x+prev.w,b.x+b.w)-x,h:Math.max(prev.y+prev.h,b.y+b.h)-y }); }
        id = found.figure.groups?.[id]?.parentId;
      }
    }
  }
  function elementRef(figure: Figure, element: ModelElement): TargetRef {
    return { kind: "element", figureId: figure.id, elementId: element.id, type: element.type,
      name: element.name || (element.type === "text" ? element.text.slice(0, 60) : element.type === "plot" ? element.source?.svgPath?.split("/").at(-1) : undefined) };
  }
  function figureRef(figure: Figure): TargetRef {
    const slide = get(slideContext);
    return storeTenant() === "slide" && slide ? { kind: "slide", deckId: slide.deckId, slideId: figure.id, index: slide.slideIndex, name: figure.nickname || figure.name }
      : { kind: "figure", figureId: figure.id, name: figure.nickname || figure.name };
  }
  const hitOf = (ref: TargetRef, node: globalThis.Element): TargetHit => ({ ref, bounds: boundsOf(node), label: describeTarget(ref) });
  const dispose = registerTargetResolver({
    get surface() { return storeTenant(); }, root: () => root, prepare: () => prepare(true), revision: () => [get(project), get(viewport), get(plotGen)],
    current() {
      prepare();
      const refs: TargetRef[] = [];
      const parts = get(partSelections), selected = get(selection);
      for (const id of selected) {
        const found = elements.get(id); if (!found) continue;
        const drilled = parts.filter(p => p.elementId === id);
        if (drilled.length) for (const part of drilled) refs.push({ kind: "part", figureId: found.figure.id, elementId: id, partId: part.partId, elementName: found.element.name });
        else refs.push(elementRef(found.figure, found.element));
      }
      if (!refs.length) {
        const fig = figures.get(get(selectedFrameId) ?? get(activeFigureId) ?? "");
        if (fig) refs.push(figureRef(fig));
      }
      return refs;
    },
    at(_x, _y, node) {
      if (!node) return [];
      const wrapper = node.closest('[data-editor-element-id]');
      const found = elements.get(wrapper?.getAttribute('data-editor-element-id') ?? "");
      const figNode = node.closest('[data-annotation-figure]');
      const figure = found?.figure ?? figures.get(figNode?.getAttribute('data-annotation-figure') ?? "");
      if (!figure) return [];
      const hits: TargetHit[] = [];
      if (wrapper && found) {
        const e = found.element;
        if (e.type === "plot") {
          const manifest = get(plotManifests)[e.assetId];
          const index = indexes.get(e.assetId) ?? {};
          const partId = resolvePartId(manifest, node, e.id, index);
          if (partId) {
            const part = index[partId];
            const partNode = root.ownerDocument.getElementById(partDomId(e.id, partId)) ?? wrapper;
            hits.push(hitOf({ kind: "part", figureId: figure.id, elementId: e.id, partId, role: part?.role, label: part?.label ?? part?.series, elementName: e.name }, partNode));
          }
        }
        hits.push(hitOf(elementRef(figure, e), wrapper));
        let group = e.groupId;
        while (group && figure.groups?.[group]) {
          const ref: TargetRef = { kind: "element", figureId: figure.id, elementId: group, type: "group", name: figure.groups[group].name };
          hits.push({ ref, bounds: groupBounds.get(figure.id + '/' + group) ?? boundsOf(wrapper), label: describeTarget(ref) });
          group = figure.groups[group].parentId;
        }
      }
      if (figNode) hits.push(hitOf(figureRef(figure), figNode.querySelector('.figure-bg') ?? figNode));
      return hits;
    },
    within(rect) {
      const hits: TargetHit[] = [];
      // Box release is one gesture, not the hover/input path. Mounted DOM only.
      canvasTargetStats.domScans++;
      for (const node of root.querySelectorAll('[data-editor-element-id]')) {
        const b = boundsOf(node);
        if (b.w <= 0 || b.h <= 0 || b.x < rect.x || b.y < rect.y || b.x + b.w > rect.x + rect.w || b.y + b.h > rect.y + rect.h) continue;
        const found = elements.get(node.getAttribute('data-editor-element-id')!);
        if (found) hits.push(hitOf(elementRef(found.figure, found.element), node));
      }
      return hits;
    },
  });
  return { destroy: dispose };
}
