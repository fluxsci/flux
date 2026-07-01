<script lang="ts">
  // The PDF view — pdf.js (Mozilla; vanilla JS, no framework/version coupling). Renders
  // each page to a canvas + a selectable DOM text layer, and overlays anchored
  // highlights. Annotations are anchored by quote (annotations.ts), located in the page
  // text at render time → DOM range → client rects, so they survive zoom/re-render.
  // Worker is the locally-bundled asset (Vite ?url) → offline in Electron.
  import { onMount } from "svelte";
  import * as pdfjs from "pdfjs-dist";
  import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
  import "pdfjs-dist/web/pdf_viewer.css";
  import {
    makeQuoteAnchor,
    locateQuote,
    ANNOTATION_COLORS,
    type Annotation,
    type TextQuoteSelector,
  } from "../../../lib/references/annotations";

  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

  let {
    buffer,
    documentId = "paper",
    scale = 1.35,
    annotations = [],
    onCreate,
    scrollTo = null,
  }: {
    buffer: ArrayBuffer;
    documentId?: string;
    scale?: number;
    annotations?: Annotation[];
    onCreate?: (a: { page: number; anchor: TextQuoteSelector; color: string }) => void;
    scrollTo?: { id?: string; page?: number; nonce: number } | null;
  } = $props();

  const HL: Record<string, string> = {
    yellow: "rgba(255,221,51,0.40)",
    green: "rgba(94,189,108,0.38)",
    blue: "rgba(67,133,190,0.32)",
    pink: "rgba(225,90,140,0.32)",
    orange: "rgba(218,160,23,0.38)",
  };

  let container = $state<HTMLDivElement | undefined>();
  let status = $state<"loading" | "ready" | "error">("loading");
  let errMsg = $state("");
  let numPages = $state(0);
  let rendered = $state(0);

  // Per-page text-layer mapping for anchoring (char offset ⇄ DOM text node).
  type PageInfo = { text: string; nodes: { node: Text; start: number }[]; pageDiv: HTMLDivElement; layer: HTMLDivElement };
  const pageInfos = new Map<number, PageInfo>();

  // Floating highlight menu shown on text selection.
  let menu = $state<{ x: number; y: number; page: number; anchor: TextQuoteSelector } | null>(null);

  function buildPageText(layer: HTMLElement): { text: string; nodes: { node: Text; start: number }[] } {
    const nodes: { node: Text; start: number }[] = [];
    let text = "";
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      nodes.push({ node: n as Text, start: text.length });
      text += n.textContent ?? "";
    }
    return { text, nodes };
  }
  function charOffset(info: PageInfo, node: Node, offset: number): number | null {
    // node may be a Text node (usual) or an element boundary
    let textNode: Text | null = node.nodeType === Node.TEXT_NODE ? (node as Text) : null;
    if (!textNode) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      textNode = walker.nextNode() as Text | null;
      offset = 0;
    }
    if (!textNode) return null;
    const entry = info.nodes.find((e) => e.node === textNode);
    return entry ? entry.start + offset : null;
  }
  function nodeAt(info: PageInfo, off: number): { node: Text; local: number } | null {
    let res: { node: Text; start: number } | null = null;
    for (const e of info.nodes) {
      if (e.start <= off) res = e;
      else break;
    }
    return res ? { node: res.node, local: Math.max(0, Math.min(off - res.start, res.node.length)) } : null;
  }
  function rangeFor(info: PageInfo, start: number, end: number): Range | null {
    const s = nodeAt(info, start);
    const e = nodeAt(info, Math.max(start, end));
    if (!s || !e) return null;
    const r = document.createRange();
    try {
      r.setStart(s.node, s.local);
      r.setEnd(e.node, e.local);
      return r;
    } catch {
      return null;
    }
  }

  function drawHighlights(page: number) {
    const info = pageInfos.get(page);
    if (!info) return;
    info.layer.querySelectorAll(".annot-hl").forEach((el) => el.remove());
    const pageRect = info.pageDiv.getBoundingClientRect();
    for (const a of annotations) {
      if (a.page !== page) continue;
      const loc = locateQuote(info.text, a.anchor);
      if (!loc) continue;
      const r = rangeFor(info, loc.start, loc.end);
      if (!r) continue;
      for (const rect of r.getClientRects()) {
        const hl = document.createElement("div");
        hl.className = "annot-hl";
        hl.dataset.id = a.id;
        hl.style.position = "absolute";
        hl.style.left = `${rect.left - pageRect.left}px`;
        hl.style.top = `${rect.top - pageRect.top}px`;
        hl.style.width = `${rect.width}px`;
        hl.style.height = `${rect.height}px`;
        hl.style.background = HL[a.color] ?? HL.yellow;
        hl.style.pointerEvents = "none";
        hl.style.mixBlendMode = "multiply";
        info.layer.appendChild(hl);
      }
    }
  }
  function drawAll() {
    for (const p of pageInfos.keys()) drawHighlights(p);
  }
  // Re-draw whenever the annotation set changes (after pages are rendered).
  $effect(() => {
    void annotations;
    if (status === "ready") drawAll();
  });

  // Scroll to a highlight (by id) or a page when the annotation panel requests it.
  $effect(() => {
    const t = scrollTo;
    if (!t || !container) return;
    void t.nonce;
    const el =
      (t.id && container.querySelector(`.annot-hl[data-id="${t.id}"]`)) ||
      (t.page != null && container.querySelector(`.pdf-page[data-page="${t.page}"]`));
    (el as HTMLElement | null)?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  function onMouseUp() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      menu = null;
      return;
    }
    const range = sel.getRangeAt(0);
    const pageDiv = (range.startContainer.parentElement as HTMLElement | null)?.closest(".pdf-page") as HTMLElement | null;
    if (!pageDiv) {
      menu = null;
      return;
    }
    const page = Number(pageDiv.dataset.page);
    const info = pageInfos.get(page);
    if (!info) return;
    const start = charOffset(info, range.startContainer, range.startOffset);
    const end = charOffset(info, range.endContainer, range.endOffset);
    if (start == null || end == null || start === end) {
      menu = null;
      return;
    }
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const anchor = makeQuoteAnchor(info.text, lo, hi);
    if (!anchor.quote.trim()) {
      menu = null;
      return;
    }
    const rect = range.getBoundingClientRect();
    menu = { x: rect.left + rect.width / 2, y: rect.top - 8, page, anchor };
  }
  function pick(color: string) {
    if (menu) onCreate?.({ page: menu.page, anchor: menu.anchor, color });
    menu = null;
    window.getSelection()?.removeAllRanges();
  }

  onMount(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    (async () => {
      try {
        task = pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)) });
        const pdf = await task.promise;
        if (cancelled) return;
        numPages = pdf.numPages;
        const host = container;
        if (!host) return;
        host.replaceChildren();
        pageInfos.clear();

        for (let p = 1; p <= pdf.numPages; p++) {
          if (cancelled) return;
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale });
          const dpr = window.devicePixelRatio || 1;

          const pageDiv = document.createElement("div");
          pageDiv.className = "pdf-page";
          pageDiv.dataset.page = String(p);
          pageDiv.style.width = `${Math.floor(viewport.width)}px`;
          pageDiv.style.height = `${Math.floor(viewport.height)}px`;
          pageDiv.style.setProperty("--scale-factor", String(scale));
          host.appendChild(pageDiv);

          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${Math.floor(viewport.width)}px`;
          canvas.style.height = `${Math.floor(viewport.height)}px`;
          pageDiv.appendChild(canvas);
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;

          const layer = document.createElement("div");
          layer.className = "textLayer";
          pageDiv.appendChild(layer);

          await page.render({
            canvas,
            canvasContext: ctx,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          }).promise;
          if (cancelled) return;

          await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();

          const { text, nodes } = buildPageText(layer);
          pageInfos.set(p, { text, nodes, pageDiv, layer });
          drawHighlights(p);
          rendered = p;
          if (status === "loading") status = "ready";
        }
        status = "ready";
      } catch (e) {
        if (!cancelled) {
          status = "error";
          errMsg = (e as Error)?.message || String(e);
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.destroy();
      } catch {
        /* ignore */
      }
    };
  });
</script>

<svelte:window onmousedown={() => (menu = null)} />

<div class="pdf-root" data-testid="pdf-root" data-pages={numPages} data-rendered={rendered}>
  {#if status === "error"}
    <div class="msg err">Couldn't render this PDF: {errMsg}</div>
  {/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="pdf-scroll" bind:this={container} onmouseup={onMouseUp} class:hidden={status === "error"}></div>
  {#if status === "loading" && rendered === 0}
    <div class="msg loading">Rendering…</div>
  {/if}

  {#if menu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="hl-menu" style:left="{menu.x}px" style:top="{menu.y}px" onmousedown={(e) => e.stopPropagation()}>
      {#each ANNOTATION_COLORS as c}
        <button class="dot" style:background={HL[c]} title="Highlight ({c})" aria-label={`Highlight ${c}`} onclick={() => pick(c)}></button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .pdf-root {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
  }
  .pdf-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    background: var(--c-surface);
    padding: 16px 0;
  }
  .pdf-scroll.hidden {
    display: none;
  }
  :global(.pdf-page) {
    position: relative;
    margin: 0 auto 14px;
    background: #fff;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
  }
  :global(.pdf-page canvas) {
    display: block;
  }
  :global(.pdf-page .annot-hl) {
    border-radius: 1px;
  }
  .msg {
    padding: 16px;
    text-align: center;
    color: var(--c-tx-faint);
    font-size: var(--ts-sm);
    font-style: italic;
  }
  .msg.loading {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
  }
  .msg.err {
    color: var(--c-danger);
  }
  .hl-menu {
    position: fixed;
    transform: translate(-50%, -100%);
    display: flex;
    gap: 5px;
    padding: 5px 7px;
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-pill);
    box-shadow: var(--elev-2, 0 2px 8px rgba(0, 0, 0, 0.25));
    z-index: 50;
  }
  .dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--c-line);
    cursor: pointer;
    padding: 0;
  }
  .dot:hover {
    transform: scale(1.15);
  }
</style>
