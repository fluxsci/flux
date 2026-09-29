<script lang="ts">
  // The scene's per-element render boundary. Canvas is a legacy-mode component
  // and the model mutates in place, so a legacy `{#each}` item holding an object
  // is "changed" whenever its list is recomputed — and a figure-scoped edit
  // recomputes the whole figure's list. Without this slot one arrow-key nudge
  // re-rendered every mounted element (~60–90 ms of Svelte work at 3,760
  // mounted objects; verify-figure-polish-electron's 5,000-object fixture).
  //
  // Rendering is a pure function of the element's own content plus the stores
  // the element components subscribe to themselves (assets, plot DOM
  // generations, model posters, the project for crops), so the slot passes
  // the element on only when its identity or content changed. Identity counts
  // too: Undo installs new objects, and a detached old one must not stay live.
  import ElementView from "./Element.svelte";
  import { perfCounters } from "./dev/perfCounters";
  import type { Element } from "./types";

  let { element, modelPartOpacity = undefined }: { element: Element; modelPartOpacity?: Record<string, number> } = $props();

  let uncomparable = 0;
  function contentOf(el: Element): string {
    // Element models are persisted JSON; anything JSON can't describe falls
    // back to "always changed" — the pre-slot behaviour, never a stale render.
    try { return JSON.stringify(el); } catch { return `\u0000${++uncomparable}`; }
  }

  // Plain memo box, not $state: the derived returns the same object when
  // nothing changed, so its dependents do not re-run.
  let last: { element: Element; content: string } | null = null;
  const current = $derived.by(() => {
    const content = contentOf(element);
    if (last && last.element === element && last.content === content) return last;
    perfCounters.elementRenders++;
    return (last = { element, content });
  });
</script>

<ElementView element={current.element} {modelPartOpacity} />
