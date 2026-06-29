<script lang="ts">
  import PaperMode from "./modes/paper/PaperMode.svelte";
  import FigureMode from "./modes/figure/FigureMode.svelte";
  import ModePlaceholder from "./ModePlaceholder.svelte";
  import { fadeRise } from "../lib/motion/actions";
  import { DUR } from "../lib/motion/tokens";
  import type { ModeId } from "./shellStore";

  let { mode, focused = false }: { mode: ModeId; focused?: boolean } = $props();

  const META: Record<
    ModeId,
    { icon: string; title: string; tagline: string; note?: string }
  > = {
    figure: {
      icon: "figure",
      title: "Figure",
      tagline: "Assemble plots and elements into publication-ready, multi-panel figures.",
    },
    paper: {
      icon: "paper",
      title: "Paper",
      tagline: "Draft the manuscript with live figure and citation references, over Quarto.",
    },
    slide: {
      icon: "slide",
      title: "Slide",
      tagline: "Turn figures into elegantly animated talks — PowerPoint meets 3blue1brown.",
    },
  };
</script>

{#key mode}
  <div class="mc" in:fadeRise={{ duration: DUR.gentle, y: 10 }}>
    {#if mode === "paper"}
      <PaperMode {focused} />
    {:else if mode === "figure"}
      <FigureMode {focused} />
    {:else}
      <ModePlaceholder {...META[mode]} />
    {/if}
  </div>
{/key}

<style>
  .mc {
    position: absolute;
    inset: 0;
  }
</style>
