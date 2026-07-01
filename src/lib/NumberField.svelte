<script lang="ts">
  // A numeric field that accepts math expressions (Feature 8) and whose LABEL can
  // be dragged to scrub the value. Emits `commit` for a discrete typed edit (wrap
  // it in commit() for one undo entry) and `scrub` for each live drag step (wrap
  // in mutate(); the scrub action already opened one history entry). Mirrors the
  // Inspector's field markup/styling so it drops in beside the existing fields.
  import { createEventDispatcher } from "svelte";
  import { evalExpr, fmtNum } from "./num";
  import { scrub } from "./scrub";

  export let value: number;
  export let label = "";
  export let step = 1;
  export let min: number | null = null;
  export let max: number | null = null;
  export let title = "";

  const dispatch = createEventDispatcher<{ commit: number; scrub: number }>();
  let inputEl: HTMLInputElement;

  $: display = fmtNum(value, step);

  function clamp(v: number): number {
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return v;
  }

  function onChange() {
    const parsed = evalExpr(inputEl.value);
    if (parsed == null) {
      inputEl.value = display; // reject invalid → keep previous value
      return;
    }
    const v = clamp(parsed);
    dispatch("commit", v);
    inputEl.value = fmtNum(v, step);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      inputEl.blur(); // triggers change
    } else if (e.key === "Escape") {
      e.preventDefault();
      inputEl.value = display;
      inputEl.blur();
    }
  }
</script>

<label class="nf" {title}>
  {#if label}
    <span
      class="lb"
      use:scrub={{ get: () => value, step, min, max, onStep: (v) => dispatch("scrub", v) }}
      >{label}</span
    >
  {/if}
  <input
    bind:this={inputEl}
    type="text"
    inputmode="decimal"
    spellcheck="false"
    value={display}
    on:change={onChange}
    on:keydown={onKey}
    on:pointerdown|stopPropagation
  />
</label>

<style>
  .nf {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    opacity: 0.85;
    min-width: 0;
  }
  .lb {
    cursor: ew-resize;
    user-select: none;
    width: fit-content;
  }
  .lb:hover {
    color: var(--c-accent-bright);
  }
  input {
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    width: 100%;
    font-family: inherit;
  }
  input:focus {
    border-color: var(--c-accent);
    outline: none;
  }
</style>
