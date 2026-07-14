<script lang="ts">
  // One filmstrip thumbnail: the slide's RESTING static state (fully built —
  // last beat), rendered from the LIVE stores through the one renderer
  // (player/render.ts renderStaticAt) at small scale.
  //
  // Invalidation is figureRev-KEYED (the store's scoped invalidation): a static
  // edit to slide A re-renders only A's thumbnail. The effect reads the project
  // through get() (non-reactive) so ordinary store notifies don't re-run every
  // thumb; overlay edits (beats/meta — rare) re-render via the overlay store.
  import { get } from "svelte/store";
  import { figureRev, globalRev } from "../../../lib/store";
  import { deckOverlay, composedSlide } from "../../../lib/slide/store";
  import { renderStaticAt } from "../../../lib/slide/player/player";
  import { getAssetData } from "../../../lib/assets";
  import { assetDisplaySize } from "../../../lib/ops";
  import { project } from "../../../lib/store";
  import { plotManifests, plotGen } from "../../../lib/plot/store";
  import { resolveTheme } from "../../../lib/slide/theme";
  import type { StageSize } from "../../../lib/slide/types";

  let { slideId, stage }: { slideId: string; stage: StageSize } = $props();

  let host = $state<HTMLDivElement | null>(null);
  let wrapW = $state(0);
  // Non-reactive memo boxes (the §9 trap: reassigning reactive state a render
  // effect also reads makes it self-dependent).
  const memo = { sig: "", renders: 0, timer: null as ReturnType<typeof setTimeout> | null };

  const rev = $derived($figureRev[slideId] ?? 0);
  const scale = $derived(wrapW > 0 ? wrapW / stage.width : 0.1);

  $effect(() => {
    // deps: this slide's scoped revision (the hot gesture-commit path — an
    // edit to slide A re-runs only A's effect), the global revision (unscoped
    // commits, e.g. inspector edits), the overlay (beats/theme/meta), and the
    // plot cache generation. The CONTENT SIGNATURE below then skips the actual
    // DOM re-render unless THIS slide changed — so a single edit never
    // re-renders N thumbnails (§7.3), while nothing can go stale.
    void rev;
    void $globalRev;
    void $plotGen;
    const overlay = $deckOverlay;
    const h = host;
    if (!h || !overlay) return;
    const slide = composedSlide(slideId);
    if (!slide) return;
    const sig = `${JSON.stringify(slide)}|${overlay.theme}|${overlay.background ?? ""}|${stage.width}x${stage.height}|${JSON.stringify($plotGen)}`;
    if (sig === memo.sig) return;
    memo.sig = sig;
    // Trailing debounce: a burst of commits (nudge auto-repeat, scrub) pays ONE
    // DOM rebuild after it settles — the thumbnail is not an instantaneous-
    // class surface, the canvas is. No continuous loop runs (E43).
    if (memo.timer) clearTimeout(memo.timer);
    memo.timer = setTimeout(() => {
      memo.timer = null;
      const cur = composedSlide(slideId);
      const ov = get(deckOverlay);
      if (!cur || !ov || !host) return;
      memo.renders++;
      host.dataset.renders = String(memo.renders); // gate probe: bounded re-renders
      try {
        renderStaticAt(host, cur, stage, Math.max(0, cur.beats.length - 1), {
          theme: resolveTheme(ov.theme),
          deckBackground: ov.background,
          assetUrl: (id) => getAssetData(id),
          assetSize: (id) => assetDisplaySize(get(project), id),
          plotManifest: (id) => get(plotManifests)[id],
          mode: "edit",
          reducedMotion: true,
        });
      } catch {
        /* a mid-edit render miss is repaired by the next invalidation */
      }
    }, 120);
    return () => {
      if (memo.timer) {
        clearTimeout(memo.timer);
        memo.timer = null;
        memo.sig = ""; // the skipped render must not swallow the next change
      }
    };
  });
</script>

<div class="thumb-wrap" bind:clientWidth={wrapW} style={`aspect-ratio: ${stage.width} / ${stage.height}`}>
  <div class="thumb-stage" bind:this={host}
    style={`width:${stage.width}px;height:${stage.height}px;transform:scale(${scale});transform-origin:0 0;`}></div>
</div>

<style>
  .thumb-wrap {
    position: relative;
    width: 100%;
    overflow: hidden;
    background: #000;
  }
  .thumb-stage {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
  }
</style>
