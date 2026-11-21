<script lang="ts">
  /**
   * The TIFF asking surface: what the file does not say, asked on the canvas where the image will land, in the image
   * board's language (dark plate and cards, paper keys, pink for what the hand takes, one hint line, nothing moving
   * at rest). Not a dialog with a form in it: the PAGES are a strip of keys you drag and roll, the pictures redraw
   * as the answer changes, the numbers are written in place.
   *
   * From the top: the file and its facts; what the file suggests (the ranked proposals, each a key); one picture per
   * channel of the answer (a hovered key shows what it would do before anything is written); the pages as keys,
   * slowest first, fastest last, each with its size, one of them "the rest"; turn and flip; pixel size, rate or
   * interval, z step; a value that means no data (when the plane suggests one); how values are stored; remember for
   * files like this; the hint line; Convert, the one lit key, off with its reason until the answer fits the file.
   *
   * It changes nothing itself: every edit is an `askOps` function handed to `tiffImport.askSet`.
   *
   * Keys (left hand, as on the board): 1-9 a proposal; T transpose; F flip left-right, Shift+F top-bottom; S compact
   * or lossless; D the no-data value; M remember (off, this project, every project); A add a page key; on a focused
   * page key Space renames, digits size, Alt+arrows move, Delete removes; Enter converts; Esc leaves without a trace.
   */
  import { get } from "svelte/store";
  import { yieldsToShellModal, isAnnotateChord } from "../../shell/agent/annotationVisibility";
  import PaperKey from "./live/PaperKey.svelte";
  import AskEdit from "./AskEdit.svelte";
  import { tiffAsk } from "./tiffAsk";
  import { askCancel, askChoose, askConvert, askForget, askHover, askRemember, askSet } from "./tiffImport";
  import {
    addDim, channelCount, LENGTH_UNITS, moveDim, nameProblem, nextColour, nextName, nudgeStep, parseNumber, removeDim, renameDim, resolvedSizes,
    setChannel, setDimSize, setNodata, setPixelSize, setPixelUnit, setT0, setTime, setZStep, toggle,
  } from "../tiff/askOps";
  import type { DimsAnswer } from "../tiff/types";

  let { x, y, host }: {
    /** The landing point, in the canvas host's px. */
    x: number;
    y: number;
    host: { w: number; h: number };
  } = $props();

  const s = $derived($tiffAsk);
  const PLATE_W = 400, INNER = PLATE_W - 18;
  let plateH = $state(0);
  // Beside where the image will land (a pink mark stands on that point), the right side first, else the left, else
  // over it; always whole inside the canvas, so the figure it lands on stays in view.
  const GAP = 26;
  const left = $derived.by(() => {
    const right = x + GAP, leftSide = x - GAP - PLATE_W;
    const at = right + PLATE_W <= host.w - 8 ? right : leftSide >= 8 ? leftSide : x - PLATE_W / 2;
    return Math.round(Math.max(8, Math.min(host.w - PLATE_W - 8, at)));
  });
  const top = $derived(Math.round(Math.max(8, Math.min(Math.max(8, host.h - plateH - 8), y - Math.min(plateH, 360) / 3))));
  const markShown = $derived(x >= 0 && y >= 0 && x <= host.w && y <= host.h && (x < left - 6 || x > left + PLATE_W + 6));

  const a = $derived(s?.answer ?? { dims: [] });
  const probe = $derived(s?.probe);
  const set = (next: DimsAnswer): void => askSet(next);
  const fmt = (v: number): string => String(Number(v.toPrecision(6)));
  const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
  const KIND: Record<string, string> = { none: "no metadata", imagej: "ImageJ", ome: "OME", shaped: "shape note", json: "per-page data", text: "a text note" };
  const facts = $derived(probe ? [`${probe.pages.toLocaleString("en-US")} page${probe.pages === 1 ? "" : "s"}`, `${probe.plane.width} × ${probe.plane.height}`, `${probe.plane.sampleType}${probe.plane.samples > 1 ? ` × ${probe.plane.samples}` : ""}`, fmtBytes(probe.container.bytes), KIND[probe.description.kind] ?? probe.description.kind] : []);

  // --- the pictures -----------------------------------------------------------------------------------------
  const pics = $derived(s?.hover ?? s?.preview ?? null);
  const nChan = $derived(probe ? channelCount(probe, a) : 1);
  // Each picture as large as its share of the plate allows (a row of up to three), at most 170 px tall.
  const slot = $derived.by(() => {
    const n = Math.max(1, Math.min(pics?.channels.length ?? 1, 6)), gap = 6;
    const perRow = n <= 3 ? n : Math.ceil(n / 2);
    return { w: Math.floor((INNER - 16 - gap * (perRow - 1)) / perRow), h: n > 3 ? 120 : 170 };
  });
  const fit = (w: number, h: number): { w: number; h: number } => { const k = Math.min(slot.w / w, slot.h / h); return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) }; };
  const isFloat = $derived(probe?.plane.dtype === "float32" || probe?.plane.dtype === "float64");
  const nodataOffer = $derived(isFloat ? (a.nodata != null ? a.nodata : s?.preview?.frequentMin?.value ?? null) : null);

  // --- the pages strip --------------------------------------------------------------------------------------
  const sizes = $derived(probe ? resolvedSizes(probe, a) : []);
  const product = $derived(sizes.every((v) => v !== null) ? sizes.reduce((p: number, v) => p * (v as number), 1) * 1 : null);
  const pageCount = $derived(probe ? (a.pages?.count ?? probe.pages - (a.pages?.first ?? 0)) : 0);
  let keyEls: HTMLElement[] = $state([]);
  let nameEds: Array<{ begin: (t?: string) => void } | undefined> = $state([]);
  let sizeEds: Array<{ begin: (t?: string) => void } | undefined> = $state([]);
  let naming = $state(-1); // a key whose free name is being typed
  let drag = $state.raw<{ from: number; to: number; x0: number; pointer: number; moved: boolean } | null>(null);
  const order = $derived.by(() => {
    const idx = a.dims.map((_, i) => i);
    if (!drag || !drag.moved) return idx;
    const [m] = idx.splice(drag.from, 1);
    idx.splice(drag.to, 0, m);
    return idx;
  });
  // A drag reorders the keys live (the keyed list moves its nodes, which ends a pointer capture), so the gesture
  // listens on the window until the button comes up.
  function keyDown(e: PointerEvent, i: number): void {
    if (e.button !== 0) return;
    e.stopPropagation();
    if ((e.target as Element).closest("[data-ask-edit], [data-ask-sub]")) return;
    drag = { from: i, to: i, x0: e.clientX, pointer: e.pointerId, moved: false };
    const move = (ev: PointerEvent): void => keyMove(ev);
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", up, true);
      ev.stopPropagation();
      keyUp(ev, i, ev.type === "pointercancel");
    };
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", up, true); window.addEventListener("pointercancel", up, true);
  }
  function keyMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
    e.stopPropagation();
    let to = 0;
    a.dims.forEach((_, i) => { if (i === drag!.from) return; const r = keyEls[i]?.getBoundingClientRect(); if (r && e.clientX > r.left + r.width / 2) to++; });
    drag = { ...drag, moved: true, to };
  }
  function keyUp(_e: PointerEvent, i: number, cancelled = false): void {
    const d = drag;
    drag = null;
    if (!d || cancelled) return;
    if (d.moved && d.to !== d.from && probe) set(moveDim(probe, a, d.from, d.to));
    else if (!d.moved) cycleName(i);
  }
  function cycleName(i: number): void {
    if (!probe) return;
    const n = nextName(a, i);
    if (n) { naming = -1; set(renameDim(probe, a, i, n)); }
    else { naming = i; queueMicrotask(() => nameEds[i]?.begin("")); }
  }
  function editName(i: number, text: string): boolean {
    if (!probe) return false;
    naming = -1;
    if (!text) return true;
    if (nameProblem(a, i, text)) return false;
    set(renameDim(probe, a, i, text));
    return true;
  }
  function editSize(i: number, text: string): boolean {
    if (!probe) return false;
    if (text === "*" || /^r(est)?$/i.test(text) || text === "") { set(setDimSize(probe, a, i, "rest")); return true; }
    const v = parseNumber(text);
    if (v === null || !Number.isInteger(v) || v < 1) return false;
    set(setDimSize(probe, a, i, v));
    return true;
  }

  // --- physical facts ---------------------------------------------------------------------------------------
  const unit = $derived(a.pixelSize?.unit ?? "µm");
  const hasT = $derived(a.dims.some((d) => d.name === "t"));
  const hasZ = $derived(a.dims.some((d) => d.name === "z"));
  const tKind = $derived<"rate" | "interval">(a.time?.interval !== undefined ? "interval" : "rate");
  const tFromPages = $derived(!!(a.time?.key || a.time?.coords) && a.time?.rate === undefined && a.time?.interval === undefined);
  const zFromPages = $derived(!!(a.z?.key || a.z?.coords) && a.z?.step === undefined);
  const markOf = (field: string): string => (s?.chosen !== -1 && s?.proposals[s.chosen]?.from === "remembered" ? "remembered" : s?.fileSays[field] ? "file" : "");
  function num(text: string, apply: (v: number | null) => void, positive = true): boolean {
    if (!text) { apply(null); return true; }
    const v = parseNumber(text);
    if (v === null || (positive && !(v > 0))) return false;
    apply(v);
    return true;
  }
  const nudge = (v: number | undefined, dir: 1 | -1, big: boolean): number => { const base = v ?? 0, st = nudgeStep(base || 1) * (big ? 10 : 1); return Number(Math.max(st, base + dir * st).toPrecision(6)); };

  // --- keys that preview on hover ------------------------------------------------------------------------------
  const preview = (next: DimsAnswer | null): void => askHover(next);
  const flips = $derived([
    { id: "transpose", glyph: "transpose" as const, label: "Transpose: swap x and y", hk: "T", on: !!a.transpose, next: () => toggle(a, "transpose") },
    { id: "flipX", glyph: "flipX" as const, label: "Flip left–right", hk: "F", on: !!a.flipX, next: () => toggle(a, "flipX") },
    { id: "flipY", glyph: "flipY" as const, label: "Flip top–bottom", hk: "⇧F", on: !!a.flipY, next: () => toggle(a, "flipY") },
  ]);
  const integer = $derived(!!probe && !isFloat);
  const storageWords = $derived(integer ? "Whole numbers are always stored exactly" : a.lossless ? "Lossless: every value exactly (about twice the size)" : "Compact: 16-bit steps where they stay within a tenth of neighbouring differences; else exact");
  const REMEMBER_WORDS = { off: "Remember for files like this: off", project: "Remember for files like this: this project", machine: "Remember for files like this: every project" } as const;
  const nextRemember = (): "off" | "project" | "machine" => (s?.remember === "off" ? "project" : s?.remember === "project" ? "machine" : "off");

  // --- the one hint line --------------------------------------------------------------------------------------
  let tip = $state<{ text: string; hk: string } | null>(null);
  function showTip(e: PointerEvent): void {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-tip]") : null;
    tip = el ? { text: el.dataset.tip ?? "", hk: el.dataset.hk ?? "" } : null;
  }
  const hint = $derived(tip?.text ? tip : { text: `${s?.batch.count && s.batch.count > 1 ? `File ${s.batch.index} of ${s.batch.count}: the others of its kind follow this answer. ` : ""}Enter converts · Esc leaves nothing`, hk: "" });

  // --- keyboard ---------------------------------------------------------------------------------------------
  let root = $state<HTMLDivElement>();
  function strike(id: string): void {
    const el = root?.querySelector<HTMLElement>(`[data-fxb-key="${id}"]`);
    if (!el) return;
    el.classList.add("struck");
    setTimeout(() => el.classList.remove("struck"), 130);
  }
  function focusedKey(): number {
    const el = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-ask-page]") : null;
    return el && root?.contains(el) ? Number(el.dataset.askPage) : -1;
  }
  function onKey(e: KeyboardEvent): void {
    if (!s || !probe) return;
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if (e.ctrlKey || e.metaKey) return; // undo, save, copy stay Flux-wide
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const done = (): void => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (k === "Escape") { done(); askCancel(); return; }
    if (k === "Enter") { done(); strike("convert"); askConvert(); return; }
    if (k === "Tab") return; // the browser walks the keys; nothing else moves
    const pk = focusedKey();
    if (pk >= 0) {
      if (e.altKey && (k === "ArrowLeft" || k === "ArrowRight")) { done(); const to = Math.max(0, Math.min(a.dims.length - 1, pk + (k === "ArrowRight" ? 1 : -1))); set(moveDim(probe, a, pk, to)); queueMicrotask(() => keyEls[to]?.focus()); return; }
      if (k === "ArrowLeft" || k === "ArrowRight") { done(); keyEls[Math.max(0, Math.min(a.dims.length - 1, pk + (k === "ArrowRight" ? 1 : -1)))]?.focus(); return; }
      if (k === " ") { done(); cycleName(pk); return; }
      if (/^[0-9*]$/.test(k)) { done(); sizeEds[pk]?.begin(k); return; }
      if (k === "Backspace" || k === "Delete") { done(); if (a.dims.length > 0) set(removeDim(probe, a, pk)); return; }
    }
    if (e.altKey) { done(); return; }
    done(); // everything unmodified is the surface's: nothing leaks to the canvas
    if (e.repeat) return;
    if (/^[1-9]$/.test(k) && Number(k) <= Math.min(9, s.proposals.length)) { strike(`proposal:${Number(k) - 1}`); askChoose(Number(k) - 1); return; }
    switch (k) {
      case "t": strike("transpose"); set(toggle(a, "transpose")); return;
      case "f": strike(e.shiftKey ? "flipY" : "flipX"); set(toggle(a, e.shiftKey ? "flipY" : "flipX")); return;
      case "s": if (!integer) { strike("storage"); set(toggle(a, "lossless")); } return;
      case "d": if (nodataOffer !== null) { strike("nodata"); set(setNodata(a, a.nodata != null ? null : nodataOffer)); } return;
      case "m": strike("remember"); askRemember(nextRemember()); return;
      case "a": strike("add"); set(addDim(probe, a)); return;
    }
  }
  // The wheel over a number rolls it; over the plate it does nothing else (the canvas behind never pans or zooms).
  $effect(() => {
    const el = root;
    if (!el) return;
    const wheel = (e: WheelEvent): void => {
      e.preventDefault(); e.stopPropagation();
      const t = (e.target as Element).closest<HTMLElement>("[data-ask-wheel]")?.dataset.askWheel;
      if (!t || Math.abs(e.deltaY) < 1) return;
      wheelNudge(t, e.deltaY < 0 ? 1 : -1, e.shiftKey);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  function wheelNudge(id: string, dir: 1 | -1, big: boolean): void {
    if (id === "pixel") set(setPixelSize(a, nudge(a.pixelSize?.x, dir, big)));
    else if (id === "time") set(setTime(a, tKind, nudge(tKind === "rate" ? a.time?.rate : a.time?.interval, dir, big)));
    else if (id === "zstep") set(setZStep(a, nudge(a.z?.step, dir, big)));
    else if (id.startsWith("size:") && probe) { const i = Number(id.slice(5)), v = sizes[i]; if (v !== null && a.dims[i].size !== "rest") set(setDimSize(probe, a, i, Math.max(1, v + dir * (big ? 10 : 1)))); }
  }
  // The first Tab lands in the surface.
  $effect(() => { if (s?.id && root) queueMicrotask(() => root?.focus({ preventScroll: true })); });
  const stop = (e: Event): void => { e.stopPropagation(); };
  const swallow = (e: Event): void => { e.preventDefault(); e.stopPropagation(); };
</script>

<svelte:window onkeydown={onKey} />

{#if s && probe}
  {#if markShown}<span class="land" style={`left:${Math.round(x)}px;top:${Math.round(y)}px`} aria-hidden="true" data-ask-landing></span>{/if}
  <!-- The plate swallows its own presses (nothing behind it moves); its keys are the window listener's above. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div class="fxb ask" bind:this={root} bind:offsetHeight={plateH} tabindex="-1" role="group" aria-label={`How to read ${s.name}`} data-tiff-ask={s.id}
    style={`left:${left}px;top:${top}px;width:${PLATE_W}px;max-height:${Math.max(160, host.h - 16)}px`}
    onpointerdown={swallow} onpointerup={stop} onclick={stop} ondblclick={stop} oncontextmenu={swallow} onpointerover={showTip} onpointerleave={() => (tip = null)}>
    <div class="col">
      <!-- the file -->
      <div class="card headcard">
        <div class="l1">
          <span class="live" class:wait={!!s.problem} data-tip={s.problem ? "The answer does not fit the file yet" : "The answer fits the file"}></span>
          <span class="ttl">{s.name}</span>
          {#if s.batch.count > 1}<span class="batch">{s.batch.index} of {s.batch.count}</span>{/if}
          <PaperKey quiet size={20} glyph="close" label="Leave it: nothing is converted" hotkey="Esc" id="close" onpress={() => askCancel()} />
        </div>
        <div class="l2">{#each facts as f (f)}<span class="fact">{f}</span>{/each}</div>
        {#if s.reason}<div class="reason" data-ask-reason>{s.reason}</div>{/if}
      </div>

      <!-- what the file suggests -->
      {#if s.proposals.length}
        <div class="card props" data-ask-proposals>
          {#each s.proposals.slice(0, 4) as p, i (i)}
            <button type="button" class="prop" class:on={s.chosen === i} data-fxb-key={`proposal:${i}`} data-ask-proposal={i}
              data-tip={`${p.confidence === "high" ? "Sure" : p.confidence === "medium" ? "Likely" : "A guess"}: ${p.reasons.join("; ")}`} data-hk={String(i + 1)}
              onpointerdown={stop} onclick={(e) => { e.stopPropagation(); askChoose(i); }} onpointerenter={() => preview(p.answer)} onpointerleave={() => preview(null)}>
              <span class="pips" aria-hidden="true">{#each [0, 1, 2] as k (k)}<i class:lit={k < (p.confidence === "high" ? 3 : p.confidence === "medium" ? 2 : 1)}></i>{/each}</span>
              <span class="sum">{p.summary}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- one picture per channel -->
      <div class="card pics" class:previewing={!!s.hover} data-ask-pictures>
        {#if pics}
          <div class="row">
            {#each pics.channels as c, i (i)}
              {@const box = fit(c.width, c.height)}
              {@const ch = a.channels?.[i]}
              <div class="pic">
                <span class="well" style={`width:${box.w}px;height:${box.h}px`}><img alt="" src={`data:image/png;base64,${c.png}`} width={box.w} height={box.h} class:px={box.w >= c.width * 2} data-ask-picture={i} /></span>
                {#if !s.hover && !pics.fallback && i < nChan}
                  <span class="chip">
                    <button type="button" class="dot" style={`--ink:${(ch?.color ?? c.color) ?? "#cecdc3"}`} data-ask-sub data-fxb-key={`colour:${i}`} data-tip="Colour: click for the next" aria-label={`Colour of channel ${i + 1}`}
                      onpointerdown={stop} onclick={(e) => { e.stopPropagation(); set(setChannel(probe, a, i, { color: nextColour(ch?.color !== undefined ? ch.color : c.color) })); }}></button>
                    <AskEdit kind="text" id={`chname:${i}`} value={ch?.name ?? ""} placeholder={c.name} tip="Channel name" mark={ch?.name && markOf("channels") ? markOf("channels") : ""}
                      onedit={(t) => { set(setChannel(probe, a, i, { name: t || null })); return true; }} />
                  </span>
                {/if}
              </div>
            {/each}
          </div>
          <div class="at">{#if pics.fallback}<span class="warn">the page itself: the answer does not fit yet</span>{:else}{pics.at || "the plane"}{#if pics.channelCount > pics.channels.length} · first {pics.channels.length} of {pics.channelCount} channels{/if}{/if}</div>
        {:else}
          <div class="at">drawing…</div>
        {/if}
      </div>

      <!-- the pages, slowest first, fastest last -->
      <div class="card pages" data-ask-pages>
        <div class="strip">
          {#each order as i, pos (i)}
            {@const d = a.dims[i]}
            {#if pos > 0}<span class="times" aria-hidden="true">×</span>{/if}
            <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
            <div class="pk" class:dragging={drag?.moved && drag.from === i} class:rest={d.size === "rest"} bind:this={keyEls[i]} tabindex="0" role="button" data-ask-page={i} data-fxb-key={`page:${i}`}
              data-tip={`${d.name ? `"${d.name}"` : "This dimension"}: click to rename (t, z, c or a name), drag to reorder; Space, digits, Alt+arrows, Delete`}
              aria-label={`Page dimension ${d.name || "unnamed"}, ${d.size === "rest" ? `the rest (${sizes[i] ?? "?"})` : d.size}`}
              onpointerdown={(e) => keyDown(e, i)}>
              <span class="nm">{#if naming === i}<AskEdit bind:this={nameEds[i]} kind="text" id={`name:${i}`} value="" placeholder="name" tip="A name: lower-case letters, digits, _" onedit={(t) => editName(i, t)} />{:else}{d.name || "?"}{/if}</span>
              <span class="sz" data-ask-sub>
                <AskEdit bind:this={sizeEds[i]} id={`size:${i}`} value={d.size === "rest" ? String(sizes[i] ?? "?") : String(d.size)} tip={d.size === "rest" ? "The rest: whatever the page count leaves. Type a number to fix it" : "Its size: type a number, or * for the rest"}
                  onedit={(t) => editSize(i, t)} onnudge={d.size === "rest" ? undefined : (dir, big) => wheelNudge(`size:${i}`, dir, big)} />
                {#if d.size === "rest"}<i class="restmark" data-tip="The rest of the pages">∗</i>{/if}
              </span>
            </div>
          {/each}
          {#if !a.dims.length}<span class="single">a single plane</span>{/if}
          <span class="addkey"><PaperKey size={22} glyph="add" label="Add a dimension over the pages" hotkey="A" id="add" onpress={() => set(addDim(probe, a))} /></span>
        </div>
        <div class="eq" class:bad={product !== pageCount} data-ask-equation>
          {#if a.dims.length}{a.dims.map((d, i) => `${d.name || "?"} ${sizes[i] ?? "?"}`).join(" × ")} = {product ?? "?"}{:else}1{/if}
          <span class="vs">{product === pageCount ? "=" : "≠"} {pageCount.toLocaleString("en-US")} pages</span>
          {#if a.dims.length > 1}<span class="fast">{a.dims[a.dims.length - 1].name || "?"} changes fastest</span>{/if}
          {#if probe.plane.samples > 1}
            <button type="button" class="samples" data-ask-sub data-fxb-key="samples" data-tip="Each pixel's samples: channels, or a colour photograph" onpointerdown={stop}
              onclick={(e) => { e.stopPropagation(); set({ ...a, samples: (a.samples ?? (probe.plane.photometric === 2 ? "rgb" : "c")) === "rgb" ? "c" : "rgb" }); }}>{(a.samples ?? (probe.plane.photometric === 2 && probe.plane.samples >= 3 ? "rgb" : "c")) === "rgb" ? "RGB" : `${probe.plane.samples} channels`}</button>
          {/if}
        </div>
      </div>

      <!-- turn, flip, the physical facts -->
      <div class="card facts">
        <span class="grp">
          {#each flips as f (f.id)}
            <PaperKey glyph={f.glyph} label={f.label} hotkey={f.hk} id={f.id} on={f.on} onpress={() => set(f.next())} onenter={() => preview(f.next())} onleave={() => preview(null)} />
          {/each}
        </span>
        <span class="nums">
          <span class="fq"><span class="lbl">pixel</span>
            <AskEdit id="pixel" value={a.pixelSize ? fmt(a.pixelSize.x) : ""} placeholder="size" mark={markOf("pixelSize")} tip="Pixel size (one side). Empty: no scale bar until it is known"
              onedit={(t) => num(t, (v) => set(setPixelSize(a, v)))} onnudge={(dir, big) => wheelNudge("pixel", dir, big)} />
            <button type="button" class="unit" data-ask-sub data-fxb-key="unit" data-tip="Unit: click for the next" onpointerdown={stop}
              onclick={(e) => { e.stopPropagation(); set(setPixelUnit(a, LENGTH_UNITS[(LENGTH_UNITS.indexOf(unit as never) + 1) % LENGTH_UNITS.length])); }}>{unit}</button>
          </span>
          {#if hasT}
            <span class="fq">
              {#if tFromPages}<span class="lbl">time</span><button type="button" class="unit wide" data-ask-sub data-fxb-key="time-pages" data-tip="Each frame's time comes from the pages. Click to give a rate instead" onpointerdown={stop} onclick={(e) => { e.stopPropagation(); set(setTime(a, "rate", null)); }}>from the pages</button>
              {:else}
                <AskEdit id="time" value={tKind === "rate" ? (a.time?.rate !== undefined ? fmt(a.time.rate) : "") : a.time?.interval !== undefined ? fmt(a.time.interval) : ""} placeholder={tKind === "rate" ? "rate" : "interval"} mark={markOf("time")}
                  tip={tKind === "rate" ? "Frames per second" : "Seconds between frames"} onedit={(t) => num(t, (v) => set(setTime(a, tKind, v)))} onnudge={(dir, big) => wheelNudge("time", dir, big)} />
                <button type="button" class="unit" data-ask-sub data-fxb-key="time-unit" data-tip="Rate or interval: click to switch" onpointerdown={stop}
                  onclick={(e) => { e.stopPropagation(); const v = tKind === "rate" ? a.time?.rate : a.time?.interval; set(setTime(a, tKind === "rate" ? "interval" : "rate", v ? Number((1 / v).toPrecision(6)) : null)); }}>{tKind === "rate" ? "Hz" : "s"}</button>
                <span class="lbl">t0</span><AskEdit id="t0" value={a.time?.t0 !== undefined ? fmt(a.time.t0) : ""} placeholder="0" tip="Time of the first frame (s)" onedit={(t) => num(t, (v) => set(setT0(a, v)), false)} />
              {/if}
            </span>
          {/if}
          {#if hasZ}
            <span class="fq"><span class="lbl">z step</span>
              {#if zFromPages}<button type="button" class="unit wide" data-ask-sub data-fxb-key="z-pages" data-tip="Each plane's depth comes from the pages. Click to give a step instead" onpointerdown={stop} onclick={(e) => { e.stopPropagation(); set(setZStep(a, null)); }}>from the pages</button>
              {:else}<AskEdit id="zstep" value={a.z?.step !== undefined ? fmt(a.z.step) : ""} placeholder="step" mark={markOf("z")} tip={`Distance between planes (${a.z?.unit ?? unit})`} onedit={(t) => num(t, (v) => set(setZStep(a, v)))} onnudge={(dir, big) => wheelNudge("zstep", dir, big)} /><span class="lbl">{a.z?.unit ?? unit}</span>{/if}
            </span>
          {/if}
        </span>
      </div>

      <!-- storage, no data, remember -->
      <div class="card keep">
        <span class="grp">
          <PaperKey glyph="storage" label={storageWords} hotkey="S" id="storage" on={!!a.lossless || integer} disabled={integer} onpress={() => set(toggle(a, "lossless"))} />
          {#if nodataOffer !== null}
            <PaperKey glyph="hideMissing" label={`${fmt(nodataOffer)} means no data${s.preview?.frequentMin ? ` (it fills ${Math.round(s.preview.frequentMin.share * 100)} % of this plane)` : ""}`} hotkey="D" id="nodata" on={a.nodata != null}
              onpress={() => set(setNodata(a, a.nodata != null ? null : nodataOffer))} onenter={() => preview(setNodata(a, a.nodata != null ? null : nodataOffer))} onleave={() => preview(null)} />
          {/if}
          <PaperKey glyph="remember" label={REMEMBER_WORDS[s.remember]} hotkey="M" id="remember" on={s.remember !== "off"} onpress={() => askRemember(nextRemember())} />
        </span>
        <span class="words">
          <span class="w1">{integer ? "exact" : a.lossless ? "lossless" : "compact"}{#if a.nodata != null} · {fmt(a.nodata)} = no data{/if}</span>
          <span class="w2" data-ask-remember={s.remember}>{s.remember === "off" ? "" : s.remember === "project" ? "remembered here" : "remembered everywhere"}</span>
        </span>
      </div>
      {#if s.remembered}
        <div class="card known" data-ask-remembered>
          <span class="kw">Remembered ({s.remembered.scope === "project" ? "this project" : "every project"}): {s.remembered.summary}</span>
          <button type="button" class="unit" data-fxb-key="forget" data-tip="Forget it: files like this are asked about again" onpointerdown={stop} onclick={(e) => { e.stopPropagation(); void askForget(); }}>forget</button>
        </div>
      {/if}

      <!-- the hint line and Convert; while the answer does not fit, Convert says why right beside it -->
      {#if s.problem}<div class="why" data-ask-why>Convert is off: {s.problem}</div>{/if}
      <div class="foot">
        <span class="hint" data-ask-hint>{hint.text}{#if hint.hk}<kbd>{hint.hk}</kbd>{/if}</span>
        <button type="button" class="convert" disabled={!!s.problem} data-fxb-key="convert" data-ask-convert aria-label={s.problem ? `Convert is off: ${s.problem}` : "Convert"}
          onpointerdown={stop} onclick={(e) => { e.stopPropagation(); askConvert(); }}>Convert<kbd>↵</kbd></button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* The board's instrument tokens (FluximgBoard.svelte), on this plate too: dark in every theme, pink for the hand. */
  .fxb { --fxb-plate: #0b0b0a; --fxb-card: #1a1918; --fxb-well: #070707; --fxb-line: rgba(255, 252, 240, 0.09); --fxb-lift: inset 0 1px 0 rgba(255, 252, 240, 0.05); --fxb-paper: var(--flx-paper); --fxb-pink: var(--c-guide); --fxb-pink-hi: #ff7ab0;
    --fxb-tx: var(--flx-base-200); --fxb-tx-hi: var(--flx-paper); --fxb-tx-dim: var(--flx-base-500); --fxb-shadow: 0 10px 26px -10px rgba(0, 0, 0, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4); }
  .ask { position: absolute; z-index: 4; box-sizing: border-box; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; border-radius: 12px; background: var(--fxb-plate); border: 1px solid var(--fxb-line);
    box-shadow: var(--fxb-shadow); color: var(--fxb-tx); font: 12px var(--font-ui); outline: none; cursor: default; animation: ask-in 150ms linear backwards; }
  /* Where the image will land: a pink ring and cross (the guides' pink), still. */
  .land { position: absolute; z-index: 4; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--c-guide), 0 0 0 1px rgba(0, 0, 0, 0.35); pointer-events: none; }
  .land::before, .land::after { content: ""; position: absolute; background: var(--c-guide); }
  .land::before { left: 8px; top: -6px; width: 2px; height: 30px; }
  .land::after { top: 8px; left: -6px; height: 2px; width: 30px; }
  @keyframes ask-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: no-preference) { .ask { animation-name: ask-settle; animation-timing-function: var(--ease-enter); } }
  @keyframes ask-settle { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  .col { display: flex; flex-direction: column; gap: 4px; padding: 4px; }
  .card { box-sizing: border-box; border-radius: 8px; background: var(--fxb-card); border: 1px solid var(--fxb-line); box-shadow: var(--fxb-lift); }
  .headcard { padding: 6px 6px 7px 10px; }
  .l1 { display: flex; align-items: center; gap: 8px; height: 22px; }
  .live { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--fxb-pink); box-shadow: 0 0 6px 0 var(--fxb-pink); }
  .live.wait { background: transparent; box-shadow: inset 0 0 0 1.5px var(--fxb-pink); }
  .ttl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13.5px var(--font-serif); color: var(--fxb-tx-hi); }
  .batch { font: 600 10px var(--font-mono); color: var(--fxb-pink-hi); }
  .l2 { display: flex; flex-wrap: wrap; padding-left: 15px; font: 10px/15px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx-dim); }
  .reason { margin-top: 5px; padding-left: 15px; color: var(--fxb-pink-hi); font: 10.5px/14px var(--font-mono); overflow-wrap: anywhere; }
  .fact + .fact::before { content: "·"; margin: 0 6px; opacity: 0.6; }
  /* Proposals: paper slips, the chosen one lit. */
  .props { display: flex; flex-direction: column; gap: 3px; padding: 5px; }
  .prop { display: flex; align-items: center; gap: 8px; min-height: 22px; padding: 2px 8px; border-radius: 5px; border: 1px solid color-mix(in oklab, var(--c-layout-gap) 45%, transparent); background: var(--flx-paper);
    color: var(--flx-magenta-600); font: 500 10.5px var(--font-mono); text-align: left; box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5); cursor: var(--cursor-cross-hover); outline: none;
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear; }
  .prop:hover, .prop:focus-visible { background: color-mix(in oklab, var(--c-layout-gap) 16%, var(--flx-paper)); border-color: var(--c-layout-gap); }
  .prop:active, .prop:global(.struck) { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); }
  .prop.on { background: var(--c-layout-gap); border-color: color-mix(in oklab, var(--flx-paper) 60%, var(--c-layout-gap)); color: var(--flx-paper); }
  .pips { display: inline-flex; gap: 2px; flex: none; }
  .pips i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0.22; }
  .pips i.lit { opacity: 0.95; }
  .sum { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  /* Pictures: dark wells, one per channel; a hovered key's preview is framed in pink. */
  .pics { padding: 8px 8px 6px; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .pic { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .well { display: block; background: var(--fxb-well); border-radius: 3px; outline: 1px solid var(--fxb-line); }
  .pics.previewing .well { outline: 1.5px dashed var(--fxb-pink); }
  .well img { display: block; width: 100%; height: 100%; }
  .well img.px { image-rendering: pixelated; }
  .chip { display: inline-flex; align-items: center; gap: 2px; max-width: 150px; }
  .dot { width: 11px; height: 11px; padding: 0; border-radius: 50%; border: 1px solid rgba(255, 252, 240, 0.35); background: var(--ink); cursor: var(--cursor-cross-hover); outline: none; flex: none; }
  .dot:hover, .dot:focus-visible { box-shadow: 0 0 0 2px var(--fxb-pink); }
  .at { margin-top: 4px; text-align: center; font: 10px var(--font-mono); color: var(--fxb-tx-dim); }
  .warn { color: var(--fxb-pink-hi); }
  /* The pages: one paper key per dimension, slowest first; drag to reorder. */
  .pages { padding: 8px 8px 6px; }
  .strip { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  .times { color: var(--fxb-tx-dim); font: 11px var(--font-mono); }
  .pk { display: inline-flex; align-items: baseline; gap: 5px; height: 28px; padding: 0 6px 0 9px; box-sizing: border-box; border-radius: 6px; border: 1px solid color-mix(in oklab, var(--c-layout-gap) 45%, transparent); background: var(--flx-paper);
    color: var(--flx-magenta-600); box-shadow: 0 1.5px 2.5px rgba(0, 0, 0, 0.5); cursor: grab; outline: none; touch-action: none; transition: background-color 80ms linear, border-color 80ms linear; }
  .pk:hover, .pk:focus-visible { border-color: var(--c-layout-gap); background: color-mix(in oklab, var(--c-layout-gap) 10%, var(--flx-paper)); }
  .pk.dragging { cursor: grabbing; border-color: var(--fxb-pink); box-shadow: 0 0 0 2px var(--fxb-pink), 0 4px 10px rgba(0, 0, 0, 0.5); }
  .pk:global(.struck) { transform: translateY(1px); }
  .nm { font: 700 15px/26px var(--font-serif); }
  .sz { display: inline-flex; align-items: baseline; --fxb-tx-hi: var(--flx-magenta-600); --fxb-tx-dim: color-mix(in oklab, var(--flx-magenta-600) 60%, transparent); --fxb-well: var(--flx-paper); }
  .restmark { font: 700 11px var(--font-mono); font-style: normal; color: var(--fxb-pink); margin-left: -2px; }
  .single { color: var(--fxb-tx-dim); font: italic 11px var(--font-mono); }
  .addkey { margin-left: 4px; }
  .eq { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin-top: 6px; font: 10px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--fxb-tx); }
  .eq.bad .vs { color: var(--c-danger); }
  .fast { color: var(--fxb-tx-dim); }
  .samples { margin-left: auto; }
  /* Facts: keys, then numbers written in place. */
  .facts, .keep { display: flex; align-items: center; gap: 10px; padding: 7px 8px; flex-wrap: wrap; }
  .grp { display: inline-flex; gap: 3px; }
  .nums { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; flex: 1; }
  .fq { display: inline-flex; align-items: baseline; gap: 3px; }
  .lbl { font: 10px var(--font-mono); color: var(--fxb-tx-dim); }
  .unit, .samples { height: 19px; padding: 0 5px; border-radius: 4px; border: 1px solid transparent; background: none; color: var(--fxb-tx); font: 500 10.5px var(--font-mono); cursor: var(--cursor-cross-hover); outline: none; }
  .unit:hover, .unit:focus-visible, .samples:hover, .samples:focus-visible { border-color: color-mix(in oklab, var(--fxb-pink) 55%, transparent); color: var(--fxb-tx-hi); }
  .unit.wide { font-style: italic; color: var(--fxb-pink-hi); }
  .words { display: flex; flex-direction: column; font: 10px var(--font-mono); color: var(--fxb-tx-dim); }
  .w1 { color: var(--fxb-tx); }
  .w2 { color: var(--fxb-pink-hi); }
  .known { display: flex; align-items: baseline; gap: 6px; padding: 5px 8px; font: 10px var(--font-mono); color: var(--fxb-tx-dim); }
  .kw { flex: 1; overflow-wrap: anywhere; }
  /* The foot: one hint line (it wraps rather than being cut) and Convert, the one lit key. */
  .foot { display: flex; align-items: center; gap: 8px; padding: 4px 4px 2px 8px; }
  .hint { flex: 1; min-width: 0; color: var(--fxb-tx-dim); font: 10.5px/14px var(--font-mono); overflow-wrap: anywhere; white-space: normal; }
  .why { padding: 2px 8px 0; color: color-mix(in oklab, var(--c-danger) 70%, var(--fxb-tx-hi)); font: 10.5px/14px var(--font-mono); overflow-wrap: anywhere; }
  .hint kbd, .convert kbd { margin-left: 6px; padding: 0 3px; border: 1px solid currentColor; border-bottom-width: 2px; border-radius: 3px; font: 600 9px/11px var(--font-mono); opacity: 0.8; }
  .convert { flex: none; height: 30px; padding: 0 12px; border-radius: 7px; border: 1px solid color-mix(in oklab, var(--flx-paper) 50%, var(--c-layout-gap)); background: var(--c-layout-gap); color: var(--flx-paper);
    font: 600 12.5px var(--font-ui); box-shadow: 0 0 10px -2px var(--fxb-pink), 0 1.5px 2.5px rgba(0, 0, 0, 0.5); cursor: var(--cursor-cross-hover); outline: none; transition: background-color 80ms linear, opacity 80ms linear; }
  .convert:hover:not(:disabled), .convert:focus-visible { background: color-mix(in oklab, var(--flx-paper) 14%, var(--c-layout-gap)); }
  .convert:active:not(:disabled), .convert:global(.struck) { transform: translateY(1px); box-shadow: 0 0 1px rgba(0, 0, 0, 0.6); }
  .convert:disabled { opacity: 0.35; box-shadow: none; cursor: var(--cursor-cross); }
</style>
