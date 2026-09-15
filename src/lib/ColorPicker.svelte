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
  import { onDestroy, onMount } from "svelte";
  import { editSession } from "./interact/editSession";
  import { WheelStepper, wheelDelta } from "./interact/wheelLaw";
  import { project, selection, partSelection } from "./store";
  import { applyColor, addRecentColor, setOpacity, currentColor, nameForHex } from "./colors";
  import { FLEXOKI } from "./flexoki";

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
  onDestroy(() => session.finish());

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
  let expanded = false;
  let hexVal = "";
  let cursor = { r: 0, c: 0 };
  let committed = false;

  // Text colour never blanks; a line's paint via the fill target neither
  // (colors.applyColor guards both — hide the swatch rather than no-op it).
  $: noneOk = allowNone && !(target === "fill" && selectionIsTextOrLine($selection, $project));
  function selectionIsTextOrLine(sel: Set<string>, p: typeof $project): boolean {
    if (!sel.size || $partSelection) return false;
    for (const f of p.figures) for (const e of f.elements) if (sel.has(e.id) && e.type !== "text" && e.type !== "line") return false;
    return true;
  }

  $: rows = ((): Row[] => {
    const out: Row[] = [];
    const head: Sw[] = [];
    if (noneOk) head.push({ hex: "none", name: `no ${target}`, group: "none", none: true });
    for (const c of $project.palette) head.push({ hex: c, name: nameForHex(c) ?? c, group: "recent" });
    if (head.length) out.push({ label: "recent", swatches: head });
    // A project with no imported palette still gets the bundled Flexoki ramp
    // (the same one new projects seed), so the picker is never empty.
    const groups = $project.colorGroups?.length ? $project.colorGroups : FLEXOKI;
    for (const g of groups) out.push({ label: g.name, swatches: g.swatches.map((s) => ({ hex: s.hex, name: s.name, group: g.name })) });
    return out;
  })();
  $: at = rows[cursor.r]?.swatches[Math.min(cursor.c, (rows[cursor.r]?.swatches.length ?? 1) - 1)] ?? null;

  onMount(() => {
    hexVal = currentColor(target);
    // Land the cursor on the current colour when the palette carries it.
    outer: for (let r = 0; r < rows.length; r++)
      for (let c = 0; c < rows[r].swatches.length; c++)
        if (rows[r].swatches[c].hex.toLowerCase() === hexVal.toLowerCase()) {
          cursor = { r, c };
          break outer;
        }
    if (autofocus) requestAnimationFrame(() => gridEl?.focus({ preventScroll: true }));
  });

  function preview(hex: string) {
    session.run(() => applyColor(hex, target, true));
  }
  function commit(hex: string) {
    session.run(() => {
      applyColor(hex, target, true);
      if (hex !== "none") addRecentColor(hex, true);
    });
    session.finish();
    committed = true;
    onDone();
  }
  function cancel() {
    session.cancel();
    onCancel();
  }
  function liveHex(hex: string) {
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
      hexVal = hex;
      preview(hex);
    }
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
    if (k === "Tab") { e.preventDefault(); e.stopPropagation(); expanded = !expanded; return; }
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
    if (e.key === "Enter") { e.preventDefault(); if (/^#[0-9a-fA-F]{3,8}$/.test(hexVal)) commit(hexVal); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="cs" on:keydown={onGridKey}>
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
              class:live={!sw.none && sw.hex.toLowerCase() === hexVal.toLowerCase()}
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
  <div class="bar">
    <span class="dot" style={at && !at.none ? `background:${at.hex}` : ""} class:isnone={!!at?.none}></span>
    <span class="cname">{at ? at.name : ""}</span>
    <input class="hex" bind:this={hexEl} value={hexVal} spellcheck="false" aria-label="Hex colour"
      on:input={(e) => liveHex(e.currentTarget.value)} on:keydown={onHexKey} on:focus={(e) => e.currentTarget.select()} />
    <button class="exp" class:on={expanded} title="Native picker & opacity (Tab)" on:click={() => (expanded = !expanded)}>⤢</button>
  </div>
  {#if expanded}
    <div class="editor">
      <label class="erow"><span>pick</span><input type="color" value={/^#[0-9a-fA-F]{6}$/.test(hexVal) ? hexVal : "#000000"} on:input={(e) => liveHex(e.currentTarget.value)} on:change={(e) => commit(e.currentTarget.value)} /></label>
      {#if $selection.size && !$partSelection}
        <label class="erow"><span>opacity</span><input type="range" min="0" max="1" step="0.01" value="1" on:input={(e) => session.run(() => setOpacity(parseFloat(e.currentTarget.value), true))} /></label>
      {/if}
    </div>
  {/if}
  <div class="hint"><b>hover</b> preview · <b>click</b>/<b>space</b> apply · <b>wasd</b>/arrows walk · <b>#</b> type a hex · <b>esc</b> revert</div>
</div>

<style>
  .cs { display: flex; flex-direction: column; gap: 6px; font-family: var(--font-ui); }
  .grid { outline: none; max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 2px; }
  .grid:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 0; border-radius: var(--r-0); }
  .prow { display: grid; grid-template-columns: 58px 1fr; align-items: center; gap: 6px; }
  .plabel { font: 600 9.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-tx-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sws { display: flex; flex-wrap: wrap; gap: 3px; }
  .sw { width: 17px; height: 17px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 12%, transparent); cursor: pointer; box-sizing: border-box; position: relative; }
  .sw.none { background: var(--c-surface); }
  .sw.none::after { content: ""; position: absolute; inset: 3px; border-top: 1.5px solid var(--c-danger); transform: rotate(-45deg); transform-origin: center; }
  .sw.live { box-shadow: inset 0 0 0 1px var(--c-tx-hi); }
  .sw.cur { outline: 2px solid var(--c-accent); outline-offset: 1px; }
  .bar { display: flex; align-items: center; gap: 6px; padding-top: 6px; border-top: 1px solid var(--c-line); }
  .dot { width: 14px; height: 14px; border-radius: var(--r-ui); border: 1px solid var(--c-line-strong); flex: none; }
  .dot.isnone { background: repeating-linear-gradient(-45deg, transparent 0 3px, var(--c-line-strong) 3px 4px); }
  .cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--c-tx-2); }
  .hex { width: 84px; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx); padding: 2px 6px; height: 24px; font: 12px var(--font-mono); outline: none; }
  .hex:focus { border-color: var(--c-accent); }
  .exp { width: 24px; height: 24px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); cursor: pointer; font-size: 12px; padding: 0; }
  .exp.on, .exp:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .editor { display: flex; gap: 12px; align-items: center; }
  .erow { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-tx-muted); }
  .erow input[type="color"] { width: 30px; height: 22px; padding: 0; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: none; }
  .erow input[type="range"] { width: 110px; accent-color: var(--c-accent); }
  .hint { font-size: 10.5px; color: var(--c-tx-muted); }
  .hint b { color: var(--c-tx-2); font-weight: 600; }
  .empty { padding: 12px; color: var(--c-tx-muted); font-size: 12px; }
</style>
