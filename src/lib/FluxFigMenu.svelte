<script lang="ts">
  // The property menu — `f` (2026-09-15 surface redesign). The principal way
  // of editing object properties without the right rail: left hand on the
  // keyboard, right hand on the mouse, and neither ever has to leave.
  //
  //   · It opens INSTANTLY beside the selection (ui/anchor.ts — right of the
  //     selection box, else left/below/above, never covering it), aligned to
  //     the pointer, and lays its groups out in COLUMNS so it never scrolls.
  //   · Every property has a left-hand hotkey (the letter on its row). Pressing
  //     it ARMS the row: a number then follows the mouse WHEEL (speed-scaled:
  //     a flick moves fast, a slow roll moves one step; Shift ×10, Alt ×0.1)
  //     or the arrow keys, typed digits replace it, and Space / Enter confirm;
  //     a choice expands its options inline (wheel / w·a·s·d / 1–9 / click);
  //     a colour opens the palette picker (hover previews, click commits);
  //     a toggle flips at once. Escape reverts the armed edit, Escape again
  //     (or f) closes. Hovering any numeric row and rolling the wheel edits it
  //     directly — the whole menu is usable with the mouse alone as well.
  //   · Every armed edit is ONE undo entry (editSession), previewed live.
  //
  // The field model (labels, hotkeys, readers, live appliers, ranges) lives in
  // interact/propertyMenu.ts, shared with the Inspector's part section.
  import { onDestroy, tick } from "svelte";
  import { get } from "svelte/store";
  import { editSession } from "./interact/editSession";
  import { selectionTargets } from "./interact/selectionTargets";
  import { buildMenuFields, groupFields, fieldRange, setDimensionBase, type Field } from "./interact/propertyMenu";
  import { anchorPanel, reclampPanel, unionRects, type Rect } from "./ui/anchor";
  import { WheelStepper, wheelDelta, wheelMultiplier } from "./interact/wheelLaw";
  import { project, selection, partSelection, partSelections } from "./store";
  import { plotManifests } from "./plot/store";
  import { globalTextStyles, loadGlobalTextStyles } from "./textStyles";
  import { evalExpr, fmtNum } from "./num";
  import { scrub } from "./scrub";
  import { nameForHex } from "./colors";
  import { fluxFigMenuOpen } from "./settings";
  import ColorPicker from "./ColorPicker.svelte";
  import Logomark from "../shell/Logomark.svelte";
  import { elementLabel } from "./xray/buildXrayTree";
  import { buildPartIndex } from "./plot/parse";
  import type { Element as FluxElement, Figure } from "./types";

  type Mode = "hotkey" | "field" | "option" | "color" | "search";

  const session = editSession();
  onDestroy(() => session.finish());

  let mode: Mode = "hotkey";
  let activeKey: string | null = null;
  let colorField: Field | null = null;
  let draft = "";
  let optIndex = 0;
  let search = "";
  let sIndex = 0;
  let panelEl: HTMLDivElement;
  let searchEl: HTMLInputElement;
  let inputs: Record<string, HTMLInputElement | undefined> = {};

  // (Re)build the field list whenever the selection / part selection or its
  // data changes (the global style library too — it feeds the style fields).
  $: fields = $fluxFigMenuOpen ? buildMenuFields($project, $selection, $partSelections, $plotManifests, $globalTextStyles) : [];
  $: groups = groupFields(fields);
  $: cols = fields.length > 18 ? 3 : fields.length > 8 ? 2 : 1;
  $: width = cols === 3 ? 900 : cols === 2 ? 616 : 328;
  $: sQ = search.trim().toLowerCase();
  $: sResults = sQ ? fields.filter((f) => `${f.label} ${f.group} ${f.key}`.toLowerCase().includes(sQ)) : fields;
  $: if (sIndex >= sResults.length) sIndex = Math.max(0, sResults.length - 1);
  $: active = activeKey ? (fields.find((f) => f.key === activeKey) ?? null) : null;
  // The header names the THING (owner request 2026-09-15): the Flux mark, a
  // hairline, then the same name the Layers rail shows — "rect 1", a plot's
  // file name, a custom name — and for a part the plot › part; `.ctx` carries
  // the kind or the plural count so the plural pick still reads "2 plot parts".
  $: head = describeHead($selection, $partSelections, $project, $plotManifests);
  function describeHead(
    sel: Set<string>,
    parts: { elementId: string; partId: string }[],
    p: typeof $project,
    manifests: typeof $plotManifests,
  ): { name: string; ctx: string } {
    const find = (id: string): { f: Figure; e: FluxElement } | null => {
      for (const f of p.figures) {
        const e = f.elements.find((x) => x.id === id);
        if (e) return { f, e };
      }
      return null;
    };
    if (parts.length) {
      const first = find(parts[0].elementId);
      const plotName = first ? elementLabel(first.f, first.e, manifests) : "plot";
      const plots = new Set(parts.map((pt) => pt.elementId)).size;
      if (parts.length === 1) {
        const m = first?.e.type === "plot" ? manifests[first.e.assetId] : undefined;
        const info = m ? buildPartIndex(m)[parts[0].partId] : undefined;
        const label =
          info?.label ??
          ([info?.role, info?.series, info?.index !== undefined ? `#${info.index}` : null].filter(Boolean).join(" · ") || parts[0].partId);
        return { name: `${plotName} › ${label}`, ctx: "plot part" };
      }
      return { name: plots > 1 ? `${plots} plots` : plotName, ctx: `${parts.length} plot parts` };
    }
    if (!sel.size) return { name: "Drawing defaults", ctx: "" };
    const kinds = new Map<string, number>();
    let single: { f: Figure; e: FluxElement } | null = null;
    for (const f of p.figures)
      for (const e of f.elements)
        if (sel.has(e.id)) {
          kinds.set(e.type, (kinds.get(e.type) ?? 0) + 1);
          single ??= { f, e };
        }
    const list = [...kinds].map(([k, n]) => (n > 1 ? `${n} ${k}s` : k)).join(", ");
    if (sel.size === 1 && single) {
      const name = elementLabel(single.f, single.e, manifests);
      return { name, ctx: name.startsWith(single.e.type) ? "" : single.e.type };
    }
    return { name: `${sel.size} selected`, ctx: list };
  }

  // --- pointer + placement -----------------------------------------------------
  // The last pointer position is the anchor's second input; tracking it costs
  // one assignment per move (no reactivity).
  const pointer = { x: -1, y: -1 };
  function onPointerMove(e: PointerEvent) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  }
  let pos = { x: 0, y: 0 };
  let placed = false;
  let sizeObs: ResizeObserver | null = null;

  /** The screen box the panel must not cover: the canvas's selection box(es),
   *  else the selected elements' own DOM boxes. */
  function avoidRect(): Rect | null {
    const rects: Rect[] = [];
    for (const n of document.querySelectorAll<Element>(".canvas-host .sel-box")) {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    if (!rects.length) {
      for (const id of get(selection)) {
        const n = document.querySelector<Element>(`.canvas-host [data-editor-element-id="${CSS.escape(id)}"]`);
        const r = n?.getBoundingClientRect();
        if (r && r.width > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
    }
    // Opened from the X-ray (Show Properties): land beside the X-ray too, so
    // the tree stays readable while its rows are being edited.
    const xr = document.querySelector<Element>(".xray")?.getBoundingClientRect();
    if (xr && xr.width > 0) rects.push({ x: xr.left, y: xr.top, w: xr.width, h: xr.height });
    return unionRects(rects);
  }
  async function place() {
    placed = false;
    await tick();
    const el = panelEl;
    if (!el) return;
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const vp = { w: window.innerWidth, h: window.innerHeight };
    const pt = pointer.x >= 0 ? { x: pointer.x, y: pointer.y } : null;
    const r = anchorPanel({ avoid: avoidRect(), point: pt, size, viewport: vp });
    pos = { x: r.x, y: r.y };
    placed = true;
    sizeObs?.disconnect();
    sizeObs = new ResizeObserver(() => {
      // A mode switch (the palette, an expanded choice) changes the height:
      // keep the origin, stay on screen.
      const p = reclampPanel(pos, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
      if (p.x !== pos.x || p.y !== pos.y) pos = p;
    });
    sizeObs.observe(el);
  }

  // Reset state each time the menu opens (+ refresh the global style library
  // so the style fields list current definitions).
  let prevOpen = false;
  $: {
    if ($fluxFigMenuOpen && !prevOpen) {
      reset();
      loadGlobalTextStyles();
      void place();
    }
    if (!$fluxFigMenuOpen && prevOpen) {
      session.finish();
      sizeObs?.disconnect();
      sizeObs = null;
    }
    prevOpen = $fluxFigMenuOpen;
  }
  onDestroy(() => sizeObs?.disconnect());
  function reset() {
    session.finish();
    setDimensionBase(null);
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    search = "";
    sIndex = 0;
    wheel.reset();
    requestAnimationFrame(() => panelEl?.focus({ preventScroll: true }));
  }

  // --- interaction ---------------------------------------------------------------
  function close() {
    session.finish();
    fluxFigMenuOpen.set(false);
  }
  function focusPanel() {
    requestAnimationFrame(() => panelEl?.focus({ preventScroll: true }));
  }
  function captureDimBase() {
    const base = new Map<string, { w: number; h: number }>();
    for (const fig of get(project).figures)
      for (const e of selectionTargets(fig, get(selection), { editable: true }))
        if ("width" in e && "height" in e) base.set(e.id, { w: e.width, h: e.height });
    setDimensionBase(base);
  }
  function enterField(f: Field) {
    if ((mode === "field" || mode === "option") && activeKey === f.key) return;
    session.finish();
    captureDimBase();
    activeKey = f.key;
    draft = f.mixed ? "" : String(f.get());
    mode = f.kind === "select" ? "option" : "field";
    if (f.kind === "select") optIndex = Math.max(0, (f.options ?? []).findIndex((o) => o.value === String(f.get())));
    wheel.reset();
  }
  function applyField(f: Field, value: string | number | boolean) {
    if (f.kind !== "toggle" && f.kind !== "action" && !f.mixed && String(value) === String(f.get())) return;
    session.run(() => f.apply(value));
  }
  function activate(f: Field) {
    session.finish();
    if (f.kind === "color") {
      colorField = f;
      activeKey = f.key;
      mode = "color";
      return;
    }
    if (f.kind === "toggle" || f.kind === "action") {
      applyField(f, true);
      session.finish();
      return;
    }
    enterField(f);
    requestAnimationFrame(() => {
      const el = inputs[f.key];
      if (f.kind === "select") {
        panelEl?.focus({ preventScroll: true });
        return;
      }
      el?.focus();
      if (el instanceof HTMLInputElement) el.select();
    });
  }
  /** Confirm the armed field and return to hotkey mode. */
  function confirmField() {
    session.finish();
    activeKey = null;
    mode = "hotkey";
    setDimensionBase(null);
    focusPanel();
  }
  /** Revert the armed field and return to hotkey mode. */
  function cancelField() {
    session.cancel();
    activeKey = null;
    mode = "hotkey";
    setDimensionBase(null);
    focusPanel();
  }
  function blurField(f: Field) {
    if (activeKey !== f.key || mode !== "field") return;
    session.finish();
    activeKey = null;
    mode = "hotkey";
    setDimensionBase(null);
  }
  function enterSearch() {
    mode = "search";
    requestAnimationFrame(() => searchEl?.focus());
  }
  function backToHotkey() {
    session.finish();
    mode = "hotkey";
    activeKey = null;
    colorField = null;
    setDimensionBase(null);
    focusPanel();
  }

  // --- numeric stepping: keys + wheel ------------------------------------------------
  const precisionOf = (step: number) => (step < 1 ? Math.min(6, Math.ceil(-Math.log10(step))) : 0);
  function stepValue(f: Field, steps: number, mult = 1) {
    const step = (f.step ?? 1) * mult;
    const cur = f.mixed && draft === "" ? Number(f.get()) : (evalExpr(draft) ?? Number(f.get()));
    let v = (Number.isFinite(cur) ? cur : 0) + steps * step;
    if (f.min != null) v = Math.max(f.min, v);
    if (f.max != null) v = Math.min(f.max, v);
    v = +v.toFixed(Math.max(precisionOf(step), precisionOf(f.step ?? 1)));
    draft = fmtNum(v, f.step ?? 1);
    applyField(f, v);
  }
  // The wheel follows the ONE law in interact/wheelLaw.ts: a notch is a step
  // in every dialect (Windows 100px, a slow macOS mouse's 4px, a trackpad's
  // stream), a spin moves further, a flick doubles, Shift ×10, Alt ×0.1.
  const wheel = new WheelStepper();
  function onWheel(e: WheelEvent) {
    if (mode === "color" || mode === "search") return;
    let f: Field | null = null;
    if ((mode === "field" || mode === "option") && active) f = active;
    else {
      const row = (e.target as HTMLElement | null)?.closest<HTMLElement>(".field[data-key]");
      const key = row?.dataset.key;
      const hover = key ? (fields.find((x) => x.key === key) ?? null) : null;
      if (hover && (hover.kind === "number" || hover.kind === "select")) {
        f = hover;
        enterField(hover); // arms it — the whole menu is mouse-only editable
        if (hover.kind === "number") requestAnimationFrame(() => { const el = inputs[hover.key]; el?.focus({ preventScroll: true }); el?.select(); });
      }
    }
    if (!f) return; // nothing armed under the pointer: let the body scroll
    e.preventDefault();
    e.stopPropagation();
    const steps = wheel.steps({ deltaY: wheelDelta(e), deltaMode: e.deltaMode, time: performance.now() });
    if (!steps) return;
    if (f.kind === "number") stepValue(f, steps, wheelMultiplier(e)); // wheel up = increase
    else if (f.kind === "select") moveOption(f, steps > 0 ? -1 : 1);
  }

  // --- option strips ------------------------------------------------------------------
  function moveOption(f: Field, d: number) {
    const opts = f.options ?? [];
    if (!opts.length) return;
    optIndex = Math.max(0, Math.min(opts.length - 1, optIndex + d));
    applyField(f, opts[optIndex].value);
  }
  function previewOption(f: Field, i: number) {
    optIndex = i;
    applyField(f, (f.options ?? [])[i]?.value ?? "");
  }
  function pickOption(f: Field, i: number) {
    previewOption(f, i);
    confirmField();
  }

  // --- keyboard ---------------------------------------------------------------------------
  function onWin(e: KeyboardEvent) {
    if (e.defaultPrevented || !$fluxFigMenuOpen) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.matches("input, textarea, select") || t.isContentEditable);
    const k = e.key;
    const lk = k.toLowerCase();
    if (mode === "hotkey") {
      if (typing) return;
      if (k === "Escape" || lk === "f") {
        // stopImmediatePropagation prevents the global shortcut handler from
        // re-processing the same key (e.g. re-opening on the closing "f").
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
        return;
      }
      if (lk === "s") {
        e.preventDefault();
        e.stopImmediatePropagation();
        enterSearch();
        return;
      }
      const f = fields.find((fl) => fl.key === lk);
      if (f) {
        e.preventDefault();
        e.stopImmediatePropagation();
        activate(f);
      }
      return;
    }
    if (mode === "option" && active) {
      const f = active;
      e.stopImmediatePropagation();
      if (k === "Escape") { e.preventDefault(); cancelField(); return; }
      if (k === "Enter" || k === " ") { e.preventDefault(); confirmField(); return; }
      if (k === "ArrowDown" || k === "ArrowRight" || lk === "s" || lk === "d") { e.preventDefault(); moveOption(f, 1); return; }
      if (k === "ArrowUp" || k === "ArrowLeft" || lk === "w" || lk === "a") { e.preventDefault(); moveOption(f, -1); return; }
      if (/^[1-9]$/.test(k)) {
        const i = Number(k) - 1;
        if (i < (f.options ?? []).length) { e.preventDefault(); pickOption(f, i); }
        return;
      }
      if (lk === "f") { e.preventDefault(); confirmField(); close(); }
      return;
    }
    // field / color / search modes: the focused control owns the keys.
  }
  function onFieldKey(e: KeyboardEvent, f: Field) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); cancelField(); return; }
    if (e.key === "Enter" || (e.key === " " && f.kind === "number")) { e.preventDefault(); confirmField(); return; }
    if (f.kind === "number" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      stepValue(f, e.key === "ArrowUp" ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    }
  }
  function onSearchKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "ArrowDown") { e.preventDefault(); sIndex = Math.min(sResults.length - 1, sIndex + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sIndex = Math.max(0, sIndex - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const f = sResults[sIndex];
      if (f) { mode = "hotkey"; activate(f); }
    } else if (e.key === "Escape") { e.preventDefault(); backToHotkey(); }
  }

  function colorDisplay(f: Field): { hex: string; name: string } {
    const hex = String(f.get());
    return { hex, name: hex === "none" ? "none" : (nameForHex(hex) ?? hex) };
  }
  const pct = (f: Field): number => {
    const r = fieldRange(f);
    if (!r) return 0;
    const v = Number(f.get());
    return Math.max(0, Math.min(100, ((v - r.min) / (r.max - r.min)) * 100));
  };
</script>

<svelte:window on:keydown={onWin} on:pointermove={onPointerMove} />

{#if $fluxFigMenuOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fbackdrop" on:pointerdown={close}></div>
  <div class="fwrap">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_static_element_interactions -->
    <div
      class="fluxFigMenu"
      class:placed
      bind:this={panelEl}
      tabindex="-1"
      role="dialog"
      aria-label="Properties"
      style={`left:${pos.x}px; top:${pos.y}px; width:${width}px;`}
      on:pointerdown|stopPropagation
      on:wheel|nonpassive={onWheel}
    >
      <div class="fcontent">
        <header class="menu-head">
          <span class="mark" aria-hidden="true"><Logomark size={14} /></span>
          <span class="vsep" aria-hidden="true"></span>
          <span class="ttl">{head.name}</span>
          {#if head.ctx}<span class="ctx">{head.ctx}</span>{/if}
          <button class="xbtn" on:click={close} aria-label="Close properties">×</button>
        </header>
        <div class="search-row" class:active={mode === "search"}>
          <span class="hk">s</span>
          {#if mode === "search"}
            <input bind:this={searchEl} bind:value={search} class="search-in" placeholder="Search properties & actions…" spellcheck="false" on:keydown={onSearchKey} />
          {:else}
            <button class="search-fake" on:click={enterSearch}>Search properties & actions…</button>
          {/if}
        </div>

        <div class="body" class:cols2={cols === 2} class:cols3={cols === 3}>
          {#if mode === "color" && colorField}
            <div class="color-mode">
              <div class="cm-head"><span class="hk">{colorField.key}</span> {colorField.label}</div>
              <ColorPicker target={colorField.target ?? "fill"} allowNone={colorField.label !== "text color" && colorField.label !== "text colour"} onDone={backToHotkey} onCancel={backToHotkey} />
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
            {#each groups as grp (grp.name)}
              <div class="group">
                <div class="gtitle">{grp.name}</div>
                {#each grp.fields as f (f.key)}
                  {@const armed = activeKey === f.key && mode !== "hotkey"}
                  {@const range = fieldRange(f)}
                  <div class="field" class:editing={armed} class:opts-open={armed && f.kind === "select"} data-key={f.key}>
                    <span class="hk">{f.key}</span>
                    {#if f.kind === "number"}
                      <span class="label scrubbable" use:scrub={{ get: () => Number(f.get()), step: f.step ?? 1, min: f.min ?? null, max: f.max ?? null, onStart: () => enterField(f), onStep: (v) => { draft = String(v); applyField(f, v); }, onEnd: () => blurField(f), onCancel: () => { session.cancel(); blurField(f); } }}>{f.label}</span>
                    {:else}
                      <span class="label">{f.label}</span>
                    {/if}
                    <span class="control">
                      {#if f.kind === "color"}
                        {@const cd = colorDisplay(f)}
                        <button class="colorbtn" on:click={() => activate(f)} title="Palette (hover previews, click applies)">
                          <span class="dot" class:isnone={cd.hex === "none"} style={cd.hex === "none" ? "" : `background:${cd.hex}`}></span>
                          <span class="cname">{cd.name}</span>
                        </button>
                      {:else if f.kind === "toggle"}
                        <button class="toggle" class:on={Boolean(f.get())} on:click={() => activate(f)}>{f.get() ? "on" : "off"}</button>
                      {:else if f.kind === "action"}
                        <button class="actbtn" on:click={() => activate(f)}>run</button>
                      {:else if f.kind === "select"}
                        {@const opts = f.options ?? []}
                        {@const cur = String(f.get())}
                        {#if armed}
                          <span class="opts" role="listbox" aria-label={f.label}>
                            {#each opts as o, i (o.value)}
                              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                              <span class="opt" class:cur={i === optIndex} role="option" tabindex="-1" aria-selected={i === optIndex}
                                on:pointerenter={() => previewOption(f, i)} on:click={() => pickOption(f, i)}>
                                {#if i < 9}<span class="ok">{i + 1}</span>{/if}{o.label}
                              </span>
                            {/each}
                          </span>
                        {:else}
                          <button class="selbtn" on:click={() => activate(f)} title="Choose (wheel, w·a·s·d, 1–9)">{opts.find((o) => o.value === cur)?.label ?? (cur || "—")}<span class="chev">▾</span></button>
                        {/if}
                      {:else if f.kind === "text"}
                        <input
                          bind:this={inputs[f.key]}
                          class="tin"
                          value={activeKey === f.key ? draft : String(f.get())}
                          spellcheck="false"
                          on:focus={() => enterField(f)}
                          on:blur={() => blurField(f)}
                          on:input={(e) => { draft = e.currentTarget.value; applyField(f, draft); }}
                          on:keydown={(e) => onFieldKey(e, f)}
                        />
                      {:else}
                        <span class="numwrap" class:ranged={!!range}>
                          <input
                            bind:this={inputs[f.key]}
                            class="nin"
                            type="text"
                            inputmode="decimal"
                            spellcheck="false"
                            placeholder={f.mixed ? "Mixed" : ""}
                            title={f.count && $selection.size > 1 ? `Applies to ${f.count} of ${$selection.size} selected objects` : f.label}
                            value={activeKey === f.key ? draft : f.mixed ? "" : fmtNum(Number(f.get()), f.step ?? 1)}
                            on:focus={() => enterField(f)}
                            on:blur={() => blurField(f)}
                            on:input={(e) => { draft = e.currentTarget.value; const v = evalExpr(draft); if (v != null) applyField(f, v); }}
                            on:keydown={(e) => onFieldKey(e, f)}
                          />
                          {#if range}<span class="track" aria-hidden="true"><span class="fill" style={`width:${pct(f)}%`}></span></span>{/if}
                        </span>
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
          <span><b class="hk">↕</b> wheel adjusts</span>
          <span><b class="hk">␣</b> applies</span>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Transparent catcher: a surface, not a modal — clicking elsewhere closes. */
  .fbackdrop { position: fixed; inset: 0; background: transparent; z-index: 300; }
  .fwrap { position: fixed; inset: 0; z-index: 301; pointer-events: none; }
  .fluxFigMenu {
    pointer-events: auto;
    position: absolute;
    visibility: hidden;
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 16px);
    color: var(--c-tx);
    font-family: var(--font-ui);
    font-size: 12px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-2);
    outline: none;
    overflow: hidden;
  }
  .fluxFigMenu.placed { visibility: visible; animation: fm-in 70ms var(--ease-standard) 1; }
  @media (prefers-reduced-motion: reduce) { .fluxFigMenu.placed { animation: none; } }
  @keyframes fm-in { from { opacity: 0; } to { opacity: 1; } }
  .fcontent { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; opacity: 1; }
  .menu-head { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--c-line); background: var(--c-bg-raised); }
  .mark { display: inline-flex; width: 14px; height: 14px; flex-shrink: 0; }
  .vsep { width: 1px; height: 14px; background: var(--c-line-strong); flex-shrink: 0; }
  .ttl { font-weight: 600; color: var(--c-tx-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .ctx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-muted); font-size: 11px; }
  .xbtn { width: 22px; height: 22px; padding: 0; background: none; border: 0; color: var(--c-tx-muted); font-size: 16px; cursor: pointer; border-radius: var(--r-ui); }
  .xbtn:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  .hk {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 16px; height: 16px; padding: 0 3px;
    font: 600 10.5px var(--font-mono); color: var(--c-accent);
    background: var(--c-accent-tint); border-radius: var(--r-ui);
  }
  .search-row { display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border-bottom: 1px solid var(--c-line); }
  .search-row.active { box-shadow: inset 0 -1px 0 var(--c-accent); }
  .search-fake { flex: 1; text-align: left; background: none; border: none; color: var(--c-tx-muted); font: 12px var(--font-ui); cursor: text; padding: 0; }
  .search-in { flex: 1; background: none; border: none; outline: none; color: var(--c-tx); font: 12px var(--font-ui); padding: 0; }
  .body { overflow-y: auto; padding: 6px 8px 8px; }
  .body.cols2 { columns: 2; column-gap: 8px; }
  .body.cols3 { columns: 3; column-gap: 8px; }
  .group { break-inside: avoid; padding: 4px 0 6px; }
  .gtitle { font: 600 10px var(--font-mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--c-tx-muted); padding: 6px 4px 3px; border-bottom: 1px solid var(--c-line); margin-bottom: 3px; }
  .field { display: grid; grid-template-columns: 18px minmax(0, 1fr) minmax(92px, 118px); align-items: center; gap: 8px; min-height: 26px; padding: 1px 4px; border-radius: var(--r-0); }
  .field.editing { background: var(--c-accent-tint); box-shadow: inset 2px 0 0 var(--c-accent); }
  .field.opts-open { grid-template-columns: 18px minmax(0, 1fr); }
  .field.opts-open .control { grid-column: 1 / -1; justify-content: flex-start; padding: 2px 0 4px 26px; }
  .label { font-size: 12px; color: var(--c-tx); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scrubbable { cursor: ew-resize; }
  .control { display: flex; justify-content: flex-end; min-width: 0; }
  .numwrap { position: relative; width: 100%; }
  .nin, .tin { width: 100%; height: 22px; background: var(--c-bg); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx); padding: 0 6px; font: 12px var(--font-mono); font-variant-numeric: tabular-nums; outline: none; box-sizing: border-box; text-align: right; }
  .tin { font-family: var(--font-ui); text-align: left; }
  .nin:focus, .tin:focus { border-color: var(--c-accent); }
  .track { position: absolute; left: 4px; right: 4px; bottom: 2px; height: 2px; background: color-mix(in oklab, var(--c-line-strong) 70%, transparent); pointer-events: none; }
  .track .fill { display: block; height: 100%; background: var(--c-tx-muted); }
  .field.editing .track .fill { background: var(--c-accent); }
  .colorbtn { display: flex; align-items: center; gap: 6px; justify-content: flex-end; width: 100%; height: 22px; background: none; border: 1px solid transparent; border-radius: var(--r-ui); color: var(--c-tx); cursor: pointer; font: 12px var(--font-ui); padding: 0 4px; }
  .colorbtn:hover { border-color: var(--c-line-strong); }
  .dot { width: 14px; height: 14px; border-radius: var(--r-ui); border: 1px solid color-mix(in oklab, var(--c-tx-hi) 14%, transparent); flex: none; }
  .dot.isnone { background: repeating-linear-gradient(-45deg, transparent 0 3px, var(--c-line-strong) 3px 4px); }
  .cname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-2); font-family: var(--font-mono); font-size: 11px; }
  .toggle, .actbtn, .selbtn { height: 22px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); padding: 0 8px; cursor: pointer; font: 12px var(--font-ui); }
  .toggle:hover, .actbtn:hover, .selbtn:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .toggle { min-width: 44px; }
  .toggle.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .selbtn { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px; overflow: hidden; white-space: nowrap; }
  .selbtn .chev { color: var(--c-tx-muted); font-size: 9px; }
  .opts { display: flex; flex-wrap: wrap; gap: 3px; }
  .opt { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 7px 0 4px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); color: var(--c-tx-2); cursor: pointer; font-size: 12px; white-space: nowrap; }
  .opt .ok { font: 600 9.5px var(--font-mono); color: var(--c-tx-muted); min-width: 10px; }
  .opt.cur { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .opt.cur .ok { color: var(--c-accent); }
  .color-mode { padding: 6px 4px 8px; }
  .cm-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--c-tx); margin-bottom: 8px; }
  .results { padding: 2px 0 6px; }
  .res { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; align-items: center; height: 26px; padding: 0 6px; cursor: pointer; }
  .res.active { background: var(--c-accent-tint); box-shadow: inset 2px 0 0 var(--c-accent); color: var(--c-tx-hi); }
  .rlabel { font-size: 12px; }
  .rgrp { font: 10px var(--font-mono); color: var(--c-tx-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .empty { color: var(--c-tx-muted); padding: 12px; text-align: center; }
  .foot { display: flex; gap: 14px; height: 26px; align-items: center; padding: 0 10px; border-top: 1px solid var(--c-line); font-size: 11px; color: var(--c-tx-muted); background: var(--c-bg-raised); }
</style>
