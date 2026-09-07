// Shared, dependency-free ingress checks. Existing saved projects retain their
// legacy reader; newly imported/reloaded bundles verify ORIGINAL SVG bytes.
import type { FluxPlotManifest, PartNode } from "./types";

export function modernPlot(manifest: Pick<FluxPlotManifest, "schemaVersion">): boolean {
  const [major, minor] = String(manifest.schemaVersion ?? "0").split(".").map(Number);
  return major > 0 || minor >= 3;
}

export function plotContractErrors(svg: string, value: unknown, strict = true): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Manifest must be a JSON object"];
  const m = value as FluxPlotManifest;
  if (!strict && !modernPlot(m)) return errors;
  if (!Array.isArray(m.series)) return ["Manifest must contain a series array"];
  if (modernPlot(m) && !Array.isArray(m.axes)) return ["Manifest must contain an axes array"];
  if (!strict) return errors;
  const ids = new Set<string>();
  // Limit the attribute scan to tags (never embedded text, comments or script).
  const tags = svg.replace(/<!--[\s\S]*?-->/g, "").match(/<[A-Za-z][^>]*>/g) ?? [];
  for (const tag of tags) for (const match of tag.matchAll(/\sid\s*=\s*(["'])(.*?)\1/g)) {
    if (ids.has(match[2])) errors.push(`Duplicate SVG id "${match[2]}"`);
    ids.add(match[2]);
  }
  const refs = new Set<string>();
  const ref = (v: unknown) => { if (typeof v === "string") refs.add(v); };
  const unique = (vs: { id?: string }[], kind: string) => {
    const seen = new Set<string>();
    for (const v of vs) {
      if (!v || typeof v.id !== "string" || seen.has(v.id)) errors.push(`Missing or duplicate ${kind} id`);
      else seen.add(v.id);
    }
    return seen;
  };
  const panelIds = unique(m.panels ?? [], "panel");
  unique(m.series, "series");
  const owners = new Set<string>();
  for (const a of Array.isArray(m.axes) ? m.axes : []) {
    if (!a || !a.x || !a.y) { errors.push("Axes need x and y descriptors"); continue; }
    ref(a.svgId);
    if (a.panelId) { if (owners.has(a.panelId) || !panelIds.has(a.panelId)) errors.push(`Invalid axes panel "${a.panelId}"`); owners.add(a.panelId); }
    for (const axis of [a.x, a.y]) {
      if (!Array.isArray(axis.domain) || axis.domain.length !== 2 || !axis.domain.every(Number.isFinite) || !Array.isArray(axis.anchors)) errors.push("Invalid axis domain/anchors");
      else if (axis.supported === true && (!['linear', 'log'].includes(axis.scale) || axis.anchors.length < 2 || axis.domain[0] === axis.domain[1] || !axis.anchors.every((p) => Number.isFinite(p.data) && Number.isFinite(p.svg)))) errors.push("Unsupported axis advertises data-space mapping");
    }
  }
  for (const s of m.series) {
    if (!s || !s.svg || typeof s.svg !== "object") { errors.push("Series needs SVG references"); continue; }
    if ((m.panels?.length || s.panelId) && (!s.panelId || !owners.has(s.panelId))) errors.push(`Series "${s.id}" has no owning panel`);
    for (const v of Object.values(s.svg)) Array.isArray(v) ? v.forEach(ref) : ref(v);
    for (const c of s.components ?? []) { ref(c.svgId); c.members?.forEach(ref); }
    const data = s.data;
    if (data && (data.x || data.y)) {
      if (!Array.isArray(data.x) || !Array.isArray(data.y) || data.x.length !== data.y.length || ![...data.x, ...data.y].every((v) => v === null || (typeof v === "number" && Number.isFinite(v)))) errors.push(`Invalid observation arrays in "${s.id}"`);
    }
    const indices = new Set<number>();
    for (const p of s.points ?? []) {
      ref(p.svgId);
      if (!Number.isInteger(p.index) || p.index < 0 || indices.has(p.index) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) errors.push(`Invalid point identity in "${s.id}"`);
      indices.add(p.index);
      if (data?.x && (data.x[p.index] !== p.x || data.y[p.index] !== p.y)) errors.push(`Point data disagree with source observation in "${s.id}"`);
    }
  }
  for (const g of m.guides ?? []) { ref(g.svgId); ref(g.mappable); g.parts?.forEach((p) => ref(p.svgId)); }
  for (const o of m.overlays ?? []) ref(o.svgId);
  const walk = (node: PartNode) => { ref(node.ref); node.members?.forEach(ref); node.children?.forEach(walk); };
  if (m.parts) walk(m.parts);
  for (const id of refs) if (!ids.has(id)) errors.push(`Manifest references missing SVG id "${id}"`);
  return [...new Set(errors)];
}

export async function validateIncomingPlot(svg: string, manifestText: string | null | undefined): Promise<void> {
  if (!manifestText) return;
  const manifest = JSON.parse(manifestText) as FluxPlotManifest;
  const errors = plotContractErrors(svg, manifest, modernPlot(manifest));
  const expected = manifest.artifact?.svgSha256;
  if (expected) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(svg));
    const actual = Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join("");
    if (actual !== expected) errors.push("SVG and manifest checksum differ; reload after plot generation completes");
  }
  if (errors.length) throw new Error(errors.slice(0, 8).join("; "));
}
