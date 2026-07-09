// WS4 — the allow-listed commands an external agent can dispatch against the live
// app. Each maps to the SAME pure op the GUI uses, run through commit() so the
// agent's action is identical to a human edit and fully undoable (Ctrl+Z). The
// switch IS the allow-list: an unknown command throws. Commands operate on the
// current selection / active figure by default (so "act on what I have selected"
// is the natural call), or on explicit ids.

import { get } from "svelte/store";
import * as store from "../store";
import * as ops from "../ops";
import { flipElements } from "../geometry";
import type { AlignKind } from "../geometry";
import type { PartOverride, VectorNode } from "../types";

export type Command = { type: string } & Record<string, unknown>;

const ids = (c: Command): string[] => (Array.isArray(c.ids) ? (c.ids as string[]) : [...get(store.selection)]);
const fig = (c: Command): string | null => (typeof c.figureId === "string" ? c.figureId : get(store.activeFigureId));
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export const ALLOWED_COMMANDS = [
  "select",
  "clear_selection",
  "restyle_part",
  "set_style",
  "rotate",
  "arrange",
  "align",
  "distribute",
  "auto_label",
  "group",
  "ungroup",
  "set_z",
  "add_path",
  "edit_path",
  "set_guides",
  "duplicate",
  "scale",
  "select_matching",
  "delete",
  "set_figure_layout",
  "duplicate_figure",
  "create_figure",
  // W11d (FIG-8): live-bridge authoring — create content, not just restyle it.
  "add_text",
  "add_plot",
  "add_image",
  "flip",
  "set_caption",
  // figure-v1 P0b: batch-import plots by path (the GUI Alt+I multi-insert).
  "import_plots",
] as const;

export async function dispatchCommand(c: Command): Promise<unknown> {
  switch (c.type) {
    case "select": {
      const list = Array.isArray(c.ids) ? (c.ids as string[]) : [];
      store.selection.set(new Set(list));
      store.partSelection.set(null);
      store.selectedFrameId.set(null);
      return { selected: list.length };
    }
    case "clear_selection":
      store.clearSelection();
      return { ok: true };

    case "restyle_part": {
      const ps = get(store.partSelection);
      // Default partId + elementId to the human's drilled-in part selection, so
      // "restyle what I have selected" works with just a patch.
      const partId = typeof c.partId === "string" ? c.partId : ps?.partId ?? "";
      if (!partId) throw new Error("restyle_part: partId required (or drill into a plot part first)");
      let elementId = typeof c.elementId === "string" ? c.elementId : ps?.elementId;
      if (!elementId) {
        const f = store.getActiveFigure(get(store.project));
        const plots = f?.elements.filter((e) => e.type === "plot") ?? [];
        if (plots.length === 1) elementId = plots[0].id;
      }
      if (!elementId) throw new Error("restyle_part: no target plot (select a plot part or pass elementId)");
      const target = elementId;
      store.commit((p) => ops.setPartOverride(p, target, partId, (c.patch ?? {}) as PartOverride));
      return { elementId: target, partId };
    }

    case "set_style": {
      const list = ids(c);
      store.commit((p) => ops.setElementStyle(p, list, (c.patch ?? {}) as ops.ElementStylePatch));
      return { styled: list.length };
    }

    case "rotate": {
      const list = ids(c);
      const deg = num(c.deg) ?? num(c.degrees) ?? 0;
      const pivot =
        c.pivot && typeof c.pivot === "object"
          ? (c.pivot as { x: number; y: number })
          : undefined;
      store.commit((p) => ops.rotateElements(p, list, deg, pivot));
      return { rotated: list.length, deg };
    }

    case "arrange": {
      const f = fig(c);
      if (!f) throw new Error("arrange: no active figure");
      store.commit((p) =>
        ops.arrangePanels(p, f, {
          rows: num(c.rows),
          cols: num(c.cols),
          gap: num(c.gap),
          ids: Array.isArray(c.ids) ? (c.ids as string[]) : undefined,
        }),
      );
      return { figureId: f };
    }

    case "align": {
      const f = fig(c);
      if (!f) throw new Error("align: no active figure");
      store.commit((p) => ops.alignPanels(p, f, c.kind as AlignKind, ids(c)));
      return { figureId: f };
    }

    case "distribute": {
      const f = fig(c);
      if (!f) throw new Error("distribute: no active figure");
      store.commit((p) => ops.distributePanels(p, f, c.axis === "v" ? "v" : "h", ids(c), num(c.gap)));
      return { figureId: f };
    }

    case "auto_label": {
      const f = fig(c);
      if (!f) throw new Error("auto_label: no active figure");
      store.commit((p) => ops.autoLetterPanels(p, f));
      return { figureId: f };
    }

    case "group": {
      const list = ids(c);
      let gid: string | null = null;
      store.commit((p) => {
        gid = ops.group(p, list);
      });
      return { groupId: gid };
    }
    case "ungroup": {
      const list = ids(c);
      store.commit((p) => ops.ungroup(p, list));
      return { ungrouped: list.length };
    }

    case "set_z": {
      const f = fig(c);
      if (!f) throw new Error("set_z: no active figure");
      const list = ids(c);
      // With an explicit `index`, move each id to that absolute z-position (0 =
      // bottom); otherwise bump/raise via `where` (front|back|forward|backward).
      if (typeof c.index === "number") {
        const idx = c.index as number;
        store.commit((p) => {
          for (const id of list) ops.reorderElement(p, f, id, idx);
        });
      } else {
        store.commit((p) => ops.setZOrder(p, f, list, (c.where as ops.ZOrder) ?? "front"));
      }
      return { figureId: f };
    }

    case "add_path": {
      const f = fig(c);
      if (!f) throw new Error("add_path: no active figure");
      const nodes = c.nodes as VectorNode[] | undefined;
      if (!Array.isArray(nodes) || nodes.length < 2) throw new Error("add_path: need ≥2 nodes");
      let nid: string | null = null;
      store.commit((p) => {
        nid = ops.addPath(p, f, {
          nodes,
          closed: !!c.closed,
          fill: typeof c.fill === "string" ? c.fill : undefined,
          stroke: typeof c.stroke === "string" ? c.stroke : undefined,
          strokeWidth: num(c.strokeWidth),
        });
      });
      if (nid) store.selectOnly(nid);
      return { id: nid };
    }

    case "edit_path": {
      const id = typeof c.id === "string" ? c.id : ids(c)[0];
      if (!id) throw new Error("edit_path: no path id");
      store.commit((p) =>
        ops.updatePath(p, id, {
          nodes: c.nodes as VectorNode[] | undefined,
          closed: typeof c.closed === "boolean" ? c.closed : undefined,
        }),
      );
      return { id };
    }

    case "set_guides": {
      const f = fig(c);
      if (!f) throw new Error("set_guides: no active figure");
      const arr = (v: unknown): number[] | undefined =>
        Array.isArray(v) ? (v.filter((n) => typeof n === "number") as number[]) : undefined;
      store.commit((p) => ops.setGuides(p, f, { x: arr(c.x), y: arr(c.y) }));
      return { figureId: f };
    }

    case "duplicate": {
      const f = fig(c);
      if (!f) throw new Error("duplicate: no active figure");
      const list = ids(c);
      let made: string[] = [];
      store.commit((p) => {
        made = ops.duplicateElements(p, f, list, { dx: num(c.dx) ?? 16, dy: num(c.dy) ?? 16, count: num(c.count) });
      });
      if (made.length) store.selection.set(new Set(made));
      return { ids: made };
    }

    case "scale": {
      const list = ids(c);
      const factor = num(c.factor);
      if (!factor || factor <= 0) throw new Error("scale: need a positive factor");
      const px = num(c.pivotX);
      const py = num(c.pivotY);
      const pivot = px != null && py != null ? { x: px, y: py } : undefined;
      store.commit((p) => ops.scaleElements(p, list, factor, pivot));
      return { scaled: list.length, factor };
    }

    case "select_matching": {
      const by = (c.by as ops.MatchBy) ?? "fill";
      const scope = c.scope === "project" ? "project" : "figure";
      const p = get(store.project);
      let matched: string[] = [];
      if (typeof c.value === "string") {
        matched = ops.matchByValue(p, by, c.value, scope, fig(c) ?? undefined);
      } else {
        const ref = ids(c)[0];
        if (!ref) throw new Error("select_matching: no reference element (select one or pass value)");
        matched = ops.matchElements(p, ref, by, scope);
      }
      store.selection.set(new Set(store.expandGroups(p, new Set(matched))));
      return { matched: matched.length };
    }

    case "delete": {
      const list = ids(c);
      store.commit((p) => ops.deleteElements(p, list));
      store.clearSelection();
      return { deleted: list.length };
    }

    case "set_figure_layout": {
      const f = fig(c);
      if (!f) throw new Error("set_figure_layout: no active figure");
      store.commit((p) => ops.setFigureLayout(p, f, (c.patch ?? {}) as Parameters<typeof ops.setFigureLayout>[2]));
      return { figureId: f };
    }

    case "duplicate_figure": {
      const f = fig(c);
      if (!f) throw new Error("duplicate_figure: no active figure");
      let nid: string | null = null;
      store.commit((p) => {
        nid = ops.duplicateFigure(p, f);
      });
      return { figureId: nid };
    }

    case "create_figure": {
      const cid = get(store.activeCanvasId) ?? get(store.project).canvases[0]?.id;
      if (!cid) throw new Error("create_figure: no canvas");
      let nid: string | null = null;
      store.commit((p) => {
        nid = ops.createFigure(p, {
          canvasId: cid,
          id: typeof c.id === "string" ? c.id : undefined,
          name: typeof c.name === "string" ? c.name : undefined,
        }).id;
      });
      return { figureId: nid };
    }

    // --- W11d (FIG-8): authoring — the same create verbs a human has, live ---

    case "add_text": {
      const f = fig(c);
      if (!f) throw new Error("add_text: no active figure");
      const text = typeof c.text === "string" ? c.text : "Text";
      let nid: string | null = null;
      store.commit((p) => {
        nid = ops.addText(p, f, {
          text,
          x: num(c.x) ?? 0,
          y: num(c.y) ?? 0,
          width: num(c.width) ?? 200,
          height: num(c.height) ?? 40,
          ...(typeof c.color === "string" ? { color: c.color } : {}),
          ...(num(c.fontSize) != null ? { fontSize: num(c.fontSize) } : {}),
        } as Parameters<typeof ops.addText>[2]);
      });
      if (nid) store.selectOnly(nid);
      return { id: nid };
    }

    case "add_plot": {
      const f = fig(c);
      if (!f) throw new Error("add_plot: no active figure");
      const assetId = typeof c.assetId === "string" ? c.assetId : null;
      if (!assetId) throw new Error("add_plot: assetId required (an already-imported plot asset)");
      let nid: string | null = null;
      store.commit((p) => {
        // Default to the asset's true physical size (canvas px @ 96/inch) — same
        // contract as GUI import; 320×240 only if the asset is somehow unsized.
        const phys = ops.assetDisplaySize(p, assetId);
        nid = ops.addPlotPanel(p, f, {
          assetId,
          x: num(c.x) ?? 0,
          y: num(c.y) ?? 0,
          width: num(c.width) ?? phys?.width ?? 320,
          height: num(c.height) ?? phys?.height ?? 240,
        });
      });
      if (nid) store.selectOnly(nid);
      return { id: nid };
    }

    case "add_image": {
      const f = fig(c);
      if (!f) throw new Error("add_image: no active figure");
      const assetId = typeof c.assetId === "string" ? c.assetId : null;
      if (!assetId) throw new Error("add_image: assetId required (an already-imported image asset)");
      let nid: string | null = null;
      store.commit((p) => {
        const phys = ops.assetDisplaySize(p, assetId);
        nid = ops.addImagePanel(p, f, {
          assetId,
          kind: c.kind === "svg" ? "svg" : "image",
          x: num(c.x) ?? 0,
          y: num(c.y) ?? 0,
          width: num(c.width) ?? phys?.width ?? 320,
          height: num(c.height) ?? phys?.height ?? 240,
        });
      });
      if (nid) store.selectOnly(nid);
      return { id: nid };
    }

    case "flip": {
      const f = fig(c);
      if (!f) throw new Error("flip: no active figure");
      const list = ids(c);
      const axis = c.axis === "v" ? "v" : "h";
      store.commit((p) => {
        const figure = ops.figById(p, f);
        if (!figure) return;
        const sel = new Set(list);
        flipElements(figure.elements.filter((e) => sel.has(e.id)), axis);
      });
      return { figureId: f, flipped: list.length, axis };
    }

    case "import_plots": {
      // Batch-import plots into the active figure by absolute path — the same
      // io.importPlotsFromPaths the GUI's Alt+I multi-insert runs (sidecar
      // resolution, physical-size placement, grid auto-arrange, ONE undo step,
      // per-file failure toast). Dynamically imported: io.ts is a GUI-runtime
      // module (browser Image/window.fig), and a static import would drag it
      // into every headless consumer of this command table.
      const paths = Array.isArray(c.paths) ? (c.paths as unknown[]).filter((p): p is string => typeof p === "string") : [];
      if (!paths.length) throw new Error("import_plots: paths[] required (absolute plot paths)");
      if (typeof window === "undefined" || !window.fig)
        throw new Error("import_plots: no file bridge (GUI runtime import — requires the running app)");
      const io = await import("../io");
      await io.importPlotsFromPaths(paths);
      // placeIncoming selects exactly the new elements — report those ids.
      return { requested: paths.length, ids: [...get(store.selection)] };
    }

    case "set_caption": {
      const f = fig(c);
      if (!f) throw new Error("set_caption: no active figure");
      const text = typeof c.text === "string" ? c.text : typeof c.markdown === "string" ? c.markdown : "";
      const key = typeof c.panel === "string" ? c.panel : "__figure__";
      store.commit((p) => {
        const figure = ops.figById(p, f);
        if (!figure) return;
        figure.captions = { ...(figure.captions ?? {}), [key]: text };
      });
      return { figureId: f, panel: key };
    }

    default:
      throw new Error(`unknown command: ${c.type}`);
  }
}
