<script lang="ts">
  import { onMount } from "svelte";
  import { setShellPanel, isAnnotateChord, captureOpen } from "./annotationVisibility";
  import { modalFocus } from "../../lib/ui/modalFocus";
  import SessionRows from "./SessionRows.svelte";

  export let close: () => void;
  $: if ($captureOpen) close();
  function keys(e: KeyboardEvent) {
    if (isAnnotateChord(e)) return;
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }
  onMount(() => { setShellPanel("agents", true); return () => setShellPanel("agents", false); });
</script>

<button class="backdrop" aria-label="Close connected agents" on:click={close}></button>
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="agents-popover" role="dialog" aria-label="Connected agents" aria-modal="true" tabindex="-1" use:modalFocus on:keydown={keys} on:dblclick|stopPropagation>
  <header><strong>Connected agents</strong><button aria-label="Close connected agents" on:click={close}>×</button></header>
  <SessionRows onshow={close} />
</div>

<style>
  .backdrop { position:fixed;inset:var(--titlebar-h) 0 0;background:transparent;border:0;z-index:179; }
  .agents-popover { position:fixed;top:calc(var(--titlebar-h) + 6px);right:16px;z-index:180;box-sizing:border-box;width:min(400px,calc(100vw - 32px));max-height:calc(100vh - var(--titlebar-h) - 24px);overflow:auto;padding:12px 16px;color:var(--c-tx);background:var(--c-bg-raised);border:1px solid var(--c-line-strong);border-radius:var(--r-panel);box-shadow:var(--elev-2);font:12px var(--font-ui);text-align:left; }
  header { display:flex;justify-content:space-between;align-items:center; } header strong { font:600 15px var(--font-serif); }
  header button { border:0;background:transparent;color:inherit;padding:4px 8px;font:inherit;cursor:var(--cursor-cross-hover); } button:focus-visible { outline:1px solid var(--c-accent); }
</style>
