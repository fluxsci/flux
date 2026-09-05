<script lang="ts">
  import { tick } from "svelte";
  import { figureDeletion, cancelFigureDeletion, confirmFigureDeletion } from "./project/figureDeletion";
  let dialog = $state<HTMLDivElement>();
  let cancel = $state<HTMLButtonElement>();
  const focus = { open: false, prior: null as HTMLElement | null };
  $effect(() => {
    if ($figureDeletion && !focus.open) {
      focus.open = true;
      focus.prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      void tick().then(() => { if (focus.open) cancel?.focus(); });
    } else if (!$figureDeletion && focus.open) {
      focus.open = false;
      const prior = focus.prior; focus.prior = null;
      void tick().then(() => { if (prior?.isConnected) prior.focus(); });
    }
  });
  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); cancelFigureDeletion(); }
    else if (e.key === "Tab") {
      const buttons = [...(dialog?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const first = buttons[0], last = buttons.at(-1);
      if (e.shiftKey && (document.activeElement === first || !buttons.includes(document.activeElement as HTMLButtonElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  }
</script>
{#if $figureDeletion}
  <div class="scrim">
    <div bind:this={dialog} role="dialog" aria-modal="true" aria-label="Delete figures" tabindex="-1" onkeydown={onKey}>
      <h2>{$figureDeletion.checking ? "Checking figure uses…" : `Delete ${$figureDeletion.kind}?`}</h2>
      <p>{$figureDeletion.names.join(", ")}</p>
      {#if $figureDeletion.usages.length}
        <p>These documents use the selected figures:</p>
        <ul>{#each $figureDeletion.usages as use}<li>{use.kind === "slide" ? "Slide" : "Paper"} · {use.label}</li>{/each}</ul>
        <p>Paper references will become unresolved. Slide copies retain their source assets. You can undo this deletion.</p>
      {/if}
      {#if $figureDeletion.diagnostic}<p role="alert">{$figureDeletion.diagnostic}</p>{/if}
      <footer><button bind:this={cancel} onclick={cancelFigureDeletion}>Cancel</button><button class="delete" disabled={$figureDeletion.checking} onclick={confirmFigureDeletion}>Delete {$figureDeletion.kind}</button></footer>
    </div>
  </div>
{/if}
<style>
  .scrim { position: fixed; inset: 0; z-index: 110; background: #0005; display: grid; place-items: center; }
  [role="dialog"] { width: min(470px, calc(100% - 40px)); background: var(--c-surface); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: 10px; padding: 24px; font-size: 12px; box-shadow: var(--elev-3); }
  h2 { font-size: 17px; margin: 0 0 16px; } p, li { line-height: 1.6; } ul { max-height: 220px; overflow: auto; padding-left: 18px; }
  footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 22px; }
  button { font: inherit; color: var(--c-tx); background: var(--c-bg); border: 1px solid var(--c-line-strong); padding: 7px 12px; border-radius: 5px; cursor: pointer; } .delete { color: var(--c-danger); } button:disabled { opacity: .4; }
</style>
