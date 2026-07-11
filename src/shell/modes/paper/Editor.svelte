<script lang="ts">
  import { onMount } from "svelte";
  import { EditorView } from "@codemirror/view";
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

  onMount(() => {
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          extensions ?? createEditorExtensions(),
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

<style>
  .host {
    height: 100%;
  }
  .host :global(.cm-editor) {
    height: 100%;
  }
</style>
