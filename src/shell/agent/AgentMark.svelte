<script lang="ts" module>
  // The agent's mark: a 13-dot seed cropped from the Flux phyllotaxis bloom
  // (Logomark.svelte), so the full accent wheel stays inside the one brand
  // object and the rest of the chrome keeps its single blue. It marks every
  // agent utterance and run; you (the human) are unmarked. While an agent
  // works the seed turns; when it finishes it blooms once; on error the
  // centre turns red. Seeded by the agent's name so heron and wren sit in
  // different poses without any per-agent colour coding.
  import { logoDots } from "../Logomark.svelte";
  const SEED = logoDots().slice(0, 13);
  const hashPose = (seed: string): number => { let h = 0; for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 8) * 45; };
</script>

<script lang="ts">
  let { size = 14, state = "idle", seed = "", class: klass = "" }: { size?: number; state?: "idle" | "working" | "done" | "error"; seed?: string; class?: string } = $props();
  const pose = $derived(hashPose(seed));
</script>

<!-- The turn runs on literal durations and is deliberately NOT gated on
     prefers-reduced-motion (the Logomark precedent: this desktop reports
     `reduce` via GTK with animations on). It runs ONLY while state is
     "working" — the class comes off the instant the run is idle, so nothing
     loops at rest (the E43 lesson). -->
<svg class={`agent-mark ${klass}`} data-state={state} width={size} height={size} viewBox="34 34 32 32" style={`--pose:${pose}deg`} aria-hidden="true">
  <g class="seed">
    {#each SEED as d, i (i)}<circle cx={d.x} cy={d.y} r={d.r * 1.15} fill={d.fill} class:centre={i === 0} />{/each}
  </g>
</svg>

<style>
  .agent-mark { display: inline-block; vertical-align: middle; overflow: visible; flex-shrink: 0; }
  .seed { transform-box: view-box; transform-origin: 50px 50px; transform: rotate(var(--pose)); }
  .agent-mark[data-state="working"] .seed { animation: seed-turn 2.4s linear infinite; }
  .agent-mark[data-state="working"] .centre { animation: seed-breathe 1.6s ease-in-out infinite; }
  .agent-mark[data-state="done"] .seed { animation: seed-bloom 220ms cubic-bezier(0.16, 1, 0.3, 1) both; }
  .agent-mark[data-state="error"] .centre { fill: var(--c-danger); }
  .agent-mark[data-state="idle"] { opacity: .85; }
  @keyframes seed-turn { from { transform: rotate(var(--pose)); } to { transform: rotate(calc(var(--pose) + 360deg)); } }
  @keyframes seed-breathe { 50% { opacity: .35; } }
  @keyframes seed-bloom { from { transform: rotate(var(--pose)) scale(0.8); } to { transform: rotate(var(--pose)) scale(1); } }
</style>
