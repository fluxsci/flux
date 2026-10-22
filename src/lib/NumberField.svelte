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
  import { numericStep } from "./interact/numericStep";
  import { scrub } from "./scrub";
  import { editSession } from "./interact/editSession";
  import { WheelStepper, wheelDelta, wheelMultiplier } from "./interact/wheelLaw";

  export let value: number;
  export let label = "";
  export let step = 1;
  /** Optional ratio per step (zoom uses 1.1). */
  export let factor: number | undefined = undefined;
  export let min: number | null = null;
  export let max: number | null = null;
  export let title = "";
  export let history = true;
  export let mixed = false;
  export let mixedLabel = "Mixed";
  export let disabled = false;
  // Opt-in nullable/live editing (axis limits); existing numeric fields retain
  // their commit-on-change contract.
  export let placeholder = "";
  export let optional = false;
  export let empty = false;
  export let live = false;
  /** Opt-in keyboard flow (the property menu's armed axis view): Space accepts
   *  the value and emits `advance`; Enter accepts it and emits `done`. */
  export let advanceOnSpace = false;
  /** A surrounding tool may own all history and inner-edit cancellation. */
  export let externalOwner: {
    begin: () => void;
    owns?: () => boolean;
    preview: (value: number | undefined) => void;
    accept: () => void;
    cancel: () => void;
    validity?: (valid: boolean) => void;
  } | null = null;
  let externalActive = false;
  let invalid = false;
  function beginExternal() {
    if (!externalOwner || (externalActive && (externalOwner.owns?.() ?? true))) return;
    externalActive = true;
    externalOwner.begin();
  }
  function externalValue(v: number | undefined) {
    beginExternal();
    invalid = false;
    externalOwner?.validity?.(true);
    externalOwner?.preview(v);
  }
  function endExternal(cancel = false) {
    if (!externalActive) return;
    externalActive = false;
    if (externalOwner?.owns && !externalOwner.owns()) return;
    if (cancel || invalid) externalOwner?.cancel(); else externalOwner?.accept();
  }
  function parsedExternal(): number | undefined | null {
    if (optional && !inputEl.value.trim()) return undefined;
    const v = evalExpr(inputEl.value);
    return v === null || !Number.isFinite(v) || (min !== null && v < min) || (max !== null && v > max) ? null : v;
  }
  let focused = false;
  let draft = "";
  let cancelled = false;
  const session = editSession();
  let scrubBaseline = value;

  const dispatch = createEventDispatcher<{ commit: number; scrub: number; scrubStart: void; preview: number | undefined; advance: void; done: void }>();
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
    if (externalOwner) {
      // A different field may have taken the shared transaction while this
      // input kept focus (for example, hover-wheel over the other grid gap).
      beginExternal();
      const v = parsedExternal();
      invalid = v === null;
      externalOwner.validity?.(!invalid);
      if (v !== null) externalValue(v);
      return;
    }
    if (!live) return;
    if (optional && !draft.trim()) { session.run(() => dispatch("preview", undefined)); return; }
    const parsed = evalExpr(draft);
    if (parsed !== null) session.run(() => dispatch("preview", clamp(parsed)));
  }
  function blur() {
    if (externalOwner) { endExternal(); focused = false; cancelled = false; return; }
    if (live) { session.finish(); focused = false; draft = ""; }
    cancelled = false;
  }
  function onChange() {
    if (externalOwner || live || cancelled) return;
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
    if (externalOwner) {
      // Local edit keys and native text Undo/Redo stay in the field; shell
      // chords such as Save and rail toggles keep ordinary input routing.
      if (["Enter", "Escape", "ArrowUp", "ArrowDown"].includes(e.key) ||
          ((e.ctrlKey || e.metaKey) && ["z", "y"].includes(e.key.toLowerCase()))) e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        preview();
        if (!invalid) { endExternal(); inputEl.blur(); }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = null; wheel.reset();
        const owned = externalOwner.owns?.() ?? true;
        endExternal(true); invalid = false; if (owned) externalOwner.validity?.(true);
        draft = format(value); inputEl.value = draft; inputEl.blur();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const parsed = parsedExternal();
        if (parsed === null) return;
        const v = clamp(round(numericStep(parsed ?? value, (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : e.altKey ? .1 : 1), step, factor)));
        draft = format(v); inputEl.value = draft; externalValue(v);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      inputEl.blur(); // triggers change
      if (advanceOnSpace) { e.stopPropagation(); dispatch("done"); }
    } else if (e.key === " " && advanceOnSpace) {
      e.preventDefault();
      e.stopPropagation();
      inputEl.blur(); // accepts (live edits are already applied; blur closes their undo entry)
      dispatch("advance");
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
      const v = clamp(round(numericStep(value, (e.key === "ArrowUp" ? 1 : -1) * mult, step, factor)));
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
    endExternal(true);
    session.finish();
  });
  $: targetKey=JSON.stringify([storeTenant(),$embeddedProjectRoot,$activeFigureId,[...$selection],$partSelections]);
  let wheelOwner="";
  $: if (wheelOwner!==targetKey) {
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer=null;wheel.reset();endExternal(true);session.finish();wheelOwner=targetKey;
  }
  function onWheel(e: WheelEvent) {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    wheelBy(e);
  }
  /** Step by one wheel event wherever it happened (the armed axis view forwards
   *  the wheel from anywhere on screen to its focused limit). */
  export function wheelBy(e: WheelEvent) {
    if (disabled || (externalOwner && focused && invalid)) return;
    const steps = wheel.steps({ deltaY: wheelDelta(e), deltaMode: e.deltaMode, time: performance.now() });
    if (!steps) return;
    const mult = wheelMultiplier(e);
    if (!wheelTimer) {
      scrubBaseline = value;
      dispatch("scrubStart");
    }
    const v = clamp(round(numericStep(value, steps * mult, step, factor)));
    if (live && focused) draft = format(v);
    if (v !== value) externalOwner ? externalValue(v) : (history ? session.run(() => dispatch("scrub", v)) : dispatch("scrub", v));
    // The gesture ends when the wheel rests: one undo entry per roll.
    if (wheelTimer) clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      wheelTimer = null;
      wheel.reset();
      if (externalOwner) { if (!focused) endExternal(); } else session.finish();
    }, 220);
  }
</script>

<label class="nf" {title}>
  {#if label}
    <span
      class="lb"
      use:scrub={{ get: () => value, step, factor, min, max, disabled, owner: targetKey, round: live ? round : undefined,
        onStart: () => { scrubBaseline = value; if (externalOwner) { if (wheelTimer) clearTimeout(wheelTimer); wheelTimer = null; wheel.reset(); endExternal(); beginExternal(); } else dispatch('scrubStart'); },
        onStep: (v) => externalOwner ? externalValue(v) : history ? session.run(() => dispatch("scrub", v)) : dispatch("scrub", v),
        onEnd: () => externalOwner ? endExternal() : session.finish(),
        onCancel: () => { if (externalOwner) endExternal(true); else if (history) session.cancel(); else dispatch("scrub", scrubBaseline); }
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
    placeholder={mixed ? mixedLabel : placeholder}
    aria-invalid={invalid || undefined}
    value={(live || externalOwner) && (focused || invalid) ? draft : mixed || empty ? "" : display}
    on:focus={() => { focused = true; draft = inputEl.value; if (externalOwner) beginExternal(); }}
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
  input[aria-invalid="true"] { border-color: var(--c-danger, #d14d41); }
  input:disabled { opacity: 0.5; }
</style>
