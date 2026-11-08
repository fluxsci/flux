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
  <header class="surface-head"><strong class="ttl">Connected agents</strong><span class="spacer"></span><button class="xbtn" aria-label="Close connected agents" on:click={close}></button></header>
  <div class="rows"><SessionRows onshow={close} /></div>
</div>

<style>
  .backdrop { position:fixed;inset:var(--titlebar-h) 0 0;background:transparent;border:0;z-index:179; }
  .agents-popover { position:fixed;top:calc(var(--titlebar-h) + 6px);right:16px;z-index:180;box-sizing:border-box;width:min(400px,calc(100vw - 32px));max-height:calc(100vh - var(--titlebar-h) - 24px);overflow:hidden;display:flex;flex-direction:column;color:var(--c-tx);background:var(--c-surface);border:1px solid var(--c-line-strong);border-radius:var(--r-1);box-shadow:var(--elev-2);font:var(--ts-sm) var(--font-ui);text-align:left;animation:flux-arrive var(--dur-fade) both; }
  .rows { overflow:auto;min-height:0;padding:4px 14px 10px; }
  button:focus-visible { outline:1px solid var(--c-accent); }
</style>
