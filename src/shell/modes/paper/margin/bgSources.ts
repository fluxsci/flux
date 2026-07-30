// The dynamic background's five sources — hand-tuned generative-art fields
// from ~/dynamic_margin_backgrounds, one entry per background the user can
// pick. Four are ambient scenes; the fifth wraps the living-vines generator.
// All the art code lives untouched under src/lib/ambient/** — this file only
// adapts the two spawn shapes (Scene.spawn vs generateVine+planOps) to the
// one BgField interface DynamicBackground.svelte composites.
//
// Knob/lifecycle values are the owner's locked defaults (screenshots in
// ~/dynamic_margin_backgrounds/default_param_configs_for_flux) — change them
// only on request.

import { writable } from "svelte/store";
import { scenes } from "../../../../lib/ambient/ambient/scenes";
import type { SceneLife } from "../../../../lib/ambient/ambient/types";
import { generateVine, VINE_FAMILIES, type VineKnobs } from "../../../../lib/ambient/vines/gen";
import { planOps } from "../../../../lib/ambient/render/painter";
import { makeRng } from "../../../../lib/ambient/core/prng";

export interface BgRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BgSprite {
  ops: Array<{ t: number; draw(ctx: CanvasRenderingContext2D): void }>;
  duration: number;
  /** Layer bounds at spawn time; null = the sprite paints the full pane. */
  bounds: BgRect | null;
}

export interface BgField {
  spawn(index: number, w: number, h: number, occupied: BgRect[]): BgSprite | null;
  life: SceneLife;
  /** Composite alpha for finished layers (paint opacity). */
  opacity: number;
  /** Simulation pacing multiplier. */
  speed: number;
  /** Minimum seconds between spawns (ambient uses 0.4, vines 0.8). */
  minGap: number;
}

export interface BgSource {
  id: string;
  label: string;
  make(seed: string): BgField;
}

function ambientSource(opts: {
  id: string;
  label: string;
  sceneId: string;
  knobs: Record<string, number>;
  life: SceneLife;
  opacity: number;
  speed: number;
}): BgSource {
  return {
    id: opts.id,
    label: opts.label,
    make(seed) {
      const scene = scenes[opts.sceneId];
      return {
        life: opts.life,
        opacity: opts.opacity,
        speed: opts.speed,
        minGap: 0.4,
        spawn(index, w, h, occupied) {
          const spec = scene.spawn(seed, index, w, h, { ...opts.knobs }, occupied);
          if (!spec || !spec.ops.length) return null;
          return { ops: spec.ops, duration: spec.duration, bounds: spec.bounds ?? null };
        },
      };
    },
  };
}

const VINES_KNOBS: VineKnobs = {
  cling: 0.5,
  wander: 0.33,
  length: 1.59,
  branchiness: 0.84,
  leafDensity: 0.8,
  texture: 0.64,
  flowerRate: 0.9,
  berryRate: 0.4,
  flowerSize: 1,
  palette: 1, // any flexoki
};

const vinesSource: BgSource = {
  id: "vines",
  label: "Living vines",
  make(seed) {
    // One color family per field (when knobs.palette = 0); picked exactly like
    // the stock LivingVines wrapper so the same seed gives the same garden.
    const homeFam = VINE_FAMILIES[Math.floor(makeRng(seed + "|home").next() * VINE_FAMILIES.length)];
    return {
      life: { rate: 11, maxConcurrent: 3, grow: 22, hold: 6, fade: 3 },
      opacity: 0.75,
      speed: 3.5,
      minGap: 0.8,
      spawn(index, w, h) {
        const model = generateVine(seed, index, w, h, { ...VINES_KNOBS }, homeFam);
        // Layers are painted at full opacity; the field's opacity applies at
        // composite time so it can change without respawning.
        const plan = planOps(model, { opacity: 1, jitter: 1, wash: 1 });
        if (!plan.ops.length) return null;
        return { ops: plan.ops, duration: plan.duration, bounds: null };
      },
    };
  },
};

export const BG_SOURCES: BgSource[] = [
  ambientSource({
    id: "harmonograph",
    label: "Harmonograph",
    sceneId: "harmonograph",
    knobs: { complexity: 2, damping: 0.8, ink: 1 /* color */, scale: 0.9, overlap: 0 /* avoid others */ },
    life: { rate: 20, maxConcurrent: 3, grow: 25, hold: 2, fade: 3 },
    opacity: 0.7,
    speed: 2.55,
  }),
  ambientSource({
    id: "neurons",
    label: "Cajal neurons",
    sceneId: "neurons",
    knobs: { arbors: 6, reach: 1.4, spines: 0.96, stain: 1 /* cajal */, axon: 1 /* on */ },
    life: { rate: 10, maxConcurrent: 4, grow: 12, hold: 5, fade: 6 },
    opacity: 0.7,
    speed: 3,
  }),
  ambientSource({
    id: "inkwind",
    label: "Ink wind",
    sceneId: "inkwind",
    knobs: { lines: 75, flow: 2, length: 1.1, accent: 0.7, hues: 2 /* all flexoki */ },
    life: { rate: 15, maxConcurrent: 1, grow: 20, hold: 2, fade: 3 },
    opacity: 0.86, // owner-tuned up from 0.76 (2026-07-29) — a touch more presence
    speed: 3.2,
  }),
  ambientSource({
    id: "loom",
    label: "Loom automata",
    sceneId: "loom",
    knobs: { pitch: 7, steps: 2750, walkers: 6, spread: 1, hues: 2, states: 3 },
    life: { rate: 22, maxConcurrent: 1, grow: 20, hold: 2, fade: 2.5 },
    opacity: 0.6,
    speed: 1,
  }),
  vinesSource,
];

export type BgSourceId = "harmonograph" | "neurons" | "inkwind" | "loom" | "vines";
/** Must match the `paperMarginScene` default in src/lib/settings.ts. */
export const DEFAULT_BG: BgSourceId = "inkwind";

export function bgSourceById(id: string): BgSource {
  return BG_SOURCES.find((s) => s.id === id) ?? BG_SOURCES[0];
}

// Seeds are testbed-style "word-###" and random every session (owner's call):
// the margin greets you with fresh art each launch, never persisted.
const SEED_WORDS = ["quiet", "haze", "vesper", "hedge", "drift", "murmur", "fern", "tide", "slate", "lull"];

export function randomBgSeed(): string {
  const word = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
  return `${word}-${100 + Math.floor(Math.random() * 900)}`;
}

/** This session's seed. Reroll via the ⌘K "New background seed" command. */
export const bgSeed = writable(randomBgSeed());

export function rerollBgSeed(): void {
  bgSeed.set(randomBgSeed());
}
