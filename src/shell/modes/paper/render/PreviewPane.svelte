<script lang="ts">
  import { renderManuscript } from "./renderManuscript";

  let { src, paginated = false }: { src: string; paginated?: boolean } = $props();

  let html = $state("<!doctype html><html><body></body></html>");
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function render() {
    try {
      const r = await renderManuscript(src, { paginated });
      html = r.full;
    } catch (e) {
      console.error("[flux] preview render failed", e);
    }
  }

  // Debounced; never on the typing hot path.
  $effect(() => {
    void src;
    void paginated;
    clearTimeout(timer);
    timer = setTimeout(render, 160);
  });
</script>

<div class="preview">
  <iframe title="Manuscript preview" sandbox="allow-scripts" srcdoc={html}></iframe>
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
