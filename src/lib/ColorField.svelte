<script lang="ts">
  // A controlled colour field that never opens Chromium's native <input type="color">
  // popup. That popup's eyedropper button invokes Chromium's EyeDropperView, which
  // SEGFAULTS Electron on Linux/Wayland — a native crash no JavaScript can catch. The
  // 2026-09-21 fix routed the F-menu picker through color/eyedropper.ts (desktop portal
  // on Linux); the figure and slide Background fields and the palette "+" still used the
  // native input and took the whole app down (owner report 2026-09-26). This is the one
  // field they all use now: swatch → popover with the same HSV square + hue bar as
  // ColorPicker, a hex field, and the portal-safe dropper. Commits on release / Enter /
  // a picked colour (one edit each, so undo stays one step per choice), never per pixel.
  import { onDestroy, tick } from "svelte";
  import { fileBridge } from "./project/types";
  import { pickColor } from "./color/eyedropper";
  import { hexToHsv, hsvToHex, type Hsv } from "./colorSpace";

  /** Current colour (6-digit hex). Anything else displays as `fallback`. */
  export let value = "#ffffff";
  export let fallback = "#ffffff";
  /** Called with a 6-digit lowercase hex on every committed choice. */
  export let onchange: (hex: string) => void = () => {};
  export let label = "Colour";
  export let title = "";
  /** Render as a small "+" button (palette add) instead of a swatch + hex. */
  export let compact = false;

  const HEX6 = /^#[0-9a-fA-F]{6}$/;
  const norm = (v: string | undefined) => (v && HEX6.test(v) ? v.toLowerCase() : fallback);

  let open = false;
  let wrap: HTMLDivElement;
  let hexEl: HTMLInputElement;
  let svEl: HTMLDivElement;
  let hsv: Hsv = { h: 0, s: 0, v: 1 };
  let hexVal = "";
  let svDrag = false;
  let alive = true;

  const bridge = fileBridge();
  const browserDropper =
    typeof window !== "undefined"
      ? (window as unknown as { EyeDropper?: new () => { open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> } }).EyeDropper
      : undefined;
  const hasDropper = !!browserDropper || !!bridge?.captureWindow || !!bridge?.pickScreenColor;
  let dropperBusy = false;
  let dropperError = "";
  let dropperScope = "screen";
  let dropperController: AbortController | undefined;

  $: shown = norm(value);
  $: if (!open) sync(shown);

  function sync(hex: string) {
    hexVal = hex;
    const parsed = hexToHsv(hex);
    if (parsed) hsv = parsed;
  }
  function commit(hex: string) {
    const h = norm(hex);
    sync(h);
    if (h !== norm(value)) onchange(h);
  }
  async function toggle() {
    open = !open;
    if (open) {
      sync(shown);
      await tick();
      hexEl?.focus({ preventScroll: true });
      hexEl?.select();
    }
  }
  function close() {
    dropperController?.abort();
    open = false;
  }
  onDestroy(() => {
    alive = false;
    dropperController?.abort();
  });
  function onDocDown(e: PointerEvent) {
    if (open && wrap && !wrap.contains(e.target as Node)) close();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (dropperBusy) dropperController?.abort();
      else close();
    }
  }

  function svPoint(e: PointerEvent): Hsv {
    const r = svEl.getBoundingClientRect();
    const sx = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    const sy = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)));
    return { h: hsv.h, s: sx, v: 1 - sy };
  }
  function onSvDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    svEl.setPointerCapture(e.pointerId);
    svDrag = true;
    hsv = svPoint(e);
    hexVal = hsvToHex(hsv);
  }
  function onSvMove(e: PointerEvent) {
    if (!svDrag) return;
    hsv = svPoint(e);
    hexVal = hsvToHex(hsv);
  }
  function onSvUp(e: PointerEvent) {
    if (!svDrag) return;
    svDrag = false;
    hsv = svPoint(e);
    commit(hsvToHex(hsv));
  }
  function onHue(e: Event, done: boolean) {
    hsv = { ...hsv, h: Number((e.currentTarget as HTMLInputElement).value) };
    hexVal = hsvToHex(hsv);
    if (done) commit(hexVal);
  }
  function onHexInput(v: string) {
    hexVal = v.trim();
    const parsed = HEX6.test(hexVal) ? hexToHsv(hexVal) : null;
    if (parsed) hsv = parsed;
  }
  function onHexKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (HEX6.test(hexVal)) commit(hexVal);
    }
  }
  function onHexBlur() {
    if (HEX6.test(hexVal)) commit(hexVal);
    else hexVal = shown;
  }
  async function dropper(event: MouseEvent) {
    const trigger = event.currentTarget as HTMLButtonElement;
    if (dropperBusy) return;
    dropperBusy = true;
    dropperError = "";
    const controller = (dropperController = new AbortController());
    try {
      const hex = await pickColor({ bridge, signal: controller.signal, browserDropper, onWindowFallback: () => { dropperScope = "Flux window"; } });
      if (hex && alive && !controller.signal.aborted) commit(hex);
    } catch (error) {
      if (alive && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError"))
        dropperError = error instanceof Error ? error.message : "Unable to pick a colour.";
    } finally {
      if (dropperController === controller) {
        dropperController = undefined;
        dropperBusy = false;
        await tick();
        if (alive && trigger.isConnected) trigger.focus({ preventScroll: true });
      }
    }
  }
</script>

<svelte:document on:pointerdown={onDocDown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="wrap" class:compact bind:this={wrap} on:keydown={onKey}>
  {#if compact}
    <button class="plus" type="button" {title} aria-label={label} aria-expanded={open} on:click={toggle}>+</button>
  {:else}
    <button class="swatch" type="button" title={title || label} aria-label={label} aria-expanded={open} on:click={toggle}>
      <span class="chip" style={`background:${shown}`}></span>
      <span class="val">{shown}</span>
    </button>
  {/if}
  {#if open}
    <div class="pop" role="dialog" aria-label={label}>
      <div class="hexrow">
        <span class="chip big" style={`background:${HEX6.test(hexVal) ? hexVal : shown}`}></span>
        <input
          class="hex"
          bind:this={hexEl}
          value={hexVal}
          spellcheck="false"
          aria-label="Hex colour"
          aria-invalid={!HEX6.test(hexVal)}
          on:input={(e) => onHexInput(e.currentTarget.value)}
          on:keydown={onHexKey}
          on:focus={(e) => e.currentTarget.select()}
          on:blur={onHexBlur} />
        {#if hasDropper}
          <button class="drop" type="button" title={`Pick a colour from the ${dropperScope}`} aria-label="Eyedropper" disabled={dropperBusy} on:click={dropper}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 1.5 14.5 5.5 12.5 7.5 13.5 8.5 12 10 11 9 5.5 14.5H1.5V10.5L7 5 6 4 7.5 2.5 8.5 3.5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          </button>
        {/if}
        <button class="done" type="button" on:click={close} aria-label="Done">✓</button>
      </div>
      {#if dropperError}<div class="drop-error" role="status">{dropperError}</div>{/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="sv"
        bind:this={svEl}
        style={`background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`}
        on:pointerdown={onSvDown}
        on:pointermove={onSvMove}
        on:pointerup={onSvUp}
        on:pointercancel={onSvUp}>
        <span class="svdot" style={`left:${hsv.s * 100}%; top:${(1 - hsv.v) * 100}%; background:${hsvToHex(hsv)}`}></span>
      </div>
      <input class="hue" type="range" min="0" max="360" step="1" value={Math.round(hsv.h)} aria-label="Hue" on:input={(e) => onHue(e, false)} on:change={(e) => onHue(e, true)} />
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; width: 100%; }
  .wrap.compact { width: auto; }
  .swatch { display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; padding: 0 6px; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx); font: 12px var(--font-mono); cursor: var(--cursor-pointer, pointer); }
  .swatch:hover, .plus:hover { border-color: var(--c-tx-muted); }
  .swatch:focus-visible, .plus:focus-visible { outline: none; border-color: var(--c-accent); }
  .chip { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0, 0, 0, 0.35); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); flex: none; }
  .chip.big { width: 22px; height: 22px; }
  .val { flex: 1; text-align: left; }
  .plus { width: 26px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); font: 14px var(--font-ui); padding: 0; }
  .pop { position: absolute; right: 0; top: calc(100% + 4px); z-index: 30; width: 208px; display: flex; flex-direction: column; gap: 6px; padding: 8px; background: var(--c-bg-2, var(--c-bg)); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); }
  .compact .pop { right: auto; left: 0; }
  .hexrow { display: flex; align-items: center; gap: 6px; }
  .hex { flex: 1; min-width: 0; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx); padding: 2px 6px; height: 24px; font: 12px var(--font-mono); outline: none; }
  .hex:focus { border-color: var(--c-accent); }
  .hex[aria-invalid="true"] { border-color: var(--c-danger); }
  .drop, .done { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); padding: 0; flex: none; }
  .drop:hover, .done:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .drop-error { font-size: 11px; color: var(--c-tx-2); }
  .sv { position: relative; width: 100%; height: 120px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); touch-action: none; }
  .svdot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55); pointer-events: none; }
  .hue { width: 100%; height: 12px; margin: 0; appearance: none; -webkit-appearance: none; border-radius: var(--r-ui); border: 1px solid var(--c-line-strong); background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%); }
  .hue::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 8px; height: 16px; border-radius: 2px; background: #fff; border: 1px solid rgba(0, 0, 0, 0.55); box-shadow: 0 0 0 1px #fff; }
</style>
