// WS4 — the allow-listed commands an external agent can dispatch against the live
// app. Each maps to the SAME pure op the GUI uses, run through commit() so the
// agent's action is identical to a human edit and fully undoable (Ctrl+Z). The
// switch IS the allow-list: an unknown command throws. Commands operate on the
// current selection / active figure by default (so "act on what I have selected"
// is the natural call), or on explicit ids.

import { hasFlushOwner, flushOwnerIdentity } from "../../shell/lifecycle";
import { currentProject, view } from "../../shell/shellStore";
import { get } from "svelte/store";
import { storeTenant } from "../tenancy";
import { validateFrameBounds } from "../interact/frameResize";
import * as store from "../store";
import * as ops from "../ops";
import { membersDeep } from "../groups";
import { reflowTexts } from "../text";
import { flipElements } from "../geometry";
import type { AlignKind } from "../geometry";
import type { PartOverride, TextStyle, VectorNode } from "../types";
import { ELEMENT_CASCADE_PROPS, type CascadeSpec } from "../cascade";

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
  "cascade",
  "group",
  "ungroup",
  // figure-v1 P7: named nestable groups (registry verbs).
  "rename_group",
  "set_group_state",
  "list_groups",
  "set_z",
  "add_path",
  "edit_path",
  "set_guides",
  "duplicate",
  "scale",
  "select_matching",
  "delete",
  "set_figure_layout",
  "resize_figure_frame",
  // figure families: structured identity (family · number · nickname).
  "set_figure_family",
  "duplicate_figure",
  "create_figure",
  // W11d (FIG-8): live-bridge authoring — create content, not just restyle it.
  "add_text",
  "add_plot",
  "add_image",
  "flip",
  "set_caption",
  // figure-v1 P0b: batch-import plots by path (the GUI Alt+G gallery multi-insert).
  "import_plots",
  // figure-v1 P5: set/clear an image/plot crop window (content-pinned).
  "set_crop",
  // figure-v1 P3: text system — B/I/U toggle + named text styles.
  "toggle_text_style",
  "create_text_style",
  "update_text_style",
  "delete_text_style",
  "apply_text_style",
  "list_text_styles",
] as const;

/** A live request owns the currently resident editor; the file API remains the
 * supported path when that editor is unavailable. Validate before history. */
export function captureDispatchOwner(opts: { allowEdits?: boolean } = {}): () => void {
  const root = get(currentProject)?.path;
  const tenant = storeTenant();
  const model = get(store.project);
  const owner = flushOwnerIdentity(tenant);
  const figureId = get(store.activeFigureId), canvasId = get(store.activeCanvasId);
  const assert = () => {
    if (!root || get(store.embeddedProjectRoot) !== root || get(view) !== 'workspace' || get(currentProject)?.path !== root || storeTenant() !== tenant || !hasFlushOwner(tenant) || flushOwnerIdentity(tenant) !== owner || (!opts.allowEdits && (get(store.project) !== model || get(store.activeFigureId) !== figureId || get(store.activeCanvasId) !== canvasId)))
      throw new Error('not-applied: the requested live editor is unavailable or changed ownership; use the file verbs or retry against the current context');
  };
  assert(); return assert;
}
function validateCommand(c: Command): void {
  if (!c || typeof c !== 'object' || !ALLOWED_COMMANDS.includes(c.type as typeof ALLOWED_COMMANDS[number])) throw new Error('Unknown live command');
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 32) throw new Error('Live command nesting exceeds 32 levels');
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Live command numbers must be finite');
    if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child, depth + 1);
  };
  visit(c);
  if (c.ids !== undefined && (!Array.isArray(c.ids) || c.ids.some(id => typeof id !== 'string'))) throw new Error('ids must be an array of element IDs');
  const p = get(store.project);
  const all = new Set(p.figures.flatMap(f => f.elements.map(e => e.id)));
  if (Array.isArray(c.ids)) for (const id of c.ids) if (!all.has(id as string)) throw new Error(`Unknown element ${String(id)}`);
  if (typeof c.elementId === 'string' && !all.has(c.elementId)) throw new Error(`Unknown element ${c.elementId}`);
  if (typeof c.figureId === 'string' && !p.figures.some(f => f.id === c.figureId)) throw new Error(`Unknown figure ${c.figureId}`);
  if (c.patch !== undefined && (!c.patch || typeof c.patch !== 'object' || Array.isArray(c.patch))) throw new Error('patch must be an object');
  const object = (v: unknown, label: string): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} must be an object`);
    return v as Record<string, unknown>;
  };
  const scalar = (obj: Record<string, unknown>, key: string, type: 'string'|'number'|'boolean', required = false) => {
    if (obj[key] === undefined && !required) return;
    if (typeof obj[key] !== type) throw new Error(`${key} must be ${type}`);
  };
  const enumeration = (obj: Record<string, unknown>, key: string, values: readonly string[], required = false) => {
    if (obj[key] === undefined && !required) return;
    if (typeof obj[key] !== 'string' || !values.includes(obj[key] as string)) throw new Error(`${key} must be one of ${values.join(', ')}`);
  };
  const numeric = ['deg','degrees','rows','cols','gap','index','count','factor','pivotX','pivotY','width','height','fontSize','strokeWidth','rotation','dx','dy','dl','dc','dh','delta','number'];
  for (const key of numeric) scalar(c,key,'number');
  if (c.type !== 'set_guides') for (const key of ['x','y']) scalar(c,key,'number');
  for (const key of ['name','text','markdown','figureId','elementId','partId','styleId','assetId','groupId','parentId','fromElementId','family','color','stroke','fill']) scalar(c,key,'string');
  for (const key of ['closed','hidden','locked','global','reverse','firstFixed']) scalar(c,key,'boolean');
  for (const key of ['width','height','fontSize','factor']) if (typeof c[key] === 'number' && c[key] <= 0) throw new Error(`${key} must be positive`);
  for (const key of ['count','rows','cols']) if (c[key] !== undefined && (!Number.isInteger(c[key]) || Number(c[key]) < 1 || Number(c[key]) > 10000)) throw new Error(`${key} must be an integer from 1 to 10000`);
  if (c.pivot !== undefined) { const value=object(c.pivot,'pivot');scalar(value,'x','number',true);scalar(value,'y','number',true); }
  if (c.type === 'align') enumeration(c,'kind',['left','right','top','bottom','centerH','centerV'],true);
  if (c.type === 'flip' || c.type === 'distribute') enumeration(c,'axis',['h','v']);
  if (c.type === 'toggle_text_style') enumeration(c,'which',['bold','italic','underline']);
  if (c.type === 'set_z') enumeration(c,'where',['front','back','forward','backward']);
  if (c.type === 'select_matching') { enumeration(c,'by',['fill','stroke','font','type']);enumeration(c,'scope',['project','figure']); }
  if (c.type === 'cascade') { enumeration(c,'property',ELEMENT_CASCADE_PROPS,true);enumeration(c,'order',['selection','layer','x','y']); }
  if (c.type === 'set_guides') for (const key of ['x','y']) if (c[key] !== undefined && (!Array.isArray(c[key]) || (c[key] as unknown[]).some(v=>typeof v!=='number'))) throw new Error(`${key} guides must be a numeric array`);
  if (c.type === 'import_plots' && c.paths !== undefined && (!Array.isArray(c.paths) || c.paths.some(v=>typeof v!=='string'||!v.trim()))) throw new Error('paths must be an array of nonempty paths');
  if (c.type === 'add_path' || c.type === 'edit_path') {
    if (c.nodes !== undefined) {
      if (!Array.isArray(c.nodes) || c.nodes.length < 2) throw new Error('nodes must contain at least two vector nodes');
      for (const node of c.nodes) { const n=object(node,'node');scalar(n,'x','number',true);scalar(n,'y','number',true);enumeration(n,'type',['corner','smooth'],true);
        for (const key of ['hIn','hOut']) if (n[key] !== undefined) { const h=object(n[key],key);scalar(h,'dx','number',true);scalar(h,'dy','number',true); }
      }
    }
  }
  if (['set_crop','edit_path'].includes(c.type)) {
    const target = c.id ?? ids(c)[0];
    const element = p.figures.flatMap(f=>f.elements).find(e=>e.id===target);
    if (!element || (c.type==='edit_path' ? element.type!=='path' : !['image','plot'].includes(element.type))) throw new Error(`${c.type}: element not found (or wrong type): ${String(target)}`);
  }
  if (c.type === 'set_crop' && c.crop !== undefined && c.crop !== null) {
    const crop=object(c.crop,'crop');if(['x','y','width','height'].some(key=>typeof crop[key]!=='number'))throw new Error('set_crop: crop needs numeric {x,y,width,height}');
    if (Number(crop.width)<=0 || Number(crop.height)<=0)throw new Error('crop dimensions must be positive');
  }
  if (['update_text_style','delete_text_style','apply_text_style'].includes(c.type) && !p.textStyles?.some(s=>s.id===c.styleId)) throw new Error(`unknown style ${String(c.styleId)}`);
  if (c.fromElementId !== undefined && !p.figures.some(f=>f.elements.some(e=>e.id===c.fromElementId&&e.type==='text'))) throw new Error('fromElementId must identify a text element');
  if (['add_plot','add_image'].includes(c.type) && !p.assets.some(a=>a.id===c.assetId&&a.kind===(c.type==='add_plot'?'svg':'png'))) throw new Error(`${c.type}: assetId must identify an existing ${c.type==='add_plot'?'SVG plot':'PNG image'}`);
  if (c.type === 'create_figure' && c.id !== undefined && (typeof c.id!=='string'||!c.id||p.figures.some(f=>f.id===c.id))) throw new Error('create_figure: id must be new and nonempty');
  for (const value of [c.patch,c.style]) if (value !== undefined) {
    const patch=object(value,'style/patch');
    for (const key of ['fontSize','lineHeight','width','height']) if (patch[key] != null && (typeof patch[key]!=='number'||Number(patch[key])<=0)) throw new Error(`${key} must be positive`);
    for (const key of ['strokeWidth','cornerRadius','arrowSize']) if (patch[key] != null && (typeof patch[key]!=='number'||Number(patch[key])<0)) throw new Error(`${key} must be nonnegative`);
    if (patch.opacity!=null && (typeof patch.opacity!=='number'||patch.opacity<0||patch.opacity>1))throw new Error('opacity must be between 0 and 1');
    for (const key of ['fontFamily','name','color','fill','stroke','background']) if(patch[key]!==null)scalar(patch,key,'string');
    for (const key of ['hidden','locked','underline','flipX','flipY','lockAspect','arrowStart','arrowEnd']) if(patch[key]!==null)scalar(patch,key,'boolean');
    for (const [key,values] of Object.entries({fontStyle:['normal','italic'],align:['left','center','right'],sizing:['auto','auto-h','fixed'],cap:['butt','round','square'],arrowStyle:['filled','vee']}))if(patch[key]!==null)enumeration(patch,key,values);
    if(patch.dash!==undefined&&(!Array.isArray(patch.dash)||patch.dash.some(n=>typeof n!=='number'||n<0)))throw new Error('dash must contain nonnegative numbers');
  }
  if (storeTenant() === 'slide' && ['create_figure','duplicate_figure','set_figure_family','set_caption','resize_figure_frame'].includes(c.type)) throw new Error(`not-applied: ${c.type} requires the Figure editor`);
}

export async function dispatchCommand(c: Command): Promise<unknown> {
  const assertOwner = captureDispatchOwner();
  validateCommand(c);
  switch (c.type) {
    case "select": {
      // {ids} and/or {groupId} sugar — a group id selects its members (deep).
      let list = Array.isArray(c.ids) ? (c.ids as string[]) : [];
      if (typeof c.groupId === "string") {
        const p = get(store.project);
        const f = p.figures.find((ff) => ff.groups?.[c.groupId as string]);
        if (!f) throw new Error(`select: unknown group ${c.groupId}`);
        list = [...list, ...membersDeep(f, c.groupId).map((e) => e.id)];
      }
      store.selection.set(new Set(list));
      store.partSelection.set(null);
      store.selectedFrameId.set(null);
      return { selected: new Set(list).size };
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
      // GUI seam: the pure op only invalidates the wrap cache; re-wrap + re-hug
      // the affected texts here so the agent edit renders like a human edit.
      store.commit((p) => {
        ops.setElementStyle(p, list, (c.patch ?? {}) as ops.ElementStylePatch);
        reflowTexts(p, list);
      });
      return { styled: list.length };
    }

    case "set_crop": {
      // {id?, crop: {x,y,width,height} | null} — id defaults to the selection.
      // Same pure op as the ctrl-drag gesture commit / Inspector Reset crop:
      // content stays pinned, the element box follows the window; null resets.
      const id = typeof c.id === "string" ? c.id : ids(c)[0];
      if (!id) throw new Error("set_crop: no target element (select one or pass id)");
      const cr = c.crop as { x?: number; y?: number; width?: number; height?: number } | null | undefined;
      let crop: { x: number; y: number; width: number; height: number } | null = null;
      if (cr && typeof cr === "object") {
        if ([cr.x, cr.y, cr.width, cr.height].some((v) => typeof v !== "number"))
          throw new Error("set_crop: crop needs numeric {x,y,width,height} (intrinsic content px) — or null to reset");
        crop = { x: cr.x!, y: cr.y!, width: cr.width!, height: cr.height! };
      }
      let found = false;
      store.commit((p) => {
        found = ops.setCrop(p, id, crop);
      });
      if (!found) throw new Error(`set_crop: element not found (or not image/plot): ${id}`);
      return { id, crop };
    }

    case "toggle_text_style": {
      const list = ids(c);
      const which = c.which === "italic" || c.which === "underline" ? c.which : "bold";
      store.commit((p) => {
        ops.toggleTextStyle(p, list, which);
        reflowTexts(p, list); // bold changes metrics
      });
      return { toggled: list.length, which };
    }

    case "create_text_style": {
      const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : "Style";
      const fromId = typeof c.fromElementId === "string" ? c.fromElementId : ids(c)[0];
      let made: TextStyle | null = null;
      store.commit((p) => {
        if (fromId && p.figures.some((f) => f.elements.some((e) => e.id === fromId && e.type === "text"))) {
          made = ops.textStyleFromElement(p, fromId, name);
          return;
        }
        const s = (c.style ?? {}) as Partial<TextStyle>;
        made = ops.createTextStyle(p, {
          name,
          fontFamily: s.fontFamily ?? "Arial",
          fontSize: s.fontSize ?? 28 / 3,
          fontWeight: s.fontWeight ?? 400,
          fontStyle: s.fontStyle ?? "normal",
          ...(s.underline != null ? { underline: s.underline } : {}),
          ...(s.lineHeight != null ? { lineHeight: s.lineHeight } : {}),
          ...(s.color != null ? { color: s.color } : {}),
          ...(s.align != null ? { align: s.align } : {}),
        });
      });
      if (!made) throw new Error("create_text_style: no source text element and no style props");
      return { style: made };
    }

    case "update_text_style": {
      const styleId = typeof c.styleId === "string" ? c.styleId : "";
      if (!styleId) throw new Error("update_text_style: styleId required");
      const patch = (c.patch ?? {}) as Partial<TextStyle>;
      store.commit((p) => {
        if (!ops.textStyleById(p, styleId)) throw new Error(`update_text_style: unknown style ${styleId}`);
        ops.updateTextStyle(p, styleId, patch);
        const linked = p.figures.flatMap((f) =>
          f.elements.filter((e) => e.type === "text" && e.styleId === styleId).map((e) => e.id),
        );
        reflowTexts(p, linked);
      });
      return { styleId };
    }

    case "delete_text_style": {
      const styleId = typeof c.styleId === "string" ? c.styleId : "";
      if (!styleId) throw new Error("delete_text_style: styleId required");
      store.commit((p) => ops.deleteTextStyle(p, styleId));
      return { deleted: styleId };
    }

    case "apply_text_style": {
      const styleId = typeof c.styleId === "string" ? c.styleId : "";
      if (!styleId) throw new Error("apply_text_style: styleId required");
      const list = ids(c);
      let applied = 0;
      store.commit((p) => {
        if (!ops.textStyleById(p, styleId)) throw new Error(`apply_text_style: unknown style ${styleId}`);
        applied = ops.applyTextStyle(p, list, styleId);
        reflowTexts(p, list);
      });
      return { applied };
    }

    case "list_text_styles": {
      // `global: true` lists the machine-global library via the file bridge
      // (Electron userData/textstyles.json; localStorage in the dev fixture).
      if (c.global === true) {
        const fb = (globalThis as { window?: { fig?: { readGlobalTextStyles?: () => Promise<unknown[]> } } }).window?.fig;
        const list = (await fb?.readGlobalTextStyles?.()) ?? [];
        assertOwner();
        return { styles: Array.isArray(list) ? list : [], scope: "global" };
      }
      return { styles: get(store.project).textStyles ?? [], scope: "project" };
    }

    case "cascade": {
      // Stepped delta across the selection/ids — the SAME pure core as the
      // ⌃⇧C popover and the headless verb. Flat args like rotate/scale:
      // {property, delta?|factor?, dl?/dc?/dh?, order?, reverse?, firstFixed?}.
      const list = ids(c);
      const f = fig(c);
      if (!f) throw new Error("cascade: no active figure");
      if (typeof c.property !== "string") throw new Error("cascade: need a property");
      const spec: CascadeSpec = {
        property: c.property as CascadeSpec["property"],
        ...(num(c.factor) != null ? { mode: "mul" as const, factor: num(c.factor) } : { delta: num(c.delta) ?? 0 }),
        ...(num(c.dl) != null || num(c.dc) != null || num(c.dh) != null
          ? { color: { dL: num(c.dl) ?? 0, dC: num(c.dc) ?? 0, dH: num(c.dh) ?? 0 } }
          : {}),
        ...(typeof c.order === "string" ? { order: c.order as CascadeSpec["order"] } : {}),
        ...(c.reverse === true ? { reverse: true } : {}),
        ...(c.firstFixed === true ? { firstFixed: true } : {}),
      };
      store.commit((p) => {
        ops.cascadeElements(p, f, list, spec);
        reflowTexts(p, list);
      });
      return { cascaded: list.length, property: spec.property };
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
      // {ids?, name?, parentId?} → a NAMED registry group (nests whole top
      // groups, splices members z-contiguous). Defaults to the selection.
      const list = ids(c);
      let gid: string | null = null;
      store.commit((p) => {
        gid = ops.group(p, list, {
          name: typeof c.name === "string" ? c.name : undefined,
          parentId: typeof c.parentId === "string" ? c.parentId : undefined,
        });
      });
      return { groupId: gid };
    }
    case "ungroup": {
      const list = ids(c);
      store.commit((p) => ops.ungroup(p, list));
      return { ungrouped: list.length };
    }

    case "rename_group": {
      const gid = typeof c.groupId === "string" ? c.groupId : "";
      const name = typeof c.name === "string" ? c.name.trim() : "";
      if (!gid || !name) throw new Error("rename_group: groupId + name required");
      if (!get(store.project).figures.some((f) => f.groups?.[gid]))
        throw new Error(`rename_group: unknown group ${gid}`);
      store.commit((p) => ops.renameGroup(p, gid, name));
      return { groupId: gid, name };
    }

    case "set_group_state": {
      // {groupId, hidden?, locked?} — the Layers panel group eye/padlock.
      const gid = typeof c.groupId === "string" ? c.groupId : "";
      if (!gid) throw new Error("set_group_state: groupId required");
      if (!get(store.project).figures.some((f) => f.groups?.[gid]))
        throw new Error(`set_group_state: unknown group ${gid}`);
      const patch: { hidden?: boolean; locked?: boolean } = {};
      if (typeof c.hidden === "boolean") patch.hidden = c.hidden;
      if (typeof c.locked === "boolean") patch.locked = c.locked;
      if (patch.hidden == null && patch.locked == null)
        throw new Error("set_group_state: pass hidden and/or locked (boolean)");
      store.commit((p) => ops.setGroupState(p, gid, patch));
      return { groupId: gid, ...patch };
    }

    case "list_groups": {
      // Read-only: the registry (name/nesting/state) + member ids, per figure
      // (all figures, or one via {figureId}).
      const p = get(store.project);
      const figs = typeof c.figureId === "string" ? p.figures.filter((f) => f.id === c.figureId) : p.figures;
      const groups = figs.flatMap((f) =>
        Object.values(f.groups ?? {}).map((g) => ({
          figureId: f.id,
          id: g.id,
          name: g.name,
          ...(g.parentId ? { parentId: g.parentId } : {}),
          ...(g.hidden ? { hidden: true } : {}),
          ...(g.locked ? { locked: true } : {}),
          members: membersDeep(f, g.id).map((e) => e.id),
        })),
      );
      return { groups };
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

    case "resize_figure_frame": {
      if (storeTenant() !== "figure") throw new Error("Individual slide frames share the deck stage size.");
      const f = fig(c);
      if (!f || !get(store.project).figures.some(fig => fig.id === f)) throw new Error("resize_figure_frame: figure not found");
      const box = { x: Number(c.x), y: Number(c.y), w: Number(c.width), h: Number(c.height) };
      validateFrameBounds(box); // rejected commands must not create history
      store.commit(p => ops.resizeFigureFrame(p, f, box));
      return { figureId: f };
    }

    case "set_figure_layout": {
      const f = fig(c);
      if (!f) throw new Error("set_figure_layout: no active figure");
      store.commit((p) => ops.setFigureLayout(p, f, (c.patch ?? {}) as Parameters<typeof ops.setFigureLayout>[2]));
      return { figureId: f };
    }

    case "set_figure_family": {
      const f = fig(c);
      if (!f) throw new Error("set_figure_family: no active figure");
      let name = "";
      store.commit((p) => {
        ops.setFigureIdentity(p, f, {
          family: typeof c.family === "string" ? c.family : undefined,
          number: num(c.number) ?? undefined,
          ...(c.nickname === null || typeof c.nickname === "string"
            ? { nickname: c.nickname as string | null }
            : {}),
        });
        name = p.figures.find((ff) => ff.id === f)?.name ?? "";
      });
      return { figureId: f, name };
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
          family: typeof c.family === "string" ? c.family : undefined,
          number: num(c.number) ?? undefined,
          nickname: typeof c.nickname === "string" ? c.nickname : undefined,
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
        if (nid) reflowTexts(p, [nid]); // hug the new box like a GUI-created text
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
        // PNG-only (figure-v1 P4): the old `kind:"svg"` variant is gone — an
        // svg asset is a semantic plot, placed via add_plot.
        nid = ops.addImagePanel(p, f, {
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
      // io.importPlotsFromPaths the GUI's Alt+G gallery multi-insert runs (sidecar
      // resolution, physical-size placement, grid auto-arrange, ONE undo step,
      // per-file failure toast). Dynamically imported: io.ts is a GUI-runtime
      // module (browser Image/window.fig), and a static import would drag it
      // into every headless consumer of this command table.
      const paths = Array.isArray(c.paths) ? (c.paths as unknown[]).filter((p): p is string => typeof p === "string") : [];
      if (!paths.length) throw new Error("import_plots: paths[] required (absolute plot paths)");
      if (typeof window === "undefined" || !window.fig)
        throw new Error("import_plots: no file bridge (GUI runtime import — requires the running app)");
      const io = await import("../io");
      assertOwner();
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
