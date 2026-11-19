<script lang="ts">
  // The Flux AI mark as a component. fluxAiMark.ts says what it is; app.css gives it its
  // CSS-only life (it turns, two fronts drift); fluxAiMarkEngine.ts, loaded only when a LIVE
  // mark is on screen, makes its points fire and lets it report what agents are doing.
  import { untrack } from "svelte";
  import { FLUX_AI_LAYERS, fluxAiMarkStyle, onFluxAiSignal, type FluxAiTone } from "./fluxAiMark";
  import type { FluxAiMarkController, FluxAiMarkState } from "./fluxAiMarkEngine";

  let { size = 18, tone = "ready", still = false, agent = undefined, agents = undefined, waiting = false, activity = null, class: klass = "", status = undefined }: {
    size?: number;
    tone?: FluxAiTone;
    /** At rest (a button's icon, a row in a list): the network in its colours, nothing moving. */
    still?: boolean;
    /** Draw it in this agent's own colouring and pose (an agent's avatar). */
    agent?: string;
    /** The agents at work: each holds one point, lit in its own colour. */
    agents?: readonly string[];
    /** An agent is waiting for the user: the gold heartbeat. */
    waiting?: boolean;
    /** What kind of work is happening, when it is known. */
    activity?: FluxAiMarkState["activity"];
    class?: string;
    /** Passed through as data-state (AgentMark's vocabulary). */
    status?: string;
  } = $props();

  let root = $state<HTMLSpanElement | undefined>(undefined);
  let engine = $state.raw<FluxAiMarkController | null>(null);
  const look = $derived(fluxAiMarkStyle({ size, tone, still, agent }));
  const layers = $derived(still ? FLUX_AI_LAYERS.slice(0, 1) : FLUX_AI_LAYERS);
  const report = (): FluxAiMarkState => ({ tone, agents, waiting, activity });

  // Life is attached after the mark is on screen, and taken away with it.
  $effect(() => {
    const el = root;
    if (still || !el) return;
    let gone = false, made: FluxAiMarkController | null = null, off = () => {};
    void import("./fluxAiMarkEngine").then(({ attachFluxAiMark }) => {
      if (gone) return;
      made = attachFluxAiMark(el, untrack(() => size), untrack(report), untrack(() => agent));
      off = onFluxAiSignal((kind) => made?.signal(kind));
      engine = made;
    });
    return () => { gone = true; off(); made?.destroy(); engine = null; };
  });
  $effect(() => { const next = report(); engine?.set(next); });
</script>

<span
  class={`flux-ai-mark ${klass}`}
  class:still
  data-tone={tone}
  data-state={status}
  aria-hidden="true"
  bind:this={root}
  style:--fam-size={look["--fam-size"]}
  style:--fam-mask={look["--fam-mask"]}
  style:--fam-base={look["--fam-base"]}
  style:--fam-flow-1={look["--fam-flow-1"]}
  style:--fam-flow-2={look["--fam-flow-2"]}
  style:--fam-pose={look["--fam-pose"]}
  style:--fam-turn={look["--fam-turn"]}>
  <span class="fam-net">{#each layers as name (name)}<i class={name}></i>{/each}</span>
</span>
