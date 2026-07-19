<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import ActivityRail from "./ActivityRail.svelte";
  import PaneArea from "./PaneArea.svelte";
  import Help from "../lib/Help.svelte";
  import Settings from "../lib/Settings.svelte";
  import CommandPalette from "./command/CommandPalette.svelte";
  import FeedbackCapture from "./agent/FeedbackCapture.svelte";
  import { contextCommands } from "./command/globalCommands";
  import { requestPaperPalette, togglePrincipalDrawer, feedbackCaptureOpen } from "./command/commandBus";
  import { initFeedbackStore } from "./agent/feedbackStore";
  import { focusedMode } from "./paneStore";
  import type { Command } from "./command/commands";

  let globalPaletteOpen = $state(false);
  let globalCommandList = $state<Command[]>([]);

  initFeedbackStore();

  // The shell owns Ctrl+K: Paper focused → route to PaperMode's richer palette
  // (its own Mod+K chord was retired to keep this single-fire); anywhere else →
  // the shell GlobalPalette. Ctrl+Shift+J toggles the principal drawer globally.
  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.code === "KeyK") {
        e.preventDefault();
        if (get(focusedMode) === "paper") requestPaperPalette();
        else {
          globalCommandList = contextCommands({ inPaper: false });
          globalPaletteOpen = !globalPaletteOpen;
        }
      } else if (mod && !e.altKey && e.shiftKey && e.code === "KeyJ") {
        e.preventDefault();
        togglePrincipalDrawer();
      } else if (mod && !e.altKey && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        feedbackCaptureOpen.update((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
</script>

<div class="workspace">
  <ActivityRail />
  <PaneArea />
  <!-- Shell-global overlays (available in every mode). -->
  <Help />
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
