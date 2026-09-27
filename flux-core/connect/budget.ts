// What goes into a pack, per depth (plan §8.4, owner ruling 4: minimal must-read,
// everything else indexed). Pure.
//
// core (default): you · FluxLib what/where/how · project map + index ·
//   ProjectContext + the files it links (capped) · Rules · recent Log + title
//   index · open items · recent activity · canvas overviews.
// full: core + every document in full + per-figure images + deck contact sheets.

import { tokensOf, type ConnectDepth, type ConnectFacts, type LogEntryFact } from "./facts";

export const LINKED_BUDGET_DEFAULT = 40_000;
export const LOG_ENTRIES_FULL = 10;
export const LEGACY_SECTIONS_CAP = 6_000;
export const FULL_WARN_TOKENS = 200_000;
export const PARTIAL_WORDS = 1_500;

export type IncludeMode = "full" | "partial" | "listed";

export interface Trimmed {
  what: string;
  tokens: number;
  reason: string;
}

export interface InclusionPlan {
  depth: ConnectDepth;
  linked: { display: string; mode: IncludeMode; tokens: number }[];
  log: { full: LogEntryFact[]; fromCheckpoint: string | null; omitted: number };
  legacy: IncludeMode | null;
  docs: { path: string; mode: IncludeMode; tokens: number }[];
  figureImages: "canvases" | "canvases+figures";
  deckSheets: boolean;
  trimmed: Trimmed[];
  warnings: string[];
}

export function planInclusion(facts: ConnectFacts, depth: ConnectDepth, opts: { linkedBudget?: number } = {}): InclusionPlan {
  const p = facts.project;
  const plan: InclusionPlan = {
    depth,
    linked: [],
    log: { full: [], fromCheckpoint: null, omitted: 0 },
    legacy: null,
    docs: [],
    figureImages: depth === "full" ? "canvases+figures" : "canvases",
    deckSheets: depth === "full",
    trimmed: [],
    warnings: [],
  };
  if (!p) return plan;

  // ProjectContext's links: text files in full while the linked budget lasts
  // (core follows one level; full follows up to three, collected upstream).
  let budget = opts.linkedBudget ?? LINKED_BUDGET_DEFAULT;
  for (const l of p.projectContext.links) {
    if (depth !== "full" && l.depth > 1) continue;
    if (l.kind !== "text" || l.text === undefined) {
      plan.linked.push({ display: l.display, mode: "listed", tokens: 0 });
      continue;
    }
    const t = tokensOf(l.text);
    if (depth === "full" || t <= budget) {
      plan.linked.push({ display: l.display, mode: "full", tokens: t });
      budget -= t;
    } else {
      plan.linked.push({ display: l.display, mode: "partial", tokens: t });
      plan.trimmed.push({ what: l.display, tokens: t, reason: "linked from ProjectContext; outline + opening only (read it when relevant)" });
    }
  }

  // Log: from the latest checkpoint forward, capped to the newest entries; a
  // title index of everything else always follows in the bundle.
  const entries = p.notebook.entries;
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].isCheckpoint) { start = i; break; }
  const fromCheckpoint = entries.slice(start);
  const full = depth === "full" ? entries : fromCheckpoint.slice(-LOG_ENTRIES_FULL);
  plan.log = {
    full,
    fromCheckpoint: start > 0 || entries[0]?.isCheckpoint ? entries[start].title : null,
    omitted: entries.length - full.length,
  };

  if (p.notebook.legacySections) {
    const t = tokensOf(p.notebook.legacySections);
    plan.legacy = depth === "full" || t <= LEGACY_SECTIONS_CAP ? "full" : "partial";
    if (plan.legacy === "partial") plan.trimmed.push({ what: `${p.notebook.path} (legacy sections)`, tokens: t, reason: "capped; read the file for the rest" });
  }

  // Documents: indexed under core (outline in the map); in full under full.
  // A document ProjectContext links is already in §D.
  const linkedDisplays = new Set(p.projectContext.links.map((l) => l.display));
  let total = 0;
  for (const d of p.docs) {
    if (linkedDisplays.has(d.path)) continue;
    const t = d.text !== undefined ? tokensOf(d.text) : Math.ceil(d.words * 1.4);
    total += t;
    plan.docs.push({ path: d.path, mode: depth === "full" ? "full" : "listed", tokens: t });
  }
  if (depth === "full" && total > FULL_WARN_TOKENS) plan.warnings.push(`--depth full is reading ~${Math.round(total / 1000)}k tokens of documents`);
  return plan;
}
