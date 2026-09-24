<script lang="ts">
  // The palette picker (2026-09-15 surface redesign) — replaces the old
  // name-search colour field. The whole point: F, then c, and the colour is
  // ONE mouse motion away. The project palette renders as a swatch grid
  // (recents, "none", then every imported hue ramp); HOVERING a swatch
  // previews it on the selection live, a click commits, leaving without a
  // click reverts. The left hand can drive it too — W/A/S/D or the arrows
  // walk the grid, Space/Enter commit, Escape reverts — and a hex can still be
  // typed (the `.hex` field), with `⤢` opening the native picker + opacity.
  // Writes go through colors.applyColor, which retargets to drilled plot
  // parts (all of them) or the draw style itself; one edit session = one undo.
  import { onDestroy, onMount, tick } from "svelte";
  import { editSession } from "./interact/editSession";
  import { WheelStepper, wheelDelta } from "./interact/wheelLaw";
  import { project, selection, partSelection, partSelections } from "./store";
  import { applyColor, applyColormap, addRecentColor, setOpacity, currentColor, currentGradient, nameForHex } from "./colors";
  import { selectionTargets } from "./interact/selectionTargets";
  import { FLEXOKI } from "./flexoki";
  import { hexToHsv, hsvToHex, type Hsv } from "./colorSpace";
  import { settings } from "./settings";
  import { availablePaletteCollections, paletteGroups, nextId } from "./color/collections";
  import ColormapPicker from "./ColormapPicker.svelte";
  import { fileBridge } from "./project/types";
  import { pickColor } from "./color/eyedropper";

  export let target: "fill" | "stroke" = "fill";
  /** Commit + close (the host returns to its hotkey mode). */
  export let onDone: () => void = () => {};
  /** Revert + close. */
  export let onCancel: () => void = () => {};
  /** Autofocus the grid so the left hand can walk it immediately. */
  export let autofocus = true;
  /** Hide the "none" swatch (text colour must never blank). */
  export let allowNone = true;

  const session = editSession();
  let alive = true;
  // An explicit pick finishes first; dismissal must discard an unchosen preview.
  onDestroy(() => { alive = false; dropperController?.abort(); session.cancel(); });
  const openingGradient = currentGradient(target);
  const validHex = (hex: string) => /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex);

  interface Sw {
    hex: string;
    name: string;
    group: string;
    /** the literal "none" swatch */
    none?: boolean;
  }
  interface Row {
    label: string;
    swatches: Sw[];
  }

  let gridEl: HTMLDivElement;
  let hexEl: HTMLInputElement;
  let hexVal = "";
  let shownHex = "";
  // The spectrum (owner request 2026-09-15): an HSV square + hue bar on the
  // right, always visible, seeded from the colour the thing had when the picker
  // opened and following the palette cursor; dragging previews live through the
  // session, releasing commits. Hue/sat/val live here so a swatch pick, a typed
  // hex and the square all agree.
  let hsv: Hsv = { h: 0, s: 0, v: 0.5 };
  let svEl: HTMLDivElement;
  let svDrag = false;
  function showColor(hex: string, syncSpectrum = true) {
    hexVal = shownHex = hex;
    if (!syncSpectrum) return;
    const parsed = hexToHsv(hex.length === 9 ? hex.slice(0, 7) : hex);
    // Grey/black carry no hue information. Keep the chosen hue so the next
    // spectrum motion can add saturation without unexpectedly turning red.
    if (parsed) hsv = { ...parsed, h: parsed.s > 0 ? parsed.h : hsv.h };
  }
  const bridge = fileBridge();
  const browserDropper = typeof window !== "undefined" ? (window as unknown as { EyeDropper?: new () => { open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> } }).EyeDropper : undefined;
  const hasDropper = !!browserDropper || !!bridge?.captureWindow;
  let dropperBusy = false;
  let dropperError = "";
  let dropperScope = "screen";
  let dropperController: AbortController | undefined;
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
    preview(hsvToHex(hsv), false);
  }
  function onSvMove(e: PointerEvent) {
    if (!svDrag) return;
    hsv = svPoint(e);
    preview(hsvToHex(hsv), false);
  }
  function onSvUp(e: PointerEvent) {
    if (!svDrag) return;
    svDrag = false;
    hsv = svPoint(e);
    commit(hsvToHex(hsv));
  }
  function onSvCancel() {
    if (!svDrag) return;
    svDrag = false;
    cancel();
  }
  function onHue(e: Event, done: boolean) {
    hsv = { ...hsv, h: Number((e.currentTarget as HTMLInputElement).value) };
    const hex = hsvToHex(hsv);
    preview(hex, false);
    // Picking a hue is a complete edit, but keep the spectrum available for
    // the natural next motion: choosing its saturation and brightness.
    if (done) session.finish();
  }
  async function dropper(event: MouseEvent) {
    const trigger = event.currentTarget as HTMLButtonElement;
    if (dropperBusy) return;
    const owner = $project, selected = JSON.stringify([...$selection]), part = JSON.stringify($partSelections), paint = target;
    dropperBusy = true;
    dropperError = "";
    const controller = dropperController = new AbortController();
    try {
      const hex = await pickColor({ bridge, signal: controller.signal, browserDropper, onWindowFallback: () => { dropperScope = "Flux window"; } });
      if (hex && alive && !controller.signal.aborted && $project === owner && target === paint && JSON.stringify([...$selection]) === selected && JSON.stringify($partSelections) === part) commit(hex);
    } catch (error) {
      if (alive && !controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) dropperError = error instanceof Error ? error.message : "Unable to pick a color.";
    } finally {
      if (dropperController === controller) { dropperController = undefined; dropperBusy = false; await tick(); if (alive && trigger.isConnected) trigger.focus({ preventScroll: true }); }
    }
  }
  let cursor = { r: 0, c: 0 };

  // Text colour never blanks; a line's paint via the fill target neither
  // (colors.applyColor guards both — hide the swatch rather than no-op it).
  $: noneOk = allowNone && !(target === "fill" && selectionIsTextOrLine($selection, $project));
  function selectionIsTextOrLine(sel: Set<string>, p: typeof $project): boolean {
    if (!sel.size || $partSelection) return false;
    for (const f of p.figures) for (const e of f.elements) if (sel.has(e.id) && e.type !== "text" && e.type !== "line") return false;
    return true;
  }

  // Palette COLLECTIONS (2026-09-16): Flexoki, ColorBrewer, Paul Tol — plus the
  // project's own imported palette when it has one. The picker opens on the
  // collection the settings name; the tabs (or Shift+Tab) move between them, and
  // Tab switches the whole left column to the colormap picker.
  $: collections = availablePaletteCollections($project);
  let collectionId = "";
  $: if (!collectionId || !collections.some((c) => c.id === collectionId)) {
    const wanted = $settings.paletteCollection;
    collectionId = collections.some((c) => c.id === wanted) ? wanted : collections[0]?.id ?? "flexoki";
  }
  let view: "palette" | "colormap" = "palette";
  function setCollection(id: string) {
    collectionId = id;
    cursor = { r: 0, c: 0 };
    requestAnimationFrame(() => gridEl?.focus({ preventScroll: true }));
  }
  function cycleCollection(step = 1) {
    setCollection(nextId(collections.map((c) => c.id), collectionId, step));
  }
  function toggleView() {
    view = view === "palette" ? "colormap" : "palette";
    if (view === "palette") requestAnimationFrame(() => gridEl?.focus({ preventScroll: true }));
  }
  // Tab toggles palette ⇄ colormaps and Shift+Tab cycles the palette collections
  // from anywhere while the picker is up (window, capture phase) — a picker whose
  // keys depend on which element holds focus is a picker that sometimes ignores
  // them. In the colormap view the child picker owns Shift+Tab.
  function onWinKey(e: KeyboardEvent) {
    if (dropperBusy) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key === "Escape") dropperController?.abort();
      return;
    }
    if (e.key !== "Tab") return;
    if (e.shiftKey && view === "colormap") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.shiftKey) cycleCollection(1);
    else toggleView();
  }
  $: rows = ((): Row[] => {
    const out: Row[] = [];
    const head: Sw[] = [];
    if (noneOk) head.push({ hex: "none", name: `no ${target}`, group: "none", none: true });
    for (const c of $project.palette) head.push({ hex: c, name: nameForHex(c) ?? c, group: "recent" });
    if (head.length) out.push({ label: "recent", swatches: head });
    // The chosen collection; an empty one (a project without an imported
    // palette) falls back to the bundled Flexoki ramp so the picker is never empty.
    const groups = paletteGroups(collectionId, $project);
    for (const g of groups.length ? groups : FLEXOKI) out.push({ label: g.name, swatches: g.swatches.map((s) => ({ hex: s.hex, name: s.name, group: g.name })) });
    return out;
  })();
  $: at = rows[cursor.r]?.swatches[Math.min(cursor.c, (rows[cursor.r]?.swatches.length ?? 1) - 1)] ?? null;
  $: shownName = shownHex === "none" ? `no ${target}` : at?.hex.toLowerCase() === shownHex.toLowerCase() ? at.name : nameForHex(shownHex) ?? shownHex;
  $: editable = $partSelection ? [] : $project.figures.flatMap((f) => selectionTargets(f, $selection, { editable: true }));
  $: opacity = editable[0]?.opacity ?? 1;
  $: mixedOpacity = editable.some((e) => (e.opacity ?? 1) !== opacity);

  onMount(() => {
    showColor(currentColor(target));
    // Land the cursor on the current colour when the palette carries it.
    outer: for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < rows[r].swatches.length; c++)
        if (rows[r].swatches[c].hex.toLowerCase() === hexVal.toLowerCase()) {
          cursor = { r, c };
          break outer;
        }
    if (autofocus) requestAnimationFrame(() => gridEl?.focus({ preventScroll: true }));
  });

  function preview(hex: string, syncSpectrum = true) {
    showColor(hex, syncSpectrum);
    session.run(() => applyColor(hex, target, true));
  }
  function commit(hex: string) {
    session.run(() => {
      applyColor(hex, target, true);
      if (hex !== "none") addRecentColor(hex, true);
    });
    session.finish();
    onDone();
  }
  // The whole map as a gradient along an axis (colormap view, x / y) — elements
  // only; parts and the draw style take solid colours (applyColormap declines).
  function commitGradient(map: string, axis: "x" | "y") {
    let done = false;
    session.run(() => {
      done = applyColormap(map, axis, target, true);
    });
    if (!done) return;
    session.finish();
    onDone();
  }
  function cancel() {
    session.cancel();
    onCancel();
  }
  function liveHex(hex: string) {
    // Keep the actual draft even while incomplete; Enter must never apply a
    // stale, previously-valid value behind what the field currently displays.
    hexVal = hex;
    if (validHex(hex)) preview(hex);
  }

  function move(dr: number, dc: number) {
    if (!rows.length) return;
    let r = Math.max(0, Math.min(rows.length - 1, cursor.r + dr));
    const len = rows[r].swatches.length;
    let c = dr ? Math.min(cursor.c, len - 1) : cursor.c + dc;
    if (c < 0) {
      if (r > 0) { r--; c = rows[r].swatches.length - 1; } else c = 0;
    } else if (c >= len) {
      if (r < rows.length - 1) { r++; c = 0; } else c = len - 1;
    }
    cursor = { r, c };
    const sw = rows[r].swatches[c];
    if (sw) preview(sw.hex);
    requestAnimationFrame(() => gridEl?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  function onGridKey(e: KeyboardEvent) {
    const k = e.key;
    const lk = k.toLowerCase();
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (k === "Enter" || k === " ") { e.preventDefault(); e.stopPropagation(); if (at) commit(at.hex); return; }
    if (k === "ArrowUp" || lk === "w") { e.preventDefault(); e.stopPropagation(); move(-1, 0); return; }
    if (k === "ArrowDown" || lk === "s") { e.preventDefault(); e.stopPropagation(); move(1, 0); return; }
    if (k === "ArrowLeft" || lk === "a") { e.preventDefault(); e.stopPropagation(); move(0, -1); return; }
    if (k === "ArrowRight" || lk === "d") { e.preventDefault(); e.stopPropagation(); move(0, 1); return; }
    if (k === "#" || /^[0-9a-f]$/i.test(k)) {
      // Start typing a hex: the field takes over.
      e.preventDefault();
      e.stopPropagation();
      hexVal = k === "#" ? "#" : "#" + k;
      requestAnimationFrame(() => { hexEl?.focus(); hexEl?.setSelectionRange(hexVal.length, hexVal.length); });
      return;
    }
    // Every other key stays inside the picker (the menu's hotkeys must not fire).
    e.stopPropagation();
  }
  function onHexKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); if (validHex(hexVal)) commit(hexVal); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  }
  function onRangeKey(e: KeyboardEvent) {
    // Arrow keys stay native to the range; Escape still belongs to the picker.
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  }
  /** Wheel over the grid walks the cursor along the palette (the mouse hand
   *  never has to leave the wheel). */
  const wheel = new WheelStepper();
  function onWheel(e: WheelEvent) {
    if (!rows.length) return;
    e.preventDefault();
    // The ONE wheel law (interact/wheelLaw.ts): a notch walks one swatch, a
    // trackpad stream walks smoothly instead of racing on every tiny delta.
    const steps = wheel.steps({ deltaY: wheelDelta(e), deltaMode: e.deltaMode, time: performance.now() });
    for (let i = 0; i < Math.abs(steps); i++) move(0, steps > 0 ? -1 : 1);
  }
</script>

<svelte:window on:keydown|capture={onWinKey} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="cs" class:cmview={view === "colormap"} on:keydown={onGridKey}>
  <div class="tabs" role="tablist" aria-label="Palette collections">
    {#each collections as c (c.id)}
      <button class="tab" class:on={view === "palette" && c.id === collectionId} role="tab" aria-selected={view === "palette" && c.id === collectionId} type="button" on:click={() => { view = "palette"; setCollection(c.id); }}>{c.name}</button>
    {/each}
    <span class="tabsep"></span>
    <button class="tab maps" class:on={view === "colormap"} role="tab" aria-selected={view === "colormap"} type="button" title="Pick a colour along a colormap (Tab)" on:click={() => { view = "colormap"; }}>Colormaps</button>
    <span class="tabhint"><b>⇧⇥</b> next · <b>⇥</b> maps</span>
  </div>
  <div class="left">
  {#if view === "colormap"}
    <ColormapPicker mode="color" value={openingGradient?.map ?? ""} gradient={$selection.size > 0 && !$partSelection} onPreview={(hex) => liveHex(hex)} onPick={(hex) => commit(hex)} onPickGradient={commitGradient} onCancel={cancel} />
  {:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div class="grid" bind:this={gridEl} tabindex="0" role="listbox" aria-label={`${target} colour`} on:wheel={onWheel}>
    {#each rows as row, r (row.label)}
      <div class="prow">
        <span class="plabel">{row.label}</span>
        <span class="sws">
          {#each row.swatches as sw, c (row.label + sw.hex + c)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <span
              class="sw"
              class:none={sw.none}
              class:cur={cursor.r === r && cursor.c === c}
              class:live={!sw.none && sw.hex.toLowerCase() === shownHex.toLowerCase()}
              data-r={r}
              data-c={c}
              role="option"
              tabindex="-1"
              aria-selected={cursor.r === r && cursor.c === c}
              title={`${sw.name}${sw.none ? "" : " · " + sw.hex}`}
              style={sw.none ? "" : `background:${sw.hex}`}
              on:pointerenter={() => { cursor = { r, c }; preview(sw.hex); }}
              on:click={() => commit(sw.hex)}
            ></span>
          {/each}
        </span>
      </div>
    {/each}
    {#if !rows.length}<div class="empty">No palette yet — import one in the Inspector's Color palette.</div>{/if}
  </div>
  {/if}
  </div>
  <div class="side">
    <div class="bar">
      <span class="dot" style={shownHex !== "none" ? `background:${shownHex}` : ""} class:isnone={shownHex === "none"}></span>
      <span class="cname">{shownName}</span>
    </div>
    <div class="hexrow">
      <input class="hex" bind:this={hexEl} value={hexVal} spellcheck="false" aria-label="Hex colour" aria-invalid={hexVal !== "none" && !validHex(hexVal)}
        on:input={(e) => liveHex(e.currentTarget.value)} on:keydown={onHexKey} on:focus={(e) => e.currentTarget.select()} />
      {#if hasDropper}
        <button class="drop" type="button" title={`Pick a colour from the ${dropperScope}`} aria-label="Eyedropper" disabled={dropperBusy} on:click={dropper}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M10.5 1.5 14.5 5.5 12.5 7.5 13.5 8.5 12 10 11 9 5.5 14.5H1.5V10.5L7 5 6 4 7.5 2.5 8.5 3.5Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
        </button>
      {/if}
    </div>
    {#if dropperError}<div class="drop-error" role="status">{dropperError}</div>{/if}
    <!-- The full spectrum: saturation → right, value ↑, hue below. -->
    <div class="spec" aria-label="Spectrum">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="sv"
        bind:this={svEl}
        style={`background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`}
        on:pointerdown={onSvDown}
        on:pointermove={onSvMove}
        on:pointerup={onSvUp}
        on:pointercancel={onSvCancel}
      >
        <span class="svdot" style={`left:${hsv.s * 100}%; top:${(1 - hsv.v) * 100}%; background:${hsvToHex(hsv)}`}></span>
      </div>
      <input class="hue" type="range" min="0" max="360" step="1" value={Math.round(hsv.h)} aria-label="Hue"
        on:input={(e) => onHue(e, false)} on:change={(e) => onHue(e, true)} on:keydown={onRangeKey} />
    </div>
    {#if editable.length}
      <label class="erow"><span>opacity</span><input type="range" min="0" max="1" step="0.01" value={opacity} aria-valuetext={mixedOpacity ? "Mixed" : `${Math.round(opacity * 100)}%`} on:input={(e) => session.run(() => setOpacity(parseFloat(e.currentTarget.value), true))} on:change={() => session.finish()} on:keydown={onRangeKey} /><output>{mixedOpacity ? "mixed" : `${Math.round(opacity * 100)}%`}</output></label>
    {/if}
    <div class="hint"><b>hover</b> preview · <b>click</b>/<b>space</b> apply · <b>wasd</b>/arrows walk · <b>#</b> type a hex · <b>esc</b> revert</div>
  </div>
</div>

<style>
  .drop-error { font-size: 11px; color: var(--c-tx-2); }
  /* Two columns when they fit: the palette gets the room (every row on ONE
     line, the whole grid visible — the menu grows instead of scrolling), the
     spectrum sits in a 204 px column on the right. A flex WRAP rather than a
     fixed grid, because the picker also lives in the Inspector, whose width the
     user sets: when the palette's own width plus the spectrum no longer fit,
     the spectrum drops below the palette and takes the full width, instead of
     the swatch rows running underneath it (owner report 2026-09-24). Slack on a
     shared line goes to the palette side (flex-grow 1000 vs 1), so the wide
     layout keeps its 204 px spectrum. Narrower still, swatch rows wrap. */
  .cs { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: flex-start; font-family: inherit; }
  .left { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1000 1 max-content; }
  .tabs { flex: 1 0 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; border-bottom: 1px solid var(--c-line); padding-bottom: 4px; }
  .tab { height: 22px; padding: 0 9px; background: transparent; border: 1px solid transparent; border-radius: var(--r-ui); color: var(--c-tx-2); font: 12px var(--font-serif); white-space: nowrap; }
  .tab:hover { color: var(--c-tx-hi); border-color: var(--c-line-strong); }
  .tab.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .tabsep { width: 1px; height: 14px; background: var(--c-line-strong); margin: 0 4px; }
  .tabhint { margin-left: auto; font: 10.5px var(--font-mono); color: var(--c-tx-muted); white-space: nowrap; }
  .tabhint b { color: var(--c-tx-2); }
  .grid { outline: none; display: flex; flex-direction: column; gap: 4px; padding: 2px; }
  .grid:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 0; border-radius: var(--r-0); }
  .prow { display: grid; grid-template-columns: 58px 1fr; align-items: center; gap: 6px; }
  .plabel { font: 600 9.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-tx-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sws { display: flex; flex-wrap: wrap; gap: 3px; }
  .sw { width: 17px; height: 17px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 12%, transparent); cursor: var(--cursor-cross-hover); box-sizing: border-box; position: relative; }
  .sw.none { background: var(--c-surface); }
  .sw.none::after { content: ""; position: absolute; inset: 3px; border-top: 1.5px solid var(--c-danger); transform: rotate(-45deg); transform-origin: center; }
  .sw.live { box-shadow: inset 0 0 0 1px var(--c-tx-hi); }
  .sw.cur { outline: 2px solid var(--c-accent); outline-offset: 1px; }
  .side { display: flex; flex-direction: column; gap: 8px; min-width: 0; flex: 1 0 204px; max-width: 100%; }
  .bar { display: flex; align-items: center; gap: 6px; height: 22px; }
  .hexrow { display: flex; align-items: center; gap: 6px; }
  .dot { width: 14px; height: 14px; border-radius: var(--r-ui); border: 1px solid var(--c-line-strong); flex: none; }
  .dot.isnone { background: repeating-linear-gradient(-45deg, transparent 0 3px, var(--c-line-strong) 3px 4px); }
  .cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--c-tx-2); }
  .hex { flex: 1; min-width: 0; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx); padding: 2px 6px; height: 24px; font: 12px var(--font-mono); outline: none; }
  .hex:focus { border-color: var(--c-accent); }
  .hex[aria-invalid="true"] { border-color: var(--c-danger); }
  .drop { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); padding: 0; flex: none; }
  .drop:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .spec { display: flex; flex-direction: column; gap: 6px; }
  .sv { position: relative; width: 100%; height: 136px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); touch-action: none; }
  .svdot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.55); pointer-events: none; }
  .hue { width: 100%; height: 12px; margin: 0; appearance: none; -webkit-appearance: none; border-radius: var(--r-ui); border: 1px solid var(--c-line-strong); background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%); }
  .hue::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 8px; height: 16px; border-radius: 2px; background: #fff; border: 1px solid rgba(0, 0, 0, 0.55); box-shadow: 0 0 0 1px #fff; }
  .erow { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-tx-muted); }
  .erow input[type="range"] { flex: 1; min-width: 0; accent-color: var(--c-accent); }
  .erow output { min-width: 4ch; text-align: right; font: 10.5px var(--font-mono); color: var(--c-tx-2); }
  .hint { font-size: 10.5px; color: var(--c-tx-muted); }
  .hint b { color: var(--c-tx-2); font-weight: 600; }
  .empty { padding: 12px; color: var(--c-tx-muted); font-size: 12px; }
</style>
