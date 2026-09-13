<script lang="ts">
  import { onDestroy } from "svelte";
  import { renderManuscript } from "./renderManuscript";

  let {
    src,
    paginated = false,
    rev = 0,
    slides = null,
    documentKey = "",
  }: {
    src: string;
    paginated?: boolean;
    /** External data revision (figures renumbered/renamed) — bump to re-render
     *  even when the manuscript text itself is unchanged. */
    rev?: number;
    slides?: import("../../../../lib/slide/embedRepository").SlideRepository | null;
    documentKey?: string;
  } = $props();

  let html = $state("<!doctype html><html><body></body></html>");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
  // Each srcdoc swap reloads the iframe from scratch; the LIVE_SCROLL script
  // (renderManuscript opts.live) reports scrollY up via postMessage and we
  // push it back down on load — edits no longer reset the preview scroll.
  let lastScroll = 0;
  let slideStates: Record<string, unknown> = {};
  let previousDocument = "";
  let renderGeneration = 0;

  let error = $state("");
  async function render() {
    const generation = ++renderGeneration;
    if (previousDocument !== documentKey) { previousDocument = documentKey; slideStates = {}; lastScroll = 0; }
    try {
      let expanded = src;
      if (slides && documentKey) {
        const { readQmdTree } = await import("../../../../lib/exportQmd");
        const { fileBridge } = await import("../../../../lib/project/types");
        const { readLiveFigureReferenceDocuments } = await import("../../../../lib/project/figureReferenceSync");
        const fb = fileBridge(), root = slides.root, entry = `${root}/${documentKey}`;
        const live = new Map(readLiveFigureReferenceDocuments(root).map(d => [d.path.startsWith(root + "/") ? d.path : `${root}/${d.path}`, d.text]));
        live.set(entry, src);
        if (fb) expanded = (await readQmdTree(entry, { readText: async p => live.get(p) ?? await fb.readText(p) })).expanded;
      }
      const r = await renderManuscript(expanded, { paginated, live: true, slides, documentKey });
      if (generation !== renderGeneration) return;
      html = r.full;
      error = "";
    } catch (e) {
      if (generation !== renderGeneration) return;
      // Keep the last good render visible, but say so — a silently stale preview
      // reads as "your edit rendered fine".
      console.error("[flux] preview render failed", e);
      error = e instanceof Error ? e.message : String(e);
    }
  }

  onDestroy(() => { clearTimeout(timer); renderGeneration++; });

  // Debounced; never on the typing hot path.
  $effect(() => {
    void src;
    void paginated;
    void rev;
    void documentKey;
    void slides;
    clearTimeout(timer);
    timer = setTimeout(render, 160);
  });

  function onMessage(e: MessageEvent) {
    if (e.source !== iframeEl?.contentWindow) return;
    if (e.data?.documentKey === documentKey && e.data?.fluxSlideStates && typeof e.data.fluxSlideStates === "object") slideStates = e.data.fluxSlideStates;
    const y = (e.data as { fluxPreviewScroll?: number } | null)?.fluxPreviewScroll;
    if (typeof y === "number") lastScroll = y;
  }
  function onLoad() {
    iframeEl?.contentWindow?.postMessage({ fluxSlideRestore: slideStates, documentKey }, "*");
    // Sandboxed srcdoc has an opaque origin — "*" is required (scroll ints only).
    if (lastScroll > 0) iframeEl?.contentWindow?.postMessage({ fluxScrollTo: lastScroll }, "*");
  }
</script>

<svelte:window onmessage={onMessage} />

<div class="preview">
  {#if error}
    <div class="prev-err" title={error}>⚠ Preview failed to update — showing the last good render.</div>
  {/if}
  <iframe
    bind:this={iframeEl}
    onload={onLoad}
    title="Manuscript preview"
    sandbox="allow-scripts"
    srcdoc={html}></iframe>
</div>

<style>
  .preview {
    position: absolute;
    inset: 0;
    background: var(--c-bg);
    overflow: hidden;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: none;
    display: block;
  }
  .prev-err {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2;
    padding: 5px 12px;
    font-size: var(--ts-xs);
    color: var(--c-on-accent, #fff);
    background: var(--c-danger, #c0392b);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
