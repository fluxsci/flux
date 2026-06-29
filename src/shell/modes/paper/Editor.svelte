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
            if (u.docChanged && onChange) onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    onReady?.(view);
    // Dev-only handle for headless testing/inspection.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__fluxView = view;
    return () => view.destroy();
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
