import type { Element, Viewport } from "./types";
import type { FluxPlotManifest } from "./plot/types";
import { buildPartTree, type XrayNode } from "./plot/tree";

/** Optional presentation chrome supplied by an embedded editor. It never
 *  becomes figure document data, and ordinary Figure mode supplies none. */
export interface EditorCanvasPresentation {
  highlight?: { elementId: string; partIds?: readonly string[] } | null;
  hiddenElementIds?: readonly string[];
  /** Objects which do not exist at this frame, even in Show hidden. */
  unbornElementIds?: readonly string[];
  /** Preserve an explicitly chosen overlapping object's plain drag target. */
  preferredDragTargetId?: string;
  ghostHidden?: boolean;
  elementStates?: Record<string, { visible?: boolean; opacity?: number }>;
  partStates?: Record<string, Record<string, { visible?: boolean; opacity?: number }>>;
  camera?: { x: number; y: number; zoom: number } | null;
  stage?: { width: number; height: number };
}

/** Stashing changes editor targeting only; the canonical animation stays intact. */
export function editorStashedElements(presentation?: EditorCanvasPresentation | null): Set<string> {
  if (!presentation || presentation.ghostHidden) return new Set();
  const unborn = new Set(presentation.unbornElementIds ?? []);
  return new Set((presentation.hiddenElementIds ?? []).filter(id => !unborn.has(id)));
}

export function editorStashedParts(
  presentation?: EditorCanvasPresentation | null,
  elements: readonly Element[] = [],
  manifests: Record<string, FluxPlotManifest> = {},
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  if (!presentation || presentation.ghostHidden) return result;
  const unborn = new Set(presentation.unbornElementIds ?? []);
  for (const [elementId, states] of Object.entries(presentation.partStates ?? {})) {
    if (unborn.has(elementId)) continue;
    const hidden = Object.entries(states)
      .filter(([, state]) => state.visible === false || state.opacity === 0)
      .map(([id]) => id);
    if (!hidden.length) continue;
    const blocked = new Set(hidden);
    const element = elements.find(e => e.id === elementId);
    const manifest = element?.type === "plot" ? manifests[element.assetId] : undefined;
    if (manifest) {
      const root = buildPartTree(manifest);
      const nodes = new Map<string, XrayNode>();
      const visit = (node: XrayNode) => { nodes.set(node.id, node); node.children.forEach(visit); };
      if (root) visit(root);
      for (const id of hidden) for (const leaf of nodes.get(id)?.targets ?? [id]) blocked.add(leaf);
      for (const node of nodes.values()) {
        // Selecting a container writes to all its leaves at mount time. Do
        // not let that route alter stashed children through their parent.
        if (node.targets.some(id => blocked.has(id))) blocked.add(node.id);
      }
    }
    result.set(elementId, blocked);
  }
  return result;
}

export function editorCameraTransform(
  camera?: EditorCanvasPresentation["camera"],
  stage?: EditorCanvasPresentation["stage"],
): { x: number; y: number; zoom: number } {
  if (!camera || !stage) return { x: 0, y: 0, zoom: 1 };
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  return { x: stage.width / 2 - camera.x * zoom, y: stage.height / 2 - camera.y * zoom, zoom };
}

export function presentationViewport(base: Viewport, presentation?: EditorCanvasPresentation | null): Viewport {
  const camera = editorCameraTransform(presentation?.camera, presentation?.stage);
  return { panX: base.panX + base.zoom * camera.x, panY: base.panY + base.zoom * camera.y, zoom: base.zoom * camera.zoom };
}

/** Zoom/pan tools operate in displayed coordinates; translate their result
 *  back to the user's base view, so changing a camera never edits the view. */
export function basePresentationViewport(display: Viewport, presentation?: EditorCanvasPresentation | null): Viewport {
  const camera = editorCameraTransform(presentation?.camera, presentation?.stage);
  const zoom = display.zoom / camera.zoom;
  return { panX: display.panX - zoom * camera.x, panY: display.panY - zoom * camera.y, zoom };
}
