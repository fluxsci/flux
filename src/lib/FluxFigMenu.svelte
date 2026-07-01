<script lang="ts">
  import { fade } from "svelte/transition";
  import { get } from "svelte/store";
  import {
    project,
    selection,
    beginGesture,
    mutate,
  } from "./store";
  import type { Element, Project } from "./types";
  import { applyAutoWidth } from "./text";
  import { evalExpr } from "./num";
  import { scrub } from "./scrub";
  import { nameForHex } from "./colors";
  import { fluxFigMenuOpen, settings } from "./settings";
  import { halfFrame, drawForge } from "./motion/selfDraw";
  import { prefersReducedMotion } from "./motion/motion";
  import ColorSearch from "./ColorSearch.svelte";

  type Kind = "number" | "text" | "select" | "toggle" | "color";
  interface Field {
    key: string;
    label: string;
    group: string;
    kind: Kind;
    get: () => string | number | boolean;
    apply: (v: string | number | boolean) => void;
    options?: { value: string; label: string }[];
    target?: "fill" | "stroke";
    step?: number;
  }

  let mode: "hotkey" | "field" | "color" | "search" = "hotkey";
  let activeKey: string | null = null;
  let colorField: Field | null = null;
  let search = "";
  let sIndex = 0;
  let panelEl: HTMLDivElement;
  let inputs: Record<string, any> = {};
  let searchEl: HTMLInputElement;
  let frameW = 0; // measured panel box, for the self-drawing outline
  let frameH = 0;

  // (Re)build the field list whenever the selection or its data changes.
  $: fields = $fluxFigMenuOpen ? buildFields($project, $selection) : [];
  $: groups = groupFields(fields);
  $: sQ = search.trim().toLowerCase();
  $: sResults = sQ
    ? fields.filter((f) => `${f.label} ${f.group} ${f.key}`.toLowerCase().includes(sQ))
    : fields;
  $: if (sIndex >= sResults.length) sIndex = Math.max(0, sResults.length - 1);

  // Reset state each time the FluxFig Menu opens.
  let prevOpen = false;
  $: {
    if ($fluxFigMenuOpen && !prevOpen) reset();
    prevOpen = $fluxFigMenuOpen;
  }
  function reset() {
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    search = "";
    sIndex = 0;
    requestAnimationFrame(() => panelEl?.focus());
  }

  function groupFields(fs: Field[]) {
    const out: { name: string; fields: Field[] }[] = [];
    for (const f of fs) {
      let g = out.find((o) => o.name === f.group);
      if (!g) {
        g = { name: f.group, fields: [] };
        out.push(g);
      }
      g.fields.push(f);
    }
    return out;
  }

  function buildFields(p: Project, sel: Set<string>): Field[] {
    const els: Element[] = [];
    for (const f of p.figures)
      for (const e of f.elements) if (sel.has(e.id)) els.push(e);
    const primary = els[0];
    if (!primary) return [];

    const upd = (fn: (e: Element) => void) =>
      mutate((proj) => {
        for (const f of proj.figures)
          for (const e of f.elements)
            if (sel.has(e.id)) {
              fn(e);
              applyAutoWidth(e);
            }
      });

    const F: Field[] = [];
    const num = (
      key: string,
      label: string,
      group: string,
      g: () => number,
      a: (e: Element, v: number) => void,
      step = 1,
    ) =>
      F.push({
        key,
        label,
        group,
        kind: "number",
        step,
        get: g,
        apply: (v) => upd((e) => a(e, Number(v))),
      });

    // Geometry (all element types)
    num("x", "x position", "Geometry", () => Math.round(primary.x), (e, v) => (e.x = v));
    num("y", "y position", "Geometry", () => Math.round(primary.y), (e, v) => (e.y = v));
    if ("width" in primary && primary.type !== "line") {
      num("w", "width", "Geometry", () => Math.round((primary as any).width), (e, v) => { if ("width" in e) e.width = Math.max(1, v); });
      num("h", "height", "Geometry", () => Math.round((primary as any).height), (e, v) => { if ("height" in e) e.height = Math.max(1, v); });
    }
    num("r", "rotation", "Geometry", () => Math.round(primary.rotation), (e, v) => (e.rotation = v));
    num("o", "opacity", "Geometry", () => primary.opacity ?? 1, (e, v) => (e.opacity = Math.min(1, Math.max(0, v))), 0.05);

    // Fill
    if (primary.type === "rect" || primary.type === "ellipse" || primary.type === "path") {
      F.push({ key: "c", label: "fill color", group: "Fill", kind: "color", target: "fill", get: () => (primary as any).fill, apply: () => {} });
    }
    if (primary.type === "rect") {
      num("u", "corner radius", "Fill", () => (primary as any).cornerRadius, (e, v) => { if (e.type === "rect") e.cornerRadius = Math.max(0, v); });
    }

    // Stroke
    if (primary.type === "rect" || primary.type === "ellipse" || primary.type === "path" || primary.type === "line") {
      F.push({ key: "k", label: "stroke color", group: "Stroke", kind: "color", target: "stroke", get: () => (primary as any).stroke, apply: () => {} });
      num("d", "stroke width", "Stroke", () => (primary as any).strokeWidth, (e, v) => { if ("strokeWidth" in e) e.strokeWidth = Math.max(0, v); });
    }
    if (primary.type === "line") {
      F.push({ key: "q", label: "arrow start", group: "Stroke", kind: "toggle", get: () => (primary as any).arrowStart, apply: () => upd((e) => { if (e.type === "line") e.arrowStart = !e.arrowStart; }) });
      F.push({ key: "g", label: "arrow end", group: "Stroke", kind: "toggle", get: () => (primary as any).arrowEnd, apply: () => upd((e) => { if (e.type === "line") e.arrowEnd = !e.arrowEnd; }) });
    }

    // Text
    if (primary.type === "text") {
      F.push({ key: "t", label: "text", group: "Text", kind: "text", get: () => (primary as any).text, apply: (v) => upd((e) => { if (e.type === "text") e.text = String(v); }) });
      num("e", "font size", "Text", () => (primary as any).fontSize, (e, v) => { if (e.type === "text") e.fontSize = Math.max(1, v); });
      F.push({ key: "b", label: "weight", group: "Text", kind: "select", options: [{ value: "400", label: "Regular" }, { value: "700", label: "Bold" }], get: () => String((primary as any).fontWeight), apply: (v) => upd((e) => { if (e.type === "text") e.fontWeight = Number(v); }) });
      F.push({ key: "m", label: "font", group: "Text", kind: "select", options: ["Georgia", "Arial", "Helvetica", "Times New Roman", "Courier New", "Verdana"].map((x) => ({ value: x, label: x })), get: () => (primary as any).fontFamily, apply: (v) => upd((e) => { if (e.type === "text") e.fontFamily = String(v); }) });
      F.push({ key: "a", label: "align", group: "Text", kind: "select", options: [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }], get: () => (primary as any).align, apply: (v) => upd((e) => { if (e.type === "text") e.align = v as "left" | "center" | "right"; }) });
      F.push({ key: "c", label: "text color", group: "Text", kind: "color", target: "fill", get: () => (primary as any).color, apply: () => {} });
    }

    return F;
  }

  // The signature entrance: the panel's accent frame DRAWS ITSELF — two luminous
  // lines start at the top-centre, race down both sides and seal at the bottom
  // (manim's rate_func=smooth IS the 5th-order smoothstep), a glowing pen-tip
  // leading each one; then the content materialises. One bidirectional
  // transition so pressing `f` mid-draw catches the state and reverses (P4);
  // only opacity/scale + cheap registered custom props animate (P5); collapses
  // to instant under reduced motion (P6).
  // The frame geometry + the signature "draw" open are shared with the Plot
  // X-Ray (see selfDraw.ts), so they never drift. Only the menu-only "quick-fade"
  // alternative lives here.
  $: pathR = halfFrame(frameW, frameH, true);
  $: pathL = halfFrame(frameW, frameH, false);

  function forge(node: HTMLElement) {
    if (prefersReducedMotion()) return { duration: 0 };
    if (get(settings).fluxFigMenuAnim === "fade") {
      // the whole panel (frame already drawn at rest) fades in/out, very fast.
      return {
        duration: 105,
        css: (t: number) => `opacity:${t}; transform: scale(${0.985 + 0.015 * t});`,
      };
    }
    return drawForge(node);
  }

  // --- interaction ---
  function close() {
    fluxFigMenuOpen.set(false);
  }
  function focusPanel() {
    requestAnimationFrame(() => panelEl?.focus());
  }

  function activate(f: Field) {
    if (f.kind === "color") {
      colorField = f;
      mode = "color";
      return;
    }
    if (f.kind === "toggle") {
      f.apply(true);
      return; // stays in hotkey mode
    }
    beginGesture();
    activeKey = f.key;
    mode = "field";
    requestAnimationFrame(() => {
      const el = inputs[f.key];
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  }

  function enterSearch() {
    mode = "search";
    requestAnimationFrame(() => searchEl?.focus());
  }

  function backToHotkey() {
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    focusPanel();
  }

  function onWin(e: KeyboardEvent) {
    if (!$fluxFigMenuOpen || mode !== "hotkey") return;
    const k = e.key;
    // stopImmediatePropagation prevents the global shortcut handler from
    // re-processing the same key (e.g. re-opening on the closing "f").
    if (k === "Escape" || k.toLowerCase() === "f") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (k.toLowerCase() === "s") {
      e.preventDefault();
      e.stopImmediatePropagation();
      enterSearch();
      return;
    }
    const f = fields.find((fl) => fl.key === k.toLowerCase());
    if (f) {
      e.preventDefault();
      e.stopImmediatePropagation();
      activate(f);
    }
  }

  function onFieldKey(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      backToHotkey();
    }
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      sIndex = Math.min(sResults.length - 1, sIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      sIndex = Math.max(0, sIndex - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const f = sResults[sIndex];
      if (f) {
        mode = "hotkey";
        activate(f);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      backToHotkey();
    }
  }

  // panel geometry from settings. Centering lives on the wrapper (NOT a
  // transform on the panel) so it can never fight the scale transition.
  $: width = { sm: 420, md: 560, lg: 720 }[$settings.fluxFigMenuSize];
  $: wrapStyle = {
    center: "align-items:center; justify-content:center;",
    top: "align-items:flex-start; justify-content:center; padding-top:64px;",
    left: "align-items:center; justify-content:flex-start; padding-left:28px;",
    right: "align-items:center; justify-content:flex-end; padding-right:28px;",
  }[$settings.fluxFigMenuPos];
  $: bgAlpha = $settings.fluxFigMenuOpacity;

  function colorDisplay(f: Field): { hex: string; name: string } {
    const hex = String(f.get());
    return { hex, name: nameForHex(hex) ?? hex };
  }
</script>

<svelte:window on:keydown={onWin} />

{#if $fluxFigMenuOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fbackdrop" transition:fade={{ duration: 110 }} on:pointerdown={close}></div>
  <div class="fwrap" style={wrapStyle}>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
    <div
      class="fluxFigMenu"
      bind:this={panelEl}
      bind:clientWidth={frameW}
      bind:clientHeight={frameH}
      tabindex="-1"
      style={`width:${width}px; --fa:${bgAlpha};`}
      transition:forge
      on:pointerdown|stopPropagation
    >
    <!-- the accent frame that draws itself in: two luminous strokes descend from
         the top-centre and seal at the bottom (manim's Create), then content rises. -->
    <svg class="frame" viewBox={`0 0 ${frameW || 1} ${frameH || 1}`} preserveAspectRatio="none" aria-hidden="true">
      <path class="fline" d={pathL} pathLength="100" />
      <path class="fline" d={pathR} pathLength="100" />
    </svg>
    <div class="fcontent">
    <!-- search bar -->
    <div class="search-row" class:active={mode === "search"}>
      <span class="hk">s</span>
      {#if mode === "search"}
        <input
          bind:this={searchEl}
          bind:value={search}
          class="search-in"
          placeholder="Search properties & actions…"
          spellcheck="false"
          on:keydown={onSearchKey}
        />
      {:else}
        <button class="search-fake" on:click={enterSearch}>Search bar…</button>
      {/if}
    </div>

    <div class="body">
      {#if mode === "color" && colorField}
        <div class="color-mode">
          <div class="cm-head"><span class="hk">{colorField.key}</span> {colorField.label}</div>
          <ColorSearch target={colorField.target ?? "fill"} onDone={backToHotkey} onCancel={backToHotkey} />
        </div>
      {:else if mode === "search"}
        <div class="results">
          {#each sResults as f, i (f.group + f.key)}
            <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
            <div class="res" class:active={i === sIndex} on:pointerenter={() => (sIndex = i)} on:click={() => { mode = "hotkey"; activate(f); }}>
              <span class="hk">{f.key}</span>
              <span class="rlabel">{f.label}</span>
              <span class="rgrp">{f.group}</span>
            </div>
          {/each}
          {#if sResults.length === 0}<div class="empty">No matching property</div>{/if}
        </div>
      {:else}
        {#each groups as grp}
          <div class="group">
            <div class="gtitle">{grp.name}</div>
            {#each grp.fields as f (f.key)}
              <div class="field" class:editing={activeKey === f.key}>
                <span class="hk">{f.key}</span>
                {#if f.kind === "number"}
                  <span class="label scrubbable" use:scrub={{ get: () => Number(f.get()), step: f.step ?? 1, onStep: (v) => f.apply(v) }}>{f.label}</span>
                {:else}
                  <span class="label">{f.label}</span>
                {/if}
                <span class="control">
                  {#if f.kind === "color"}
                    {@const cd = colorDisplay(f)}
                    <button class="colorbtn" on:click={() => activate(f)}>
                      <span class="dot" style={`background:${cd.hex}`}></span>
                      <span class="cname">{cd.name}</span>
                    </button>
                  {:else if f.kind === "toggle"}
                    <button class="toggle" class:on={Boolean(f.get())} on:click={() => f.apply(true)}>
                      {f.get() ? "on" : "off"}
                    </button>
                  {:else if f.kind === "select"}
                    <select
                      bind:this={inputs[f.key]}
                      value={String(f.get())}
                      on:change={(e) => { f.apply(e.currentTarget.value); backToHotkey(); }}
                      on:keydown={(e) => onFieldKey(e)}
                    >
                      {#each f.options ?? [] as o}<option value={o.value}>{o.label}</option>{/each}
                    </select>
                  {:else if f.kind === "text"}
                    <input
                      bind:this={inputs[f.key]}
                      class="tin"
                      value={String(f.get())}
                      spellcheck="false"
                      on:input={(e) => f.apply(e.currentTarget.value)}
                      on:keydown={(e) => onFieldKey(e)}
                    />
                  {:else}
                    <input
                      bind:this={inputs[f.key]}
                      class="nin"
                      type="text"
                      inputmode="decimal"
                      spellcheck="false"
                      value={f.get()}
                      on:input={(e) => { const v = evalExpr(e.currentTarget.value); if (v != null) f.apply(v); }}
                      on:keydown={(e) => onFieldKey(e)}
                    />
                  {/if}
                </span>
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>

    <div class="foot">
      <span><b class="hk">s</b> search</span>
      <span><b class="hk">f</b>/esc close</span>
      <span>hotkeys jump to a property</span>
    </div>
    </div>
    </div>
  </div>
{/if}

<style>
  .fbackdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.28);
    z-index: 300;
  }
  .fwrap {
    position: fixed;
    inset: 0;
    z-index: 301;
    display: flex;
    pointer-events: none;
  }
  /* Animatable custom properties (Chromium @property = smooth interpolation).
     Inherited so the panel's entrance transition can drive the frame + content
     children. Both rest at 1 (fully drawn / fully shown). */
  @property --draw {
    syntax: "<number>";
    inherits: true;
    initial-value: 1;
  }
  @property --content {
    syntax: "<number>";
    inherits: true;
    initial-value: 1;
  }

  .fluxFigMenu {
    pointer-events: auto;
    position: relative;
    border-radius: var(--r-3);
    color: var(--c-tx);
    font-family: var(--font-serif);
    outline: none;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    max-height: 78vh;
    will-change: transform, opacity;
    /* Quiet glass: surface tint (opacity from settings) + a faint top sheen. */
    background:
      linear-gradient(
        180deg,
        color-mix(in oklab, var(--c-tx-hi) 6%, transparent),
        transparent 42%
      ),
      color-mix(in oklab, var(--c-surface) calc(var(--fa, 0.94) * 100%), transparent);
    backdrop-filter: blur(16px) saturate(120%);
    -webkit-backdrop-filter: blur(16px) saturate(120%);
    /* depth + a soft blue glow halo so the accent outline reads as distinct */
    box-shadow:
      var(--elev-3),
      0 0 26px -6px var(--c-accent-glow);
  }

  /* The drawn accent frame: a real SVG stroke that draws the rounded rectangle
     (two mirrored half-paths sealing at the bottom), driven by --draw (0..1) via
     stroke-dashoffset. At rest --draw = 1 → fully drawn (it IS the border). */
  .frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 3;
    pointer-events: none;
    overflow: visible;
  }
  .fline {
    fill: none;
    stroke: var(--c-accent-bright);
    stroke-width: 2;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
    stroke-dasharray: 100;
    stroke-dashoffset: calc((1 - var(--draw, 1)) * 100);
    /* the line glows as it draws — the inner halo reads as luminous ink */
    filter: drop-shadow(0 0 2.5px var(--c-accent-glow));
  }

  /* Content rises in once the frame is set (--content 0..1; rest = 1). */
  .fcontent {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    opacity: var(--content, 1);
    transform: translateY(calc((1 - var(--content, 1)) * 6px));
  }
  .hk {
    color: var(--c-accent-bright);
    font-weight: 700;
    font-family: var(--font-serif);
  }
  .search-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px;
    padding: 10px 14px;
    background: color-mix(in oklab, var(--c-tx-hi) 4%, transparent);
    border: 1px solid var(--c-line);
    border-radius: 9px;
  }
  .search-row.active {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px var(--c-accent-tint);
  }
  .search-fake {
    flex: 1;
    text-align: left;
    background: none;
    border: none;
    color: var(--c-tx-muted);
    font-size: 19px;
    font-family: inherit;
    cursor: text;
  }
  .search-in {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--c-tx);
    font-size: 19px;
    font-family: inherit;
  }
  .body {
    overflow-y: auto;
    padding: 0 12px;
  }
  .group {
    margin-bottom: 14px;
  }
  .gtitle {
    font-size: 12px;
    letter-spacing: 0.4px;
    opacity: 0.5;
    margin: 6px 2px 6px;
    text-transform: capitalize;
  }
  .field {
    display: grid;
    grid-template-columns: 16px 1fr 130px;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    border-radius: 7px;
  }
  .field.editing {
    background: var(--c-accent-tint);
    box-shadow: inset 0 0 0 1px var(--c-accent);
  }
  .label {
    font-style: italic;
    font-size: 15px;
  }
  .control {
    display: flex;
    justify-content: flex-end;
  }
  .nin,
  .tin,
  select {
    width: 100%;
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    padding: 5px 8px;
    font-size: 14px;
    font-family: inherit;
    outline: none;
  }
  .nin:focus,
  .tin:focus,
  select:focus {
    border-color: var(--c-accent);
  }
  .colorbtn {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-end;
    width: 100%;
    background: none;
    border: none;
    color: var(--c-tx);
    cursor: pointer;
    font-family: inherit;
  }
  .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--c-line-strong);
  }
  .cname {
    font-style: italic;
    font-size: 14px;
    color: var(--c-accent-bright);
  }
  .toggle {
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    color: var(--c-tx);
    padding: 4px 12px;
    cursor: pointer;
    font-family: inherit;
    font-style: italic;
  }
  .toggle.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .color-mode {
    padding: 6px 2px 14px;
  }
  .cm-head {
    font-style: italic;
    font-size: 15px;
    margin-bottom: 10px;
  }
  .results {
    padding: 4px 0 10px;
  }
  .res {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 7px 8px;
    border-radius: 7px;
    cursor: pointer;
  }
  .res.active {
    background: var(--c-accent);
    color: var(--c-on-accent);
  }
  .res.active .hk {
    color: var(--c-on-accent);
  }
  .rlabel {
    font-style: italic;
    font-size: 15px;
  }
  .rgrp {
    font-size: 12px;
    opacity: 0.55;
    text-transform: capitalize;
  }
  .empty {
    opacity: 0.45;
    padding: 14px;
    text-align: center;
  }
  .foot {
    display: flex;
    gap: 16px;
    padding: 9px 16px;
    border-top: 1px solid var(--c-line);
    font-size: 12px;
    color: var(--c-tx-muted);
  }
</style>
