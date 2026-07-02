<script lang="ts">
  import { renderManuscript } from "./renderManuscript";

  let {
    src,
    paginated = false,
    rev = 0,
  }: {
    src: string;
    paginated?: boolean;
    /** External data revision (figures renumbered/renamed) — bump to re-render
     *  even when the manuscript text itself is unchanged. */
    rev?: number;
  } = $props();

  let html = $state("<!doctype html><html><body></body></html>");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let iframeEl = $state<HTMLIFrameElement | undefined>(undefined);
  // Each srcdoc swap reloads the iframe from scratch; the LIVE_SCROLL script
  // (renderManuscript opts.live) reports scrollY up via postMessage and we
  // push it back down on load — edits no longer reset the preview scroll.
  let lastScroll = 0;

  async function render() {
    try {
      const r = await renderManuscript(src, { paginated, live: true });
      html = r.full;
    } catch (e) {
      console.error("[flux] preview render failed", e);
    }
  }

  // Debounced; never on the typing hot path.
  $effect(() => {
    void src;
    void paginated;
    void rev;
    clearTimeout(timer);
    timer = setTimeout(render, 160);
  });

  function onMessage(e: MessageEvent) {
    if (e.source !== iframeEl?.contentWindow) return;
    const y = (e.data as { fluxPreviewScroll?: number } | null)?.fluxPreviewScroll;
    if (typeof y === "number") lastScroll = y;
  }
  function onLoad() {
    // Sandboxed srcdoc has an opaque origin — "*" is required (scroll ints only).
    if (lastScroll > 0) iframeEl?.contentWindow?.postMessage({ fluxScrollTo: lastScroll }, "*");
  }
</script>

<svelte:window onmessage={onMessage} />

<div class="preview">
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
</style>
