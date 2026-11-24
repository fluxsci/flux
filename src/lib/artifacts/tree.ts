// The artifact rail's rows, and the few lookups Paper needs on a listing. Pure.
import type { Artifact, ArtifactListing, ArtifactRoot } from "./types";

export type ArtifactRow =
  | { kind: "group"; key: string; path: string; name: string; depth: number; count: number }
  | { kind: "artifact"; key: string; artifact: Artifact; depth: number };

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
const leaf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

/**
 * One root as rows: groups (folders that only hold artifacts) open or folded, each level sorted
 * by name with folders and artifacts together, the way the folder reads on disk.
 */
export function artifactRows(root: ArtifactRoot, collapsed: ReadonlySet<string> = new Set()): ArtifactRow[] {
  const children = new Map<string, { groups: Set<string>; artifacts: Artifact[] }>();
  const at = (path: string) => {
    let node = children.get(path);
    if (!node) children.set(path, (node = { groups: new Set(), artifacts: [] }));
    return node;
  };
  for (const artifact of root.artifacts) {
    at(artifact.group).artifacts.push(artifact);
    for (let path = artifact.group; path; ) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      at(parent).groups.add(path);
      path = parent;
    }
  }
  const countIn = (path: string): number => {
    const node = children.get(path);
    return node ? node.artifacts.length + [...node.groups].reduce((n, g) => n + countIn(g), 0) : 0;
  };
  const rows: ArtifactRow[] = [];
  const walk = (path: string, depth: number) => {
    const node = children.get(path);
    if (!node) return;
    const items = [
      ...[...node.groups].map((g) => ({ name: leaf(g), group: g as string | null, artifact: null as Artifact | null })),
      ...node.artifacts.map((a) => ({ name: leaf(a.rel) || a.title, group: null as string | null, artifact: a as Artifact | null })),
    ].sort((a, b) => byName(a.name, b.name));
    for (const item of items) {
      if (item.artifact) rows.push({ kind: "artifact", key: item.artifact.id, artifact: item.artifact, depth });
      else if (item.group) {
        const key = `${root.id}:${item.group}/`;
        rows.push({ kind: "group", key, path: item.group, name: item.name, depth, count: countIn(item.group) });
        if (!collapsed.has(key)) walk(item.group, depth + 1);
      }
    }
  };
  walk("", 0);
  return rows;
}

export const allArtifacts = (listing: ArtifactListing | null): Artifact[] => listing?.roots.flatMap((r) => r.artifacts) ?? [];
export const findArtifact = (listing: ArtifactListing | null, id: string | null | undefined): Artifact | null =>
  (id && allArtifacts(listing).find((a) => a.id === id)) || null;
export const rootOf = (listing: ArtifactListing | null, artifact: Artifact | null): ArtifactRoot | null =>
  (artifact && listing?.roots.find((r) => r.id === artifact.rootId)) || null;

/**
 * The artifact a saved place names. `ref` is a page's path as an agent was told it (project-relative
 * or absolute): the artifact whose page that is, or failing that the one whose folder holds it.
 */
export function artifactForRef(listing: ArtifactListing | null, ref: string): { artifact: Artifact; page: string } | null {
  const all = allArtifacts(listing);
  for (const artifact of all) {
    if (artifact.ref === ref) return { artifact, page: artifact.entry };
    const base = artifact.ref.slice(0, artifact.ref.length - artifact.entry.length);
    for (const page of artifact.pages) if (base + page.rel === ref) return { artifact, page: page.rel };
  }
  for (const artifact of all) {
    if (artifact.kind !== "folder") continue;
    const base = artifact.ref.slice(0, artifact.ref.length - artifact.entry.length);
    const folder = base + (artifact.rel ? artifact.rel + "/" : "");
    if (ref.startsWith(folder)) return { artifact, page: ref.slice(base.length) };
  }
  return null;
}

/** The path an agent is told for one page of an artifact (see Artifact.ref). */
export function pageRef(artifact: Artifact, pageRel: string): string {
  return artifact.ref.slice(0, artifact.ref.length - artifact.entry.length) + pageRel;
}

/** Does a changed file belong to what this artifact shows? Its folder for a folder, its file for a page. */
export function changeTouches(artifact: Artifact, paths: readonly string[]): boolean {
  if (artifact.kind === "file") {
    const file = artifact.pages[0]?.path;
    return paths.some((p) => p === file);
  }
  const prefix = artifact.dir.endsWith("/") || artifact.dir.endsWith("\\") ? artifact.dir : artifact.dir + (artifact.dir.includes("\\") ? "\\" : "/");
  return paths.some((p) => p.startsWith(prefix));
}

/** How long ago, as short as a rail has room for: "now", "12m", "3h", "5d", then the date. */
export function artifactAge(mtimeMs: number, now: number): string {
  if (!mtimeMs) return "";
  const s = Math.max(0, (now - mtimeMs) / 1000);
  if (s < 90) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 60 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

/** The same, in words, with the moment itself: for a tooltip. */
export function artifactAgeWords(mtimeMs: number, now: number): string {
  if (!mtimeMs) return "";
  const s = Math.max(0, (now - mtimeMs) / 1000);
  const ago = s < 90 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  return `changed ${ago} (${new Date(mtimeMs).toISOString().slice(0, 16).replace("T", " ")} UTC)`;
}

/** Titles that more than one artifact of a listing carries: those rows also show their file or folder name. */
export function sharedTitles(listing: ArtifactListing | null): Set<string> {
  const seen = new Set<string>(), shared = new Set<string>();
  for (const a of allArtifacts(listing)) (seen.has(a.title) ? shared : seen).add(a.title);
  return shared;
}
