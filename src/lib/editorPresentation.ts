import type { Viewport } from "./types";

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
