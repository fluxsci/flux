import { createTransformDrive, type TransformDrive } from "./compositorDrive";

/** Apply direct-manipulation transforms only to the affected scene wrappers.
 * Keeping the live transform out of the keyed element template avoids waking
 * every mounted element for each pointer movement. Geometry stays in the model
 * until the single release commit; these CSS transforms are disposable.
 *
 * The value reaches the compositor through a paused Web Animation
 * (interact/compositorDrive.ts), not a bare per-move `style.transform` write:
 * a bare write re-runs Chromium's layerization (PaintArtifactCompositor::Update,
 * O(paint chunks)) every frame of the drag — measured 2026-09-30, 75 of 75
 * frames layerized on the responsivity canvas, 12 with the drive plus the
 * rigid selection-chrome translate in Canvas.svelte
 * (notes/perf_figure_responsiveness_2026-09-30/report-drag-layer.md).
 * The element stays promoted (will-change + the animation) for the gesture only:
 * a non-composited move repaints the subtree and re-rasters the scene layer's
 * damaged tiles every frame (~10x the GPU raster work, same report). */
export function transientSceneTransforms() {
  const nodes = new Map<string, SVGGElement>();
  const drives = new Map<string, TransformDrive>();
  let transforms = new Map<string, string>();
  const release = (id: string) => {
    drives.get(id)?.destroy();
    drives.delete(id);
  };
  const apply = (id: string, node: SVGGElement) => {
    const transform = transforms.get(id) ?? "";
    const d = drives.get(id);
    if (!transform) {
      if (d) {
        d.set(""); // base style first, so cool() can never expose a stale value
        d.cool();
        release(id);
      } else node.style.transform = "";
      node.style.willChange = "";
      return;
    }
    if (d) {
      d.set(transform);
      return;
    }
    const drive = createTransformDrive(node);
    drives.set(id, drive);
    drive.set(transform);
    drive.hot();
    node.style.willChange = "transform";
  };
  return {
    register(node: SVGGElement, id: string) {
      release(id); // a re-mounted element gets a fresh drive on its own node
      nodes.set(id, node);
      apply(id, node);
      return {
        destroy() {
          if (nodes.get(id) !== node) return;
          nodes.delete(id);
          release(id);
        },
      };
    },
    update(move: ReadonlySet<string> | null, moveTransform: string, rotate: ReadonlySet<string> | null, rotateTransform: string) {
      const previous = transforms;
      transforms = new Map();
      for (const id of rotate ?? []) transforms.set(id, rotateTransform);
      for (const id of move ?? []) transforms.set(id, moveTransform);
      for (const id of new Set([...previous.keys(), ...transforms.keys()])) {
        if (previous.get(id) === transforms.get(id)) continue;
        const node = nodes.get(id);
        if (node) apply(id, node);
      }
    },
  };
}
