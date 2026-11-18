<script lang="ts">
  // The Flux AI mark as a component: fluxAiMark.ts says what it is and why its look is global.
  import { FLUX_AI_LAYERS, FLUX_AI_MASK, FLUX_AI_SPARKS, type FluxAiTone } from "./fluxAiMark";
  let { size = 18, tone = "ready", still = false }: {
    size?: number;
    tone?: FluxAiTone;
    /** At rest, for a button's icon: the network in its colours, nothing moving. */
    still?: boolean;
  } = $props();
  const sparkAt = (name: string) => FLUX_AI_SPARKS[name.endsWith("s2") ? 1 : 0];
</script>

<span class="flux-ai-mark" class:still data-tone={tone} aria-hidden="true" style:--fam-size={`${size}px`} style:--fam-mask={FLUX_AI_MASK}>
  <span class="fam-net">
    {#each FLUX_AI_LAYERS as name (name)}
      {#if name.startsWith("fam-spark")}<i class={name} style:left={sparkAt(name).left} style:top={sparkAt(name).top}></i>{:else}<i class={name}></i>{/if}
    {/each}
  </span>
</span>
