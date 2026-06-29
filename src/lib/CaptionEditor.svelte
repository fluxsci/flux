<script lang="ts">
  // The caption editor (Alt+C): a manuscript-style "caption page" that appears
  // to the right of the active figure, in world space (it pans/zooms with the
  // canvas). One block per panel (derived from the figure's a/b/c… labels), each
  // directly editable. The connector brace draws itself in, then the page fades
  // in. While it's open the rest of the canvas is read-only (see keyboard.ts /
  // Canvas.svelte) — only pan/zoom and caption editing are allowed.
  import { project, viewport, activeFigureId, beginGesture, mutate } from "./store";
  import { captionBlocks } from "./captions";
  import { drawOn } from "./motion/actions";
  import { prefersReducedMotion } from "./motion/motion";
  import { DUR } from "./motion/tokens";
  import { fade } from "svelte/transition";

  const GAP = 90; // world px between the figure and the caption page
  const PAD = 34; // page inner padding (world px)
  const BLOCK_H = 150; // min block height (world px)

  const reduce = prefersReducedMotion();

  $: af = $project.figures.find((f) => f.id === $activeFigureId) ?? null;
  $: panels = af ? captionBlocks(af) : [];
  $: captions = af?.captions ?? {};

  $: pageX = af ? af.x + af.width + GAP : 0;
  $: figRight = af ? af.x + af.width : 0;

  // A vertical curly brace spanning the figure's height, in its own local box
  // [0..GAP] × [0..h], vertex pointing left toward the figure.
  $: braceD = (() => {
    const h = af ? af.height : 0;
    const Sx = GAP - 8,
      Tx = 10,
      Ty = 6,
      By = h - 6,
      My = h / 2;
    const c = Sx - (Sx - Tx) * 0.55;
    return (
      `M ${Sx} ${Ty} C ${c} ${Ty}, ${Tx} ${(Ty + My) / 2}, ${Tx} ${My} ` +
      `C ${Tx} ${(My + By) / 2}, ${c} ${By}, ${Sx} ${By}`
    );
  })();

  function setCaption(id: string, value: string) {
    if (!af) return;
    const figId = af.id;
    mutate((p) => {
      const f = p.figures.find((ff) => ff.id === figId);
      if (!f) return;
      if (!f.captions) f.captions = {};
      f.captions[id] = value;
    });
  }
</script>

{#if af}
  <div
    class="cap-layer"
    style="transform: translate({$viewport.panX}px, {$viewport.panY}px) scale({$viewport.zoom});"
  >
    <!-- brace connector, in the gap between figure and page -->
    <svg
      class="cap-brace"
      style="left:{figRight}px; top:{af.y}px; width:{GAP}px; height:{af.height}px;"
      viewBox="0 0 {GAP} {af.height}"
      fill="none"
    >
      <path d={braceD} use:drawOn={{ play: true, duration: reduce ? 0 : 460, smooth: true }} />
    </svg>

    <!-- the caption page -->
    <div
      class="cap-page"
      style="left:{pageX}px; top:{af.y}px; width:{af.width}px; min-height:{af.height}px; padding:{PAD}px; gap:{PAD * 0.62}px;"
      in:fade={{ duration: reduce ? 0 : DUR.gentle, delay: reduce ? 0 : 230 }}
      out:fade={{ duration: reduce ? 0 : DUR.quick }}
    >
      {#each panels as p (p.id)}
        <fieldset class="cap-block" style="min-height:{BLOCK_H}px;">
          {#if p.label}<legend>{p.label}</legend>{/if}
          <textarea
            class="cap-text"
            value={captions[p.id] ?? ""}
            placeholder="caption text…"
            spellcheck="false"
            on:focus={() => beginGesture()}
            on:input={(e) => setCaption(p.id, e.currentTarget.value)}
          ></textarea>
        </fieldset>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* The page is a deliberately light "manuscript" surface — it represents the
     printed caption, so it is NOT the dark editor chrome. Blue lines key off the
     UI accent; the warm paper + ink are local to this surface. */
  .cap-layer {
    --cap-paper: #fdfbf2;
    --cap-ink: #24303d;
    --cap-line: color-mix(in oklab, var(--c-accent) 42%, var(--cap-paper));
    --cap-legend: color-mix(in oklab, var(--c-accent) 72%, #06233f);
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
    pointer-events: none;
    z-index: 5;
  }
  .cap-brace {
    position: absolute;
    overflow: visible;
  }
  .cap-brace path {
    fill: none;
    stroke: var(--c-accent);
    stroke-width: 3;
    stroke-linecap: round;
  }
  .cap-page {
    position: absolute;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    background: var(--cap-paper);
    border: 1.5px solid var(--c-accent);
    border-radius: 4px;
    box-shadow: var(--elev-3);
    font-family: var(--font-serif);
  }
  .cap-block {
    min-inline-size: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--cap-line);
    border-radius: 8px;
    padding: 6px 16px 14px;
  }
  .cap-block legend {
    padding: 0 8px;
    font-weight: 700;
    font-size: 19px;
    color: var(--cap-legend);
    font-family: var(--font-serif);
  }
  .cap-text {
    flex: 1;
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    resize: none;
    color: var(--cap-ink);
    font-family: var(--font-serif);
    font-size: 15px;
    line-height: 1.45;
    padding: 0;
    pointer-events: auto;
    user-select: text;
  }
  .cap-text::placeholder {
    color: color-mix(in oklab, var(--cap-ink) 38%, transparent);
    font-style: italic;
  }
</style>
