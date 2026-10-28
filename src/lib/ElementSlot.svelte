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
  import type { Element, Figure } from "./types";
  import type { FluxPlotManifest } from "./plot/types";
  import { elementTone } from "./cursor/cursorTone";
  import { presentEditorParts } from "./editorPresentationDom";
  import { modelPartOpacity as deriveModelPartOpacity, type ModelPartStates } from "./model3d/appearance";
  import { activeTool, hoverId } from "./store";
  import { get } from "svelte/store";
  import type { transientSceneTransforms } from "./interact/sceneTransforms";

  let {
    element, figure, sceneTransforms, onPointerDown, onDoubleClick,
    plotManifest = null, generation = 0, partStates = undefined,
    ghost = false, hidden = false, opacity = 1, absent = false,
    editingHidden = false, gestureHidden = false, override = null,
  }: {
    element: Element;
    figure: Figure;
    sceneTransforms: ReturnType<typeof transientSceneTransforms>;
    onPointerDown: (event: PointerEvent, element: Element, figure: Figure) => void;
    onDoubleClick: (event: MouseEvent, element: Element, figure: Figure) => void;
    plotManifest?: FluxPlotManifest | null;
    generation?: number;
    partStates?: ModelPartStates;
    ghost?: boolean;
    hidden?: boolean;
    opacity?: number;
    absent?: boolean;
    editingHidden?: boolean;
    gestureHidden?: boolean;
    override?: Element | null;
  } = $props();

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
    perfCounters.slotChecks++;
    const content = contentOf(element);
    if (last && last.element === element && last.content === content) return last;
    perfCounters.elementRenders++;
    return (last = { element, content });
  });
  // Keep the wrapper inside the same memo boundary as its artwork. A scoped
  // model edit otherwise wakes every legacy Canvas wrapper, recalculating
  // cursor tones and allocating presentation-action parameters thousands of
  // times even though ElementView itself is protected by this slot.
  const tone = $derived(elementTone(current.element, plotManifest));
  const partDisplay = $derived({ elementId: current.element.id, states: partStates, ghost, generation });
  const modelPartOpacity = $derived(current.element.type === "model3d" ? deriveModelPartOpacity(partStates, ghost) : undefined);
  // Preserve the content-change token even when the mutable element retains
  // its identity; deriving the bare element would suppress an in-place nudge.
  const rendered = $derived({ element: override ?? (hidden && ghost ? { ...current.element, opacity: 1 } : current.element) });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<g
  class="el"
  class:cursor-on-light={tone === "light"}
  class:cursor-on-dark={tone === "dark"}
  data-editor-element-id={current.element.id}
  use:presentEditorParts={partDisplay}
  opacity={hidden ? (ghost ? 0.25 : 0) : opacity}
  style:pointer-events={absent ? "none" : null}
  class:editing-hidden={editingHidden}
  style:visibility={gestureHidden ? "hidden" : null}
  use:sceneTransforms.register={current.element.id}
  onpointerdown={(event) => onPointerDown(event, current.element, figure)}
  onpointerenter={() => {
    const tool = get(activeTool);
    if (tool === "select" || tool === "scale") hoverId.set(current.element.id);
  }}
  onpointerleave={() => {
    if (get(hoverId) === current.element.id) hoverId.set(null);
  }}
  ondblclick={(event) => onDoubleClick(event, current.element, figure)}
>
  <ElementView element={rendered.element} {modelPartOpacity} haloBackground={figure?.background} />
</g>

<style>
  .editing-hidden { opacity: 0; }
  .el {
    /* Cursor firewall: host cursor changes must stop at the wrapper instead
       of restyling the plot's entire SVG subtree. Never use inherit here. */
    cursor: var(--cursor-cross-hover);
  }
</style>
