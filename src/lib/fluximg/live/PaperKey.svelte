<script lang="ts">
  /**
   * A paper key: the board's button. The face is Flux's paper with the magenta mark of the Crystallize offer, and it
   * is a key in the physical sense: it stands a little proud of the board and goes down when pressed. A key that is
   * ON (a mode in hand, an annotation that is shown) is lit: the face takes the ink and the mark takes the paper.
   *
   * It says what it is through the board's one label (`data-tip`, `data-hk`), never a browser tooltip.
   */
  import { GLYPHS, type GlyphName } from "./glyphs";

  let { glyph, label, hotkey = "", on = false, disabled = false, size = 24, round = false, quiet = false, id = "", onpress, onenter = undefined, onleave = undefined }: {
    glyph: GlyphName;
    /** What the key does, as the label says it. */
    label: string;
    hotkey?: string;
    on?: boolean;
    disabled?: boolean;
    size?: number;
    round?: boolean;
    /** A key on an instrument's own face: no paper until the pointer is on it. */
    quiet?: boolean;
    /** `data-fxb-key`, for the keyboard's flash and for gates. */
    id?: string;
    onpress: (e: MouseEvent) => void;
    onenter?: (() => void) | undefined;
    onleave?: (() => void) | undefined;
  } = $props();
</script>

<button class="pk" class:on class:round class:quiet type="button" {disabled} aria-label={label} aria-pressed={on} data-tip={label} data-hk={hotkey || undefined} data-fxb-key={id || undefined}
  style={`--s:${size}px`} onpointerdown={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()} onclick={(e) => { e.stopPropagation(); onpress(e); }}
  onpointerenter={onenter} onpointerleave={onleave}>
  <span class="face"><svg viewBox="0 0 16 16" aria-hidden="true">{@html GLYPHS[glyph]}</svg></span>
</button>

<style>
  .pk { position: relative; display: block; flex: none; width: var(--s); height: var(--s); padding: 0; margin: 0; border: 0; background: none; cursor: var(--cursor-cross-hover); outline: none; -webkit-tap-highlight-color: transparent; }
  .face { position: absolute; inset: 0; display: grid; place-items: center; box-sizing: border-box; border-radius: 5px; color: var(--flx-magenta-600);
    background: var(--flx-paper); border: 1px solid color-mix(in oklab, var(--c-layout-gap) 45%, transparent); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5);
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear, opacity 80ms linear; }
  .pk.round .face { border-radius: 50%; }
  .face svg { display: block; width: calc(var(--s) * 0.62); height: calc(var(--s) * 0.62); fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  .face :global(.f) { fill: currentColor; stroke: none; }
  .face :global(.q) { opacity: 0.5; }
  .pk:hover:not(:disabled) .face, .pk:focus-visible .face { background: color-mix(in oklab, var(--c-layout-gap) 16%, var(--flx-paper)); border-color: var(--c-layout-gap); }
  /* Down: the key meets the board (its shadow goes) one pixel lower. */
  .pk:active:not(:disabled) .face, .pk:global(.struck) .face { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); background: color-mix(in oklab, var(--c-layout-gap) 30%, var(--flx-paper)); }
  .pk.on .face { background: var(--c-layout-gap); border-color: color-mix(in oklab, var(--flx-paper) 60%, var(--c-layout-gap)); color: var(--flx-paper); }
  .pk.on:hover:not(:disabled) .face { background: color-mix(in oklab, var(--flx-paper) 14%, var(--c-layout-gap)); }
  .pk:disabled { cursor: var(--cursor-cross); }
  .pk:disabled .face { opacity: 0.32; box-shadow: none; }
  /* A quiet key is only its mark until it is wanted. */
  .pk.quiet .face { background: transparent; border-color: transparent; box-shadow: none; color: var(--fxb-tx-dim, #878580); }
  .pk.quiet:hover:not(:disabled) .face { background: var(--flx-paper); border-color: var(--c-layout-gap); color: var(--flx-magenta-600); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5); }
  .pk.quiet.on .face { background: transparent; border-color: transparent; color: var(--fxb-pink, #f43f8e); }
  .pk.quiet.on:hover:not(:disabled) .face { background: var(--c-layout-gap); color: var(--flx-paper); }
</style>
