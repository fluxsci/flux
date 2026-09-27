// Mode-owned resolvers keep editor code out of the eager shell. Point lookups
// use the browser's spatial hit test and ancestor walk, never a scene scan.
import { uniqueTargets, type TargetRef } from "../project/targets";

export interface TargetBounds { x: number; y: number; w: number; h: number }
export interface TargetHit { ref: TargetRef; bounds: TargetBounds; label: string }
export interface TargetResolver {
  surface: string;
  root(): Element | null;
  current(): TargetRef[];
  prepare?(): void;
  revision?(): readonly unknown[];
  at(x: number, y: number, hit?: Element): TargetHit[];
  within?(rect: TargetBounds): TargetHit[];
}
const resolvers = new Set<TargetResolver>();
export const targetResolutionStats = { calls: 0, roots: 0, hits: 0 };
export function registerTargetResolver(resolver: TargetResolver): () => void {
  resolvers.add(resolver);
  return () => { resolvers.delete(resolver); };
}
export function boundsOf(el: Element): TargetBounds {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
}
function visible(el: Element): boolean {
  return el.isConnected && !el.closest('.mc.hidden, [hidden], [inert], [data-doc-active="false"]') && el.getClientRects().length > 0;
}
/** Cheap view identity lets a retained draft detect changes behind its old picture. */
export function targetViewIdentity(doc: Document): unknown[] {
  return [...resolvers].flatMap(r => {
    const root = r.root(); if (!root || root.ownerDocument !== doc || !visible(root)) return [];
    const b = boundsOf(root);
    return [root, b.x, b.y, b.w, b.h, root.scrollLeft, root.scrollTop, ...(r.revision?.() ?? [])];
  });
}
export function prepareTargetResolvers(): void { for (const r of resolvers) { const root = r.root(); if (root && visible(root)) r.prepare?.(); } }
export function currentTargets(surface?: string, doc?: Document): TargetRef[] {
  const ownerDocument = doc ?? (typeof document !== "undefined" ? document : undefined);
  const active = ownerDocument?.activeElement;
  const available = [...resolvers].filter(r => { const root = r.root(); return root && (!ownerDocument || root.ownerDocument === ownerDocument) && (!surface || r.surface === surface) && visible(root); });
  const focused = active ? available.filter(r => r.root()!.contains(active)).sort((a,b) => a.root()!.contains(b.root()!) ? 1 : -1) : [];
  for (const r of focused) { const refs = r.current(); if (refs.length) return uniqueTargets(refs); }
  return uniqueTargets(available.flatMap(r => r.current()));
}
export function elementUnder(x: number, y: number, opts: { ignore?: Element | null; document?: Document } = {}): Element | null {
  return (opts.document ?? document).elementsFromPoint(x, y).find(el => !opts.ignore?.contains(el) && !el.closest('[data-annotation-surface]')) ?? null;
}
function candidates(x: number, y: number, opts: { ignore?: Element | null; document?: Document }) {
  const doc = opts.document ?? document;
  const hit = elementUnder(x, y, opts);
  const found: { resolver: TargetResolver; root: Element }[] = [];
  for (const resolver of resolvers) {
    const root = resolver.root();
    targetResolutionStats.roots++;
    if (!root || root.ownerDocument !== doc || !visible(root)) continue;
    const b = root.getBoundingClientRect();
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom && (!hit || root.contains(hit))) found.push({ resolver, root });
  }
  found.sort((a, b) => a.root.contains(b.root) ? 1 : b.root.contains(a.root) ? -1 : 0);
  return { found, hit };
}
export function resolveAt(x: number, y: number, opts: { ignore?: Element | null; document?: Document } = {}): TargetHit[] {
  targetResolutionStats.calls++;
  const { found, hit } = candidates(x, y, opts);
  for (const { resolver } of found) {
    const results = resolver.at(x, y, hit ?? undefined);
    targetResolutionStats.hits += results.length;
    if (results.length) return results;
  }
  return [];
}
export function resolveWithin(rect: TargetBounds, opts: { ignore?: Element | null; document?: Document } = {}): TargetHit[] {
  const { found } = candidates(rect.x + rect.w / 2, rect.y + rect.h / 2, opts);
  for (const { resolver } of found) {
    const hits = resolver.within?.(rect);
    if (hits?.length) return hits;
  }
  return resolveAt(rect.x + rect.w / 2, rect.y + rect.h / 2, opts).slice(-1);
}
