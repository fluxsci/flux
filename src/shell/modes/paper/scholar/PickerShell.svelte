<script lang="ts">
  // The frame of a picker that opens over the manuscript (`@@`, `/figure`): a wash over the page
  // and, on it, the margin card's own chrome (MarginPaneFrame) in the Figures card's ink, so
  // choosing a figure here looks and answers like the Figures card beside it (owner, 2026-11-18:
  // "feel much more similar to the new one you made in the right sidebar"). `.mk-host` brings the
  // margin kit to everything inside.
  import type { Snippet } from "svelte";
  import { fadeRise } from "../../../../lib/motion/actions";
  import MarginPaneFrame from "../margin/MarginPaneFrame.svelte";
  import "../margin/marginKit.css";

  let { title, color = "var(--flx-cyan-600)", onClose, children }: {
    title: string;
    /** The card's ink (a `--flx-*-600` token); the Figures card's by default. */
    color?: string;
    onClose: () => void;
    children: Snippet;
  } = $props();
  const desc = $derived({ id: "figure-picker", title, color });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="scrim mk-host" onclick={onClose} transition:fadeRise={{ y: 0 }}>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="picker" role="dialog" aria-label={title} tabindex="-1" onclick={(e) => e.stopPropagation()}>
    <MarginPaneFrame {desc} active {onClose} closeHint="Close (Esc)">
      {@render children()}
    </MarginPaneFrame>
  </div>
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--c-bg) 62%, transparent);
    backdrop-filter: blur(2px);
  }
  .picker {
    display: flex;
    flex-direction: column;
    width: min(620px, 88%);
    max-height: 82%;
    /* a deeper shadow than a margin card's: this one floats over the page */
    filter: drop-shadow(0 18px 34px rgba(74, 56, 16, 0.22));
  }
  /* In the margin a card takes an equal share of the column; here it is as tall as what is in it,
     up to the picker's limit, and its body scrolls beyond that. */
  .picker :global(.pane) {
    flex: 0 1 auto;
    min-height: 0;
  }
  /* The card's body hands its height limit on to what is inside, which decides what scrolls. */
  .picker :global(.pane > .body) {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
