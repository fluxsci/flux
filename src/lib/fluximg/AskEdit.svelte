<script lang="ts">
  /**
   * A value written in place on the asking surface: no box until the pointer (or the keyboard) is on it. Click it,
   * or focus it and type, and it takes the keys: Enter or Tab keeps the text (refused text stays, marked), Esc puts
   * the old value back, Backspace while not editing clears it. Numbers also roll with the arrows and the wheel
   * (`data-ask-wheel`, read by the surface). Never a native form control: the surface's keys stay the surface's.
   */
  let { value, placeholder = "set", kind = "number", tip, hk = "", id, mark = "", wide = false, onedit, onnudge = undefined }: {
    value: string;
    placeholder?: string;
    kind?: "number" | "text";
    /** What it is, for the surface's one hint line. */
    tip: string;
    hk?: string;
    /** `data-ask-edit`, for the keyboard and the gates. */
    id: string;
    /** Where the value came from ("file", "remembered"): a small word beside it. */
    mark?: string;
    wide?: boolean;
    /** Keep `text` (""= clear). Returns false when it is refused. */
    onedit: (text: string) => boolean;
    onnudge?: ((dir: 1 | -1, big: boolean) => void) | undefined;
  } = $props();

  let buf = $state<string | null>(null);
  let bad = $state(false);
  let el = $state<HTMLSpanElement>();
  const TYPED = $derived(kind === "text" ? /^[a-z0-9_ .\-]$/i : /^[0-9.,\-−eE*r]$/);

  /** Start editing (from a key or a click), with `initial` as the text. */
  export function begin(initial = value): void { buf = initial; bad = false; el?.focus(); }
  function commit(): void {
    if (buf === null) return;
    if (onedit(buf.trim()) === false) { bad = true; return; }
    buf = null; bad = false;
  }
  function key(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // chords stay Flux-wide; Alt is the surface's
    const take = (): void => { e.preventDefault(); e.stopPropagation(); };
    if (buf === null) {
      if (e.key === "Enter" || e.key === "F2") { take(); begin(value); return; }
      if (e.key.length === 1 && TYPED.test(e.key)) { take(); begin(e.key); return; }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && onnudge) { take(); onnudge(e.key === "ArrowUp" ? 1 : -1, e.shiftKey); return; }
      if (e.key === "Backspace" || e.key === "Delete") { take(); onedit(""); return; }
      return; // everything else is the surface's
    }
    if (e.key === "Tab") { commit(); if (buf !== null) take(); return; }
    take();
    if (e.key === "Escape") { buf = null; bad = false; return; }
    if (e.key === "Enter") { commit(); return; }
    if (e.key === "Backspace") { buf = buf.slice(0, -1); bad = false; return; }
    if (e.key.length === 1 && buf.length < 40) { buf += e.key; bad = false; }
  }
</script>

<span class="ed" class:editing={buf !== null} class:bad class:empty={!value} class:wide bind:this={el} tabindex="0" role="button" aria-label={tip}
  data-tip={tip} data-hk={hk || undefined} data-ask-edit={id} data-ask-wheel={onnudge ? id : undefined}
  onkeydown={key} onpointerdown={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); if (buf === null) begin(value); }} onblur={commit}
>{#if buf !== null}{buf}<span class="caret"></span>{:else}{value || placeholder}{/if}{#if mark && buf === null && value}<sup class="mark">{mark}</sup>{/if}</span>

<style>
  .ed { position: relative; display: inline-flex; align-items: baseline; min-width: 22px; height: 19px; padding: 0 4px; box-sizing: border-box; border-radius: 4px; border: 1px solid transparent;
    color: var(--fxb-tx-hi); font: 500 11.5px/17px var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; cursor: var(--cursor-cross-hover); outline: none;
    transition: border-color 80ms linear, background-color 80ms linear; }
  .ed.wide { min-width: 56px; }
  .ed.empty { color: var(--fxb-tx-dim); font-style: italic; font-weight: 400; }
  .ed:hover, .ed:focus-visible { border-color: color-mix(in oklab, var(--fxb-pink) 55%, transparent); background: color-mix(in oklab, var(--fxb-pink) 8%, transparent); }
  .ed.editing { border-color: var(--fxb-pink); background: var(--fxb-well); color: var(--fxb-tx-hi); font-style: normal; }
  .ed.bad { border-color: var(--c-danger); }
  /* A still caret: nothing on the surface moves at rest. */
  .caret { display: inline-block; width: 1.5px; height: 12px; margin-left: 1px; align-self: center; background: var(--fxb-pink); }
  .mark { margin-left: 3px; font: 600 8px var(--font-mono); letter-spacing: 0.02em; color: var(--fxb-pink-hi); opacity: 0.8; text-transform: lowercase; }
</style>
