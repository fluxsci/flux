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
  import Help from "../../../lib/Help.svelte";
  import ArrangeHud from "../../../lib/ArrangeHud.svelte";
  import Forgery from "../../../lib/Forgery.svelte";
  import Settings from "../../../lib/Settings.svelte";
  import PlotXray from "../../../lib/PlotXray.svelte";
  import PlotImporter from "../../../lib/PlotImporter.svelte";
  import { handleKey } from "../../../lib/keyboard";
  import { dirty as figDirty, embeddedProjectRoot, captionOpen } from "../../../lib/store";
  import { projectModel } from "../../shellStore";
  import { loadFigInto, saveFigFrom } from "../../../lib/project/figbridge";
  import { pendingRevealFigureId, focusFigure } from "../../scholar/nav";
  import { bumpFigRevision } from "../../scholar/revisions";

  // Only handle figure shortcuts while this pane is focused, so they don't fire
  // while the user is typing in another (e.g. Write) pane.
  let { focused = true }: { focused?: boolean } = $props();

  const pm = get(projectModel); // the loaded Flux project (or null on web/demo)
  let ready = false;
  let unsubDirty: (() => void) | undefined;
  let unsubReveal: (() => void) | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    if (!focused) return;
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  onMount(async () => {
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
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        await saveFigFrom(pm.root);
        bumpFigRevision(); // tell the manuscript its figures changed
      }, 700);
    });
  });

  onDestroy(() => {
    unsubDirty?.();
    unsubReveal?.();
    clearTimeout(saveTimer);
    if (pm && get(figDirty)) void saveFigFrom(pm.root); // flush
    embeddedProjectRoot.set(null);
  });
</script>

<div class="figure-mode">
  <Toolbar />
  <div class="body">
    <Sidebar />
    <main class="canvas-wrap"><Canvas /><Help /><ArrangeHud /></main>
    <!-- The Inspector steps aside while the caption editor is open, giving the
         caption page room (and keeping the figure read-only / distraction-free). -->
    {#if !$captionOpen}<Inspector />{/if}
  </div>
  <Forgery />
  <Settings />
  <PlotXray />
  <PlotImporter />
</div>

<style>
  .figure-mode {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
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
