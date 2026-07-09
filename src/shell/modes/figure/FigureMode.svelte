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
  import FluxFigMenu from "../../../lib/FluxFigMenu.svelte";
  import Xray from "../../../lib/Xray.svelte";
  import PlotImporter from "../../../lib/PlotImporter.svelte";
  import { handleKey } from "../../../lib/keyboard";
  import { dirty as figDirty, embeddedProjectRoot, captionOpen } from "../../../lib/store";
  import { projectModel } from "../../shellStore";
  import { loadFigInto, saveFigFrom, figDiskDiverged } from "../../../lib/project/figbridge";
  import { pendingRevealFigureId, focusFigure } from "../../scholar/nav";
  import { bumpFigRevision, figRevision } from "../../scholar/revisions";
  import { createAutosave, ConflictError } from "../../../lib/autosave";
  import { registerFlushable } from "../../lifecycle";

  // Only handle figure shortcuts while this pane is focused, so they don't fire
  // while the user is typing in another (e.g. Write) pane.
  let { focused = true }: { focused?: boolean } = $props();

  const pm = get(projectModel); // the loaded Flux project (or null on web/demo)
  let ready = false;
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
    isDirty: () => !!pm && get(figDirty),
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

  async function reloadFigures() {
    if (!pm) return;
    await loadFigInto(pm.root, pm.manifest.title); // resets baseline + clears dirty
    figDiverged = false;
  }
  // W10 (AGT-3): an external (agent/CLI) write to fig/ live-reloads the open
  // editor. figRevision also fires on our OWN save, so gate on figDiskDiverged
  // (false right after we write). Clean → reload in place (viewport preserved);
  // dirty → surface the reload/overwrite banner instead of clobbering.
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

  $effect(() => {
    if (!focused) return;
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  onMount(async () => {
    figureModeMounts++;
    if (pm) {
      embeddedProjectRoot.set(pm.root);
      await loadFigInto(pm.root, pm.manifest.title);
    }
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
  });

  // W5: register with the shell's dirty registry so goHome/quit/reload flush us.
  const unregFlush = registerFlushable({
    id: "figure",
    isDirty: () => !!pm && get(figDirty),
    flush: () => autosave.flush(),
  });

  onDestroy(() => {
    unsubDirty?.();
    unsubReveal?.();
    unsubFigRev?.();
    void autosave.flush();
    autosave.dispose();
    unregFlush();
    if (--figureModeMounts === 0) embeddedProjectRoot.set(null); // W16: last one out clears it
  });
</script>

<div class="figure-mode">
  <Toolbar />
  <div class="body">
    <Sidebar />
    <main class="canvas-wrap"><Canvas /><ArrangeHud /></main>
    <!-- The Inspector steps aside while the caption editor is open, giving the
         caption page room (and keeping the figure read-only / distraction-free). -->
    {#if !$captionOpen}<Inspector />{/if}
  </div>
  <FluxFigMenu />
  <Xray />
  <PlotImporter />

  {#if figDiverged}
    <div class="disk-toast">
      <span>These figures changed on disk (an agent or another tool edited them).</span>
      <button onclick={reloadFigures}>Reload theirs</button>
      <button class="ghost" onclick={overwriteFigures}>Overwrite with mine</button>
    </div>
  {/if}
</div>

<style>
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
  }
  .canvas-wrap {
    flex: 1;
    min-width: 0;
    position: relative;
  }
</style>
