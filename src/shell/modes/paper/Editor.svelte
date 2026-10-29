<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView, tooltips } from "@codemirror/view";
  import { EditorState, type Extension } from "@codemirror/state";
  import { createEditorExtensions } from "./markdown-setup";

  let {
    doc = "",
    onChange,
    extensions,
    onReady,
  }: {
    doc?: string;
    onChange?: (s: string) => void;
    extensions?: Extension[];
    onReady?: (view: EditorView) => void;
  } = $props();

  let host: HTMLDivElement;
  let tooltipAnchor: HTMLDivElement;

  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          extensions ?? createEditorExtensions(),
          // Tooltips (spelling menu, completions, hovers) live outside the
          // contained host: inside it they would stack below the column's
          // title and status pills.
          tooltips({ parent: tooltipAnchor }),
          EditorView.updateListener.of((u) => {
            // WS-2 note: this per-keystroke doc.toString() is the residual
            // O(doc) allocation after the block-field change-gating (a single
            // ~1-2ms string at 20k lines). Deliberately left: removing it would
            // ripple through the latest/autosave/preview contract (consumers
            // already read the 150ms-debounced latestIdle).
            if (u.docChanged && onChange) onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    onReady?.(view);
    // Dev-only handles for headless testing/inspection (§1.4 / M17). __fluxView is
    // the most-recently-mounted editor; __flux.editors holds all live views (one
    // per Paper pane) so multi-pane tests can target a specific editor.
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, any>;
      w.__fluxView = view;
      w.__flux = w.__flux || {};
      w.__flux.editors = w.__flux.editors || [];
      w.__flux.editors.push(view);
    }
    return () => {
      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, any>;
        if (Array.isArray(w.__flux?.editors)) {
          w.__flux.editors = w.__flux.editors.filter((v: unknown) => v !== view);
        }
      }
      view.destroy();
    };
  });
</script>

<div class="host" bind:this={host}></div>
<div class="tooltip-anchor" bind:this={tooltipAnchor}></div>

<style>
  .host {
    height: 100%;
    /* A relayout boundary. Without it every keystroke laid out the whole shell
       from the root: each scroller (doc list, outline, margin) re-derived its
       scrollbars and repainted in full, and the editor re-rastered its whole
       viewport, replaying any SVG embed in view (2026-10-29, GPU raster:
       701 -> 20 ms of raster per 42 keys beside one heavy embed). The size
       comes from the column, never the text. */
    contain: size layout;
  }
  .tooltip-anchor {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 0;
  }
  .host :global(.cm-editor) {
    height: 100%;
  }
</style>
