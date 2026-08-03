<script lang="ts">
  // The caption editor (Alt+C): a manuscript-style "caption page" that appears
  // to the right of the active figure, in world space (it pans/zooms with the
  // canvas). One block per panel (derived from the figure's a/b/c… labels), each
  // directly editable. The connector brace draws itself in, then the page fades
  // in. While it's open the rest of the canvas is read-only (see keyboard.ts /
  // Canvas.svelte) — only pan/zoom and caption editing are allowed.
  //
  // SIZING CONTRACT (owner, 2026-08-03): a caption box NEVER scrolls — every
  // block grows to fit all of its text (use:autogrow), so opening the editor
  // shows every caption in full. Scrolling happens BETWEEN blocks instead: the
  // page is exactly as tall as the figure it belongs to (so it always pairs with
  // the brace) and its block column scrolls inside that. Canvas.svelte's onWheel
  // routes the wheel here when the cursor is over the column.
  import { project, viewport, activeFigureId, beginGesture, mutate } from "./store";
  import { captionBlocks } from "./captions";
  import { settings } from "./settings";
  import { autogrow } from "./ui/autogrow";
  import { drawOn } from "./motion/actions";
  import { prefersReducedMotion } from "./motion/motion";
  import { DUR } from "./motion/tokens";
  import { fade } from "svelte/transition";

  const GAP = 90; // world px between the figure and the caption page
  const PAD = 26; // page inner padding (world px)
  const BLOCK_GAP = 14; // world px between blocks
  // The page is exactly as tall as its figure, so it always pairs with the
  // brace. The floor only catches a degenerate stub figure, where matching the
  // height would leave a page too short to hold even one block — it is
  // deliberately below any real figure height so it never engages in practice.
  const PAGE_MIN_H = 200;

  const reduce = prefersReducedMotion();

  $: af = $project.figures.find((f) => f.id === $activeFigureId) ?? null;
  $: panels = af ? captionBlocks(af) : [];
  $: captions = af?.captions ?? {};
  $: fs = $settings.captionFontSize;

  $: pageX = af ? af.x + af.width + GAP : 0;
  $: figRight = af ? af.x + af.width : 0;
  $: pageH = af ? Math.max(af.height, PAGE_MIN_H) : 0;

  // Scroll affordances. A native scrollbar is unusable here — it would be scaled
  // by the canvas zoom (huge at 3×, invisible at 0.4×) — so it is hidden and
  // replaced by soft parchment fades at whichever edge has more content past it.
  let colEl: HTMLDivElement | null = null;
  let fadeTop = false;
  let fadeBottom = false;

  function syncFades() {
    if (!colEl) return;
    const max = colEl.scrollHeight - colEl.clientHeight;
    fadeTop = colEl.scrollTop > 1;
    fadeBottom = max > 1 && colEl.scrollTop < max - 1;
  }

  function scheduleFadeSync() {
    if (colEl) queueMicrotask(syncFades); // after autogrow's batched flush
  }
  // The column's content height moves with the block set, the font size and the
  // page height, so re-measure after each — the leading names are the deps.
  $: panels, fs, pageH, colEl, scheduleFadeSync();

  // A caption that grows under the caret must not push it below the fold.
  // offsetParent is .cap-scroll (position: relative), so offsetTop is already in
  // the column's content coordinates — layout px throughout, no gBCR, which
  // would be scaled by the world transform.
  function onGrow(el: HTMLTextAreaElement) {
    if (colEl && document.activeElement === el) {
      const overshoot = el.offsetTop + el.offsetHeight - (colEl.scrollTop + colEl.clientHeight);
      if (overshoot > 0) colEl.scrollTop += overshoot;
    }
    syncFades();
  }

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
      style="left:{pageX}px; top:{af.y}px; width:{af.width}px; height:{pageH}px; --cap-fs:{fs}px;"
      in:fade={{ duration: reduce ? 0 : DUR.gentle, delay: reduce ? 0 : 230 }}
      out:fade={{ duration: reduce ? 0 : DUR.quick }}
    >
      <div
        class="cap-scroll"
        bind:this={colEl}
        style="padding:{PAD}px; gap:{BLOCK_GAP}px;"
        on:scroll={syncFades}
      >
        {#each panels as p (p.id)}
          <fieldset class="cap-block">
            {#if p.label}<legend>{p.label}</legend>{/if}
            <textarea
              class="cap-text"
              value={captions[p.id] ?? ""}
              placeholder="caption text…"
              spellcheck="false"
              rows="1"
              on:focus={() => beginGesture()}
              on:input={(e) => setCaption(p.id, e.currentTarget.value)}
              use:autogrow={{ value: captions[p.id] ?? "", fs, onFit: onGrow }}
            ></textarea>
          </fieldset>
        {/each}
      </div>
      <div class="cap-fade top" class:on={fadeTop}></div>
      <div class="cap-fade bottom" class:on={fadeBottom}></div>
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
    overflow: hidden;
    background: var(--cap-paper);
    border: 1.5px solid var(--c-accent);
    border-radius: 4px;
    box-shadow: var(--elev-3);
    font-family: var(--font-serif);
    /* the page's size is fixed, so nothing outside it depends on its layout */
    contain: layout;
  }
  .cap-scroll {
    position: relative; /* the offsetParent the grow-into-view math measures against */
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow-y: auto;
    overflow-x: hidden;
    /* the column is the hit target for the wheel (Canvas.svelte onWheel) and for
       clicks into the blocks — .cap-layer turns pointer events off wholesale */
    pointer-events: auto;
    scrollbar-width: none; /* replaced by the edge fades — see the script */
  }
  .cap-scroll::-webkit-scrollbar {
    display: none;
  }
  .cap-fade {
    position: absolute;
    left: 0;
    right: 0;
    height: 22px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .cap-fade.on {
    opacity: 1;
  }
  .cap-fade.top {
    top: 0;
    background: linear-gradient(to bottom, var(--cap-paper), transparent);
  }
  .cap-fade.bottom {
    bottom: 0;
    background: linear-gradient(to top, var(--cap-paper), transparent);
  }
  .cap-block {
    min-inline-size: 0;
    flex: 0 0 auto;
    margin: 0;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--cap-line);
    border-radius: 8px;
    padding: 4px 14px 10px;
  }
  .cap-block legend {
    padding: 0 8px;
    font-weight: 700;
    font-size: calc(var(--cap-fs, 13px) * 1.27);
    color: var(--cap-legend);
    font-family: var(--font-serif);
  }
  .cap-text {
    width: 100%;
    border: none;
    outline: none;
    background: transparent;
    resize: none;
    /* autogrow writes the height; it never scrolls (the page does) */
    overflow: hidden;
    min-height: 2.9em; /* two lines, so an empty block stays a target */
    color: var(--cap-ink);
    font-family: var(--font-serif);
    font-size: var(--cap-fs, 13px);
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
