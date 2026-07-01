<script lang="ts">
  // W15 (SHL-4): modes load on demand from the registry instead of being
  // statically imported into the entry chunk. A warmed/visited mode is in the
  // sync cache → renders with no flash; a cold mode shows a quiet empty pane for
  // the frame or two its chunk takes to arrive, then swaps in.
  import { loadMode, cachedMode } from "./modeRegistry";
  import { pushToast, errMsg } from "../lib/toast";
  import { fadeRise } from "../lib/motion/actions";
  import { DUR } from "../lib/motion/tokens";
  import type { ModeId } from "./shellStore";

  let { mode, focused = false }: { mode: ModeId; focused?: boolean } = $props();

  // Bumped when a chunk finishes loading, to re-derive Comp from the cache.
  let loadTick = $state(0);
  const Comp = $derived.by(() => {
    void loadTick; // reactive dep: recompute once the pending chunk resolves
    return cachedMode(mode) ?? null;
  });

  $effect(() => {
    const m = mode;
    if (cachedMode(m)) return; // already resolved — $derived has it
    let alive = true;
    loadMode(m)
      .then(() => {
        if (alive) loadTick++;
      })
      .catch((e) => {
        if (alive) pushToast("error", `Couldn't open ${m} mode`, { detail: errMsg(e) });
      });
    return () => {
      alive = false;
    };
  });
</script>

{#key mode}
  <div class="mc" in:fadeRise={{ duration: DUR.gentle, y: 10 }}>
    {#if Comp}
      <Comp {focused} />
    {/if}
  </div>
{/key}

<style>
  .mc {
    position: absolute;
    inset: 0;
  }
</style>
