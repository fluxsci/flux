<script lang="ts">
  import { yieldsToShellModal, isAnnotateChord } from "../shell/agent/annotationVisibility";

  // Shell-global Settings dialog (title-bar gear / the `settingsOpen` store).
  // A tabbed surface — General · Figure · Paper · Corrections — in the house
  // language of the property menu and Align & Arrange (2026-11-18 rebuild):
  // serif words, mono eyebrows and values, global key caps, hairlines, tint +
  // inset rail for what is chosen, opacity-only open/close.
  //
  // ONE row anatomy: the name (and what it does, in a smaller line under it) on
  // the left, the control at the right edge. A switch, a stepper field, a
  // select and a colour field all end on the same line, so a pane reads as two
  // columns instead of a ragged list. Section heads stay pinned while their
  // section scrolls.
  //
  // Every pane stays in the DOM (inactive ones are `hidden`) so the dialog's
  // text and controls are reachable whichever tab was chosen last — the shell
  // and correction gates read them without switching tabs.
  import { fade } from "svelte/transition";
  import { COLORMAP_COLLECTIONS, PALETTE_COLLECTIONS } from "./color/collections";
  import { PLOT_SEARCH_SCOPES } from "./plot/galleryScope";
  import { untrack } from "svelte";
  import { settings, settingsOpen, type Settings } from "./settings";
  import {
    buildCursorFamily, buildCursorFamilyDark, cursorPresetOf, isDefaultCursorParams, CURSOR_DEFAULTS, CURSOR_GAP_RANGE, CURSOR_HALO_OPACITY_RANGE, CURSOR_HALO_WIDTH_RANGE,
    CURSOR_PRESETS, CURSOR_SIZE_RANGE, CURSOR_STROKE_RANGE,
    ARROW_OUTLINE_RANGE, ARROW_ROUNDING_RANGE, ARROW_SHADOW_RANGE, ARROW_SIZE_RANGE, ARROW_TILT_RANGE,
    CURSOR_PRESS_DEFAULTS, CURSOR_PRESS_DEPTH_RANGE, CURSOR_PRESS_RETURN_RANGE,
    type CursorPreset, type CursorState,
  } from "./cursor/cursorFamily";
  import { cursorParamsFromSettings } from "./cursor/cursorTheme";
  import { cursorPress } from "./cursor/cursorPress";
  import ColorField from "./ColorField.svelte";
  import Icon from "../shell/Icon.svelte";
  import { openDocs } from "../shell/docsLink";
  import { railPrefs } from "./plotsRail/railPrefs";
  import { modalFocus } from "./ui/modalFocus";
  import { fileBridge } from "./project/types";
  import {
    clearLocalCorrectionLearning,
    LOCAL_CORRECTION_RESET_EVENT,
  } from "../shell/modes/paper/editing/localCorrectionProfile";

  // --- Cursor (Settings → General → Cursor, 2026-10-22) -------------------------
  // The preview strip draws the generated family itself (CDP/OS screenshots
  // never show the pointer), on a split dark/light swatch so the halo is judged.
  const CURSOR_PREVIEW: { state: CursorState; label: string }[] = [
    { state: "cross", label: "rest" },
    { state: "cross-hover", label: "hover" },
    { state: "cross-press", label: "press" },
    { state: "resize-ns", label: "resize" },
    { state: "resize-nwse", label: "corner" },
    { state: "rotate-se", label: "rotate" },
    { state: "move", label: "move" },
    { state: "move-copy", label: "duplicate" },
  ];
  const cursorFamily = $derived(buildCursorFamily(cursorParamsFromSettings($settings)));
  const cursorFamilyDark = $derived(buildCursorFamilyDark(cursorParamsFromSettings($settings)));
  const cursorIsDefault = $derived(isDefaultCursorParams(cursorParamsFromSettings($settings)) &&
    $settings.cursorPressEnabled === CURSOR_PRESS_DEFAULTS.enabled &&
    $settings.cursorPressDepth === CURSOR_PRESS_DEFAULTS.depth &&
    $settings.cursorPressReturnMs === CURSOR_PRESS_DEFAULTS.returnMs);
  const cursorPreset = $derived(
    cursorPresetOf({
      coreColor: $settings.cursorCoreColor,
      coreColorDark: $settings.cursorAdaptive ? $settings.cursorCoreColorDark : $settings.cursorCoreColor,
      haloWidth: $settings.cursorHaloWidth,
      haloColor: $settings.cursorHaloColor,
      haloOpacity: $settings.cursorHaloOpacity,
    }),
  );
  function applyCursorPreset(id: string) {
    if (!(id in CURSOR_PRESETS)) return; // "custom" keeps whatever the fields hold
    const c = CURSOR_PRESETS[id as keyof typeof CURSOR_PRESETS];
    settings.update((v) => ({
      ...v,
      cursorAdaptive: c.coreColor !== c.coreColorDark,
      cursorCoreColor: c.coreColor,
      cursorCoreColorDark: c.coreColorDark,
      cursorHaloWidth: c.haloWidth,
      cursorHaloColor: c.haloColor,
      cursorHaloOpacity: c.haloOpacity,
    }));
  }
  const PRESET_LABELS: Record<CursorPreset, string> = {
    adaptive: "Adaptive — ink on paper, light on dark",
    outlined: "Outlined — dark mark under a light halo",
    accent: "Accent — blue everywhere",
    custom: "Custom",
  };
  function cursorImg(state: CursorState, tone: "light" | "dark" = "light"): string {
    // the builder's svg uses %23 for '#'; an <img> data URL wants the same encoding
    return `data:image/svg+xml,${(tone === "dark" ? cursorFamilyDark : cursorFamily)[state].svg.replace(/#/g, "%23")}`;
  }
  function resetCursor() {
    settings.update((v) => ({
      ...v,
      cursorStyle: CURSOR_DEFAULTS.style, arrowSize: CURSOR_DEFAULTS.arrowSize, arrowFill: CURSOR_DEFAULTS.arrowFill, arrowOutline: CURSOR_DEFAULTS.arrowOutline,
      arrowOutlineWidth: CURSOR_DEFAULTS.arrowOutlineWidth, arrowRounding: CURSOR_DEFAULTS.arrowRounding, arrowShadow: CURSOR_DEFAULTS.arrowShadow, arrowTilt: CURSOR_DEFAULTS.arrowTilt,
      cursorPressEnabled: CURSOR_PRESS_DEFAULTS.enabled, cursorPressDepth: CURSOR_PRESS_DEFAULTS.depth, cursorPressReturnMs: CURSOR_PRESS_DEFAULTS.returnMs,
      cursorSize: CURSOR_DEFAULTS.size, cursorStroke: CURSOR_DEFAULTS.stroke, cursorAdaptive: true, cursorCoreColor: CURSOR_DEFAULTS.coreColor, cursorCoreColorDark: CURSOR_DEFAULTS.coreColorDark,
      cursorHaloWidth: CURSOR_DEFAULTS.haloWidth, cursorHaloColor: CURSOR_DEFAULTS.haloColor, cursorHaloOpacity: CURSOR_DEFAULTS.haloOpacity,
      cursorDotColor: CURSOR_DEFAULTS.dotColor, cursorGap: CURSOR_DEFAULTS.gap,
      cursorCentre: CURSOR_DEFAULTS.centre, cursorHoverDot: CURSOR_DEFAULTS.hoverDot, cursorPressContract: CURSOR_DEFAULTS.pressContract,
      cursorResizeStyle: CURSOR_DEFAULTS.resizeStyle,
    }));
  }
  // Snap to the step and keep only the step's decimals: 1.25 − 0.05 is 1.2, not
  // 1.2000000000000002 (which the field would show).
  const num = (v: string, lo: number, hi: number, d: number, step = 1) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return d;
    const decimals = (String(step).split(".")[1] ?? "").length;
    return +Math.min(hi, Math.max(lo, Math.round(n / step) * step)).toFixed(decimals);
  };

  // --- Rows ------------------------------------------------------------------
  const put = <K extends keyof Settings>(key: K, value: Settings[K]) => settings.update((v) => ({ ...v, [key]: value }));
  type NumKey = { [K in keyof Settings]-?: Settings[K] extends number ? K : never }[keyof Settings];
  /** One stepper row: − value unit +. `parse` owns the clamp, so typing and stepping agree. */
  type NumRow = { label: string; aria?: string; sub?: string; unit?: string; value: number; min: number; max: number; step: number; parse: (v: string) => number; set: (n: number) => void };
  const ranged = (key: NumKey, range: { min: number; max: number }, step: number, fallback: number, label: string, aria: string, unit = "", sub = ""): NumRow => ({
    label, aria, unit, sub, step, min: range.min, max: range.max, value: $settings[key],
    parse: (v) => num(v, range.min, range.max, fallback, step),
    set: (n) => put(key, n),
  });
  const stepBy = (row: NumRow, direction: 1 | -1) => row.set(row.parse(String(row.value + direction * row.step)));

  // --- Tabs ------------------------------------------------------------------
  type TabId = "general" | "figure" | "paper" | "corrections";
  const TABS: { id: TabId; label: string; icon: string }[] = [
    { id: "general", label: "General", icon: "settings" },
    { id: "figure", label: "Figure", icon: "figure" },
    { id: "paper", label: "Paper", icon: "paper" },
    { id: "corrections", label: "Corrections", icon: "" },
  ];
  const TAB_KEY = "flux.ui.settingsTab";
  function loadTab(): TabId {
    try {
      const v = localStorage.getItem(TAB_KEY);
      if (TABS.some((t) => t.id === v)) return v as TabId;
    } catch {}
    return "general";
  }
  let tab = $state<TabId>(loadTab());
  function selectTab(id: TabId) {
    tab = id;
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {}
  }
  // Vertical tablist keyboard model: ↑/↓ (Home/End) move selection and focus.
  function onTabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowUp") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    selectTab(TABS[next].id);
    document.getElementById(`settings-tab-${TABS[next].id}`)?.focus();
  }

  // --- FluxConfig location (desktop app only) --------------------------------
  // ONE user-facing folder for all user-level Flux state (FluxLib, Guidelines).
  // Moving it moves everything; the folder is always named exactly "FluxConfig"
  // (the user picks its PARENT). FluxLib is derived: <FluxConfig>/FluxLib.
  let cfgPath = $state("");
  let libPath = $state("");
  let plotLibPath = $state("");
  let libNotice = $state("");
  let libBusy = $state(false);
  let correctionLearningReset = $state(false);
  let modalEl = $state<HTMLDivElement | null>(null);
  let prevFocus: HTMLElement | null = null;

  async function loadLib() {
    try {
      const p = await fileBridge()?.prefsGet?.();
      cfgPath = (p?.fluxConfigResolved as string) ?? "";
      libPath = (p?.fluxLibResolved as string) ?? "";
      plotLibPath = (p?.plotLibraryResolved as string) ?? "";
    } catch {
      cfgPath = "";
      libPath = "";
      plotLibPath = "";
    }
  }

  async function revealCfg() {
    if (cfgPath) await fileBridge()?.revealPath?.(cfgPath);
  }

  async function moveCfg() {
    const fb = fileBridge();
    if (!fb?.openDirectory || !fb?.configMove) {
      libNotice = "Moving FluxConfig needs the desktop app.";
      return;
    }
    libBusy = true;
    try {
      const parent = await fb.openDirectory("Choose the new parent folder for FluxConfig");
      if (!parent) return;
      const r = await fb.configMove(parent);
      if (r && "error" in r && r.error) {
        libNotice = `Couldn't move FluxConfig: ${r.error}`;
        return;
      }
      if (r && "path" in r && r.path) cfgPath = r.path;
      libNotice = "FluxConfig moved. Restart Flux to finish switching over.";
    } catch (e) {
      libNotice = `Couldn't move FluxConfig: ${(e as Error).message}`;
    } finally {
      libBusy = false;
    }
  }

  // Open: refresh the displayed library path and move focus into the
  // dialog. Close: clear the transient notice and hand focus back to wherever
  // it was.
  $effect(() => {
    if ($settingsOpen) {
      prevFocus = document.activeElement as HTMLElement | null;
      untrack(() => void loadLib());
      queueMicrotask(() => modalEl?.focus());
    } else {
      libNotice = "";
      if (prevFocus) {
        prevFocus.focus?.();
        prevFocus = null;
      }
    }
  });

  function onKey(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    if ($settingsOpen && e.key === "Escape") {
      e.preventDefault();
      settingsOpen.set(false);
    }
  }

  function resetCorrectionLearning() {
    clearLocalCorrectionLearning();
    window.dispatchEvent(new Event(LOCAL_CORRECTION_RESET_EVENT));
    correctionLearningReset = true;
    window.setTimeout(() => (correctionLearningReset = false), 1800);
  }

  // Open/close is opacity only, ≤ 90 ms — and nothing under reduced motion.
  const fadeMs = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 80;

  // Each margin scene with a small drawing of its character (24 × 16, stroked).
  const marginScenes: { v: Settings["paperMarginScene"]; l: string; d: string }[] = [
    { v: "harmonograph", l: "Harmonograph", d: "M3 8a9 6 0 0 1 18 0a7.5 5 0 0 1-15 0a6 4 0 0 1 12 0a4.5 3 0 0 1-9 0a3 2 0 0 1 6 0a1.5 1 0 0 1-3 0" },
    { v: "neurons", l: "Neurons", d: "M8.5 9 3 4.5M8.5 9 4 13.5M8.5 9l6-2.5 4.5-3.5M14.5 6.5l5.5 2.5M8.5 9l5 4.5 6.5.5M8.5 7.4a1.6 1.6 0 1 0 .01 0" },
    { v: "inkwind", l: "Ink wind", d: "M2 4.5c5-3 9 3 14 0 2-1.2 4-1.2 6-.5M2 8.5c5-3 9 3 14 0 1.5-.9 3-1 4-.8M4 12.5c4-2.4 7 2.4 11 0" },
    { v: "loom", l: "Loom", d: "M6 2v12M12 2v12M18 2v12M2 5.5h20M2 10.5h20" },
    { v: "vines", l: "Vines", d: "M3 14c4 0 5-4 9-4s5-5 9-6.5M9 11c-1.5-1.5-1.5-3.5 0-5M14.5 9.2c1.5 1.3 3.5 1.3 5 0M6 13.5c0-1.5 1-2.5 2.5-2.5" },
  ];
</script>

<svelte:window onkeydown={onKey} />

{#snippet toggle(label: string, on: boolean, set: (v: boolean) => void, sub: string = "", aria: string = "")}
  <label class="chk">
    <input type="checkbox" checked={on} aria-label={aria || undefined} onchange={(e) => set(e.currentTarget.checked)} />
    <span class="nm">{label}{#if sub}<small>{sub}</small>{/if}</span>
  </label>
{/snippet}

<!-- The field comes first in the DOM so a click on the name lands in it, not on a stepper. -->
{#snippet numRow(o: NumRow)}
  <label class="chk num">
    <span class="nm">{o.label}{#if o.sub}<small>{o.sub}</small>{/if}</span>
    <span class="numf">
      <input type="number" min={o.min} max={Number.isFinite(o.max) ? o.max : undefined} step={o.step} value={o.value} aria-label={o.aria ?? o.label} onchange={(e) => o.set(o.parse(e.currentTarget.value))} />
      <i class="unit">{o.unit ?? ""}</i>
      <button type="button" class="step dec" tabindex="-1" aria-label={`Decrease ${(o.aria ?? o.label).toLowerCase()}`} disabled={o.value <= o.min} onclick={() => stepBy(o, -1)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" /></svg></button>
      <button type="button" class="step inc" tabindex="-1" aria-label={`Increase ${(o.aria ?? o.label).toLowerCase()}`} disabled={o.value >= o.max} onclick={() => stepBy(o, 1)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6M6 3v6" /></svg></button>
    </span>
  </label>
{/snippet}

{#snippet colour(label: string, aria: string, value: string, fallback: string, set: (hex: string) => void)}
  <div class="row cursor-colour">
    <span class="nm">{label}</span>
    <ColorField {value} {fallback} label={aria} onchange={set} />
  </div>
{/snippet}

{#if $settingsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="bk" transition:fade={{ duration: fadeMs() }} onclick={() => settingsOpen.set(false)}>
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      bind:this={modalEl}
      use:modalFocus
      onclick={(e) => e.stopPropagation()}>
      <div class="head">
        <span class="mark" aria-hidden="true"><Icon name="settings" size={14} /></span>
        <span class="title">Settings</span>
        <span class="vsep" aria-hidden="true"></span>
        <span class="scope">for every project · saved as you change them</span>
        <button class="x" aria-label="Close" title="Close (Esc)" onclick={() => settingsOpen.set(false)}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /></svg></button>
      </div>

      <div class="body">
        <div class="tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {#each TABS as t (t.id)}
            <button
              class="tab"
              class:on={tab === t.id}
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`settings-pane-${t.id}`}
              tabindex={tab === t.id ? 0 : -1}
              onclick={() => selectTab(t.id)}
              onkeydown={onTabKey}><span class="ti" aria-hidden="true">{#if t.icon}<Icon name={t.icon} size={16} />{:else}<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 18.5c1.5-2 3-2 4.5 0s3 2 4.5 0 3-2 4.5 0 3 2 4.5 0" stroke-width="1.8" /><path d="M6.5 9.5l3.5 3.5L17.5 5" stroke="var(--c-accent)" stroke-width="2.2" /></svg>{/if}</span>{t.label}</button>
          {/each}
          <button class="guide" title="Open this section of the guide in your browser" onclick={() => void openDocs({ surface: "settings", tab })}>
            <span>Guide</span>
            <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5l-7 7" /></svg>
          </button>
        </div>

        <div class="content">
          <!-- ---------------------------------------------------------- General -->
          <div class="pane" role="tabpanel" id="settings-pane-general" aria-labelledby="settings-tab-general" hidden={tab !== "general"}>
            <section class="grp">
              <h3>Setup</h3>
              <div class="item">
                <span class="nm">What Flux works with<small>The terminal command, Word export (Quarto), PDF through Quarto, fluxplot and AI agents.</small></span>
                <button class="ghost" data-open-setup onclick={() => { settingsOpen.set(false); void import("../shell/setup/setupState").then((m) => m.openSetup()); }}>Set up Flux…</button>
              </div>
            </section>

            <section class="grp">
              <h3>FluxConfig folder</h3>
              <div class="pathrow">
                <div class="libpath" title={cfgPath}>{cfgPath || "—"}</div>
                <button class="ghost" onclick={revealCfg} disabled={!cfgPath}>Reveal</button>
                <button class="ghost" onclick={moveCfg} disabled={libBusy}>{libBusy ? "Moving…" : "Move…"}</button>
              </div>
              <p class="hint">Everything user-level lives here — the reference library ({libPath || "FluxLib"}), and the agent Context folders.</p>
              {#if libNotice}<p class="hint notice">{libNotice}</p>{/if}
            </section>

            <section class="grp">
              <h3>Agents</h3>
              {@render toggle("Allow agents to view the Flux window", $settings.allowAgentView, (v) => put("allowAgentView", v), "A paired agent can capture a picture of this project's window when you mean “this”.")}
              {#await import("../shell/agent/RunnerSettings.svelte") then module}<module.default />{/await}
            </section>

            <section class="grp">
              <h3>Updates</h3>
              {@render toggle("Check for a newer version on launch", $settings.updateCheck, (v) => put("updateCheck", v), "Desktop app only.")}
            </section>

            <section class="grp">
              <h3>Palette</h3>
              {@render toggle("Include the Flexoki palette in new projects", $settings.flexokiDefault, (v) => put("flexokiDefault", v))}
            </section>

            <section class="grp">
              <h3>Cursor</h3>
              <div class="cursor-preview" aria-label="Cursor preview">
                {#each CURSOR_PREVIEW as c (c.state)}
                  <figure class="cursor-cell">
                    <div class="swatch" title="Hover to see the real cursor">
                      <span class="half dark cursor-on-dark" style:cursor={cursorFamilyDark[c.state].css}><img src={cursorImg(c.state, "dark")} alt={c.label} width={$settings.cursorSize * 2} height={$settings.cursorSize * 2} draggable="false" /></span>
                      <span class="half light cursor-on-light" style:cursor={cursorFamily[c.state].css}><img src={cursorImg(c.state, "light")} alt="" width={$settings.cursorSize * 2} height={$settings.cursorSize * 2} draggable="false" /></span>
                    </div>
                    <figcaption>{c.label}</figcaption>
                  </figure>
                {/each}
              </div>
              <p class="hint">The pointer of the Figure and Slide editors (Paper, Reader and Library keep the system's). It is one mark that changes form: over a handle or edge it becomes the resize arrows, outside a corner the rotate arc, and it keeps that form for the whole drag. Hover a tile to see the real cursor.</p>
              <label class="row">
                <span class="nm">Style</span>
                <select bind:value={$settings.cursorStyle} aria-label="Cursor style">
                  <option value="classic">Classic arrow</option>
                  <option value="crosshair">Crosshair</option>
                </select>
              </label>

              {#if $settings.cursorStyle === "classic"}
                <h4>Press</h4>
                {@render toggle("Press on click", $settings.cursorPressEnabled, (v) => put("cursorPressEnabled", v), "A small, tip-led press into the surface, then a quiet return. The tip stays on the point you click.", "Cursor press animation")}
                {#if $settings.cursorPressEnabled}
                  {@render numRow(ranged("cursorPressDepth", CURSOR_PRESS_DEPTH_RANGE, 0.05, CURSOR_PRESS_DEFAULTS.depth, "Press depth", "Cursor press depth", "×", "Lower is subtler."))}
                  {@render numRow(ranged("cursorPressReturnMs", CURSOR_PRESS_RETURN_RANGE, 5, CURSOR_PRESS_DEFAULTS.returnMs, "Return time", "Cursor press return time", "ms", "Shorter feels tighter, longer feels softer."))}
                {/if}
                <button type="button" class="cursor-press-trial" style:cursor={cursorFamily.cross.css} use:cursorPress={cursorFamily.cross.css}>Click to try the press</button>

                <h4>Arrow</h4>
                {@render colour("Fill", "Arrow fill colour", $settings.arrowFill, CURSOR_DEFAULTS.arrowFill, (hex) => put("arrowFill", hex))}
                {@render colour("Outline", "Arrow outline colour", $settings.arrowOutline, CURSOR_DEFAULTS.arrowOutline, (hex) => put("arrowOutline", hex))}
                {@render colour("Dot colour", "Dot colour", $settings.cursorDotColor, CURSOR_DEFAULTS.dotColor, (hex) => put("cursorDotColor", hex))}
                {@render numRow(ranged("arrowSize", ARROW_SIZE_RANGE, 1, CURSOR_DEFAULTS.arrowSize, "Size", "Arrow size", "px"))}
                {@render numRow(ranged("arrowOutlineWidth", ARROW_OUTLINE_RANGE, 0.1, CURSOR_DEFAULTS.arrowOutlineWidth, "Outline width", "Arrow outline width", "px"))}
                {@render numRow(ranged("arrowRounding", ARROW_ROUNDING_RANGE, 0.1, CURSOR_DEFAULTS.arrowRounding, "Corner rounding", "Arrow corner rounding", "px"))}
                {@render numRow(ranged("arrowShadow", ARROW_SHADOW_RANGE, 0.05, CURSOR_DEFAULTS.arrowShadow, "Shadow", "Arrow shadow amount", "", "0 is none, 1 is strong."))}
                {@render numRow(ranged("arrowTilt", ARROW_TILT_RANGE, 1, CURSOR_DEFAULTS.arrowTilt, "Tilt", "Arrow tilt", "°"))}
                <p class="hint">A slightly leaning arrow with a contrasting outline and a gentle shadow lift. The resize and rotate arrows use the same fill and outline; the dot colour marks the rotate centre and the duplicate badge.</p>
              {/if}

              {#if $settings.cursorStyle === "crosshair"}
                <h4>Colours</h4>
                <label class="row">
                  <span class="nm">Colours</span>
                  <select value={cursorPreset} onchange={(e) => applyCursorPreset(e.currentTarget.value)} aria-label="Cursor colour preset">
                    {#each ["adaptive", "outlined", "accent", "custom"] as id (id)}<option value={id} disabled={id === "custom" && cursorPreset !== "custom"}>{PRESET_LABELS[id as CursorPreset]}</option>{/each}
                  </select>
                </label>
                {@render toggle("Adapt the colour to the surface", $settings.cursorAdaptive, (v) => put("cursorAdaptive", v), "One colour over paper and other light surfaces, another over the dark canvas, chrome and dark fills.")}
                {@render colour($settings.cursorAdaptive ? "Crosshair on light surfaces" : "Crosshair colour", "Crosshair colour", $settings.cursorCoreColor, CURSOR_DEFAULTS.coreColor, (hex) => put("cursorCoreColor", hex))}
                {#if $settings.cursorAdaptive}
                  {@render colour("Crosshair on dark surfaces", "Crosshair colour on dark surfaces", $settings.cursorCoreColorDark, CURSOR_DEFAULTS.coreColorDark, (hex) => put("cursorCoreColorDark", hex))}
                {/if}
                {@render colour("Halo colour", "Halo colour", $settings.cursorHaloColor, CURSOR_DEFAULTS.haloColor, (hex) => put("cursorHaloColor", hex))}
                {@render colour("Dot colour", "Dot colour", $settings.cursorDotColor, CURSOR_DEFAULTS.dotColor, (hex) => put("cursorDotColor", hex))}
                {@render numRow(ranged("cursorStroke", CURSOR_STROKE_RANGE, 0.1, CURSOR_DEFAULTS.stroke, "Crosshair stroke", "Crosshair stroke width", "px"))}
                {@render numRow(ranged("cursorHaloWidth", CURSOR_HALO_WIDTH_RANGE, 0.1, CURSOR_DEFAULTS.haloWidth, "Halo width", "Halo stroke width", "px"))}
                {@render numRow(ranged("cursorHaloOpacity", CURSOR_HALO_OPACITY_RANGE, 0.05, CURSOR_DEFAULTS.haloOpacity, "Halo opacity", "Halo opacity"))}
                <p class="hint">The halo is an outline drawn under the crosshair; it is off by default (width 0) because the adaptive colour already keeps the mark legible — give it a width to bring the outlined look back. The dot is the accent that marks anything you can select, the rotate centre and the duplicate badge.</p>

                <h4>Shape</h4>
                <label class="row">
                  <span class="nm">Centre at rest</span>
                  <select bind:value={$settings.cursorCentre} aria-label="Cursor centre mark">
                    <option value="none">Empty gap</option>
                    <option value="dot">Dot</option>
                    <option value="ring">Ring</option>
                  </select>
                </label>
                {@render numRow(ranged("cursorSize", CURSOR_SIZE_RANGE, 2, CURSOR_DEFAULTS.size, "Size", "Cursor size", "px"))}
                {@render numRow(ranged("cursorGap", CURSOR_GAP_RANGE, 1, CURSOR_DEFAULTS.gap, "Centre gap", "Cursor centre gap", "px"))}
                {@render toggle("Dot over anything you can select", $settings.cursorHoverDot, (v) => put("cursorHoverDot", v))}
                {@render toggle("Arms pull in while pressing", $settings.cursorPressContract, (v) => put("cursorPressContract", v))}
              {/if}

              <h4>Handles</h4>
              {@render toggle("Use the system's resize, rotate and move cursors instead", $settings.cursorResizeStyle === "system", (v) => put("cursorResizeStyle", v ? "system" : "crosshair"))}
              <div class="cursor-actions">
                <button type="button" class="ghost" onclick={resetCursor} disabled={cursorIsDefault}>Reset cursor to defaults</button>
              </div>
            </section>
          </div>

          <!-- ----------------------------------------------------------- Figure -->
          <div class="pane" role="tabpanel" id="settings-pane-figure" aria-labelledby="settings-tab-figure" hidden={tab !== "figure"}>
            <section class="grp">
              <h3>Rulers &amp; grid</h3>
              <label class="chk">
                <input type="checkbox" checked={$settings.showRulers} onchange={(e) => put("showRulers", e.currentTarget.checked)} />
                <span class="nm">Show rulers <kbd>Shift+R</kbd><small>Drag from a ruler to place a guide.</small></span>
              </label>
              <label class="chk">
                <input type="checkbox" checked={$settings.showGrid} onchange={(e) => put("showGrid", e.currentTarget.checked)} />
                <span class="nm">Show background grid <kbd>Shift+G</kbd><small>While it is visible, the pen places nodes on its vertices.</small></span>
              </label>
              {@render toggle("Snap to grid", $settings.snapGrid, (v) => put("snapGrid", v))}
              {@render numRow({ label: "Grid size", unit: "px", value: $settings.gridSize, min: 1, max: Infinity, step: 1, parse: (v) => Math.max(1, parseFloat(v) || 1), set: (n) => put("gridSize", n) })}
              {@render toggle("Snap to pixel", $settings.snapPixel, (v) => put("snapPixel", v), "Rounds coordinates when a change is committed, for a crisp export.")}
              {@render toggle("Connectors stick to shapes", $settings.connectorsStick, (v) => put("connectorsStick", v), "A line end released on a shape follows it.")}
            </section>

            <section class="grp">
              <h3>Slides</h3>
              <label class="chk">
                <input type="checkbox" checked={$settings.slideBackAnimates !== false} onchange={(e) => put("slideBackAnimates", e.currentTarget.checked)} />
                <span class="nm">Back plays the step in reverse<small>In Present, <b>Back</b> rewinds the step you just saw instead of cutting to the one before. Exported decks always rewind. Pressing Back twice quickly still jumps; slides with video or 3D always cut.</small></span>
              </label>
            </section>

            <section class="grp">
              <h3>Figure-Meta captions</h3>
              <label class="chk num">
                <span class="nm">Font size<small>The typing size in Figure-Meta <kbd>Alt+M</kbd>. Each field grows to fit its text; scroll the fields column to move between captions.</small></span>
                <span class="numf">
                  <input type="number" min="9" max="28" step="1" value={$settings.captionFontSize} aria-label="Caption font size"
                    onchange={(e) => put("captionFontSize", Math.min(28, Math.max(9, Math.round(parseFloat(e.currentTarget.value) || 16))))} />
                  <i class="unit">px</i>
                  <button type="button" class="step dec" tabindex="-1" aria-label="Decrease caption font size" disabled={$settings.captionFontSize <= 9} onclick={() => put("captionFontSize", Math.max(9, $settings.captionFontSize - 1))}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" /></svg></button>
                  <button type="button" class="step inc" tabindex="-1" aria-label="Increase caption font size" disabled={$settings.captionFontSize >= 28} onclick={() => put("captionFontSize", Math.min(28, $settings.captionFontSize + 1))}><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6M6 3v6" /></svg></button>
                </span>
              </label>
            </section>

            <section class="grp">
              <h3>Physical sizes</h3>
              <label class="row">
                <span class="nm">Show sizes in<small>How the Inspector and the Plots rail's Peek give a plot's or figure's printed size. Inches match matplotlib's <code>figsize</code>.</small></span>
                <select bind:value={$settings.physicalUnit} aria-label="Physical size unit" data-physical-unit>
                  <option value="in">Inches</option>
                  <option value="mm">Millimetres</option>
                </select>
              </label>
            </section>

            <section class="grp">
              <h3>Plot gallery</h3>
              <label class="row">
                <span class="nm">Search reaches<small>What typing in the Plot gallery <kbd>Shift+Alt+G</kbd> searches. <b>Project</b> is this project's <code>plots/</code> folder; <b>Global</b> is your plot library in <code>{plotLibPath || "FluxConfig/plot_library"}</code>, shared by every project. The switch at the top of the gallery picks which one you browse.</small></span>
                <select bind:value={$settings.plotSearchScope} aria-label="Plot gallery search scope">
                  {#each PLOT_SEARCH_SCOPES as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
                </select>
              </label>
              <label class="row">
                <span class="nm">Folders open<small>Where the Plots rail's folder navigator <kbd>Alt+/</kbd> appears. <b>Beside the rail</b> is a panel off the rail's edge that leaves Dissections in place; <b>In the lower pane</b> takes the place of Dissections. The button in the navigator's header switches too.</small></span>
                <select value={$railPrefs.folders} aria-label="Folder navigator placement" onchange={(e) => railPrefs.update((p) => ({ ...p, folders: e.currentTarget.value === "below" ? "below" : "beside" }))}>
                  <option value="beside">Beside the rail</option>
                  <option value="below">In the lower pane</option>
                </select>
              </label>
              <label class="chk">
                <input type="checkbox" checked={$settings.galleryFolderClickExpands} onchange={(e) => put("galleryFolderClickExpands", e.currentTarget.checked)} />
                <span class="nm">Clicking a gallery folder expands/collapses it<small>Off: clicking a folder in the gallery's <b>Folders</b> sidebar only shows what is in it, and the <b>›</b> arrow beside it expands or collapses the subtree. On: the click does both.</small></span>
              </label>
            </section>

            <section class="grp">
              <h3>Colour pickers</h3>
              <label class="row">
                <span class="nm">Palette collection</span>
                <select bind:value={$settings.paletteCollection} aria-label="Default palette collection">
                  {#each PALETTE_COLLECTIONS as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
                  <option value="project">Project palette</option>
                </select>
              </label>
              <label class="row">
                <span class="nm">Colormap collection</span>
                <select bind:value={$settings.colormapCollection} aria-label="Default colormap collection">
                  {#each COLORMAP_COLLECTIONS as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
                </select>
              </label>
              <p class="hint">The collection a picker opens on. Every collection stays a <kbd>Shift+Tab</kbd> away inside the picker; <kbd>Tab</kbd> switches between palettes and colormaps.</p>
            </section>

            <section class="grp">
              <h3>Property menu</h3>
              <p class="hint lead">Press <kbd>F</kbd> with objects selected. The menu opens beside the selection; every property has a left-hand key, and the mouse wheel adjusts the armed value.</p>
            </section>
          </div>

          <!-- ------------------------------------------------------------ Paper -->
          <div class="pane" role="tabpanel" id="settings-pane-paper" aria-labelledby="settings-tab-paper" hidden={tab !== "paper"}>
            <section class="grp">
              <h3>Dynamic margin background</h3>
              <div class="seg scenes" role="radiogroup" aria-label="Dynamic margin background">
                {#each marginScenes as m (m.v)}
                  <button role="radio" aria-checked={$settings.paperMarginScene === m.v} class:on={$settings.paperMarginScene === m.v} onclick={() => put("paperMarginScene", m.v)}>
                    <svg viewBox="0 0 24 16" aria-hidden="true"><path d={m.d} /></svg>
                    <span>{m.l}</span>
                  </button>
                {/each}
              </div>
              <p class="hint">What drifts behind the margin while no pane is open. It changes as you choose.</p>
            </section>

            <section class="grp">
              <h3>Dynamic panes</h3>
              {@render numRow({ label: "Max panes open at once", value: $settings.paperMaxMarginPanes, min: 1, max: 6, step: 1, parse: (v) => Math.min(6, Math.max(1, Math.round(parseFloat(v) || 4))), set: (n) => put("paperMaxMarginPanes", n), sub: "Opening one more closes the oldest." })}
              {@render toggle("Clean dynamic margin", $settings.paperCleanMargin, (v) => put("paperCleanMargin", v), "Close all panes when focus returns to the editor.")}
            </section>
          </div>

          <!-- ------------------------------------------------------ Corrections -->
          <div class="pane" role="tabpanel" id="settings-pane-corrections" aria-labelledby="settings-tab-corrections" hidden={tab !== "corrections"}>
            <section class="grp">
              <h3>Local corrections</h3>
              {@render toggle("Correct clear typing and spacing errors as I write", $settings.paperLocalCorrections, (v) => put("paperLocalCorrections", v), "Runs entirely on this device. A blue pulse marks each correction; click it for details or press Undo to restore the original.")}
              <div class="item">
                <span class="nm">What Flux has learned<small>Reverting a correction teaches this project what to leave alone. Resetting these lessons keeps explicit dictionaries and aliases.</small></span>
                <button class="ghost learning-reset" class:did={correctionLearningReset} onclick={resetCorrectionLearning}>
                  {correctionLearningReset ? "Learning reset" : "Reset correction learning"}
                </button>
              </div>
            </section>

            <section class="grp">
              <h3>English dialect</h3>
              <label class="row">
                <span class="nm">Spelling follows<small>Click or hover an underlined word for spelling suggestions, type your own correction, or add it to your personal dictionary. Accepted corrections are remembered across projects. Common neuroscience and biology terms are included in your personal dictionary.</small></span>
                <select aria-label="Correction dialect" value={$settings.paperCorrectionDialect} onchange={(e) => put("paperCorrectionDialect", e.currentTarget.value as Settings["paperCorrectionDialect"])}>
                  <option value="american">US English</option>
                  <option value="british">British English</option>
                  <option value="canadian">Canadian English</option>
                  <option value="australian">Australian English</option>
                </select>
              </label>
            </section>
          </div>
        </div>
      </div>

      <div class="foot">
        <span class="keys"><kbd>↑</kbd><kbd>↓</kbd> sections <span class="dot">·</span> <kbd>Esc</kbd> close</span>
        <button class="close" onclick={() => settingsOpen.set(false)}>Done</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* ---- scrim + panel ------------------------------------------------------ */
  .bk {
    position: fixed;
    inset: 0;
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.35);
  }
  .modal {
    --ctl: 212px; /* the control column: selects and colour fields share it */
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: min(840px, calc(100vw - 40px));
    height: min(640px, calc(100vh - 40px));
    overflow: hidden;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-3);
    color: var(--c-tx);
    font: 13px/1.35 var(--font-serif);
    -webkit-font-smoothing: antialiased;
  }
  .modal:focus {
    outline: none;
  }
  .modal *,
  .modal *::before {
    box-sizing: border-box;
  }
  svg {
    display: block;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* ---- header · body · footer, hairline-separated -------------------------- */
  .head {
    flex: 0 0 36px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 6px 0 12px;
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
  }
  .mark {
    display: inline-flex;
    color: var(--c-tx-muted);
  }
  .title {
    font: 600 14px var(--font-serif);
    color: var(--c-tx-hi);
    white-space: nowrap;
  }
  .vsep {
    flex: 0 0 1px;
    height: 14px;
    background: var(--c-line-strong);
  }
  .scope {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--c-tx-muted);
    font: 11px var(--font-mono);
  }
  button {
    margin: 0;
    font: inherit;
    cursor: var(--cursor-cross-hover);
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  button:disabled {
    cursor: var(--cursor-cross);
  }
  .x {
    flex: 0 0 24px;
    width: 24px;
    height: 24px;
    padding: 0;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
  }
  .x svg {
    width: 12px;
    height: 12px;
    stroke-width: 1.5;
  }
  .x:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  .foot {
    flex: 0 0 38px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 8px 0 12px;
    background: var(--c-bg-raised);
    border-top: 1px solid var(--c-line);
  }
  .keys {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--c-tx-muted);
    font: 11px var(--font-ui);
  }
  .keys kbd {
    margin-right: 3px;
  }
  .keys .dot {
    margin: 0 5px;
    color: var(--c-tx-faint);
  }

  /* ---- tab column ---------------------------------------------------------- */
  .tabs {
    flex: 0 0 172px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 8px 6px;
    background: var(--c-bg-raised);
    border-right: 1px solid var(--c-line);
  }
  .tab {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    align-items: center;
    column-gap: 9px;
    height: 30px;
    padding: 0 8px 0 9px;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: var(--r-ui);
    color: var(--c-tx-2);
    font: 13px var(--font-serif);
    white-space: nowrap;
  }
  .ti {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    opacity: 0.7;
  }
  .tab:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .tab:hover .ti,
  .tab.on .ti {
    opacity: 1;
  }
  .tab:active {
    background: var(--c-accent-tint);
  }
  .tab.on {
    background: var(--c-accent-tint);
    box-shadow: inset 2px 0 0 var(--c-accent);
    color: var(--c-tx-hi);
  }

  /* The guide's page for the open section, at the foot of the rail. */
  .guide {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    margin-top: auto;
    padding: 0 9px;
    background: transparent;
    border: 0;
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
    font: 12px var(--font-serif);
    text-align: left;
  }
  .guide svg {
    width: 10px;
    height: 10px;
    stroke-width: 1.4;
  }
  .guide:hover {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }

  /* ---- content pane -------------------------------------------------------- */
  .content {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    overflow: hidden;
  }
  /* Each section owns its scroll position, so switching tabs never carries
     the previous section's offset into a different group of settings. */
  .pane {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 0 22px 24px;
    scrollbar-gutter: stable;
  }
  .pane[hidden] {
    display: none;
  }
  .grp {
    margin: 0;
    padding-bottom: 10px;
  }
  /* A section's head stays pinned while its rows scroll under it. */
  h3 {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: flex-end;
    height: 36px;
    margin: 0 0 4px;
    padding-bottom: 6px;
    background: var(--c-surface);
    border-bottom: 1px solid var(--c-line);
    font: 600 10px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--c-tx-muted);
  }
  h4 {
    margin: 14px 0 2px;
    font: 600 10px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--c-tx-faint);
  }

  /* ---- one row anatomy: name (and what it does) · control ------------------ */
  .chk,
  .row,
  .item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    /* The control sits on the NAME's line, however long the description under it runs. */
    align-items: start;
    column-gap: 20px;
    min-height: 32px;
    margin: 0;
    padding: 4px 0;
  }
  .chk {
    cursor: var(--cursor-cross-hover);
  }
  .nm {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
    padding-top: 3px;
    color: var(--c-tx);
    font: 13px/1.35 var(--font-serif);
    transition: color 80ms linear;
  }
  .chk:hover .nm {
    color: var(--c-tx-hi);
  }
  .nm small {
    display: block;
    max-width: 60ch;
    margin-top: 2px;
    color: var(--c-tx-muted);
    font: 11.5px/1.45 var(--font-serif);
  }
  .nm > kbd {
    margin-left: 5px;
    vertical-align: 1px;
  }
  .hint {
    max-width: 68ch;
    margin: 4px 0 6px;
    color: var(--c-tx-muted);
    font: 11.5px/1.5 var(--font-serif);
  }
  .hint.lead {
    margin-top: 8px;
  }
  .hint.notice {
    color: var(--c-tx);
  }
  kbd {
    color: var(--c-tx-2);
  }
  small kbd,
  .hint kbd {
    margin: 0 1px;
    vertical-align: 1px;
  }
  b {
    color: var(--c-tx-2);
    font-weight: 600;
  }
  code {
    padding: 0 3px;
    background: var(--c-surface-2);
    border-radius: var(--r-ui);
    color: var(--c-tx-2);
    font: 10.5px var(--font-mono);
  }

  /* Switch: a square track and a knob that slides. Checkbox semantics, so the
     whole row is its hit target. */
  .chk input[type="checkbox"] {
    grid-column: 2;
    grid-row: 1;
    justify-self: end;
    position: relative;
    appearance: none;
    -webkit-appearance: none;
    width: 30px;
    height: 16px;
    margin: 4px 0 0;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    cursor: var(--cursor-cross-hover);
    transition: background-color 90ms linear, border-color 90ms linear;
  }
  .chk input[type="checkbox"]::before {
    content: "";
    position: absolute;
    left: 2px;
    top: 2px;
    width: 10px;
    height: 10px;
    border-radius: 1px;
    background: var(--c-tx-muted);
    transition: transform 90ms var(--ease-standard, ease-out), background-color 90ms linear;
  }
  .chk:hover input[type="checkbox"] {
    border-color: var(--c-tx-muted);
  }
  .chk input[type="checkbox"]:checked {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
  }
  .chk input[type="checkbox"]:checked::before {
    transform: translateX(14px);
    background: var(--c-accent);
  }
  .chk:active input[type="checkbox"]::before {
    transform: translateX(3px);
  }
  .chk:active input[type="checkbox"]:checked::before {
    transform: translateX(11px);
  }

  /* Stepper field: − value unit +, one box. */
  .numf {
    grid-column: 2;
    grid-row: 1;
    display: inline-flex;
    align-items: stretch;
    height: 24px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    transition: border-color 80ms linear;
  }
  .numf:hover {
    border-color: var(--c-tx-muted);
  }
  .numf:focus-within {
    border-color: var(--c-accent);
  }
  .numf input {
    order: 1;
    width: 50px;
    min-width: 0;
    height: 22px;
    margin: 0;
    padding: 0 0 0 6px;
    background: transparent;
    border: 0;
    outline: none;
    color: var(--c-tx);
    font: 12px var(--font-mono);
    font-variant-numeric: tabular-nums;
    text-align: right;
    -moz-appearance: textfield;
    appearance: textfield;
  }
  .numf input::-webkit-inner-spin-button,
  .numf input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .numf .unit {
    order: 2;
    display: flex;
    align-items: center;
    width: 26px;
    padding-left: 4px;
    color: var(--c-tx-faint);
    font: normal 10.5px var(--font-mono);
  }
  .numf .step {
    display: grid;
    place-items: center;
    width: 22px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 0;
    color: var(--c-tx-muted);
  }
  .numf .step.dec {
    order: 0;
    border-right: 1px solid var(--c-line);
  }
  .numf .step.inc {
    order: 3;
    border-left: 1px solid var(--c-line);
  }
  .numf .step svg {
    width: 12px;
    height: 12px;
    stroke-width: 1.5;
  }
  .numf .step:hover:not(:disabled) {
    background: var(--c-surface-2);
    color: var(--c-tx-hi);
  }
  .numf .step:active:not(:disabled) {
    background: var(--c-accent-tint);
    color: var(--c-accent);
  }
  .numf .step:disabled {
    opacity: 0.3;
  }

  select {
    grid-column: 2;
    grid-row: 1;
    appearance: none;
    -webkit-appearance: none;
    width: var(--ctl);
    min-width: 0;
    height: 24px;
    margin: 0;
    padding: 0 24px 0 8px;
    background: var(--c-bg)
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%23878580' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5 6 7.5l3-3'/%3E%3C/svg%3E")
      no-repeat right 7px center / 11px 11px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx);
    font: 12px var(--font-ui);
    text-overflow: ellipsis;
    cursor: var(--cursor-cross-hover);
    transition: border-color 80ms linear;
  }
  select:hover {
    border-color: var(--c-tx-muted);
  }
  select:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  button:focus-visible,
  input[type="checkbox"]:focus-visible {
    outline: 1px solid var(--c-accent);
    outline-offset: 1px;
  }

  .ghost {
    height: 24px;
    padding: 0 10px;
    background: transparent;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx);
    font: 12.5px var(--font-serif);
    white-space: nowrap;
  }
  .ghost:hover:not(:disabled) {
    background: var(--c-surface-2);
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .ghost:active:not(:disabled) {
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
  }
  .ghost:disabled {
    opacity: 0.4;
  }
  .ghost.did {
    border-color: var(--c-accent);
    color: var(--c-accent);
  }
  .close {
    height: 24px;
    padding: 0 16px;
    background: var(--c-accent-tint);
    border: 1px solid color-mix(in oklab, var(--c-accent) 60%, transparent);
    border-radius: var(--r-ui);
    color: var(--c-tx-hi);
    font: 600 12.5px var(--font-serif);
  }
  .close:hover {
    background: color-mix(in oklab, var(--c-accent) 28%, transparent);
    border-color: var(--c-accent);
  }
  .close:active {
    background: color-mix(in oklab, var(--c-accent) 38%, transparent);
  }

  /* ---- General ------------------------------------------------------------- */
  .pathrow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 6px;
    align-items: center;
    padding: 4px 0;
  }
  .libpath {
    overflow: hidden;
    height: 24px;
    padding: 0 8px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx-2);
    font: 11.5px/22px var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }

  /* ---- cursor preview ------------------------------------------------------- */
  .cursor-preview {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px 6px;
    margin: 8px 0 6px;
  }
  .cursor-cell {
    min-width: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
  }
  .cursor-cell figcaption {
    text-align: center;
    font: 10px var(--font-mono);
    letter-spacing: 0.04em;
    color: var(--c-tx-muted);
  }
  /* a dark half and a paper half, each showing (and carrying) the drawing for its surface */
  .cursor-cell .swatch {
    display: flex;
    border-radius: var(--r-ui);
    border: 1px solid var(--c-line-strong);
    overflow: hidden;
  }
  .cursor-cell .half {
    flex: 1 1 0;
    min-width: 0;
    display: grid;
    place-items: center;
    padding: 6px 4px;
  }
  .cursor-cell .half.dark {
    background: #1c1b1a;
  }
  .cursor-cell .half.light {
    background: #fffcf0;
  }
  .cursor-cell img {
    display: block;
    max-width: 100%;
    image-rendering: auto;
  }
  .cursor-press-trial {
    display: block;
    width: 100%;
    min-height: 46px;
    margin: 6px 0 4px;
    border: 1px dashed var(--c-line-strong);
    border-radius: var(--r-panel);
    background: var(--c-bg);
    color: var(--c-tx-muted);
    font: italic 12.5px var(--font-serif);
    touch-action: manipulation;
  }
  .cursor-press-trial:hover {
    border-color: var(--c-tx-muted);
    color: var(--c-tx-2);
  }
  .cursor-actions {
    display: flex;
    justify-content: flex-end;
    margin: 8px 0 0;
  }
  /* the colour rows: a swatch + hex field in the control column */
  .cursor-colour :global(.wrap) {
    grid-column: 2;
    grid-row: 1;
    width: var(--ctl);
  }

  /* ---- Paper: the margin scenes, each a small drawing and its name ----------- */
  .seg.scenes {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
    margin: 8px 0 6px;
  }
  .seg button {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 7px;
    min-width: 0;
    height: 68px;
    padding: 0 4px;
    background: var(--c-bg);
    border: 1px solid var(--c-line);
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
    font: 12px var(--font-serif);
  }
  .seg button span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .seg button svg {
    width: 42px;
    height: 28px;
    stroke-width: 1.1;
  }
  .seg button:hover {
    background: var(--c-surface-2);
    border-color: var(--c-line-strong);
    color: var(--c-tx-hi);
  }
  .seg button:active {
    background: var(--c-accent-tint);
  }
  .seg button.on {
    background: var(--c-accent-tint);
    border-color: color-mix(in oklab, var(--c-accent) 60%, transparent);
    box-shadow: inset 0 -2px 0 var(--c-accent);
    color: var(--c-tx-hi);
  }
  .seg button.on svg {
    color: var(--c-accent);
  }

  /* Narrow windows: the control column gives way before the names do. */
  @media (max-width: 700px) {
    .modal {
      --ctl: 168px;
    }
    .tabs {
      flex-basis: 132px;
    }
    .pane {
      padding: 0 14px 20px;
    }
    .scope {
      visibility: hidden;
    }
    .seg.scenes {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    button,
    select,
    .nm,
    .numf,
    .chk input[type="checkbox"],
    .chk input[type="checkbox"]::before {
      transition: none;
    }
  }
</style>
