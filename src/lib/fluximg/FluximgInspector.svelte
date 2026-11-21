<script lang="ts">
  /**
   * The Inspector's sections for a selected fluximg: the live view's settings as numbers.
   *
   * Every control shows the RESOLVED view and writes the SPARSE recipe through `ops.setFluximgView` (the patches
   * come from `inspectorEdits.ts`, where a value equal to its default clears its key). It edits the selected
   * element whether or not the live view is open, so it never goes through the live session: a discrete edit is
   * one edit session of its own, and a NumberField's scrub or wheel run is that field's session (one undo each).
   * Nothing here reads pixels: the manifest (kilobytes) is all it needs.
   */
  import { project, mutate } from "../store";
  import { pushToast } from "../toast";
  import { editSession } from "../interact/editSession";
  import { setCrop, setFluximgView } from "../ops";
  import NumberField from "../NumberField.svelte";
  import ColorField from "../ColorField.svelte";
  import type { Project } from "../types";
  import type { FluximgElement } from "./element";
  import type { FluximgProjectionMode, FluximgView, ResolvedChannel } from "./view";
  import { describeFluximg } from "./place";
  import { channelTable } from "./lut";
  import { fluximgIssues, fluximgLutsReady, fluximgManifests, needLuts, needManifest, resolveLut } from "./store";
  import { clampCrop, fullCrop } from "./still";
  import { describePosition, describeProjection, formatNumber, resolveView } from "./viewOps";
  import { histDomain, nudgeStep } from "./live/histogram";
  import { fluximgLiveUnavailable, openFluximgLive, settleLiveEdit } from "./live/session";
  import {
    CORNERS, autoPatch, backgroundPatch, colorPatch, compositePatch, dimLength, furnitureFieldPatch, furnitureOnPatch, gammaPatch,
    indexPatch, integerData, layerNumberPatch, layerWindowPatch, middleEllipsis, namesLayerPatch, normPatch, projectionPatch, runPatch,
    showChannelPatch, showLayerPatch, smoothPatch, styleColumnPatch, styleLutPatch, styleMissingPatch, styleOpacityToPatch, styleRangePatch, styleReversePatch, windowPatch,
  } from "./inspectorEdits";
  import { columnSummaries, DEFAULT_STYLE_LUT } from "./objectStyle";
  import { layerTablePath } from "./static";
  import { fluximgTables, needTable, tableOf } from "./live/objectTables";

  let { element, readOnly = false }: { element: FluximgElement; readOnly?: boolean } = $props();

  const asset = $derived($project.assets.find((a) => a.id === element.assetId && a.kind === "fluximg"));
  const info = $derived(asset?.fluximg);
  const manifest = $derived($fluximgManifests[element.assetId]);
  const issue = $derived($fluximgIssues[element.assetId]);
  $effect(() => { if (asset && !manifest) void needManifest(asset).catch(() => {}); });
  $effect(() => { if (manifest) void needLuts(); });

  const rv = $derived(manifest ? resolveView(manifest, element.view) : null);
  const integer = $derived(!!manifest && integerData(manifest));
  /** Dimensions with somewhere to go: every position dimension with more than one plane. Time first, then depth. */
  const dims = $derived.by(() => {
    if (!manifest) return [] as string[];
    const rank = (d: string): number => (d === "t" ? 0 : d === "z" ? 1 : 2);
    return manifest.pixels.dims.filter((d) => d !== "c" && d !== "y" && d !== "x" && dimLength(manifest, d) > 1).sort((a, b) => rank(a) - rank(b));
  });
  const DIM_NAMES: Record<string, string> = { t: "Time", z: "Depth" };
  const dimName = (d: string): string => DIM_NAMES[d] ?? d.charAt(0).toUpperCase() + d.slice(1);
  const MODES: ReadonlyArray<[FluximgProjectionMode, string]> = [["max", "max"], ["mean", "mean"], ["min", "min"], ["sum", "sum"], ["std", "std"]];
  /** The dimension a projection is chosen along while none is on (with one, its own). */
  let alongPick = $state("");
  const along = $derived(rv?.projection?.dim ?? (dims.includes(alongPick) ? alongPick : dims[0] ?? ""));

  const objectLayers = $derived(rv ? rv.layers.filter((l) => l.kind !== "intensity") : []);
  // Layers that have a table can be styled by its columns: their tables are read (small JSON) so the pickers list them.
  const tablePaths = $derived(manifest ? Object.fromEntries(manifest.layers.map((l) => [l.id, layerTablePath(l)]).filter(([, p]) => !!p)) as Record<string, string> : {});
  $effect(() => { if (asset) for (const p of Object.values(tablePaths)) needTable(asset, p); });
  const columnsOf = (layerId: string) => (asset && tablePaths[layerId] ? columnSummaries(tableOf($fluximgTables, asset, tablePaths[layerId])) : []);
  const STYLE_MAPS = ["viridis", "cividis", "plasma", "magma", "crameri.batlow", "cmasher.ember"];
  const unit = $derived(info?.pixelSize?.unit ?? manifest?.axes?.x?.unit ?? "");
  const hasScale = $derived(!!manifest?.axes?.x?.unit && (manifest.axes.x.scale ?? 0) > 0);
  const crop = $derived(manifest ? clampCrop(manifest, element.crop) : null);

  // Read the project so "can the live view open" follows locking and hiding.
  const liveBlocked = $derived.by(() => { void $project; return fluximgLiveUnavailable(element.id); });

  // --- words ------------------------------------------------------------------------------------
  /** Decimals worth showing for values that move by `step`: one finer than the step (focus shows them all). */
  const places = (step: number): number => (step >= 1 ? 0 : Math.min(8, Math.ceil(-Math.log10(step)) + 1));
  // A size without a unit says nothing a reader can use, so it is shown only with one.
  const pixelWords = $derived.by(() => {
    const ps = info?.pixelSize;
    if (!ps?.unit) return "";
    return ps.x === ps.y ? `${formatNumber(ps.x)} ${ps.unit} per pixel` : `${formatNumber(ps.x)} × ${formatNumber(ps.y)} ${ps.unit} per pixel`;
  });
  const encodingWords = $derived.by(() => {
    if (!info) return "";
    const from = manifest?.pixels.encoding.sourceDtype;
    if (info.encoding === "linear16") return `Stored compactly: 16-bit steps of the ${from ?? "original"} values`;
    return from && from !== info.dtype ? `Stored exactly (${from} as ${info.dtype})` : `Stored exactly (${info.dtype})`;
  });
  const KIND_WORDS: Record<string, string> = { intensity: "image", labels: "objects", vector: "shapes" };

  /** A channel's colour map as a small ramp (its colour as a plain chip). */
  function ramp(c: ResolvedChannel): string {
    void $fluximgLutsReady;
    if (c.color) return `background:${c.color}`;
    const t = channelTable({ color: null, lut: c.lut, invert: c.invert }, resolveLut);
    const stops = [0, 64, 128, 192, 255].map((i) => `rgb(${t[i * 4]},${t[i * 4 + 1]},${t[i * 4 + 2]})`);
    return `background:linear-gradient(90deg,${stops.join(",")})`;
  }
  /** The colour a colour map ends in: "Use colour" keeps the brightest look the map had. */
  function mapEnd(c: ResolvedChannel): string {
    const lut = c.lut ? resolveLut(c.lut) : null;
    const end = lut ? lut[c.invert ? 0 : lut.length - 1] : null;
    return end && /^#[0-9a-f]{6}$/i.test(end) ? end.toLowerCase() : "#ffffff";
  }
  const stepOf = (i: number): number => {
    if (!manifest || !rv) return 1;
    return nudgeStep(histDomain(manifest.channels[i].stats, rv.channels[i].range), integer);
  };
  const layerStep = (r: [number, number] | null): number => (r ? nudgeStep({ lo: Math.min(r[0], 0), hi: Math.max(r[1], r[0] + 1e-12) }, false) : 0.01);

  // --- writes -----------------------------------------------------------------------------------
  /** A discrete edit (a button, a choice, a typed value): one session, one undo. */
  function apply(fn: (p: Project) => void): void {
    if (readOnly) return;
    // A gesture the live view still holds (a wheel run waiting to settle) ends first, as its own undo step.
    settleLiveEdit();
    const session = editSession();
    session.run(() => mutate(fn));
    session.finish();
  }
  /** One step of a NumberField's scrub or wheel run: the field's own session makes the run one undo. */
  function preview(fn: (p: Project) => void): void {
    if (readOnly) return;
    settleLiveEdit();
    mutate(fn);
  }
  function view(patch: FluximgView | null, live = false): void {
    if (!patch) return;
    const id = element.id;
    (live ? preview : apply)((p) => setFluximgView(p, id, patch));
  }
  function setCropField(key: "x" | "y" | "width" | "height", v: number, live = false): void {
    if (!manifest || !crop || !Number.isFinite(v)) return;
    const full = fullCrop(manifest), c = { ...crop };
    if (key === "x") c.x = Math.min(full.width - c.width, Math.max(0, v));
    else if (key === "y") c.y = Math.min(full.height - c.height, Math.max(0, v));
    else if (key === "width") c.width = Math.min(full.width - c.x, Math.max(1, v));
    else c.height = Math.min(full.height - c.y, Math.max(1, v));
    const id = element.id;
    (live ? preview : apply)((p) => { setCrop(p, id, c); });
  }
  function toggleChannel(e: Event, i: number): void {
    const box = e.currentTarget as HTMLInputElement;
    const patch = rv ? showChannelPatch(rv, i, box.checked, manifest) : null;
    if (!patch) { box.checked = !box.checked; return; }
    view(patch);
  }
  // Is the bundle this image came from still what it was? Asked when the image or its asset changes (never per
  // edit: the answer compares two small manifest files on the file side).
  let sourceState = $state<"current" | "changed" | "missing" | "external" | "">("");
  const sourceKey = $derived(`${element.id}|${element.assetId}|${element.source?.bundlePath ?? ""}|${element.source?.sha256 ?? ""}`);
  $effect(() => {
    void sourceKey;
    sourceState = "";
    if (!element.source?.bundlePath) return;
    let closed = false;
    void import("./sourceUpdate").then((m) => m.fluximgSourceState(element)).then((state) => { if (!closed) sourceState = state; }, () => {});
    return () => { closed = true; };
  });
  function updateFromSource(): void {
    void import("./sourceUpdate").then((m) => m.updateFluximgFromSource(element.id)).catch((error: unknown) => pushToast("error", "The image could not be updated", { detail: error instanceof Error ? error.message : String(error) }));
  }
  /** Other panels of the same image that share this one's link. */
  const linkedWith = $derived.by(() => {
    const link = element.view?.link;
    if (!link) return 0;
    let n = 0;
    for (const f of $project.figures) for (const e of f.elements) if (e.type === "fluximg" && e.id !== element.id && e.assetId === element.assetId && e.view?.link === link) n++;
    return n;
  });
  const selectValue = (e: Event): string => (e.currentTarget as HTMLSelectElement).value;
  const checked = (e: Event): boolean => (e.currentTarget as HTMLInputElement).checked;
</script>

<section class="fluximg-properties" aria-label="Image" data-fluximg-inspector="image">
  <h4>Image<span class="grow"></span><button class="live" data-fluximg-open-live disabled={readOnly || !!liveBlocked}
    title={readOnly ? "This selection is read-only" : liveBlocked ?? "Change how the image is shown, live (R)"}
    onclick={() => openFluximgLive(element.id)}>Live view <kbd>R</kbd></button></h4>
  <div class="secbody">
    {#if info}<p class="meta" data-fluximg-describe>{describeFluximg(info)}</p>{/if}
    {#if pixelWords}<p class="line" data-fluximg-pixel>{pixelWords}</p>{/if}
    {#if encodingWords}<p class="line">{encodingWords}</p>{/if}
    {#if element.source?.bundlePath}<p class="line path" title={element.source.bundlePath} data-fluximg-source>{middleEllipsis(element.source.bundlePath)}</p>{/if}
    {#if element.source?.frozen && /\.tiff?$/i.test(element.source.bundlePath)}<p class="line" data-fluximg-converted>Converted from this TIFF, which is never changed.</p>{/if}
    {#if sourceState === "changed" || sourceState === "missing"}
      <p class="line srcrow" data-fluximg-source-state={sourceState}>
        <span>{sourceState === "changed" ? "The source bundle has changed since this was placed." : "The source bundle is no longer there; this copy is kept."}</span>
        {#if sourceState === "changed"}<button class="mini" disabled={readOnly} data-fluximg-update-source title="Move this image to the bundle as it is now (its view is kept where it still fits)" onclick={updateFromSource}>Update</button>{/if}
      </p>
    {/if}
    {#if linkedWith > 0}
      <p class="line srcrow" data-fluximg-linked>
        <span>Moves with {linkedWith} other {linkedWith === 1 ? "panel" : "panels"} of this image (plane, projection, channel windows).</span>
        <button class="mini" disabled={readOnly} data-fluximg-unlink title="Let this panel change on its own" onclick={() => view({ link: null as unknown as undefined })}>Unlink</button>
      </p>
    {/if}
    {#if element.rotation && Math.abs(element.rotation % 90) > 1e-6}<p class="line warn" data-fluximg-rotated>Rotated by {Number(element.rotation.toFixed(2))}°: an angle that is not a quarter turn resamples the pixels.</p>{/if}
    {#if !manifest}<p class="line quiet" data-fluximg-inspector-state>{issue ? issue : "Reading the image…"}</p>{/if}
  </div>
</section>

{#if manifest && rv}
  {@const m = manifest}
  {@const v = rv}
  {@const f = rv.furniture}
  <section class="fluximg-properties" aria-label="Channels" data-fluximg-inspector="channels">
    <h4>Channels{#if v.channels.length > 1}<span class="grow"></span><button data-fluximg-auto="all" disabled={readOnly}
      title="Auto contrast for every channel; again tightens it" onclick={() => view(autoPatch(m, v, "all"))}>Auto all</button>{/if}</h4>
    <fieldset class="secbody" disabled={readOnly}>
      {#if v.channels.length > 1}
        <div class="choice"><span>Composite</span><div class="seg" role="group" aria-label="Composite">
          <button class:on={v.composite === "blend"} data-fluximg-composite="blend" title="Add every shown channel" onclick={() => view(compositePatch("blend"))}>Blend</button>
          <button class:on={v.composite === "single"} data-fluximg-composite="single" title="Show one channel at a time" onclick={() => view(compositePatch("single"))}>Single</button>
        </div></div>
        {#if v.composite === "single"}
          <div class="choice"><span>Showing</span><select class="narrow" aria-label="Channel shown" value={String(v.solo)}
            onchange={(e) => view(compositePatch("single", Number(selectValue(e))))}>
            {#each v.channels as c (c.index)}<option value={String(c.index)}>{c.name}</option>{/each}
          </select></div>
        {/if}
      {/if}
      {#each v.channels as c (c.index)}
        {@const shown = v.composite === "single" ? v.solo === c.index : c.visible}
        <div class="block" data-fluximg-channel={c.index}>
          <div class="head">
            <label class="chk" title={v.composite === "single" ? "Show this channel" : shown ? "Hide this channel" : "Show this channel"}>
              <input type="checkbox" checked={shown} data-fluximg-channel-show onchange={(e) => toggleChannel(e, c.index)} />
              <span class="name">{c.name}</span>
            </label>
            <button class="mini" data-fluximg-auto={c.index} title="Auto contrast from the stack's percentiles; again tightens it"
              onclick={() => view(autoPatch(m, v, c.index))}>Auto</button>
          </div>
          <div class="pair cn">
            {#if c.color}
              <ColorField label={`${c.name} colour`} value={c.color} onchange={(hex) => view(colorPatch(m, c.index, hex))} />
            {:else}
              <div class="lut" title={`Colour map ${c.lut}${c.invert ? " (reversed)" : ""}`}>
                <span class="ramp" style={ramp(c)}></span><span class="lutname">{c.lut}</span>
                <button class="mini" data-fluximg-use-colour title="Use a single colour instead of the colour map"
                  onclick={() => view(colorPatch(m, c.index, mapEnd(c)))}>Use colour</button>
              </div>
            {/if}
            <select aria-label={`${c.name} scale`} title="How values map from black to white" value={c.norm} data-fluximg-norm
              onchange={(e) => view(normPatch(v, c.index, selectValue(e) as "linear" | "log" | "gamma"))}>
              <option value="linear">Linear</option><option value="log">Log</option><option value="gamma">Gamma</option>
            </select>
          </div>
          <div class="three">
            <NumberField label="Black" value={c.range[0]} step={stepOf(c.index)} displayPrecision={places(stepOf(c.index))} disabled={readOnly} title="Black point, in the image's values"
              on:commit={(e) => view(windowPatch(m, v, c.index, 0, e.detail))} on:scrub={(e) => view(windowPatch(m, v, c.index, 0, e.detail, true), true)} />
            <NumberField label="White" value={c.range[1]} step={stepOf(c.index)} displayPrecision={places(stepOf(c.index))} disabled={readOnly} title="White point, in the image's values"
              on:commit={(e) => view(windowPatch(m, v, c.index, 1, e.detail))} on:scrub={(e) => view(windowPatch(m, v, c.index, 1, e.detail, true), true)} />
            <NumberField label="Gamma" value={c.gamma} step={0.05} min={0.1} max={5} disabled={readOnly} title="1 = linear"
              on:commit={(e) => view(gammaPatch(c.index, e.detail))} on:scrub={(e) => view(gammaPatch(c.index, e.detail), true)} />
          </div>
          {#if c.norm === "gamma" && c.gamma !== 1}<p class="warn">Gamma is not 1: brightness is no longer proportional to signal. Say so in the legend.</p>{/if}
          {#if c.norm === "log" && !(c.range[0] > 0)}<p class="warn">A log scale needs a black point above 0; until then this channel is drawn linear.</p>{/if}
        </div>
      {/each}
    </fieldset>
  </section>

  {#if dims.length}
    <section class="fluximg-properties" aria-label="Position" data-fluximg-inspector="position">
      <h4>Position</h4>
      <fieldset class="secbody" disabled={readOnly}>
        {#each dims as d (d)}
          {#if v.projection?.dim !== d}
            <div class="pos" data-fluximg-dim={d}>
              <div class="posfield"><NumberField label={dimName(d)} value={(v.index[d] ?? 0) + 1} step={1} min={1} max={dimLength(m, d)} disabled={readOnly}
                title={`Plane along ${d}, 1 to ${dimLength(m, d)}`}
                on:commit={(e) => view(indexPatch(m, d, e.detail - 1))} on:scrub={(e) => view(indexPatch(m, d, e.detail - 1), true)} /></div>
              <span class="where" data-fluximg-where={d}>{describePosition(m, d, v.index[d] ?? 0)}</span>
            </div>
          {/if}
        {/each}
        <div class="choice"><span>Projection</span><div class="selects">
          <select aria-label="Projection" data-fluximg-projection value={v.projection?.mode ?? ""}
            onchange={(e) => { const mode = selectValue(e); view(projectionPatch(m, v, along, mode ? (mode as FluximgProjectionMode) : null)); }}>
            <option value="">off · one plane</option>
            {#each MODES as [mode, label] (mode)}<option value={mode}>{label}</option>{/each}
          </select>
          {#if dims.length > 1}
            <select class="dimsel" aria-label="Along" title="The dimension a projection runs along" data-fluximg-along value={along}
              onchange={(e) => { const d = selectValue(e); alongPick = d; if (v.projection) view(projectionPatch(m, { ...v, projection: null }, d, v.projection.mode)); }}>
              {#each dims as d (d)}<option value={d}>along {d}</option>{/each}
            </select>
          {/if}
        </div></div>
        {#if v.projection}
          {@const p = v.projection}
          <div class="two">
            <NumberField label="From" value={p.from + 1} step={1} min={1} max={p.to} disabled={readOnly} title="First plane of the run (inclusive)"
              on:commit={(e) => view(runPatch(m, v, "from", e.detail - 1))} on:scrub={(e) => view(runPatch(m, v, "from", e.detail - 1), true)} />
            <NumberField label="To" value={p.to} step={1} min={p.from + 1} max={dimLength(m, p.dim)} disabled={readOnly} title="Last plane of the run (inclusive)"
              on:commit={(e) => view(runPatch(m, v, "to", e.detail - 1))} on:scrub={(e) => view(runPatch(m, v, "to", e.detail - 1), true)} />
          </div>
          <p class="line mono" data-fluximg-run>{describeProjection(m, p)}</p>
        {/if}
      </fieldset>
    </section>
  {/if}

  {#if v.layers.length}
    <section class="fluximg-properties" aria-label="Layers" data-fluximg-inspector="layers">
      <h4>Layers</h4>
      <fieldset class="secbody" disabled={readOnly}>
        {#each v.layers as l (l.id)}
          <div class="block" data-fluximg-layer={l.id}>
            <div class="head">
              <label class="chk"><input type="checkbox" checked={l.visible} data-fluximg-layer-show onchange={(e) => view(showLayerPatch(m, l.id, checked(e)))} /><span class="name">{l.name}</span></label>
              <span class="kind">{KIND_WORDS[l.kind] ?? l.kind}</span>
            </div>
            <div class="three">
              <NumberField label="Opacity %" value={Math.round(l.opacity * 100)} step={5} min={0} max={100} disabled={readOnly}
                on:commit={(e) => view(layerNumberPatch(m, l.id, "opacity", Math.round(e.detail) / 100))} on:scrub={(e) => view(layerNumberPatch(m, l.id, "opacity", Math.round(e.detail) / 100), true)} />
              {#if l.kind === "intensity" && l.range}
                <NumberField label="Black" value={l.range[0]} step={layerStep(l.range)} displayPrecision={places(layerStep(l.range))} disabled={readOnly}
                  on:commit={(e) => view(layerWindowPatch(m, l, 0, e.detail))} on:scrub={(e) => view(layerWindowPatch(m, l, 0, e.detail), true)} />
                <NumberField label="White" value={l.range[1]} step={layerStep(l.range)} displayPrecision={places(layerStep(l.range))} disabled={readOnly}
                  on:commit={(e) => view(layerWindowPatch(m, l, 1, e.detail))} on:scrub={(e) => view(layerWindowPatch(m, l, 1, e.detail), true)} />
              {:else if l.kind !== "intensity"}
                <NumberField label="Stroke px" value={l.strokeWidth} step={0.25} min={0} disabled={readOnly} title="Outline width in screen pixels"
                  on:commit={(e) => view(layerNumberPatch(m, l.id, "strokeWidth", e.detail))} on:scrub={(e) => view(layerNumberPatch(m, l.id, "strokeWidth", e.detail), true)} />
                <NumberField label="Fill %" value={Math.round(l.fillOpacity * 100)} step={5} min={0} max={100} disabled={readOnly}
                  on:commit={(e) => view(layerNumberPatch(m, l.id, "fillOpacity", Math.round(e.detail) / 100))} on:scrub={(e) => view(layerNumberPatch(m, l.id, "fillOpacity", Math.round(e.detail) / 100), true)} />
              {/if}
            </div>
            {#if tablePaths[l.id]}
              {@const cols = columnsOf(l.id)}
              {@const sb = l.styleBy}
              {@const cc = cols.find((c) => c.name === sb?.color?.column)}
              {@const oc = cols.find((c) => c.name === sb?.opacity?.column)}
              <div class="pair" data-fluximg-style={l.id}>
                <select aria-label={`Colour ${l.name} by`} title="Colour each object by a column of the layer's table" value={sb?.color?.column ?? ""} data-fluximg-style-color
                  onchange={(e) => view(styleColumnPatch(l.id, "color", selectValue(e) || null))}>
                  <option value="">One colour</option>
                  {#each cols.filter((c) => c.kind !== "empty") as c (c.name)}<option value={c.name}>Colour by {c.name}</option>{/each}
                </select>
                <select aria-label={`Opacity of ${l.name} by`} title="Each object's opacity from a column of numbers" value={sb?.opacity?.column ?? ""} data-fluximg-style-opacity
                  onchange={(e) => view(styleColumnPatch(l.id, "opacity", selectValue(e) || null))}>
                  <option value="">Even opacity</option>
                  {#each cols.filter((c) => c.kind === "number") as c (c.name)}<option value={c.name}>Opacity by {c.name}</option>{/each}
                </select>
              </div>
              {#if sb?.color && cc?.kind === "number" && cc.range && !(sb.color.palette && !sb.color.lut)}
                {@const r = sb.color.range ?? cc.range}
                <div class="three" data-fluximg-style-color-range>
                  <NumberField label="From" value={r[0]} step={layerStep(cc.range)} displayPrecision={places(layerStep(cc.range))} disabled={readOnly} title="The value at the colour map's start"
                    on:commit={(e) => view(styleRangePatch(l.id, "color", cc.range!, r, 0, e.detail))} on:scrub={(e) => view(styleRangePatch(l.id, "color", cc.range!, r, 0, e.detail), true)} />
                  <NumberField label="To" value={r[1]} step={layerStep(cc.range)} displayPrecision={places(layerStep(cc.range))} disabled={readOnly} title="The value at the colour map's end"
                    on:commit={(e) => view(styleRangePatch(l.id, "color", cc.range!, r, 1, e.detail))} on:scrub={(e) => view(styleRangePatch(l.id, "color", cc.range!, r, 1, e.detail), true)} />
                  <select aria-label="Colour map" value={sb.color.lut ?? DEFAULT_STYLE_LUT} data-fluximg-style-lut onchange={(e) => view(styleLutPatch(l.id, selectValue(e)))}>
                    {#each STYLE_MAPS as name (name)}<option value={name}>{name}</option>{/each}
                  </select>
                </div>
                <label class="chk sub"><input type="checkbox" checked={!!sb.color.reverse} data-fluximg-style-reverse onchange={(e) => view(styleReversePatch(l.id, checked(e)))} />Reverse the colour map</label>
              {/if}
              {#if sb?.opacity && oc?.range}
                {@const r = sb.opacity.range ?? oc.range}
                {@const to = sb.opacity.to ?? [0.15, 1]}
                <div class="two" data-fluximg-style-opacity-range>
                  <NumberField label="From" value={r[0]} step={layerStep(oc.range)} displayPrecision={places(layerStep(oc.range))} disabled={readOnly} title="The value that is faintest"
                    on:commit={(e) => view(styleRangePatch(l.id, "opacity", oc.range!, r, 0, e.detail))} on:scrub={(e) => view(styleRangePatch(l.id, "opacity", oc.range!, r, 0, e.detail), true)} />
                  <NumberField label="To" value={r[1]} step={layerStep(oc.range)} displayPrecision={places(layerStep(oc.range))} disabled={readOnly} title="The value that is most opaque"
                    on:commit={(e) => view(styleRangePatch(l.id, "opacity", oc.range!, r, 1, e.detail))} on:scrub={(e) => view(styleRangePatch(l.id, "opacity", oc.range!, r, 1, e.detail), true)} />
                </div>
                <div class="two">
                  <NumberField label="Faint %" value={Math.round(to[0] * 100)} step={5} min={0} max={100} disabled={readOnly}
                    on:commit={(e) => view(styleOpacityToPatch(l.id, to, 0, Math.round(e.detail) / 100))} on:scrub={(e) => view(styleOpacityToPatch(l.id, to, 0, Math.round(e.detail) / 100), true)} />
                  <NumberField label="Opaque %" value={Math.round(to[1] * 100)} step={5} min={0} max={100} disabled={readOnly}
                    on:commit={(e) => view(styleOpacityToPatch(l.id, to, 1, Math.round(e.detail) / 100))} on:scrub={(e) => view(styleOpacityToPatch(l.id, to, 1, Math.round(e.detail) / 100), true)} />
                </div>
              {/if}
              {#if sb}
                <label class="chk sub" title="Objects with no value in a styling column: hidden, or drawn faint and grey"><input type="checkbox" checked={sb.missing === "hide"} data-fluximg-style-missing
                  onchange={(e) => view(styleMissingPatch(l.id, checked(e) ? "hide" : "dim"))} />Hide objects without a value</label>
              {/if}
            {/if}
          </div>
        {/each}
      </fieldset>
    </section>
  {/if}

  <section class="fluximg-properties" aria-label="Annotations" data-fluximg-inspector="annotations">
    <h4>Annotations</h4>
    <fieldset class="secbody" disabled={readOnly}>
      {#if hasScale}
        <div class="block" data-fluximg-furniture="scalebar">
          <div class="head"><label class="chk"><input type="checkbox" checked={!!f.scalebar} data-fluximg-scalebar onchange={(e) => view(furnitureOnPatch("scalebar", checked(e)))} /><span class="name">Scale bar</span></label>
            {#if f.scalebar}<label class="chk sub"><input type="checkbox" checked={f.scalebar.label} onchange={(e) => view(furnitureFieldPatch(m, "scalebar", "label", checked(e)))} />Label</label>{/if}</div>
          {#if f.scalebar}
            {@const sb = f.scalebar}
            <div class="three">
              <NumberField label={`Length ${unit}`.trim()} value={sb.length ?? 0} optional live empty={sb.length === null} placeholder="auto" min={0} step={1} disabled={readOnly}
                title="Bar length in the image's unit; empty = a round length for the shown region"
                on:preview={(e) => view(furnitureFieldPatch(m, "scalebar", "length", e.detail && e.detail > 0 ? e.detail : null), true)}
                on:scrub={(e) => view(furnitureFieldPatch(m, "scalebar", "length", e.detail > 0 ? e.detail : null), true)} />
              <NumberField label="Bar pt" value={sb.thickness} step={0.25} min={0.25} disabled={readOnly}
                on:commit={(e) => view(furnitureFieldPatch(m, "scalebar", "thickness", e.detail))} on:scrub={(e) => view(furnitureFieldPatch(m, "scalebar", "thickness", e.detail), true)} />
              <NumberField label="Text pt" value={sb.fontSize} step={0.5} min={1} disabled={readOnly}
                on:commit={(e) => view(furnitureFieldPatch(m, "scalebar", "fontSize", e.detail))} on:scrub={(e) => view(furnitureFieldPatch(m, "scalebar", "fontSize", e.detail), true)} />
            </div>
            <div class="pair">
              <select aria-label="Scale bar corner" value={sb.corner} onchange={(e) => view(furnitureFieldPatch(m, "scalebar", "corner", selectValue(e)))}>
                {#each CORNERS as [k, label] (k)}<option value={k}>{label}</option>{/each}
              </select>
              <ColorField label="Scale bar colour" value={sb.color} onchange={(hex) => view(furnitureFieldPatch(m, "scalebar", "color", hex))} />
            </div>
          {/if}
        </div>
      {/if}
      {#if dims.length}
        <div class="block" data-fluximg-furniture="stamp">
          <div class="head"><label class="chk" title="Where along depth / time the picture is, printed on it"><input type="checkbox" checked={!!f.stamp} data-fluximg-stamp onchange={(e) => view(furnitureOnPatch("stamp", checked(e)))} /><span class="name">Position stamp</span></label>
            {#if f.stamp}{@const st = f.stamp}<div class="sizefield"><NumberField label="" value={st.fontSize} step={0.5} min={1} disabled={readOnly} title="Stamp text size in points"
              on:commit={(e) => view(furnitureFieldPatch(m, "stamp", "fontSize", e.detail))} on:scrub={(e) => view(furnitureFieldPatch(m, "stamp", "fontSize", e.detail), true)} /></div><span class="u">pt</span>{/if}</div>
          {#if f.stamp}
            {@const st = f.stamp}
            <div class="pair">
              <select aria-label="Stamp corner" title="Corner" value={st.corner} onchange={(e) => view(furnitureFieldPatch(m, "stamp", "corner", selectValue(e)))}>
                {#each CORNERS as [k, label] (k)}<option value={k}>{label}</option>{/each}
              </select>
              <ColorField label="Stamp colour" value={st.color} onchange={(hex) => view(furnitureFieldPatch(m, "stamp", "color", hex))} />
            </div>
          {/if}
        </div>
      {/if}
      <div class="block" data-fluximg-furniture="channelLabels">
        <div class="head"><label class="chk" title="Each channel's name, in its colour"><input type="checkbox" checked={!!f.channelLabels} data-fluximg-channel-names onchange={(e) => view(furnitureOnPatch("channelLabels", checked(e)))} /><span class="name">Channel names</span></label>
          {#if f.channelLabels}{@const cl = f.channelLabels}<div class="sizefield"><NumberField label="" value={cl.fontSize} step={0.5} min={1} disabled={readOnly} title="Channel name size in points"
            on:commit={(e) => view(furnitureFieldPatch(m, "channelLabels", "fontSize", e.detail))} on:scrub={(e) => view(furnitureFieldPatch(m, "channelLabels", "fontSize", e.detail), true)} /></div><span class="u">pt</span>{/if}</div>
        {#if f.channelLabels}
          <div class="pair">
            <select aria-label="Channel names corner" title="Corner" value={f.channelLabels.corner} onchange={(e) => view(furnitureFieldPatch(m, "channelLabels", "corner", selectValue(e)))}>
              {#each CORNERS as [k, label] (k)}<option value={k}>{label}</option>{/each}
            </select>
          </div>
        {/if}
      </div>
      <div class="block" data-fluximg-furniture="colorbar">
        <div class="head"><label class="chk" title="Each shown channel's colours from its black point to its white point, with both values"><input type="checkbox" checked={!!f.colorbar} data-fluximg-colorbar onchange={(e) => view(furnitureOnPatch("colorbar", checked(e)))} /><span class="name">Calibration bar</span></label>
          {#if f.colorbar}{@const cb = f.colorbar}<div class="sizefield"><NumberField label="" value={cb.fontSize} step={0.5} min={1} disabled={readOnly} title="Calibration bar text size in points"
            on:commit={(e) => view(furnitureFieldPatch(m, "colorbar", "fontSize", e.detail))} on:scrub={(e) => view(furnitureFieldPatch(m, "colorbar", "fontSize", e.detail), true)} /></div><span class="u">pt</span>{/if}</div>
        {#if f.colorbar}
          <div class="pair">
            <select aria-label="Calibration bar corner" title="Corner" value={f.colorbar.corner} onchange={(e) => view(furnitureFieldPatch(m, "colorbar", "corner", selectValue(e)))}>
              {#each CORNERS as [k, label] (k)}<option value={k}>{label}</option>{/each}
            </select>
          </div>
        {/if}
      </div>
      {#if Object.keys(tablePaths).length}
        <div class="block" data-fluximg-furniture="key">
          <div class="head"><label class="chk" title="What the objects' colours mean: their categories, or the colour map with its two ends"><input type="checkbox" checked={!!f.key} data-fluximg-key onchange={(e) => view(furnitureOnPatch("key", checked(e)))} /><span class="name">Key</span></label>
            {#if f.key}{@const ky = f.key}<div class="sizefield"><NumberField label="" value={ky.fontSize} step={0.5} min={1} disabled={readOnly} title="Key text size in points"
              on:commit={(e) => view(furnitureFieldPatch(m, "key", "fontSize", e.detail))} on:scrub={(e) => view(furnitureFieldPatch(m, "key", "fontSize", e.detail), true)} /></div><span class="u">pt</span>{/if}</div>
          {#if f.key}
            <div class="pair">
              <select aria-label="Key corner" title="Corner" value={f.key.corner} data-fluximg-key-corner onchange={(e) => view(furnitureFieldPatch(m, "key", "corner", selectValue(e)))}>
                {#each CORNERS as [k, label] (k)}<option value={k}>{label}</option>{/each}
              </select>
              <ColorField label="Key colour" value={f.key.color} onchange={(hex) => view(furnitureFieldPatch(m, "key", "color", hex))} />
            </div>
          {/if}
        </div>
      {/if}
      {#if objectLayers.length}
        <div class="block" data-fluximg-furniture="names">
          <div class="head"><span class="name lbl">Object names</span>
            {#if f.names}{@const nm = f.names}<div class="sizefield"><NumberField label="" value={nm.fontSize} step={0.5} min={1} disabled={readOnly} title="Text size in points"
              on:commit={(e) => view(furnitureFieldPatch(m, "names", "fontSize", e.detail))} on:scrub={(e) => view(furnitureFieldPatch(m, "names", "fontSize", e.detail), true)} /></div><span class="u">pt</span>{/if}</div>
          {#each objectLayers as l (l.id)}
            <label class="chk sub" title={`Names of the ${l.name} objects`}><input type="checkbox" checked={!!f.names && f.names.layers.includes(l.id)} data-fluximg-names={l.id}
              onchange={(e) => view(namesLayerPatch(m, v, l.id, checked(e)))} />{l.name}</label>
          {/each}
        </div>
      {/if}
    </fieldset>
  </section>

  <section class="fluximg-properties" aria-label="View" data-fluximg-inspector="view">
    <h4>View</h4>
    <fieldset class="secbody" disabled={readOnly}>
      <div class="choice"><span>Pixels</span><div class="seg" role="group" aria-label="Pixels">
        <button class:on={!v.smooth} data-fluximg-smooth="off" title="Every image pixel a sharp square when magnified" onclick={() => view(smoothPatch(false))}>True</button>
        <button class:on={v.smooth} data-fluximg-smooth="on" title="Interpolate between pixels when magnified" onclick={() => view(smoothPatch(true))}>Smoothed</button>
      </div></div>
      <p class="sub-h">Background</p>
      <div class="bgrow">
        {#if v.background === "transparent"}<span class="none">No background</span>
        {:else}<ColorField label="Background" value={v.background} onchange={(hex) => view(backgroundPatch(hex))} />{/if}
        <button class="mini" class:on={v.background === "transparent"} data-fluximg-transparent title="Where the image has no data, show what lies behind it"
          onclick={() => view(backgroundPatch(v.background === "transparent" ? "#000000" : "transparent"))}>Transparent</button>
      </div>
      {#if crop}
        <p class="sub-h">Region shown <span class="u">image pixels</span></p>
        <div class="two" data-fluximg-crop="origin">
          <NumberField label="X" value={crop.x} step={1} min={0} displayPrecision={1} disabled={readOnly} on:commit={(e) => setCropField("x", e.detail)} on:scrub={(e) => setCropField("x", e.detail, true)} />
          <NumberField label="Y" value={crop.y} step={1} min={0} displayPrecision={1} disabled={readOnly} on:commit={(e) => setCropField("y", e.detail)} on:scrub={(e) => setCropField("y", e.detail, true)} />
        </div>
        <div class="two" data-fluximg-crop="size">
          <NumberField label="W" value={crop.width} step={1} min={1} displayPrecision={1} disabled={readOnly} on:commit={(e) => setCropField("width", e.detail)} on:scrub={(e) => setCropField("width", e.detail, true)} />
          <NumberField label="H" value={crop.height} step={1} min={1} displayPrecision={1} disabled={readOnly} on:commit={(e) => setCropField("height", e.detail)} on:scrub={(e) => setCropField("height", e.detail, true)} />
        </div>
        {#if !element.crop}<p class="line quiet">The whole image</p>{/if}
      {/if}
    </fieldset>
  </section>
{/if}

<style>
  /* Mirrors Inspector.svelte's section chrome (eyebrow h4, .secbody, 24px controls, accent-tint .seg), as
     Model3dInspector does: the 2026-09-15 surface contract. */
  .fluximg-properties { border-bottom: 1px solid var(--c-line); }
  h4 { margin: 0; height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 10px; font: 600 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; color: var(--c-tx-muted); border-bottom: 1px solid var(--c-line); }
  .grow { flex: 1; }
  h4 button { text-transform: none; letter-spacing: 0; height: 20px; font: 11px var(--font-ui); display: inline-flex; align-items: center; gap: 6px; }
  h4 kbd { color: var(--c-tx-muted); }
  .secbody { padding: 8px 10px 10px; }
  fieldset { margin: 0; border: 0; min-width: 0; display: block; }
  /* Sections dim independently (never nested), so opacity never compounds. */
  fieldset:disabled { opacity: .55; }
  .meta { margin: 0 0 6px; font: 10px var(--font-mono); color: var(--c-tx-muted); }
  .line { margin: 0 0 4px; font: 11px var(--font-ui); color: var(--c-tx-2); line-height: 1.4; }
  .line:last-child { margin-bottom: 0; }
  .line.mono { font: 10.5px var(--font-mono); color: var(--c-tx-muted); margin: 6px 0 0; }
  /* nowrap + overflow would clip an underscore's descender at the default line height */
  .line.path { font: 10.5px/16px var(--font-mono); color: var(--c-tx-muted); white-space: nowrap; overflow: hidden; }
  .line.srcrow { display: flex; align-items: flex-start; gap: 8px; }
  .line.srcrow span { flex: 1 1 auto; min-width: 0; }
  .line.warn { color: var(--c-warning); }
  .line.quiet { color: var(--c-tx-muted); }
  .block { padding: 8px 0; border-top: 1px solid var(--c-line); }
  .block:first-child { border-top: 0; padding-top: 0; }
  .block:last-child { padding-bottom: 0; }
  .choice + .block { margin-top: 8px; border-top: 1px solid var(--c-line); padding-top: 8px; }
  .head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
  .head + * { margin-top: 6px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name.lbl { flex: 1; font: 12px var(--font-ui); color: var(--c-tx); }
  .kind { margin-left: auto; font: 10px var(--font-mono); color: var(--c-tx-muted); }
  label.chk { display: flex; flex-direction: row; align-items: center; gap: 5px; flex: 1; min-width: 0; font: 12px var(--font-ui); color: var(--c-tx); }
  label.chk.sub { flex: 0 0 auto; font-size: 11px; color: var(--c-tx-2); margin-top: 4px; }
  .head label.chk.sub { margin: 0 0 0 auto; }
  input[type="checkbox"] { margin: 0; accent-color: var(--c-accent); }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; align-items: center; }
  .pair.cn { grid-template-columns: minmax(0, 1fr) 78px; }
  .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-top: 6px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 6px; }
  .pair + .three, .three + .pair { margin-top: 6px; }
  .lut { display: flex; align-items: center; gap: 6px; min-width: 0; height: 24px; }
  .ramp { flex: 0 0 22px; height: 12px; border-radius: var(--r-ui); box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .12); border: 1px solid rgba(0, 0, 0, .35); }
  .lutname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--font-mono); color: var(--c-tx-2); }
  .warn { margin: 6px 0 0; font: 11px var(--font-ui); line-height: 1.4; color: var(--c-warning); }
  .pos { display: flex; align-items: flex-end; gap: 8px; margin-bottom: 6px; }
  .posfield { flex: 0 0 76px; }
  .where { flex: 1; min-width: 0; padding-bottom: 5px; font: 10.5px var(--font-mono); color: var(--c-tx-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .choice { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0 0; font: 10.5px var(--font-ui); color: var(--c-tx-muted); }
  .choice:first-child { margin-top: 0; }
  .selects { display: flex; gap: 4px; flex: 0 1 auto; min-width: 0; }
  .selects select { width: auto; min-width: 0; }
  .sizefield { flex: 0 0 48px; margin-left: auto; }
  .sizefield + .u { margin-left: -4px; }
  .u { font: 10px var(--font-mono); color: var(--c-tx-muted); text-transform: none; letter-spacing: 0; }
  .bgrow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; margin-top: 4px; }
  .bgrow .mini { height: 24px; }
  .none { font: 11px var(--font-ui); color: var(--c-tx-muted); }
  .sub-h { margin: 8px 0 0; display: flex; justify-content: space-between; font: 10.5px var(--font-ui); color: var(--c-tx-muted); }
  select { background: var(--c-bg); border: 1px solid var(--c-line-strong); color: var(--c-tx); border-radius: var(--r-ui); height: 24px; padding: 0 4px; font: 12px var(--font-ui); width: 100%; box-sizing: border-box; min-width: 0; }
  select:focus { outline: none; border-color: var(--c-accent); }
  select.narrow { width: auto; max-width: 60%; }
  button { height: 24px; background: transparent; color: var(--c-tx-2); border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 0 8px; font: 12px var(--font-ui); cursor: var(--cursor-cross-hover); }
  button:hover:not(:disabled) { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  button:disabled { opacity: .5; cursor: var(--cursor-cross); }
  button.mini { height: 20px; padding: 0 7px; font-size: 11px; flex: 0 0 auto; }
  button.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .seg { display: flex; flex: 0 0 auto; }
  .seg button { flex: 1 0 auto; min-width: 58px; white-space: nowrap; border-radius: 0; border-right-width: 0; font-size: 11px; }
  .seg button:first-child { border-radius: var(--r-ui) 0 0 var(--r-ui); }
  .seg button:last-child { border-radius: 0 var(--r-ui) var(--r-ui) 0; border-right-width: 1px; }
</style>
