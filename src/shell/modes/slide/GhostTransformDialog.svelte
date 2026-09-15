<script lang="ts">
  import { onMount, untrack } from "svelte";
  let { source, step, initialOriginal = "stay", onCreate, onClose }: {
    source: string; step: string; initialOriginal?: "stay" | "disappear" | "transform";
    onCreate: (count: number, original: "stay" | "disappear" | "transform") => void;
    onClose: () => void;
  } = $props();
  let count = $state(3);
  let original = $state(untrack(() => initialOriginal));
  let dialog: HTMLDialogElement;
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialog;
    modal.showModal();
    const countInput = modal.querySelector<HTMLInputElement>('input[type="number"]');
    countInput?.focus(); countInput?.select();
    return () => { modal.close(); previous?.focus({preventScroll:true}); };
  });
  function submit(e: SubmitEvent) { e.preventDefault(); if (Number.isInteger(count) && count >= 1 && count <= 32) onCreate(count, original); }
</script>

<div class="ghost-scrim">
  <dialog bind:this={dialog} aria-label="Ghost transform" onkeydown={e => { e.stopPropagation(); if (e.key === "Escape") {e.preventDefault();onClose();} }}>
    <form onsubmit={submit}>
      <h2>Ghost transform</h2>
      <p>Create copies of <strong>{source}</strong> in <strong>{step}</strong>. Each starts at the original’s state before this step, then moves to its own destination.</p>
      <label class="count">Copies <input aria-label="Ghost copies" type="number" min="1" max="32" step="1" required bind:value={count} /></label>
      <fieldset><legend>Original object</legend>
        {#each [["stay", "Stay", "Keep the original where it is."], ["disappear", "Disappear", "Remove the original as the copies leave."], ["transform", "Transform", "Give the original its own editable destination."]] as option}
          <label class="choice"><input type="radio" name="ghost-original" value={option[0]} bind:group={original}/><span><strong>{option[1]}</strong><small>{option[2]}</small></span></label>
        {/each}
      </fieldset>
      <p class="hint">After creating, move Ghost 1 on the canvas. Use the copy selector to edit the others. All copies have independent timing.</p>
      <footer><button type="button" onclick={onClose}>Cancel</button><button class="primary" type="submit">Create ghosts</button></footer>
    </form>
  </dialog>
</div>

<style>
  .ghost-scrim { position: fixed; inset: 0; z-index: 1100; }
  dialog {
    position: fixed; inset: 50% auto auto 50%; transform: translate(-50%, -50%); margin: 0;
    width: 400px; max-width: calc(100vw - 32px); padding: 0;
    background: var(--c-surface); color: var(--c-tx); border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel); box-shadow: var(--elev-2);
    font: 12px/1.35 var(--font-ui); -webkit-font-smoothing: antialiased;
  }
  dialog::backdrop { background: rgba(0, 0, 0, .35); }
  form { display: flex; flex-direction: column; }
  /* ONE compact header line, hairline below */
  h2 { display: flex; align-items: center; height: 30px; margin: 0; padding: 0 12px; font: 600 12px var(--font-ui); color: var(--c-tx); border-bottom: 1px solid var(--c-line); }
  p { margin: 0; padding: 10px 12px 0; line-height: 1.5; color: var(--c-tx-2); }
  strong { color: var(--c-tx); font-weight: 600; }
  .count { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; margin: 10px 12px 0; color: var(--c-tx-muted); }
  .count input { width: 64px; font: 12px var(--font-mono); font-variant-numeric: tabular-nums; }
  input, button {
    font: 12px var(--font-ui); color: var(--c-tx); background: var(--c-bg);
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); height: 24px; padding: 2px 6px;
  }
  input:focus { border-color: var(--c-accent); outline: none; }
  button:focus-visible, input:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 1px; }
  fieldset { border: 0; padding: 0; margin: 10px 12px 0; }
  legend { font: 600 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: .08em; color: var(--c-tx-muted); margin-bottom: 4px; padding: 0; }
  .choice { display: flex; gap: 8px; padding: 4px 0; align-items: flex-start; cursor: pointer; }
  .choice input { height: auto; margin: 2px 0 0; accent-color: var(--c-accent); }
  .choice small { display: block; color: var(--c-tx-muted); margin-top: 2px; font-size: 11px; }
  .hint { font-size: 11px; color: var(--c-tx-muted); padding-bottom: 10px; }
  footer { display: flex; justify-content: flex-end; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--c-line); }
  button { background: transparent; color: var(--c-tx-2); padding: 3px 10px; cursor: pointer; }
  button:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  /* Create ghosts is the dialog's one primary */
  .primary { background: var(--c-accent); color: var(--c-on-accent); border-color: var(--c-accent); font-weight: 600; }
  .primary:hover { background: var(--c-accent-bright); border-color: var(--c-accent-bright); color: var(--c-on-accent); }
</style>
