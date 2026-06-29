<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";
  let { host }: { host: MarginHost; margin: MarginApi } = $props();
</script>

<div class="stub">
  <p class="lead">Reference PDFs</p>
  <p class="note">
    Open and read the full PDF of a cited reference right here in the margin. Coming soon — your
    library has {host.references.length} reference{host.references.length === 1 ? "" : "s"}.
  </p>
</div>

<style>
  .stub {
    padding: var(--sp-6) var(--sp-4);
    text-align: center;
    color: var(--c-tx-muted);
  }
  .lead {
    font-family: var(--font-serif);
    font-size: var(--ts-lg);
    color: var(--c-tx);
    margin: 0 0 var(--sp-2);
  }
  .note {
    font-size: var(--ts-sm);
    line-height: 1.6;
    margin: 0;
  }
</style>
