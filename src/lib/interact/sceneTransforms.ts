import { createTransformDrive, type TransformDrive } from "./compositorDrive";

/** Apply direct-manipulation transforms only to the affected scene wrappers.
 * Keeping the live transform out of the keyed element template avoids waking
 * every mounted element for each pointer movement. Geometry stays in the model
 * until the single release commit; these wrapper transforms are disposable.
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
 * damaged tiles every frame (~10x the GPU raster work, same report).
 *
 * Large layout selections can opt primitive wrappers into SVG translations:
 * thousands of compositor effects cost more than painting these small shapes.
 * An SVG transform attribute also avoids CSS style resolution over every moved
 * primitive. Dense plot/image/model artwork keeps the compositor path. */
export function transientSceneTransforms() {
  const nodes = new Map<string, SVGGElement>();
  const drives = new Map<string, TransformDrive>();
  const svgDirect = new Map<string, SVGGElement>();
  const clearSvg = (id: string) => {
    // Own only attributes we installed on wrappers without an authored one.
    // Track the node as well as its ID so culling/remount cannot inherit ownership.
    svgDirect.get(id)?.removeAttribute("transform");
    svgDirect.delete(id);
  };
  let transforms = new Map<string, string>();
  let direct: ReadonlySet<string> | null = null;
  const release = (id: string) => {
    drives.get(id)?.destroy();
    drives.delete(id);
  };
  const apply = (id: string, node: SVGGElement) => {
    const transform = transforms.get(id) ?? "";
    const d = drives.get(id);
    if (!transform) {
      clearSvg(id);
      if (d) {
        d.set(""); // base style first, so cool() can never expose a stale value
        d.cool();
        release(id);
      } else node.style.transform = "";
      node.style.willChange = "";
      return;
    }
    // Thousands of tiny primitive layers cost more to animate than to paint.
    // Layout may opt those wrappers into direct transforms while dense plot
    // artwork retains its compositor drive. Existing move/resize is unchanged.
    if (direct?.has(id)) {
      release(id);
      const translation = /^translate3d\(([-+\de.]+)px, ([-+\de.]+)px, 0\)$/i.exec(transform);
      if (translation && (svgDirect.get(id) === node || !node.hasAttribute("transform"))) {
        node.style.transform = "";
        node.setAttribute("transform", `translate(${translation[1]} ${translation[2]})`);
        svgDirect.set(id, node);
      } else {
        clearSvg(id);
        node.style.transform = transform;
      }
      node.style.willChange = "";
      return;
    }
    clearSvg(id);
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
      clearSvg(id);
      nodes.set(id, node);
      apply(id, node);
      return {
        destroy() {
          if (nodes.get(id) !== node) return;
          nodes.delete(id);
          release(id);
          clearSvg(id);
        },
      };
    },
    // `perElement` (resize preview): an individual transform per wrapper, for gestures whose
    // transient differs per element (a plot's box → its remapped box).
    update(move: ReadonlySet<string> | null, moveTransform: string, rotate: ReadonlySet<string> | null, rotateTransform: string, perElement?: ReadonlyMap<string, string> | null, directIds?: ReadonlySet<string> | null) {
      const previous = transforms;
      const previousDirect = direct;
      direct = directIds ?? null;
      transforms = new Map(perElement ?? []);
      for (const id of rotate ?? []) transforms.set(id, rotateTransform);
      for (const id of move ?? []) transforms.set(id, moveTransform);
      for (const id of new Set([...previous.keys(), ...transforms.keys()])) {
        if (previous.get(id) === transforms.get(id) && !!previousDirect?.has(id) === !!direct?.has(id)) continue;
        const node = nodes.get(id);
        if (node) apply(id, node);
      }
    },
  };
}
