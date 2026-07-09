// WS4 — snapshot the live Figure-editor UI state into a versioned, JSON-safe
// AppContext that an external agent reads to "see what the human is doing": what
// is selected (elements / a drilled-in plot part / a whole frame), what figure +
// canvas are active, the viewport, and a compact digest of the active figure so
// the agent can reason without reading files. Pure read of the stores in store.ts.

import { get } from "svelte/store";
import {
  project,
  selection,
  partSelection,
  activeFigureId,
  selectedFrameId,
  activeCanvasId,
  viewport,
  hoverId,
  projectDir,
  embeddedProjectRoot,
  getActiveFigure,
} from "../store";
import type { Element, Figure } from "../types";
import { membersDeep } from "../groups";
import { focusedMode } from "../../shell/paneStore";
import type { ModeId } from "../../shell/shellStore";

export interface ContextElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  assetId?: string;
  panelLabel?: boolean;
  groupId?: string;
}

// P7: the active figure's group registry, digested (members = deep count) so
// an agent can address groups (select {groupId}, rename_group, …) without
// reading files.
export interface ContextGroup {
  id: string;
  name: string;
  parentId?: string;
  hidden?: boolean;
  locked?: boolean;
  members: number;
}

export interface AppContext {
  v: 1;
  // AGT-14: the human's actually-focused mode (was hardcoded "figure"), so an
  // agent knows which surface the human is on. The figure-centric fields below
  // stay populated (the figure model is the richest live context we expose).
  surface: ModeId;
  projectRoot: string | null;
  activeFigureId: string | null;
  selectedFrameId: string | null;
  activeCanvasId: string | null;
  selection: string[];
  partSelection: { elementId: string; partId: string } | null;
  hoverId: string | null;
  viewport: { panX: number; panY: number; zoom: number };
  figures: { id: string; name: string; canvasId: string }[];
  activeFigure:
    | { id: string; name: string; width: number; height: number; elements: ContextElement[]; groups: ContextGroup[] }
    | null;
  selectedElements: { id: string; type: string }[];
}

function digest(e: Element): ContextElement {
  const c: ContextElement = { id: e.id, type: e.type, x: e.x, y: e.y };
  if ("width" in e) c.width = e.width;
  if ("height" in e) c.height = e.height;
  if ("assetId" in e) c.assetId = e.assetId;
  if (e.type === "text" && e.panelLabel) c.panelLabel = true;
  if (e.groupId) c.groupId = e.groupId;
  return c;
}

function digestGroups(fig: Figure): ContextGroup[] {
  return Object.values(fig.groups ?? {}).map((g) => ({
    id: g.id,
    name: g.name,
    ...(g.parentId ? { parentId: g.parentId } : {}),
    ...(g.hidden ? { hidden: true } : {}),
    ...(g.locked ? { locked: true } : {}),
    members: membersDeep(fig, g.id).length,
  }));
}

export function getAppContext(): AppContext {
  const p = get(project);
  const fig = getActiveFigure(p);
  const sel = get(selection);
  return {
    v: 1,
    surface: get(focusedMode),
    projectRoot: get(embeddedProjectRoot) ?? get(projectDir) ?? null,
    activeFigureId: get(activeFigureId),
    selectedFrameId: get(selectedFrameId),
    activeCanvasId: get(activeCanvasId),
    selection: [...sel],
    partSelection: get(partSelection),
    hoverId: get(hoverId),
    viewport: get(viewport),
    figures: p.figures.map((f) => ({ id: f.id, name: f.name, canvasId: f.canvasId })),
    activeFigure: fig
      ? {
          id: fig.id,
          name: fig.name,
          width: fig.width,
          height: fig.height,
          elements: fig.elements.map(digest),
          groups: digestGroups(fig),
        }
      : null,
    selectedElements: fig
      ? fig.elements.filter((e) => sel.has(e.id)).map((e) => ({ id: e.id, type: e.type }))
      : [],
  };
}
