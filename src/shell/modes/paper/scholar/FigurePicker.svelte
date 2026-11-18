<script lang="ts">
  // `/figure`: choose a figure to place in the manuscript. The finder, in the margin card's
  // chrome (PickerShell); Enter or a click places it.
  import { yieldsToShellModal, isAnnotateChord } from "../../../agent/annotationVisibility";
  import { type FigureRef } from "./figures";
  import PickerShell from "./PickerShell.svelte";
  import FigureFinder from "./FigureFinder.svelte";

  let {
    figures,
    canvases = [],
    onSelect,
    onClose,
  }: {
    figures: FigureRef[];
    /** Project canvas list (id + display name, canonical order) for the
     *  scope dropdown; with 0–1 canvases the dropdown is not shown. */
    canvases?: { id: string; name: string }[];
    onSelect: (ref: FigureRef) => void;
    onClose: () => void;
  } = $props();

  let finder = $state<ReturnType<typeof FigureFinder> | undefined>(undefined);

  function onkeydown(e: KeyboardEvent) {
    if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
    // The keydown that OPENED the picker (e.g. Enter accepting the /figure
    // completion) is still bubbling when this window listener mounts — anything
    // already claimed upstream must not double-fire here.
    if (e.defaultPrevented) return;
    // The canvas dropdown owns its own keyboard when focused (native arrow/
    // Enter behavior) — only Escape still closes the picker from there.
    if (e.target instanceof HTMLSelectElement && e.key !== "Escape") return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else finder?.handleKey(e);
  }
</script>

<svelte:window {onkeydown} />

<PickerShell title="Insert a figure" {onClose}>
  <FigureFinder
    bind:this={finder}
    {figures}
    {canvases}
    gridId="figpicker-grid"
    optionPrefix="figopt-"
    note="Linked to Figure: content, caption and number stay current."
    onChoose={onSelect} />
</PickerShell>
