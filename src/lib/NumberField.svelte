<script lang="ts">
  // A numeric field that accepts math expressions (Feature 8) and whose LABEL can
  // be dragged to scrub the value; the mouse WHEEL over the field steps it too
  // (2026-09-15: the same speed-scaled wheel law as the property menu — one
  // notch = one step, a flick moves further; Shift ×10, Alt ×0.1). Emits
  // `commit` for a discrete typed edit (wrap it in commit() for one undo entry)
  // and `scrub` for each live drag/wheel step (wrap in mutate(); this control
  // owns the history entry). Mirrors the Inspector's field markup/styling so it
  // drops in beside the existing fields.
  import { createEventDispatcher, onDestroy } from "svelte";
  import { activeFigureId, selection, partSelections, embeddedProjectRoot } from "./store";
  import { storeTenant } from "./tenancy";
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
  // Opt-in nullable/live editing (axis limits); existing numeric fields retain
  // their commit-on-change contract.
  export let placeholder = "";
  export let optional = false;
  export let empty = false;
  export let live = false;
  let focused = false;
  let draft = "";
  let cancelled = false;
  const session = editSession();
  let scrubBaseline = value;

  const dispatch = createEventDispatcher<{ commit: number; scrub: number; scrubStart: void; preview: number | undefined }>();
  let inputEl: HTMLInputElement;

  // Axis/data values may be much smaller than a layout pixel. Preserve their
  // significant digits in the opt-in live mode instead of rounding to zero.
  const format = (v: number) => live && Number.isFinite(v) ? String(+v.toPrecision(12)) : fmtNum(v);
  const round = (v: number) => Number(format(v));
  $: display = format(value);

  function clamp(v: number): number {
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    return v;
  }

  function preview() {
    draft = inputEl.value;
    if (!live) return;
    if (optional && !draft.trim()) { session.run(() => dispatch("preview", undefined)); return; }
    const parsed = evalExpr(draft);
    if (parsed !== null) session.run(() => dispatch("preview", clamp(parsed)));
  }
  function blur() {
    if (live) { session.finish(); focused = false; draft = ""; }
    cancelled = false;
  }
  function onChange() {
    if (live || cancelled) return;
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
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = null; wheel.reset(); session.cancel();
      cancelled = true;
      inputEl.value = empty ? "" : display;
      inputEl.blur();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const v = clamp(round(value + (e.key === "ArrowUp" ? 1 : -1) * step * mult));
      if (v !== value) { if (live) session.run(() => dispatch("preview", v)); else dispatch("commit", v); }
      if (live) draft = format(v);
    }
  }

  // Wheel stepping over the field (plain hover — mouse-only editing; the rail
  // scrolls when the pointer is not over a field). The ONE law in
  // interact/wheelLaw.ts: a notch is a step in every dialect, a spin moves
  // further, a flick doubles, Shift ×10, Alt ×0.1 — the same as the property menu.
  const wheel = new WheelStepper();
  let wheelTimer: ReturnType<typeof setTimeout> | null = null;
  onDestroy(() => {
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = null;
    wheel.reset();
    session.finish();
  });
  $: targetKey=JSON.stringify([storeTenant(),$embeddedProjectRoot,$activeFigureId,[...$selection],$partSelections]);
  let wheelOwner="";
  $: if (wheelOwner!==targetKey) {
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer=null;wheel.reset();session.finish();wheelOwner=targetKey;
  }
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
    const v = clamp(round(value + steps * step * mult));
    if (live && focused) draft = format(v);
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
      use:scrub={{ get: () => value, step, min, max, disabled, owner: targetKey, round: live ? round : undefined,
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
    placeholder={mixed ? "Mixed" : placeholder}
    value={live && focused ? draft : mixed || empty ? "" : display}
    on:focus={() => { focused = true; draft = inputEl.value; }}
    on:input={preview}
    on:blur={blur}
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
