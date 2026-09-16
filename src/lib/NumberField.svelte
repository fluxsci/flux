<script lang="ts">
  // A numeric field that accepts math expressions (Feature 8) and whose LABEL can
  // be dragged to scrub the value; the mouse WHEEL over the field steps it too
  // (2026-09-15: the same speed-scaled wheel law as the property menu — one
  // notch = one step, a flick moves further; Shift ×10, Alt ×0.1). Emits
  // `commit` for a discrete typed edit (wrap it in commit() for one undo entry)
  // and `scrub` for each live drag/wheel step (wrap in mutate(); this control
  // owns the history entry). Mirrors the Inspector's field markup/styling so it
  // drops in beside the existing fields.
  import { createEventDispatcher } from "svelte";
  import { evalExpr, fmtNum } from "./num";
  import { scrub } from "./scrub";
  import { editSession } from "./interact/editSession";
  import { WheelStepper, wheelDelta, wheelMultiplier } from "./interact/wheelLaw";

  export let value: number;
  export let label = "";
  export let step = 1;
  export let min: number | null = null;
  export let max: number | null = null;
  export let title = "";
  export let history = true;
  export let mixed = false;
  export let disabled = false;
  const session = editSession();
  let scrubBaseline = value;

  const dispatch = createEventDispatcher<{ commit: number; scrub: number; scrubStart: void }>();
  let inputEl: HTMLInputElement;

  $: display = fmtNum(value);

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
    if (mixed || v !== value) dispatch("commit", v);
    inputEl.value = fmtNum(v);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      inputEl.blur(); // triggers change
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      inputEl.value = display;
      inputEl.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const v = clamp(+(value + (e.key === "ArrowUp" ? 1 : -1) * step * mult).toFixed(6));
      if (v !== value) dispatch("commit", v);
    }
  }

  // Wheel stepping over the field (plain hover — mouse-only editing; the rail
  // scrolls when the pointer is not over a field). The ONE law in
  // interact/wheelLaw.ts: a notch is a step in every dialect, a spin moves
  // further, a flick doubles, Shift ×10, Alt ×0.1 — the same as the property menu.
  const wheel = new WheelStepper();
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  function onWheel(e: WheelEvent) {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const steps = wheel.steps({ deltaY: wheelDelta(e), deltaMode: e.deltaMode, time: performance.now() });
    if (!steps) return;
    const mult = wheelMultiplier(e);
    if (!wheelTimer) {
      scrubBaseline = value;
      dispatch("scrubStart");
    }
    const v = clamp(+(value + steps * step * mult).toFixed(6));
    if (v !== value) (history ? session.run(() => dispatch("scrub", v)) : dispatch("scrub", v));
    // The gesture ends when the wheel rests: one undo entry per roll.
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      wheel.reset();
      session.finish();
    }, 220);
  }
</script>

<label class="nf" {title}>
  {#if label}
    <span
      class="lb"
      use:scrub={{ get: () => value, step, min, max, disabled,
        onStart: () => { scrubBaseline = value; dispatch('scrubStart'); },
        onStep: (v) => history ? session.run(() => dispatch("scrub", v)) : dispatch("scrub", v),
        onEnd: session.finish,
        onCancel: () => { if (history) session.cancel(); else dispatch("scrub", scrubBaseline); }
      }}
      >{label}</span
    >
  {/if}
  <input
    bind:this={inputEl}
    type="text"
    inputmode="decimal"
    spellcheck="false"
    {disabled}
    placeholder={mixed ? "Mixed" : ""}
    value={mixed ? "" : display}
    on:change={onChange}
    on:keydown={onKey}
    on:wheel|nonpassive={onWheel}
    on:pointerdown|stopPropagation
  />
</label>

<style>
  .nf {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .lb {
    cursor: ew-resize;
    user-select: none;
    width: fit-content;
    font: 10.5px var(--font-ui);
    color: var(--c-tx-muted);
    letter-spacing: 0.02em;
  }
  .lb:hover {
    color: var(--c-tx-hi);
  }
  input {
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: var(--r-ui);
    padding: 0 6px;
    height: 24px;
    font: 12px var(--font-mono);
    font-variant-numeric: tabular-nums;
    width: 100%;
    box-sizing: border-box;
  }
  input:focus {
    border-color: var(--c-accent);
    outline: none;
  }
  input:disabled { opacity: 0.5; }
</style>
