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
  .ghost-scrim{position:fixed;inset:0;z-index:1100}
  dialog{position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);margin:0;width:420px;max-width:calc(100vw - 32px);padding:22px;background:var(--c-bg);color:var(--c-tx);border:1px solid var(--c-line-strong);border-radius:12px;box-shadow:0 16px 64px #0006;font:13px var(--font-serif)}
  dialog::backdrop{background:#0006}
  h2{font-size:18px;margin:0 0 12px}p{line-height:1.5;color:var(--c-tx-2);margin:0 0 16px}strong{color:var(--c-tx)}
  .count{display:flex;align-items:center;gap:12px;margin-bottom:18px;font-weight:600}.count input{width:70px;padding:7px}
  input,button{font:inherit;color:var(--c-tx);background:var(--c-bg-2);border:1px solid var(--c-line-strong);border-radius:5px}input:focus-visible,button:focus-visible{outline:2px solid var(--c-accent);outline-offset:2px}
  fieldset{border:0;padding:0;margin:0 0 16px}legend{font-weight:600;margin-bottom:8px}.choice{display:flex;gap:9px;padding:8px 0;align-items:flex-start}.choice input{margin-top:3px}.choice small{display:block;color:var(--c-tx-2);margin-top:3px;font-size:12px}
  .hint{font-size:12px;margin-bottom:18px}footer{display:flex;justify-content:flex-end;gap:8px}button{padding:7px 12px;cursor:pointer}.primary{background:var(--c-accent);color:var(--c-bg);border-color:var(--c-accent);font-weight:600}
</style>
