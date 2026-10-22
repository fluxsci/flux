// The Plots rail's view preferences (localStorage, bounded decode — the figureLayoutStore
// pattern). Layout widths/split live in figureLayoutStore; these are what the ⋯ menus set.

import { writable } from "svelte/store";
import { decodePreferences } from "../preferences";
import type { BackdropMode } from "./rules";

export interface RailPrefs {
  scope: "project" | "global";
  /** Folders: sections in tree order. Recent: one list, newest-modified first. */
  sort: "folders" | "recent";
  names: boolean;
  backdrop: BackdropMode;
  /** Gallery target row height (the tile size). */
  tileH: number;
  /** Dissections target row height — panels are usually viewed smaller than plots. */
  dissectTileH: number;
  /** Scroll the gallery to the plot selected on the canvas when it is off-screen. */
  autoReveal: boolean;
}

export const RAIL_PREFS_DEFAULTS: RailPrefs = { scope: "project", sort: "folders", names: true, backdrop: "auto", tileH: 112, dissectTileH: 84, autoReveal: true };
export const TILE_H_MIN = 56;
export const TILE_H_MAX = 360;
const KEY = "flux.plotsRail";

function load(): RailPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return decodePreferences(JSON.parse(raw), RAIL_PREFS_DEFAULTS, {
      scope: { enum: ["project", "global"] },
      sort: { enum: ["folders", "recent"] },
      backdrop: { enum: ["auto", "paper", "dark", "checker", "destination"] },
      tileH: { min: TILE_H_MIN, max: TILE_H_MAX },
      dissectTileH: { min: TILE_H_MIN, max: TILE_H_MAX },
    });
  } catch { /* defaults */ }
  return { ...RAIL_PREFS_DEFAULTS };
}

export const railPrefs = writable<RailPrefs>(load());
railPrefs.subscribe((v) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } });

// Per-project collapsed folders / dissection groups (by folder path / group NAME — the same
// group recurs across plots, so "Show all" and collapse follow the name).
function readSet(key: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set<string>(Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 5000) : []);
  } catch { return new Set<string>(); }
}
function writeSet(key: string, set: Set<string>) {
  try { localStorage.setItem(key, JSON.stringify([...set].slice(0, 5000))); } catch { /* private mode */ }
}

/** Folders whose collapse the user flipped from the default (per project / library root). */
export function toggledFolders(root: string): Set<string> { return readSet(`flux.plotsRail.toggled:${root}`); }
export function saveToggledFolders(root: string, set: Set<string>): void { writeSet(`flux.plotsRail.toggled:${root}`, set); }
export function dissectGroupState(): { collapsed: Set<string>; expanded: Set<string> } {
  return { collapsed: readSet("flux.plotsRail.dissectCollapsed"), expanded: readSet("flux.plotsRail.dissectShowAll") };
}
export function saveDissectGroupState(s: { collapsed: Set<string>; expanded: Set<string> }): void {
  writeSet("flux.plotsRail.dissectCollapsed", s.collapsed);
  writeSet("flux.plotsRail.dissectShowAll", s.expanded);
}

/** Default collapse for a folder never toggled: the root's files and its top-level folders
 *  open, deeper folders closed — a fixed rule, so adding the 301st plot never reshapes the list. */
export function defaultCollapsed(dir: string): boolean {
  return dir.split("/").filter(Boolean).length >= 2;
}

/** Whether a folder is collapsed, given the user's flips. */
export function isCollapsed(dir: string, toggled: Set<string>): boolean {
  return defaultCollapsed(dir) !== toggled.has(dir);
}
