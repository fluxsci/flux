<script lang="ts">
  import PaperMode from "./modes/paper/PaperMode.svelte";
  import FigureMode from "./modes/figure/FigureMode.svelte";
  import LibraryMode from "./modes/library/LibraryMode.svelte";
  import SlideMode from "./modes/slide/SlideMode.svelte";
  import ReaderMode from "./modes/reader/ReaderMode.svelte";
  import { fadeRise } from "../lib/motion/actions";
  import { DUR } from "../lib/motion/tokens";
  import type { ModeId } from "./shellStore";

  let { mode, focused = false }: { mode: ModeId; focused?: boolean } = $props();
</script>

{#key mode}
  <div class="mc" in:fadeRise={{ duration: DUR.gentle, y: 10 }}>
    {#if mode === "paper"}
      <PaperMode {focused} />
    {:else if mode === "figure"}
      <FigureMode {focused} />
    {:else if mode === "library"}
      <LibraryMode {focused} />
    {:else if mode === "slide"}
      <SlideMode {focused} />
    {:else if mode === "reader"}
      <ReaderMode {focused} />
    {/if}
  </div>
{/key}

<style>
  .mc {
    position: absolute;
    inset: 0;
  }
</style>
