<script lang="ts">
  import { fade, scale } from "svelte/transition";
  import { onDestroy } from "svelte";
  import { settings, settingsOpen, type Settings, type FluxFigMenuSize, type FluxFigMenuPos, type FluxFigMenuAnim, type XrayPos } from "./settings";
  import { fileBridge } from "./project/types";
  import {
    clearLocalCorrectionLearning,
    LOCAL_CORRECTION_RESET_EVENT,
  } from "../shell/modes/paper/editing/localCorrectionProfile";

  // --- FluxConfig location (desktop app only) --------------------------------
  // ONE user-facing folder for all user-level Flux state (FluxLib, Guidelines).
  // Moving it moves everything; the folder is always named exactly "FluxConfig"
  // (the user picks its PARENT). FluxLib is derived: <FluxConfig>/FluxLib.
  let cfgPath = "";
  let libPath = "";
  let libNotice = "";
  let libBusy = false;
  let correctionLearningReset = false;
  let correctionProviderStatus = "Checking…";
  let correctionModels: string[] = [];
  let correctionCloudKey = "";
  let correctionCloudConfigured = false;
  let correctionCloudCost = 0;
  let correctionPersonalProfile: Record<string, unknown> = { words: [], aliases: [], guidance: "" };
  let correctionProjectProfile: Record<string, unknown> = { words: [], aliases: [], blockedPairs: [], guidance: "" };
  let correctionProjectGuidance = "";
  let correctionVetoes: string[] = [];
  let correctionModelStatus: { available: boolean; installed: boolean; updateRequired?: boolean; running: boolean; ready?: boolean; downloading: boolean; model: { id: string; displayName: string; bytes: number; license: string }; runtime?: string | null; acceleration?: "metal" | "vulkan" | "cpu"; contextPerSlot?: number; parallelSlots?: number; error?: string } | null = null;
  let correctionModelProgress: { received: number; total: number; verifying?: boolean; complete?: boolean } | null = null;
  let correctionModelBusy = false;
  let stopCorrectionProgress: (() => void) | null = null;
  let modalEl: HTMLDivElement | null = null;

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
    correctionProjectProfile = { ...correctionProjectProfile, blockedPairs: correctionVetoes };
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

  // Refresh the displayed path and move focus in whenever the panel opens; clear
  // the transient notice on close.
  $: if ($settingsOpen) {
    void loadLib();
    queueMicrotask(() => modalEl?.focus());
  } else {
    libNotice = "";
  }

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

  const sizes: { v: FluxFigMenuSize; l: string }[] = [
    { v: "sm", l: "Small" },
    { v: "md", l: "Medium" },
    { v: "lg", l: "Large" },
  ];
  const positions: { v: FluxFigMenuPos; l: string }[] = [
    { v: "center", l: "Center" },
    { v: "left", l: "Left" },
    { v: "right", l: "Right" },
  ];
  const xrayPositions: { v: XrayPos; l: string }[] = [
    { v: "above", l: "Above the menu" },
    { v: "below", l: "Below the menu" },
  ];
  const anims: { v: FluxFigMenuAnim; l: string }[] = [
    { v: "draw", l: "Draw-in" },
    { v: "fade", l: "Quick fade" },
  ];

  function setNum(key: "fluxFigMenuDx" | "fluxFigMenuDy", raw: string) {
    const n = parseFloat(raw);
    settings.update((v) => ({ ...v, [key]: Number.isFinite(n) ? Math.round(n) : 0 }));
  }
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

<svelte:window on:keydown={onKey} />

{#if $settingsOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="bk" transition:fade={{ duration: 120 }} on:click={() => settingsOpen.set(false)}>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      tabindex="-1"
      bind:this={modalEl}
      transition:scale={{ duration: 150, start: 0.96 }}
      on:click|stopPropagation>
      <h2>Settings</h2>

      <h3>FluxConfig folder</h3>
      <div class="libpath" title={cfgPath}>{cfgPath || "—"}</div>
      <p class="hint">Everything user-level lives here — the reference library ({libPath || "FluxLib"}), the agent Context folders, and agents.json.</p>
      <div class="libbtns">
        <button class="ghost" on:click={revealCfg} disabled={!cfgPath}>Reveal</button>
        <button class="ghost" on:click={moveCfg} disabled={libBusy}>{libBusy ? "Moving…" : "Move…"}</button>
      </div>
      {#if libNotice}<p class="hint">{libNotice}</p>{/if}

      <h3>Updates</h3>
      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.updateCheck}
          on:change={(e) => settings.update((v) => ({ ...v, updateCheck: e.currentTarget.checked }))}
        />
        Check for a newer version on launch (desktop app)
      </label>

      <h3>FluxFig Menu — size</h3>
      <div class="seg">
        {#each sizes as s}
          <button class:on={$settings.fluxFigMenuSize === s.v} on:click={() => settings.update((v) => ({ ...v, fluxFigMenuSize: s.v }))}>{s.l}</button>
        {/each}
      </div>

      <h3>FluxFig Menu — position</h3>
      <div class="seg">
        {#each positions as p}
          <button class:on={$settings.fluxFigMenuPos === p.v} on:click={() => settings.update((v) => ({ ...v, fluxFigMenuPos: p.v }))}>{p.l}</button>
        {/each}
      </div>
      <div class="nudge">
        <label class="chk num">
          Nudge X
          <input type="number" step="5" value={$settings.fluxFigMenuDx} on:input={(e) => setNum("fluxFigMenuDx", e.currentTarget.value)} />
          px
        </label>
        <label class="chk num">
          Nudge Y
          <input type="number" step="5" value={$settings.fluxFigMenuDy} on:input={(e) => setNum("fluxFigMenuDy", e.currentTarget.value)} />
          px
        </label>
        {#if $settings.fluxFigMenuDx || $settings.fluxFigMenuDy}
          <button class="ghost" on:click={() => settings.update((v) => ({ ...v, fluxFigMenuDx: 0, fluxFigMenuDy: 0 }))}>Reset</button>
        {/if}
      </div>
      <p class="hint">Fine-tune the spot: +X moves right, +Y moves down. Type an exact value or use the arrows (steps of 5).</p>

      <h3>X-Ray — position</h3>
      <div class="seg">
        {#each xrayPositions as p}
          <button class:on={$settings.xrayPos === p.v} on:click={() => settings.update((v) => ({ ...v, xrayPos: p.v }))}>{p.l}</button>
        {/each}
      </div>
      <p class="hint">The X-ray docks to the FluxFig menu's spot at the same width. Above: the X-ray grows upward and the menu downward from that spot (and vice&nbsp;versa).</p>

      <h3>FluxFig Menu — appearance</h3>
      <div class="seg">
        {#each anims as a}
          <button class:on={$settings.fluxFigMenuAnim === a.v} on:click={() => settings.update((v) => ({ ...v, fluxFigMenuAnim: a.v }))}>{a.l}</button>
        {/each}
      </div>
      <p class="hint">{$settings.fluxFigMenuAnim === "draw" ? "The accent frame draws itself, then the controls rise in." : "The whole menu fades in at once — fastest."}</p>

      <h3>FluxFig Menu — opacity ({Math.round($settings.fluxFigMenuOpacity * 100)}%)</h3>
      <input
        type="range"
        min="0.6"
        max="1"
        step="0.01"
        value={$settings.fluxFigMenuOpacity}
        on:input={(e) => settings.update((v) => ({ ...v, fluxFigMenuOpacity: parseFloat(e.currentTarget.value) }))}
      />

      <h3>Palette</h3>
      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.flexokiDefault}
          on:change={(e) => settings.update((v) => ({ ...v, flexokiDefault: e.currentTarget.checked }))}
        />
        Include the Flexoki palette in new projects
      </label>

      <h3>Rulers &amp; grid</h3>
      <label class="chk">
        <input type="checkbox" checked={$settings.showRulers} on:change={(e) => settings.update((v) => ({ ...v, showRulers: e.currentTarget.checked }))} />
        Show rulers (<b>Shift+R</b>) — drag from a ruler to place a guide
      </label>
      <label class="chk">
        <input type="checkbox" checked={$settings.showGrid} on:change={(e) => settings.update((v) => ({ ...v, showGrid: e.currentTarget.checked }))} />
        Show background grid (<b>Shift+G</b>) — while visible, the pen places nodes on its vertices
      </label>
      <label class="chk">
        <input type="checkbox" checked={$settings.snapGrid} on:change={(e) => settings.update((v) => ({ ...v, snapGrid: e.currentTarget.checked }))} />
        Snap to grid
      </label>
      <label class="chk num">
        Grid size
        <input type="number" min="1" step="1" value={$settings.gridSize} on:change={(e) => settings.update((v) => ({ ...v, gridSize: Math.max(1, parseFloat(e.currentTarget.value) || 1) }))} />
        px
      </label>
      <label class="chk">
        <input type="checkbox" checked={$settings.snapPixel} on:change={(e) => settings.update((v) => ({ ...v, snapPixel: e.currentTarget.checked }))} />
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
          on:change={(e) => settings.update((v) => ({ ...v, captionFontSize: Math.min(28, Math.max(9, Math.round(parseFloat(e.currentTarget.value) || 13))) }))}
        />
        px
      </label>
      <p class="hint">The size captions are typed at in the caption page (<b>Alt+C</b>). World px, so it scales with the canvas zoom just like the figure. Every caption grows to fit its text — the page scrolls between them, the boxes never do.</p>

      <h3>Paper — dynamic margin background</h3>
      <div class="seg scenes">
        {#each marginScenes as m}
          <button class:on={$settings.paperMarginScene === m.v} on:click={() => settings.update((v) => ({ ...v, paperMarginScene: m.v }))}>{m.l}</button>
        {/each}
      </div>

      <h3>Paper — dynamic panes</h3>
      <label class="chk num">
        Max panes open at once
        <input
          type="number"
          min="1"
          max="6"
          step="1"
          value={$settings.paperMaxMarginPanes}
          on:change={(e) => settings.update((v) => ({ ...v, paperMaxMarginPanes: Math.min(6, Math.max(1, Math.round(parseFloat(e.currentTarget.value) || 4))) }))}
        />
      </label>
      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.paperCleanMargin}
          on:change={(e) => settings.update((v) => ({ ...v, paperCleanMargin: e.currentTarget.checked }))}
        />
        Clean dynamic margin — close all panes when focus returns to the editor
      </label>

      <h3>Paper — caret motion</h3>
      <div class="seg">
        {#each caretFeels as f}
          <button class:on={$settings.paperCaretFeel === f.v} on:click={() => settings.update((v) => ({ ...v, paperCaretFeel: f.v }))}>{f.l}</button>
        {/each}
      </div>
      <p class="hint">Chase — the caret pursues its target, arriving fast and settling softly. Smooth — a constant-pace 90&nbsp;ms glide.</p>

      <h3>Paper — local corrections</h3>
      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.paperLocalCorrections}
          on:change={(e) => settings.update((v) => ({ ...v, paperLocalCorrections: e.currentTarget.checked }))}
        />
        Correct clear typing and spacing errors as I write
      </label>
      <p class="hint">Runs entirely on this device. A blue pulse marks each correction; click it for details or press Undo to restore the original. Reverting teaches this project what to leave alone. Resetting these lessons keeps explicit dictionaries and aliases.</p>
      <button class="ghost learning-reset" on:click={resetCorrectionLearning}>
        {correctionLearningReset ? "Learning reset" : "Reset correction learning"}
      </button>

      <label class="chk">
        <input
          type="checkbox"
          checked={$settings.paperContextualCorrections}
          on:change={(e) => {
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
          <select value={$settings.paperCorrectionProvider} on:change={(e) => void activateCorrectionProvider(e.currentTarget.value as Settings["paperCorrectionProvider"])}>
            <option value="flux">Local · Flux managed</option>
            <option value="ollama">Local · Ollama</option>
            <option value="openai">Cloud · GPT-5.6 Luna</option>
          </select>
        </label>
        <label>
          Dialect
          <select value={$settings.paperCorrectionDialect} on:change={(e) => settings.update((v) => ({ ...v, paperCorrectionDialect: e.currentTarget.value as Settings["paperCorrectionDialect"] }))}>
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
            on:change={(e) => settings.update((v) => ({
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
              <button class="ghost" on:click={() => void fileBridge()?.correctionModelUnload?.()}>Unload</button>
              <button class="ghost danger" on:click={() => void removeCorrectionModel()}>Remove model</button>
            {:else if correctionModelBusy}
              <button class="ghost" disabled={correctionModelProgress?.complete} on:click={() => void cancelCorrectionModel()}>{correctionModelProgress?.complete ? "Loading model…" : "Cancel download"}</button>
            {:else}
              <button class="ghost" on:click={() => void installCorrectionModel()}>{correctionModelStatus?.updateRequired ? "Update local model" : "Install local model"}</button>
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
            on:change={(e) => void activateCorrectionModel(e.currentTarget.value)}
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
            <button class="ghost" disabled={!correctionCloudKey.trim()} on:click={saveCorrectionCloudKey}>Save</button>
            {#if correctionCloudConfigured}<button class="ghost" on:click={() => { correctionCloudKey = ""; void saveCorrectionCloudKey(); }}>Clear</button>{/if}
          </div>
        </label>
        <p class="hint cloud-disclosure">Cloud mode sends the completed sentence, bounded nearby context, candidates, and configured project guidance to OpenAI with <code>store: false</code>. It is opt-in and never activated by a local failure.</p>
        <p class="hint">This-session API estimate: ${correctionCloudCost.toFixed(4)} at GPT-5.6 Luna’s current $1/M input and $6/M output rates.</p>
      {/if}

      <label class="field-label">
        Personal correction guidance
        <textarea
          rows="2"
          maxlength="500"
          value={$settings.paperCorrectionGuidance}
          on:input={(e) => settings.update((v) => ({ ...v, paperCorrectionGuidance: e.currentTarget.value.slice(0, 500) }))}
          on:change={() => void saveCorrectionGuidance("personal")}
        ></textarea>
      </label>
      <label class="field-label">
        Project correction guidance
        <textarea rows="2" maxlength="500" bind:value={correctionProjectGuidance} on:change={() => void saveCorrectionGuidance("project")}></textarea>
      </label>
      {#if correctionVetoes.length}
        <details class="veto-list">
          <summary>Learned “leave alone” corrections ({correctionVetoes.length})</summary>
          {#each correctionVetoes as pair}
            <div class="veto-row">
              <code>{pair.replace("\u0000", " → ")}</code>
              <button class="ghost" on:click={() => void removeCorrectionVeto(pair)}>Remove</button>
            </div>
          {/each}
        </details>
      {/if}
      <p class="provider-status">{correctionProviderStatus}</p>

      <p class="tip">Open the FluxFig Menu with <b>F</b> while objects are selected.</p>
      <button class="close" on:click={() => settingsOpen.set(false)}>Done</button>
    </div>
  </div>
{/if}

<style>
  .bk {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 400;
  }
  .modal {
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: 12px;
    padding: 22px 26px;
    width: 380px;
    color: var(--c-tx);
    box-shadow: var(--elev-3);
    font-family: var(--font-serif);
    max-height: min(820px, calc(100vh - 40px));
    overflow-y: auto;
  }
  h2 {
    margin: 0 0 16px;
    font-size: 17px;
  }
  h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    opacity: 0.55;
    margin: 16px 0 7px;
  }
  .seg {
    display: flex;
    gap: 6px;
  }
  .seg button {
    flex: 1;
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 6px;
    padding: 7px;
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
  }
  .seg button.on {
    background: var(--c-accent);
    border-color: var(--c-accent);
    color: var(--c-on-accent);
  }
  .seg.scenes {
    flex-wrap: wrap;
  }
  .seg.scenes button {
    flex: 1 1 30%;
    font-size: 12px;
    padding: 6px 4px;
  }
  input[type="range"] {
    width: 100%;
  }
  .chk {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }
  .chk input {
    width: auto;
  }
  .chk.num input {
    width: 64px;
  }
  .nudge {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 7px;
  }
  .libpath {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--c-tx-muted);
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line);
    border-radius: 6px;
    padding: 6px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .libbtns {
    display: flex;
    gap: 6px;
    margin-top: 7px;
  }
  .ghost {
    background: var(--c-ui);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }
  .ghost:hover:not(:disabled) {
    background: var(--c-ui-hover);
  }
  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .learning-reset {
    margin-top: 8px;
    margin-bottom: 12px;
  }
  .correction-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 10px;
  }
  .correction-grid label,
  .field-label {
    display: grid;
    gap: 4px;
    margin-top: 9px;
    color: var(--c-tx-muted);
    font-size: 11px;
  }
  .correction-grid label:last-child {
    grid-column: 1 / -1;
  }
  .correction-grid select,
  .field-label input,
  .field-label textarea {
    min-width: 0;
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--c-line-strong);
    border-radius: 6px;
    background: var(--c-bg-raised);
    color: var(--c-tx);
    padding: 7px 8px;
    font: 12px var(--font-serif);
  }
  .managed-model {
    display: grid;
    gap: 7px;
    padding: 12px;
    border: 1px solid var(--c-line);
    border-radius: 10px;
    background: var(--c-bg-raised);
  }
  .managed-model > span, .managed-model small { color: var(--c-tx-muted); font-size: 12px; }
  .managed-model progress { width: 100%; accent-color: var(--c-accent); }
  .danger { color: var(--c-danger); }
  .field-label textarea {
    resize: vertical;
    line-height: 1.35;
  }
  .key-row {
    display: flex;
    gap: 5px;
  }
  .key-row input {
    flex: 1;
  }
  .key-row .ghost {
    flex: 0 0 auto;
  }
  .provider-status {
    margin: 6px 0 0;
    color: var(--c-tx-muted);
    font: 11px var(--font-mono);
  }
  .veto-list {
    margin-top: 10px;
    color: var(--c-tx-muted);
    font-size: 11px;
  }
  .veto-list summary {
    cursor: pointer;
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
    text-overflow: ellipsis;
    font-family: var(--font-mono);
  }
  .cloud-disclosure code {
    font-family: var(--font-mono);
  }
  .modal:focus {
    outline: none;
  }
  .tip {
    font-size: 12px;
    opacity: 0.6;
    margin: 18px 0 14px;
  }
  .hint {
    font-size: 11px;
    opacity: 0.5;
    margin: 6px 0 0;
    line-height: 1.4;
  }
  .close {
    width: 100%;
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: 7px;
    padding: 9px;
    cursor: pointer;
    font-family: inherit;
    font-size: 14px;
  }
</style>
