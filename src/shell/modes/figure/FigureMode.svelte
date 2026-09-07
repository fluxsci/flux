<script module lang="ts">
  // W16: the figure-editor store (src/lib/store.ts) is an app-wide singleton, so
  // `embeddedProjectRoot` must be cleared only when the LAST FigureMode instance
  // unmounts. With keep-alive a hidden instance can be evicted (or one split pane
  // closed) while another still shows the figure — a naive set(null) on every
  // onDestroy would null the root out from under the survivor. Ref-count instead.
  let figureModeMounts = 0;
</script>

<script lang="ts">
  // flux-figure: the Figure mode of Flux. Reuses the figure-editor components
  // (src/lib/*) verbatim; only the root is de-rooted (height:100% instead of
  // 100vh) and the keyboard handler is scoped to this component's lifetime so
  // figure shortcuts aren't global when another mode is focused. Persistence is
  // wired into the project's `fig/` subsystem via project/figbridge.ts.
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import Toolbar from "../../../lib/Toolbar.svelte";
  import Sidebar from "../../../lib/Sidebar.svelte";
  import Canvas from "../../../lib/Canvas.svelte";
  import Inspector from "../../../lib/Inspector.svelte";
  import ArrangeHud from "../../../lib/ArrangeHud.svelte";
  import CascadePopover from "../../../lib/CascadePopover.svelte";
  import FigureNamer from "../../../lib/FigureNamer.svelte";
  import FigureDeletionDialog from "../../../lib/FigureDeletionDialog.svelte";
  import FigureCatalog from "../../../lib/FigureCatalog.svelte";
  import FluxFigMenu from "../../../lib/FluxFigMenu.svelte";
  import Xray from "../../../lib/Xray.svelte";
  import PlotImporter from "../../../lib/PlotImporter.svelte";
  import DissectOverlay from "../../../lib/dissect/DissectOverlay.svelte";
  import PresetPicker from "../../../lib/PresetPicker.svelte";
  import { handleKey, handleEditorPaste } from "../../../lib/keyboard";
  import { activeFigureId, dirty as figDirty, embeddedProjectRoot, captionOpen } from "../../../lib/store";
  import { inspectorHidden, leftRailHidden } from "../../../lib/settings";
  import { figureLayout, FIGURE_LAYOUT_DEFAULTS } from "../../../lib/figureLayoutStore";
  import { projectModel } from "../../shellStore";
  import { loadFigInto, saveFigFrom, figDiskDiverged } from "../../../lib/project/figbridge";
  import { pendingRevealFigureId, focusFigure } from "../../scholar/nav";
  import { bumpFigRevision, figRevision } from "../../scholar/revisions";
  import { createAutosave, ConflictError } from "../../../lib/autosave";
  import { registerFlushable } from "../../lifecycle";
  import { pointerDrag } from "../../../lib/ui/pointerDrag";
  import { initializeEditor } from "../../editorHandoff";
  import { errMsg } from "../../../lib/toast";

  // Only handle figure shortcuts while this pane is focused, so they don't fire
  // while the user is typing in another (e.g. Write) pane.
  // WS-1 Fix 7: `active` (ModeContent keep-alive — false while another mode is
  // shown) suspends the per-notify derived recompute in Canvas/Sidebar; the
  // scene DOM stays mounted (W16 warm-switch) and one recompute runs on
  // reactivation via the figureRev memo keys.
  let { focused = true, active = true, paneId = "" }: { focused?: boolean; active?: boolean; paneId?: string } = $props();

  const pm = get(projectModel); // the loaded Flux project (or null on web/demo)
  let ready = $state(false);
  let loadError = $state<string | null>(null);
  let alive = true;
  let unsubDirty: (() => void) | undefined;
  let unsubReveal: (() => void) | undefined;
  let unsubFigRev: (() => void) | undefined;
  // W7: fig/ changed on disk (agent/CLI) while the editor had unsaved edits.
  let figDiverged = $state(false);

  // W4: shared autosave controller — save failures stay dirty, retry once
  // silently, then surface a sticky toast (they were fire-and-forget before).
  const autosave = createAutosave({
    name: "figures",
    delay: 700,
    isDirty: () => ready && !!pm && get(figDirty),
    save: async () => {
      if (!pm) return;
      try {
        await saveFigFrom(pm.root); // clears figDirty only on success
        figDiverged = false;
        bumpFigRevision(); // tell the manuscript its figures changed
      } catch (e) {
        // W7: don't clobber an external write — surface the banner; the controller
        // keeps us dirty and won't retry/toast a ConflictError.
        if (e instanceof ConflictError) figDiverged = true;
        throw e;
      }
    },
  });
  const autosaveStatus = autosave.status;
  const autosaveError = autosave.error;

  async function reloadFigures() {
    if (!pm) return;
    // reload: true — keep the user's canvas/figure/selection where their ids
    // survive, and land the external change as ONE undo entry (Ctrl+Z reverts
    // the agent's batch). Resets baseline + clears dirty as before.
    await loadFigInto(pm.root, pm.manifest.title, { reload: true });
    figDiverged = false;
  }
  // W10 (AGT-3): an external (agent/CLI) write to fig/ live-reloads the open
  // editor. figRevision also fires on our OWN save, so gate on figDiskDiverged
  // (false right after we write). Clean → reload in place (view + history
  // preserved); dirty → surface the reload/overwrite banner instead of
  // clobbering.
  async function onFigRevision() {
    if (!pm || !ready) return;
    if (!(await figDiskDiverged(pm.root))) return;
    if (get(figDirty)) figDiverged = true;
    else await reloadFigures();
  }
  async function overwriteFigures() {
    if (!pm) return;
    await saveFigFrom(pm.root, { force: true }); // editor's version wins
    figDiverged = false;
    bumpFigRevision();
  }

  // --- draggable rail edges → sidebar/inspector widths (the slide filmstrip
  // gutter pattern; persists via figureLayout). No preventDefault on
  // pointerdown — it would suppress the derived dblclick (reset affordance);
  // text selection during the drag is blocked via body user-select instead.
  let bodyEl = $state<HTMLElement | null>(null);
  const railMax = (min: number) => Math.max(min, Math.round(window.innerWidth * 0.4));
  let cancelRail: (() => void) | null = null;
  function railDrag(apply: (x: number, rect: DOMRect) => void) {
    return (event: PointerEvent) => {
      if (event.button !== 0) return;
      cancelRail?.();
      const original = { ...get(figureLayout) };
      cancelRail = pointerDrag(event, e => {
        if (bodyEl) apply(e.clientX, bodyEl.getBoundingClientRect());
      }, () => figureLayout.set(original), () => { cancelRail = null; });
    };
  }
  const startSbDrag = railDrag((x, rect) => {
    const w = Math.max(140, Math.min(railMax(420), x - rect.left));
    figureLayout.update((s) => ({ ...s, sidebarW: Math.round(w) }));
  });
  const startInspDrag = railDrag((x, rect) => {
    const w = Math.max(200, Math.min(railMax(480), rect.right - x));
    figureLayout.update((s) => ({ ...s, inspectorW: Math.round(w) }));
  });
  const resetSbW = () => figureLayout.update((s) => ({ ...s, sidebarW: FIGURE_LAYOUT_DEFAULTS.sidebarW }));
  const resetInspW = () => figureLayout.update((s) => ({ ...s, inspectorW: FIGURE_LAYOUT_DEFAULTS.inspectorW }));

  $effect(() => {
    if (!focused || !ready) return;
    const onPaste = (e: ClipboardEvent) => handleEditorPaste(e, get(activeFigureId));
    window.addEventListener("keydown", handleKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("paste", onPaste);
    };
  });

  onMount(() => {
    figureModeMounts++;
    void initializeEditor("figure", paneId, () => alive, async () => {
    if (pm) {
      embeddedProjectRoot.set(pm.root);
      await loadFigInto(pm.root, pm.manifest.title);
    }
    if (!alive) return;
    ready = true;
    // If the user clicked a @fig ref in the manuscript, jump to that figure.
    const pend = get(pendingRevealFigureId);
    if (pend) focusFigure(pend);
    unsubReveal = pendingRevealFigureId.subscribe((id) => {
      if (id && ready) focusFigure(id);
    });
    // Autosave to fig/ whenever the figure editor marks the project dirty (debounced).
    unsubDirty = figDirty.subscribe((d) => {
      if (!ready || !pm || !d) return;
      autosave.schedule();
    });
    // W10: live-reload on external fig/ edits (gated by figDiskDiverged so our own
    // saves don't self-reload). Skip the immediate on-subscribe call.
    let first = true;
    unsubFigRev = figRevision.subscribe(() => {
      if (first) { first = false; return; }
      void onFigRevision();
    });
    }).catch(e => { if (alive) loadError = errMsg(e); });
  });

  // W5: register with the shell's dirty registry so goHome/quit/reload flush us.
  const unregFlush = registerFlushable({
    id: "figure",
    isDirty: () => ready && !!pm && get(figDirty),
    flush: () => autosave.flush(),
  });

  onDestroy(() => {
    cancelRail?.();
    alive = false;
    unsubDirty?.();
    unsubReveal?.();
    unsubFigRev?.();
    if (ready) void autosave.flush();
    autosave.dispose();
    unregFlush();
    if (--figureModeMounts === 0 && ready) embeddedProjectRoot.set(null);
  });
</script>

<div class="figure-mode">
  {#if !ready}
    <div class="editor-loading" role="status">{loadError ?? "Opening figures…"}</div>
  {:else}
  <Toolbar saveStatus={$autosaveStatus} saveError={$autosaveError} retrySave={() => void autosave.flush()} />
  <div
    class="body"
    bind:this={bodyEl}
    style={`--sb-w:${$figureLayout.sidebarW}px; --insp-w:${$figureLayout.inspectorW}px`}>
    {#if !$leftRailHidden}
      <Sidebar paneActive={active} />
      <div
        class="rail-gutter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar (double-click resets)"
        onpointerdown={startSbDrag}
        ondblclick={resetSbW}>
      </div>
    {:else}
      <button class="edgetab left" title="Show sidebar (Ctrl+B)" onclick={() => leftRailHidden.set(false)}>›</button>
    {/if}
    <main class="canvas-wrap">
      <Canvas paneActive={active} /><ArrangeHud /><CascadePopover />
      <!-- Only the focused pane owns/hosts the namer (split-workspace safe). -->
      {#if focused}<FigureNamer /><FigureCatalog /><FigureDeletionDialog />{/if}
    </main>
    <!-- The Inspector steps aside while the caption editor is open, giving the
         caption page room (and keeping the figure read-only / distraction-free).
         Ctrl+Shift+B (keyboard.ts) hides it entirely. -->
    {#if !$captionOpen && !$inspectorHidden}
      <div
        class="rail-gutter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector (double-click resets)"
        onpointerdown={startInspDrag}
        ondblclick={resetInspW}>
      </div>
      <Inspector />
    {:else if !$captionOpen}
      <button class="edgetab right" title="Show right rail (Ctrl+Shift+B)" onclick={() => inspectorHidden.set(false)}>‹</button>
    {/if}
  </div>
  <FluxFigMenu />
  <Xray />
  <PlotImporter {active} />
  <DissectOverlay />
  <PresetPicker />

  {#if figDiverged}
    <div class="disk-toast">
      <span>These figures changed on disk (an agent or another tool edited them).</span>
      <button onclick={reloadFigures}>Reload theirs</button>
      <button class="ghost" onclick={overwriteFigures}>Overwrite with mine</button>
    </div>
  {/if}
  {/if}
</div>

<style>
  .editor-loading { margin: auto; padding: 24px; color: var(--c-tx-2); }
  .figure-mode {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    position: relative;
  }
  .disk-toast {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 10px 14px;
    background: var(--c-bg-1, #1c1b1a);
    color: var(--c-tx, #cecdc3);
    border: 1px solid var(--c-ui, #403e3c);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    font-size: 13px;
    z-index: 50;
  }
  .disk-toast button {
    border: 1px solid var(--c-ui, #403e3c);
    background: var(--c-bg-2, #282726);
    color: var(--c-tx, #cecdc3);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 12px;
  }
  .disk-toast button:hover {
    background: var(--c-ui, #403e3c);
  }
  .disk-toast button.ghost {
    background: transparent;
    color: var(--c-tx-2, #878580);
  }
  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .canvas-wrap {
    flex: 1;
    min-width: 0;
    position: relative;
  }
  /* Drag-to-resize rail edges (slide filmstrip gutter pattern). */
  .rail-gutter {
    flex: 0 0 5px;
    margin: 0 -2px;
    cursor: col-resize;
    z-index: 5;
    background: transparent;
  }
  .rail-gutter:hover {
    background: color-mix(in srgb, var(--c-accent, #4385be) 35%, transparent);
  }
  /* Slim hover-revealed reopen affordance for a hidden rail. */
  .edgetab {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 12px;
    border: none;
    padding: 0;
    background: transparent;
    color: var(--c-tx-2, #878580);
    font-size: 14px;
    cursor: pointer;
    opacity: 0.25;
    z-index: 6;
  }
  .edgetab:hover {
    opacity: 1;
    background: color-mix(in srgb, var(--c-accent, #4385be) 18%, transparent);
  }
  .edgetab.left {
    left: 0;
  }
  .edgetab.right {
    right: 0;
  }
</style>
