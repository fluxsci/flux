<script lang="ts">
  // Shell-global Settings dialog (title-bar gear / the `settingsOpen` store).
  // A tabbed surface — General · Figure · Paper · Corrections — in the editor
  // chrome language (2026-09-15 surface redesign): one flat panel, hairline
  // dividers, square controls, opacity-only open/close. Every pane stays in
  // the DOM (inactive ones are `hidden`) so the dialog's text and controls are
  // reachable whichever tab was chosen last — the shell and correction gates
  // read them without switching tabs.
  import { fade } from "svelte/transition";
  import { COLORMAP_COLLECTIONS, PALETTE_COLLECTIONS } from "./color/collections";
  import { onDestroy, untrack } from "svelte";
  import { settings, settingsOpen, type Settings } from "./settings";
  import { fileBridge } from "./project/types";
  import {
    clearLocalCorrectionLearning,
    LOCAL_CORRECTION_RESET_EVENT,
  } from "../shell/modes/paper/editing/localCorrectionProfile";

  // --- Tabs ------------------------------------------------------------------
  type TabId = "general" | "figure" | "paper" | "corrections";
  const TABS: { id: TabId; label: string }[] = [
    { id: "general", label: "General" },
    { id: "figure", label: "Figure" },
    { id: "paper", label: "Paper" },
    { id: "corrections", label: "Corrections" },
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
  let libNotice = $state("");
  let libBusy = $state(false);
  let correctionLearningReset = $state(false);
  let correctionProviderStatus = $state("Checking…");
  let correctionModels = $state<string[]>([]);
  let correctionCloudKey = $state("");
  let correctionCloudConfigured = $state(false);
  let correctionCloudCost = $state(0);
  let correctionPersonalProfile: Record<string, unknown> = { words: [], aliases: [], guidance: "" };
  let correctionProjectProfile: Record<string, unknown> = { words: [], aliases: [], blockedPairs: [], guidance: "" };
  let correctionProjectGuidance = $state("");
  let correctionVetoes = $state<string[]>([]);
  type ManagedModelStatus = { available: boolean; installed: boolean; updateRequired?: boolean; running: boolean; ready?: boolean; downloading: boolean; model: { id: string; displayName: string; bytes: number; license: string }; runtime?: string | null; acceleration?: "metal" | "vulkan" | "cpu"; contextPerSlot?: number; parallelSlots?: number; error?: string };
  type ManagedModelProgress = { received: number; total: number; verifying?: boolean; complete?: boolean };
  let correctionModelStatus = $state<ManagedModelStatus | null>(null);
  let correctionModelProgress = $state<ManagedModelProgress | null>(null);
  let correctionModelBusy = $state(false);
  let stopCorrectionProgress: (() => void) | null = null;
  let modalEl = $state<HTMLDivElement | null>(null);
  let prevFocus: HTMLElement | null = null;

  async function loadLib() {
    try {
      const p = await fileBridge()?.prefsGet?.();
      cfgPath = (p?.fluxConfigResolved as string) ?? "";
      libPath = (p?.fluxLibResolved as string) ?? "";
    } catch {
      cfgPath = "";
      libPath = "";
    }
    await loadCorrectionProvider();
  }

  async function loadCorrectionProvider() {
    const fb = fileBridge();
    if (!fb?.correctionStatus) {
      correctionProviderStatus = "Smart sentence corrections require the desktop app";
      return;
    }
    try {
      const provider = $settings.paperCorrectionProvider;
      if (!stopCorrectionProgress && fb.onCorrectionModelProgress) {
        stopCorrectionProgress = fb.onCorrectionModelProgress((progress) => {
          correctionModelProgress = progress;
        });
      }
      const selectedModel = $settings.paperCorrectionModel;
      const [status, key, managed] = await Promise.all([
        fb.correctionStatus(provider, selectedModel),
        fb.correctionCloudKeyStatus?.(),
        fb.correctionModelStatus?.(),
      ]);
      correctionModelStatus = managed ?? null;
      correctionModels = status.models ?? [];
      if (provider === "ollama" && correctionModels.length && !correctionModels.includes($settings.paperCorrectionModel)) {
        // Switching from the managed provider should work immediately when an
        // existing Ollama model is present, rather than leaving the managed
        // model ID in a field Ollama cannot resolve.
        settings.update((value) => ({ ...value, paperCorrectionModel: correctionModels[0] }));
      }
      correctionCloudConfigured = key?.configured ?? false;
      correctionCloudCost = provider === "openai"
        ? ((status.stats?.inputTokens ?? 0) / 1_000_000) + ((status.stats?.outputTokens ?? 0) / 1_000_000 * 6)
        : 0;
      correctionProviderStatus = status.available
        ? provider === "flux"
          ? managed?.ready
            ? `Flux local model ready · ${accelerationLabel(managed.acceleration)}`
            : managed?.running ? "Flux local model is loading and priming…" : "Flux local model installed · idle"
          : provider === "ollama"
            ? status.ready ? `Ollama model ready${correctionModels.length ? ` · ${correctionModels.length} installed` : ""}` : `Ollama available${correctionModels.length ? ` · ${correctionModels.length} model${correctionModels.length === 1 ? "" : "s"}` : ""}`
            : "Cloud key ready"
        : status.error || (provider === "openai"
          ? "Add an API key to enable cloud judgment"
          : provider === "flux"
            // `runtime` is the staged llama-server's release stamp. Null means the
            // helper itself is absent — a state only source checkouts can reach
            // (packaged builds ship it), and one more model installs cannot fix.
            ? managed && managed.runtime == null
              ? "Correction runtime missing from this build — run npm run fetch:correction-runtime in the Flux checkout"
              : managed?.updateRequired ? "Flux local model update required" : "Install the Flux local model to enable sentence judgment"
            : "Ollama is not available");
      const profile = await fb.correctionProfileGet?.("") as { personal?: Record<string, unknown>; project?: Record<string, unknown> } | undefined;
      if (profile?.personal) {
        correctionPersonalProfile = profile.personal;
        const guidance = typeof profile.personal.guidance === "string" ? profile.personal.guidance : "";
        if (guidance && guidance !== $settings.paperCorrectionGuidance) {
          settings.update((value) => ({ ...value, paperCorrectionGuidance: guidance.slice(0, 500) }));
        }
      }
      if (profile?.project) {
        correctionProjectProfile = profile.project;
        correctionProjectGuidance = typeof profile.project.guidance === "string" ? profile.project.guidance.slice(0, 500) : "";
        correctionVetoes = Array.isArray(profile.project.blockedPairs)
          ? profile.project.blockedPairs.filter((value): value is string => typeof value === "string")
          : [];
      }
    } catch (error) {
      correctionProviderStatus = (error as Error).message;
    }
  }

  async function installCorrectionModel() {
    const fb = fileBridge();
    if (!fb?.correctionModelInstall) return;
    correctionModelBusy = true;
    correctionModelProgress = { received: 0, total: correctionModelStatus?.model.bytes ?? 0 };
    try {
      await fb.correctionModelInstall();
      if ($settings.paperContextualCorrections && $settings.paperCorrectionProvider === "flux") {
        correctionProviderStatus = "Loading and priming the Flux local model…";
        await fb.correctionWarm?.({ provider: "flux", model: $settings.paperCorrectionModel });
      }
    }
    catch (error) { correctionProviderStatus = (error as Error).message; }
    finally { correctionModelBusy = false; await loadCorrectionProvider(); }
  }

  async function cancelCorrectionModel() {
    await fileBridge()?.correctionModelCancel?.();
    correctionModelBusy = false;
  }

  async function removeCorrectionModel() {
    await fileBridge()?.correctionModelRemove?.();
    correctionModelProgress = null;
    await loadCorrectionProvider();
  }

  function sizeLabel(bytes: number) {
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }

  function accelerationLabel(value?: "metal" | "vulkan" | "cpu") {
    return value === "metal" ? "Metal GPU" : value === "vulkan" ? "Vulkan GPU when available" : "CPU";
  }

  async function activateCorrectionProvider(provider: Settings["paperCorrectionProvider"]) {
    settings.update((value) => ({ ...value, paperCorrectionProvider: provider }));
    await loadCorrectionProvider();
    if (provider !== "openai" && $settings.paperContextualCorrections) {
      correctionProviderStatus = "Loading and priming the local model…";
      await fileBridge()?.correctionWarm?.({ provider, model: $settings.paperCorrectionModel }).catch(() => false);
      await loadCorrectionProvider();
    }
  }

  async function activateCorrectionModel(model: string) {
    settings.update((value) => ({ ...value, paperCorrectionModel: model.trim() }));
    if ($settings.paperCorrectionProvider === "ollama" && model.trim() && $settings.paperContextualCorrections) {
      correctionProviderStatus = "Loading and priming the Ollama model…";
      await fileBridge()?.correctionWarm?.({ provider: "ollama", model: model.trim() }).catch(() => false);
      await loadCorrectionProvider();
    }
  }

  onDestroy(() => stopCorrectionProgress?.());

  async function saveCorrectionCloudKey() {
    const result = await fileBridge()?.correctionCloudKeySet?.(correctionCloudKey.trim());
    correctionCloudKey = "";
    correctionCloudConfigured = result?.configured ?? false;
    await loadCorrectionProvider();
  }

  async function saveCorrectionGuidance(scope: "personal" | "project") {
    const fb = fileBridge();
    if (!fb?.correctionProfileSet) return;
    if (scope === "personal") {
      correctionPersonalProfile = { ...correctionPersonalProfile, guidance: $settings.paperCorrectionGuidance.slice(0, 500) };
      await fb.correctionProfileSet({ projectRoot: "", scope, data: correctionPersonalProfile });
    } else {
      correctionProjectProfile = { ...correctionProjectProfile, guidance: correctionProjectGuidance.slice(0, 500) };
      await fb.correctionProfileSet({ projectRoot: "", scope, data: correctionProjectProfile });
    }
    window.dispatchEvent(new CustomEvent("flux:local-language-changed", { detail: { scope } }));
  }

  async function removeCorrectionVeto(pair: string) {
    correctionVetoes = correctionVetoes.filter((value) => value !== pair);
    correctionProjectProfile = { ...correctionProjectProfile, blockedPairs: [...correctionVetoes] };
    await fileBridge()?.correctionProfileSet?.({ projectRoot: "", scope: "project", data: correctionProjectProfile });
    window.dispatchEvent(new CustomEvent("flux:local-language-changed", { detail: { scope: "project" } }));
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

  // Open: refresh the displayed path / provider state and move focus into the
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

  // Paper caret motion — see editing/caretFeel.ts.
  const caretFeels: { v: Settings["paperCaretFeel"]; l: string }[] = [
    { v: "chase", l: "Chase" },
    { v: "smooth", l: "Smooth" },
  ];
  const marginScenes: { v: Settings["paperMarginScene"]; l: string }[] = [
    { v: "harmonograph", l: "Harmonograph" },
    { v: "neurons", l: "Neurons" },
    { v: "inkwind", l: "Ink wind" },
    { v: "loom", l: "Loom" },
    { v: "vines", l: "Vines" },
  ];
</script>

<svelte:window onkeydown={onKey} />

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
      onclick={(e) => e.stopPropagation()}>
      <div class="head">
        <span class="title">Settings</span>
        <button class="x" aria-label="Close" title="Close (Esc)" onclick={() => settingsOpen.set(false)}>×</button>
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
              onkeydown={onTabKey}>{t.label}</button>
          {/each}
        </div>

        <div class="content">
          <!-- ---------------------------------------------------------- General -->
          <div class="pane" role="tabpanel" id="settings-pane-general" aria-labelledby="settings-tab-general" hidden={tab !== "general"}>
            <h3>FluxConfig folder</h3>
            <div class="libpath" title={cfgPath}>{cfgPath || "—"}</div>
            <p class="hint">Everything user-level lives here — the reference library ({libPath || "FluxLib"}), the agent Context folders, and agents.json.</p>
            <div class="libbtns">
              <button class="ghost" onclick={revealCfg} disabled={!cfgPath}>Reveal</button>
              <button class="ghost" onclick={moveCfg} disabled={libBusy}>{libBusy ? "Moving…" : "Move…"}</button>
            </div>
            {#if libNotice}<p class="hint">{libNotice}</p>{/if}

            <h3>Updates</h3>
            <label class="chk">
              <input
                type="checkbox"
                checked={$settings.updateCheck}
                onchange={(e) => settings.update((v) => ({ ...v, updateCheck: e.currentTarget.checked }))}
              />
              Check for a newer version on launch (desktop app)
            </label>

            <h3>Palette</h3>
            <label class="chk">
              <input
                type="checkbox"
                checked={$settings.flexokiDefault}
                onchange={(e) => settings.update((v) => ({ ...v, flexokiDefault: e.currentTarget.checked }))}
              />
              Include the Flexoki palette in new projects
            </label>
          </div>

          <!-- ----------------------------------------------------------- Figure -->
          <div class="pane" role="tabpanel" id="settings-pane-figure" aria-labelledby="settings-tab-figure" hidden={tab !== "figure"}>
            <h3>Rulers &amp; grid</h3>
            <label class="chk">
              <input type="checkbox" checked={$settings.showRulers} onchange={(e) => settings.update((v) => ({ ...v, showRulers: e.currentTarget.checked }))} />
              Show rulers (<b>Shift+R</b>) — drag from a ruler to place a guide
            </label>
            <label class="chk">
              <input type="checkbox" checked={$settings.showGrid} onchange={(e) => settings.update((v) => ({ ...v, showGrid: e.currentTarget.checked }))} />
              Show background grid (<b>Shift+G</b>) — while visible, the pen places nodes on its vertices
            </label>
            <label class="chk">
              <input type="checkbox" checked={$settings.snapGrid} onchange={(e) => settings.update((v) => ({ ...v, snapGrid: e.currentTarget.checked }))} />
              Snap to grid
            </label>
            <label class="chk num">
              Grid size
              <input type="number" min="1" step="1" value={$settings.gridSize} onchange={(e) => settings.update((v) => ({ ...v, gridSize: Math.max(1, parseFloat(e.currentTarget.value) || 1) }))} />
              px
            </label>
            <label class="chk">
              <input type="checkbox" checked={$settings.snapPixel} onchange={(e) => settings.update((v) => ({ ...v, snapPixel: e.currentTarget.checked }))} />
              Snap to pixel (round coords on commit — crisp export)
            </label>

            <h3>Caption editor</h3>
            <label class="chk num">
              Font size
              <input
                type="number"
                min="9"
                max="28"
                step="1"
                value={$settings.captionFontSize}
                onchange={(e) => settings.update((v) => ({ ...v, captionFontSize: Math.min(28, Math.max(9, Math.round(parseFloat(e.currentTarget.value) || 13))) }))}
              />
              px
            </label>
            <p class="hint">The size captions are typed at in the caption page (<b>Alt+C</b>). World px, so it scales with the canvas zoom just like the figure. Every caption grows to fit its text — the page scrolls between them, the boxes never do.</p>

            <h3>Colour pickers</h3>
            <label class="row">
              <span>Palette collection</span>
              <select bind:value={$settings.paletteCollection} aria-label="Default palette collection">
                {#each PALETTE_COLLECTIONS as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
                <option value="project">Project palette</option>
              </select>
            </label>
            <label class="row">
              <span>Colormap collection</span>
              <select bind:value={$settings.colormapCollection} aria-label="Default colormap collection">
                {#each COLORMAP_COLLECTIONS as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
              </select>
            </label>
            <p class="hint">The collection a picker opens on. Every collection stays a <b>Shift+Tab</b> away inside the picker; <b>Tab</b> switches between palettes and colormaps.</p>

            <h3>Property menu</h3>
            <p class="hint">Press F with objects selected. The menu opens beside the selection; every property has a left-hand key, and the mouse wheel adjusts the armed value.</p>
          </div>

          <!-- ------------------------------------------------------------ Paper -->
          <div class="pane" role="tabpanel" id="settings-pane-paper" aria-labelledby="settings-tab-paper" hidden={tab !== "paper"}>
            <h3>Dynamic margin background</h3>
            <div class="seg scenes">
              {#each marginScenes as m}
                <button class:on={$settings.paperMarginScene === m.v} onclick={() => settings.update((v) => ({ ...v, paperMarginScene: m.v }))}>{m.l}</button>
              {/each}
            </div>

            <h3>Dynamic panes</h3>
            <label class="chk num">
              Max panes open at once
              <input
                type="number"
                min="1"
                max="6"
                step="1"
                value={$settings.paperMaxMarginPanes}
                onchange={(e) => settings.update((v) => ({ ...v, paperMaxMarginPanes: Math.min(6, Math.max(1, Math.round(parseFloat(e.currentTarget.value) || 4))) }))}
              />
            </label>
            <label class="chk">
              <input
                type="checkbox"
                checked={$settings.paperCleanMargin}
                onchange={(e) => settings.update((v) => ({ ...v, paperCleanMargin: e.currentTarget.checked }))}
              />
              Clean dynamic margin — close all panes when focus returns to the editor
            </label>

            <h3>Caret motion</h3>
            <div class="seg">
              {#each caretFeels as f}
                <button class:on={$settings.paperCaretFeel === f.v} onclick={() => settings.update((v) => ({ ...v, paperCaretFeel: f.v }))}>{f.l}</button>
              {/each}
            </div>
            <p class="hint">Chase — the caret pursues its target, arriving fast and settling softly. Smooth — a constant-pace 90&nbsp;ms glide.</p>
          </div>

          <!-- ------------------------------------------------------ Corrections -->
          <div class="pane" role="tabpanel" id="settings-pane-corrections" aria-labelledby="settings-tab-corrections" hidden={tab !== "corrections"}>
            <h3>Local corrections</h3>
            <label class="chk">
              <input
                type="checkbox"
                checked={$settings.paperLocalCorrections}
                onchange={(e) => settings.update((v) => ({ ...v, paperLocalCorrections: e.currentTarget.checked }))}
              />
              Correct clear typing and spacing errors as I write
            </label>
            <p class="hint">Runs entirely on this device. A blue pulse marks each correction; click it for details or press Undo to restore the original. Reverting teaches this project what to leave alone. Resetting these lessons keeps explicit dictionaries and aliases.</p>
            <button class="ghost learning-reset" onclick={resetCorrectionLearning}>
              {correctionLearningReset ? "Learning reset" : "Reset correction learning"}
            </button>

            <h3>Sentence judgment</h3>
            <label class="chk">
              <input
                type="checkbox"
                checked={$settings.paperContextualCorrections}
                onchange={(e) => {
                  const checked = e.currentTarget.checked;
                  settings.update((v) => ({ ...v, paperContextualCorrections: checked }));
                  if (checked) void activateCorrectionProvider($settings.paperCorrectionProvider);
                }}
              />
              Judge unresolved corrections with sentence context
            </label>
            <p class="hint">The model judges exact Harper-flagged spans. It may keep the text, choose a nearby candidate, or propose one bounded spelling repair; it cannot rewrite the sentence. Local inference is the default, and cloud is never used as a fallback.</p>

            <div class="correction-grid">
              <label>
                Provider
                <select value={$settings.paperCorrectionProvider} onchange={(e) => void activateCorrectionProvider(e.currentTarget.value as Settings["paperCorrectionProvider"])}>
                  <option value="flux">Local · Flux managed</option>
                  <option value="ollama">Local · Ollama</option>
                  <option value="openai">Cloud · GPT-5.6 Luna</option>
                </select>
              </label>
              <label>
                Dialect
                <select value={$settings.paperCorrectionDialect} onchange={(e) => settings.update((v) => ({ ...v, paperCorrectionDialect: e.currentTarget.value as Settings["paperCorrectionDialect"] }))}>
                  <option value="american">US English</option>
                  <option value="british">British English</option>
                  <option value="canadian">Canadian English</option>
                  <option value="australian">Australian English</option>
                </select>
              </label>
              <label>
                Judgment
                <select
                  value={$settings.paperCorrectionAggressiveness}
                  onchange={(e) => settings.update((v) => ({
                    ...v,
                    paperCorrectionAggressiveness: e.currentTarget.value as Settings["paperCorrectionAggressiveness"],
                  }))}
                >
                  <option value="standard">Standard</option>
                  <option value="aggressive">Aggressive</option>
                  <option value="really-aggressive">Really aggressive</option>
                </select>
              </label>
            </div>
            <p class="hint">Aggressive tries harder on genuine spelling flags and permits three edits from nine letters. Really aggressive examines every bounded flag, permits three edits from seven letters and four from ten. Both retain the same no-rewrite, scientific-term, syntax, dictionary, and final lexical safety checks.</p>

            {#if $settings.paperCorrectionProvider === "flux"}
              <div class="managed-model">
                <strong>{correctionModelStatus?.model.displayName ?? "Qwen3 4B Instruct 2507 · Q4_K_M"}</strong>
                <span>{correctionModelStatus?.model.bytes ? sizeLabel(correctionModelStatus.model.bytes) : "2.33 GB"} · {correctionModelStatus?.model.license ?? "Apache-2.0"} · {accelerationLabel(correctionModelStatus?.acceleration)}</span>
                {#if correctionModelProgress && correctionModelBusy}
                  <progress max={correctionModelProgress.total || 1} value={correctionModelProgress.received}></progress>
                  <small>{correctionModelProgress.verifying ? "Verifying SHA-256…" : `${Math.round(correctionModelProgress.received / Math.max(1, correctionModelProgress.total) * 100)}% downloaded`}</small>
                {/if}
                <div class="key-row">
                  {#if correctionModelStatus?.installed}
                    <button class="ghost" onclick={() => void fileBridge()?.correctionModelUnload?.()}>Unload</button>
                    <button class="ghost danger" onclick={() => void removeCorrectionModel()}>Remove model</button>
                  {:else if correctionModelBusy}
                    <button class="ghost" disabled={correctionModelProgress?.complete} onclick={() => void cancelCorrectionModel()}>{correctionModelProgress?.complete ? "Loading model…" : "Cancel download"}</button>
                  {:else}
                    <button class="ghost" onclick={() => void installCorrectionModel()}>{correctionModelStatus?.updateRequired ? "Update local model" : "Install local model"}</button>
                  {/if}
                </div>
                <p class="hint">{correctionModelStatus?.updateRequired ? "This replaces the older Qwen3 hybrid artifact with the held-out-selected Instruct 2507 model. " : ""}Downloaded only when you ask, resumable and SHA-256 verified under FluxConfig. It stays local and can be removed here.</p>
              </div>
            {:else if $settings.paperCorrectionProvider === "ollama"}
              <label class="field-label">
                Local model
                <input
                  list="flux-correction-models"
                  value={$settings.paperCorrectionModel}
                  maxlength="120"
                  onchange={(e) => void activateCorrectionModel(e.currentTarget.value)}
                />
              </label>
              <datalist id="flux-correction-models">
                {#each correctionModels as model}<option value={model}></option>{/each}
              </datalist>
            {:else}
              <label class="field-label">
                OpenAI API key {correctionCloudConfigured ? "· configured" : ""}
                <div class="key-row">
                  <input type="password" bind:value={correctionCloudKey} autocomplete="off" placeholder={correctionCloudConfigured ? "Replace encrypted key" : "sk-…"} />
                  <button class="ghost" disabled={!correctionCloudKey.trim()} onclick={saveCorrectionCloudKey}>Save</button>
                  {#if correctionCloudConfigured}<button class="ghost" onclick={() => { correctionCloudKey = ""; void saveCorrectionCloudKey(); }}>Clear</button>{/if}
                </div>
              </label>
              <p class="hint cloud-disclosure">Cloud mode sends the completed sentence, bounded nearby context, candidates, and configured project guidance to OpenAI with <code>store: false</code>. It is opt-in and never activated by a local failure.</p>
              <p class="hint">This-session API estimate: ${correctionCloudCost.toFixed(4)} at GPT-5.6 Luna’s current $1/M input and $6/M output rates.</p>
            {/if}
            <p class="provider-status">{correctionProviderStatus}</p>

            <h3>Guidance</h3>
            <label class="field-label">
              Personal correction guidance
              <textarea
                rows="2"
                maxlength="500"
                value={$settings.paperCorrectionGuidance}
                oninput={(e) => settings.update((v) => ({ ...v, paperCorrectionGuidance: e.currentTarget.value.slice(0, 500) }))}
                onchange={() => void saveCorrectionGuidance("personal")}
              ></textarea>
            </label>
            <label class="field-label">
              Project correction guidance
              <textarea rows="2" maxlength="500" bind:value={correctionProjectGuidance} onchange={() => void saveCorrectionGuidance("project")}></textarea>
            </label>
            {#if correctionVetoes.length}
              <details class="veto-list">
                <summary>Learned “leave alone” corrections ({correctionVetoes.length})</summary>
                {#each correctionVetoes as pair}
                  <div class="veto-row">
                    <code>{pair.replace("\u0000", " → ")}</code>
                    <button class="ghost" onclick={() => void removeCorrectionVeto(pair)}>Remove</button>
                  </div>
                {/each}
              </details>
            {/if}
          </div>
        </div>
      </div>

      <div class="foot">
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
    display: flex;
    flex-direction: column;
    width: min(780px, calc(100vw - 40px));
    height: min(600px, calc(100vh - 40px));
    overflow: hidden;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel);
    box-shadow: var(--elev-2);
    color: var(--c-tx);
    font: 12px/1.35 var(--font-ui);
    -webkit-font-smoothing: antialiased;
  }
  .modal:focus {
    outline: none;
  }

  /* ---- header · body · footer, hairline-separated -------------------------- */
  .head {
    flex: 0 0 36px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 6px 0 12px;
    border-bottom: 1px solid var(--c-line);
  }
  .title {
    font: 600 13px var(--font-ui);
    color: var(--c-tx-hi);
  }
  .x {
    width: 24px;
    height: 24px;
    padding: 0;
    display: grid;
    place-items: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--r-ui);
    color: var(--c-tx-muted);
    font: 16px/1 var(--font-ui);
    cursor: var(--cursor-cross-hover);
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
    flex: 0 0 auto;
    display: flex;
    justify-content: flex-end;
    padding: 8px 12px;
    border-top: 1px solid var(--c-line);
  }

  /* ---- tab column ---------------------------------------------------------- */
  .tabs {
    flex: 0 0 170px;
    display: flex;
    flex-direction: column;
    padding: 6px 0;
    background: var(--c-bg-raised);
    border-right: 1px solid var(--c-line);
  }
  .tab {
    height: 26px;
    padding: 0 12px;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: var(--r-0);
    color: var(--c-tx-2);
    font: 12px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .tab:hover {
    background: var(--c-surface-2);
    color: var(--c-tx);
  }
  .tab.on {
    background: var(--c-accent-tint);
    box-shadow: inset 2px 0 0 var(--c-accent);
    color: var(--c-tx-hi);
  }

  /* ---- content pane -------------------------------------------------------- */
  .content {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    padding: 0 18px 18px;
  }
  .pane[hidden] {
    display: none;
  }
  h3 {
    display: flex;
    align-items: flex-end;
    height: 28px;
    margin: 14px 0 8px;
    padding-bottom: 5px;
    border-bottom: 1px solid var(--c-line);
    font: 600 10.5px var(--font-mono);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--c-tx-muted);
  }
  .pane > h3:first-child {
    margin-top: 8px;
  }
  .hint {
    margin: 6px 0 0;
    font: 11px/1.4 var(--font-ui);
    color: var(--c-tx-muted);
  }
  /* hotkey glyphs inside labels/hints */
  b {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    vertical-align: -3px;
    background: var(--c-accent-tint);
    border-radius: var(--r-ui);
    color: var(--c-accent);
    font: 600 11px var(--font-mono);
  }

  /* ---- controls ------------------------------------------------------------ */
  .ghost {
    height: 24px;
    padding: 3px 8px;
    background: transparent;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx);
    font: 12px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .ghost:hover:not(:disabled) {
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .ghost:disabled {
    opacity: 0.4;
    cursor: var(--cursor-cross);
  }
  .danger {
    color: var(--c-danger);
  }
  .close {
    height: 24px;
    padding: 3px 14px;
    background: var(--c-accent);
    border: 1px solid var(--c-accent);
    border-radius: var(--r-ui);
    color: var(--c-on-accent);
    font: 600 12px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .close:hover {
    background: var(--c-accent-bright);
    border-color: var(--c-accent-bright);
  }

  /* segmented group: joined buttons, shared 1px borders, outer radius only */
  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    max-width: 100%;
  }
  .seg button {
    position: relative;
    height: 24px;
    margin-left: -1px;
    padding: 3px 10px;
    background: transparent;
    border: 1px solid var(--c-line-strong);
    border-radius: 0;
    color: var(--c-tx);
    font: 12px var(--font-ui);
    cursor: var(--cursor-cross-hover);
  }
  .seg button:first-child {
    margin-left: 0;
    border-radius: var(--r-ui) 0 0 var(--r-ui);
  }
  .seg button:last-child {
    border-radius: 0 var(--r-ui) var(--r-ui) 0;
  }
  .seg button:hover {
    z-index: 1;
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .seg button.on {
    z-index: 2;
    background: var(--c-accent-tint);
    border-color: var(--c-accent);
    color: var(--c-tx-hi);
  }

  .chk {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    margin: 2px 0;
    font: 12px/1.35 var(--font-ui);
    color: var(--c-tx);
    cursor: var(--cursor-cross-hover);
  }
  .chk input[type="checkbox"] {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    margin: 0;
    accent-color: var(--c-accent);
  }
  .chk.num input[type="number"] {
    width: 64px;
  }
  input[type="number"],
  .field-label input,
  .correction-grid select,
  .field-label textarea {
    min-width: 0;
    height: 24px;
    padding: 2px 6px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx);
    font: 12px var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .correction-grid select {
    width: 100%;
    font-family: var(--font-ui);
  }
  .field-label input,
  .field-label textarea {
    width: 100%;
  }
  .field-label textarea {
    height: auto;
    min-height: 48px;
    resize: vertical;
    font-family: var(--font-ui);
    line-height: 1.35;
  }
  input:not([type="checkbox"]):focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: var(--c-accent);
  }
  button:focus-visible,
  summary:focus-visible,
  input[type="checkbox"]:focus-visible {
    outline: 1px solid var(--c-accent);
    outline-offset: 1px;
    border-radius: var(--r-ui);
  }

  /* ---- General ------------------------------------------------------------- */
  .libpath {
    overflow: hidden;
    padding: 4px 8px;
    background: var(--c-bg);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    color: var(--c-tx-2);
    font: 11px/1.4 var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
  }
  .libbtns {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }

  /* ---- Corrections --------------------------------------------------------- */
  .learning-reset {
    margin-top: 8px;
  }
  .correction-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
  }
  .correction-grid label,
  .field-label {
    display: grid;
    gap: 4px;
    margin-top: 8px;
    color: var(--c-tx-muted);
    font: 11px var(--font-ui);
  }
  .correction-grid label {
    margin-top: 0;
  }
  .managed-model {
    display: grid;
    gap: 6px;
    margin-top: 10px;
    padding: 8px 10px;
    background: var(--c-bg-raised);
    border-radius: var(--r-ui);
  }
  .managed-model strong {
    color: var(--c-tx-hi);
    font-weight: 600;
  }
  .managed-model > span,
  .managed-model small {
    color: var(--c-tx-muted);
    font-size: 11px;
  }
  .managed-model progress {
    width: 100%;
    height: 4px;
    accent-color: var(--c-accent);
  }
  .key-row {
    display: flex;
    gap: 6px;
  }
  .key-row input {
    flex: 1;
  }
  .key-row .ghost {
    flex: 0 0 auto;
  }
  .provider-status {
    margin: 8px 0 0;
    color: var(--c-tx-muted);
    font: 11px var(--font-mono);
  }
  .veto-list {
    margin-top: 10px;
    color: var(--c-tx-muted);
    font-size: 11px;
  }
  .veto-list summary {
    cursor: var(--cursor-cross-hover);
  }
  .veto-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 5px;
  }
  .veto-row code {
    overflow: hidden;
    color: var(--c-tx);
    font: 11px var(--font-mono);
    text-overflow: ellipsis;
  }
  .cloud-disclosure code {
    font-family: var(--font-mono);
  }
</style>
