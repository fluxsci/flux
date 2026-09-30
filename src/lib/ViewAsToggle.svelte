<script lang="ts">
  // "View as": simulate a colour-vision deficiency over the whole canvas (plan B3). A session
  // choice, never saved; the filter lives on the canvas root (Canvas.svelte reads the store).
  import { viewAs, CVD_KINDS, CVD_LABEL, cvdFilterDefsMarkup, type CvdKind } from "./color/cvd";
  const defs = cvdFilterDefsMarkup();
</script>

<span class="view-as" class:active={$viewAs !== "none"} title="See the canvas as a colour-deficient reader would (Machado 2009, full severity) or in greyscale. Nothing in the document changes.">
  <select aria-label="View as" data-view-as value={$viewAs} on:change={(e) => viewAs.set(e.currentTarget.value as CvdKind)}>
    {#each CVD_KINDS as k}<option value={k}>{k === "none" ? "View as…" : CVD_LABEL[k]}</option>{/each}
  </select>
  <!-- the filter definitions, once, zero-sized; referenced by url(#flux-view-as-<kind>) -->
  <svg class="cvd-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>{@html defs}</defs></svg>
</span>

<style>
  .view-as { display: inline-flex; align-items: center; }
  .view-as select { height: 22px; font: inherit; font-size: 11px; color: var(--tx-dim, inherit); background: transparent; border: 1px solid var(--line, #8884); border-radius: var(--r-ui, 4px); padding: 0 4px; max-width: 150px; }
  .view-as.active select { color: var(--accent, #4385be); border-color: var(--accent, #4385be); }
  .cvd-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
</style>
