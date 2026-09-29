<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import PaneArea from "./PaneArea.svelte";
  // Load workspace settings when a project opens, outside the eager Home graph.
  const settingsModule = import("../lib/Settings.svelte");
  import CommandPalette from "./command/CommandPalette.svelte";
  import { contextCommands } from "./command/globalCommands";
  import { requestPaperPalette } from "./command/commandBus";
  import { figureMeta, figureMetaDetached, openFigureMeta } from "../lib/figure/metadataState";
  import { activeFigureId } from "../lib/store";
  import { storeTenant } from "../lib/tenancy";
  import { shellModalOpen } from "../lib/settings";
  import { aiOpen, aiDetached } from "./agent/aiMonitorState";
  import { focusedMode, setFocusedMode } from "./paneStore";
  import type { ModeId } from "./shellStore";
  import type { Command } from "./command/commands";

  // Ctrl+1…Ctrl+5, in the title-bar strip's order (top-bar rework, 2026-07).
  const MODE_ORDER: ModeId[] = ["figure", "paper", "slide", "library", "reader"];

  let globalPaletteOpen = $state(false);
  let globalCommandList = $state<Command[]>([]);

  let Meta: typeof import("../lib/figure/FigureMeta.svelte").default | null = $state(null);
  $effect(() => { if ($figureMeta && !Meta) void import("../lib/figure/FigureMeta.svelte").then(m => Meta = m.default); });

  import { annotationOpen, askOpen, yieldsToShellModal } from "./agent/annotationVisibility";

  // The shell owns Ctrl+K: Paper focused → route to PaperMode's richer palette
  // (its own Mod+K chord was retired to keep this single-fire); Library focused →
  // LibraryMode's own listener claims it (jump to the add box, per Help), so the
  // shell stands down; anywhere else → the shell GlobalPalette. Ctrl+Shift+M
  // opens Annotate.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (yieldsToShellModal(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.defaultPrevented) return;
      if (e.altKey && !mod && e.code === "KeyM" && ["paper", "figure"].includes(get(focusedMode))) {
        e.preventDefault();
        openFigureMeta(storeTenant() === "figure" ? get(activeFigureId) ?? undefined : undefined, "captions", e.shiftKey);
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyK") {
        if (get(focusedMode) === "library") return;
        e.preventDefault();
        if (get(focusedMode) === "paper") requestPaperPalette();
        else {
          globalCommandList = contextCommands({ inPaper: false });
          globalPaletteOpen = !globalPaletteOpen;
        }
      } else if (mod && !e.altKey && !e.shiftKey && /^Digit[1-5]$/.test(e.code)) {
        // Mode switching by number — mirrors the title-bar strip left to right.
        e.preventDefault();
        setFocusedMode(MODE_ORDER[Number(e.code.slice(5)) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    // While Annotate, AI status or Figure-Meta is up, the editor's
    // keyboard yields (lib/keyboard.ts reads shellModalOpen).
    const sync = () => shellModalOpen.set(get(annotationOpen) || get(askOpen) || (get(aiOpen) && !get(aiDetached)) || (!!get(figureMeta) && !get(figureMetaDetached)));
    const unsubs = [annotationOpen.subscribe(sync), askOpen.subscribe(sync), aiOpen.subscribe(sync), aiDetached.subscribe(sync), figureMeta.subscribe(sync), figureMetaDetached.subscribe(sync)];
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const u of unsubs) u();
      shellModalOpen.set(false);
    };
  });
</script>

<div class="workspace">
  <PaneArea />
  <!-- Workspace-global overlays (Help lives one level up in Shell, so "?" also
       works on the Home screen). -->
  {#await settingsModule then { default: Settings }}
    <Settings />
  {/await}
  {#if globalPaletteOpen}
    <div class="global-palette">
      <CommandPalette commands={globalCommandList} onClose={() => (globalPaletteOpen = false)} />
    </div>
  {/if}
  {#if $figureMeta && Meta}<Meta />{/if}
</div>

<style>
  .workspace {
    position: relative; /* containing block for the global palette overlay */
    display: flex;
    height: 100%;
    width: 100%;
  }
  /* CommandPalette positions absolutely inside its nearest positioned ancestor. */
  .global-palette {
    position: absolute;
    inset: 0;
    z-index: 120;
    pointer-events: none;
  }
  .global-palette :global(.cp-scrim),
  .global-palette :global(.cp) {
    pointer-events: auto;
  }
</style>
