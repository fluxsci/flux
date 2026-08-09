// Dissections, headless half: list the companion material a plot owns under
// plots/_dissections/<key>/ (the Dissect viewer's folder convention). The path rules are the
// SAME shared module the GUI and the watcher load (electron/dissectRules.js) — twin-engine
// rule; drift structurally impossible. Writing needs no verb: the folder is the API — analysis
// code just drops files (subfolders become named groups in the viewer).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  DISSECT_DIRNAME,
  plotKeyFor,
  dissectionRootRelFor,
  classifyDissectionFile,
} from "../electron/dissectRules.js";
import { isReservedPlotDirName } from "../electron/plotsFolders.js";
import { ValidationError } from "./errors";

export interface DissectionFileInfo {
  name: string;
  kind: string;
}
export interface DissectionGroupInfo {
  /** "" = the default group (files directly in the plot's dissection root). */
  group: string;
  files: DissectionFileInfo[];
}
export interface DissectionDetail {
  plot: string;
  /** Project-relative folder ("plots/_dissections/<key>"). */
  root: string;
  exists: boolean;
  groups: DissectionGroupInfo[];
  files: number;
}
export interface DissectionSummary {
  plot: string;
  root: string;
  groups: string[];
  files: number;
}

/** The plot argument in any shape (key, plots/-relative, project-relative, absolute) → key.
 *  A bare/relative form that doesn't name plots/ explicitly is read AS plots/-relative, so
 *  `sub/charlie` and `sub/charlie.svg` both key the nested plot. */
function keyForArg(root: string, plot: string): string {
  const raw = String(plot ?? "").trim();
  if (!raw) throw new ValidationError("empty plot argument");
  const explicit = path.isAbsolute(raw) || raw.replace(/\\/g, "/").startsWith("plots/");
  const key = plotKeyFor(explicit ? raw : `plots/${raw}`, root);
  if (!key) throw new ValidationError(`can't derive a dissection key from ${JSON.stringify(raw)}`);
  return key;
}

function listFiles(dir: string): DissectionFileInfo[] {
  const out: DissectionFileInfo[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) continue;
    const kind = classifyDissectionFile(e.name);
    if (kind !== "sidecar") out.push({ name: e.name, kind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Detailed listing for one plot: loose files = the default group, one level of subfolders
 *  = named groups (the viewer's model, byte-for-byte the same convention). */
export function listDissectionsFor(root: string, plot: string): DissectionDetail {
  const key = keyForArg(root, plot);
  const rel = `plots/${dissectionRootRelFor(key)}`;
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { plot: key, root: rel, exists: false, groups: [], files: 0 };
  const groups: DissectionGroupInfo[] = [];
  const loose = listFiles(abs);
  if (loose.length) groups.push({ group: "", files: loose });
  const subs = fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const d of subs) groups.push({ group: d, files: listFiles(path.join(abs, d)) });
  return { plot: key, root: rel, exists: true, groups, files: groups.reduce((n, g) => n + g.files.length, 0) };
}

/** Every plot that HAS a dissection folder. Plot files are enumerated first (skipping the
 *  reserved folders — _dissections itself, and _lighttable's exploratory image sets, which
 *  are not composable plots and can be enormous), then checked for a root — so an orphaned
 *  dissection folder whose plot was renamed away is deliberately not invented into a plot. */
export function listAllDissections(root: string): DissectionSummary[] {
  const plotsDir = path.join(root, "plots");
  if (!fs.existsSync(plotsDir)) return [];
  const keys: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!isReservedPlotDirName(e.name)) walk(path.join(dir, e.name), r, depth + 1);
      } else if (/\.(svg|png)$/i.test(e.name)) {
        const key = plotKeyFor(`plots/${r}`, root);
        if (key) keys.push(key);
      }
    }
  };
  walk(plotsDir, "", 0);
  const out: DissectionSummary[] = [];
  for (const key of keys) {
    const rel = `plots/${dissectionRootRelFor(key)}`;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    const d = listDissectionsFor(root, key);
    out.push({ plot: key, root: rel, groups: d.groups.map((g) => g.group || "·"), files: d.files });
  }
  return out.sort((a, b) => a.plot.localeCompare(b.plot, undefined, { numeric: true }));
}

/** The verb's handler: one plot's detail, or the project-wide summary. */
export function listDissections(root: string, plot?: string): DissectionDetail | DissectionSummary[] {
  return plot ? listDissectionsFor(root, plot) : listAllDissections(root);
}

export { DISSECT_DIRNAME };
