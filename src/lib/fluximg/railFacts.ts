/**
 * What the Plots rail and the Plot gallery know about the image bundles they list, learned only for the tiles that
 * were on screen (railThumb.ts reads a bundle's manifest when its tile first asks for a picture; a listing never
 * does). Keyed by the bundle's absolute path; each fact belongs to one version (`stamp`, the index's size:mtime of
 * the manifest), so a rewritten bundle is described afresh.
 *
 * Deliberately tiny (svelte/store only): the rail imports it eagerly, the decoding machinery stays lazy.
 */
import { writable, type Readable } from "svelte/store";

export interface FluximgRailFact {
  stamp: string;
  /** "3 channels · 25 z · 2048 × 2048 · uint16" (place.describeFluximg). */
  line: string;
  /** Image x / y size in pixels (level 0). */
  width: number;
  height: number;
}

const facts = writable<ReadonlyMap<string, FluximgRailFact>>(new Map());
const MAX_FACTS = 4000;

/** Facts by bundle path. */
export const fluximgRailFacts: Readable<ReadonlyMap<string, FluximgRailFact>> = { subscribe: facts.subscribe };

/** Record what a bundle's manifest says (railThumb.ts). */
export function noteFluximgRailFact(abs: string, fact: FluximgRailFact): void {
  facts.update((m) => {
    const was = m.get(abs);
    if (was && was.stamp === fact.stamp && was.line === fact.line && was.width === fact.width && was.height === fact.height) return m;
    const next = new Map(m);
    next.delete(abs);
    next.set(abs, fact);
    // Bounded: the oldest facts go first (a 20,000-bundle tree scrolled end to end must not grow without limit).
    while (next.size > MAX_FACTS) next.delete(next.keys().next().value!);
    return next;
  });
}

/** The fact for this version of a bundle, if one is known. */
export function fluximgRailFact(map: ReadonlyMap<string, FluximgRailFact>, abs: string, stamp: string): FluximgRailFact | null {
  const f = map.get(abs);
  return f && f.stamp === stamp ? f : null;
}

/** Forget everything (project change). */
export function clearFluximgRailFacts(): void { facts.set(new Map()); }

/** True for a path that names an image bundle (`….fluximg`, the directory). */
export const isFluximgPath = (p: string): boolean => /\.fluximg[\\/]*$/i.test(p) && !/(^|[\\/])\.fluximg[\\/]*$/i.test(p);
