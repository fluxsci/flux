<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import PaneArea from "./PaneArea.svelte";
  import Settings from "../lib/Settings.svelte";
  import CommandPalette from "./command/CommandPalette.svelte";
  import FeedbackCapture from "./agent/FeedbackCapture.svelte";
  import { contextCommands } from "./command/globalCommands";
  import { requestPaperPalette, feedbackCaptureOpen } from "./command/commandBus";
  import { initFeedbackStore } from "./agent/feedbackStore";
  import { focusedMode, setFocusedMode } from "./paneStore";
  import type { ModeId } from "./shellStore";
  import type { Command } from "./command/commands";

  // Ctrl+1…Ctrl+5, in the title-bar strip's order (top-bar rework, 2026-07).
  const MODE_ORDER: ModeId[] = ["figure", "paper", "slide", "library", "reader"];

  let globalPaletteOpen = $state(false);
  let globalCommandList = $state<Command[]>([]);

  initFeedbackStore();

  // The shell owns Ctrl+K: Paper focused → route to PaperMode's richer palette
  // (its own Mod+K chord was retired to keep this single-fire); Library focused →
  // LibraryMode's own listener claims it (jump to the add box, per Help), so the
  // shell stands down; anywhere else → the shell GlobalPalette. Ctrl+Shift+M
  // toggles the feedback capture ("Note to agent").
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyK") {
        if (get(focusedMode) === "library") return;
        e.preventDefault();
        if (get(focusedMode) === "paper") requestPaperPalette();
        else {
          globalCommandList = contextCommands({ inPaper: false });
          globalPaletteOpen = !globalPaletteOpen;
        }
      } else if (mod && !e.altKey && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        feedbackCaptureOpen.update((v) => !v);
      } else if (mod && !e.altKey && !e.shiftKey && /^Digit[1-5]$/.test(e.code)) {
        // Mode switching by number — mirrors the title-bar strip left to right.
        e.preventDefault();
        setFocusedMode(MODE_ORDER[Number(e.code.slice(5)) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="workspace">
  <PaneArea />
  <!-- Workspace-global overlays (Help lives one level up in Shell, so "?" also
       works on the Home screen). -->
  <Settings />
  {#if globalPaletteOpen}
    <div class="global-palette">
      <CommandPalette commands={globalCommandList} onClose={() => (globalPaletteOpen = false)} />
    </div>
  {/if}
  <FeedbackCapture />
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
