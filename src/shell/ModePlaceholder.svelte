<script lang="ts">
  import Icon from "./Icon.svelte";

  let {
    icon,
    title,
    tagline,
    note,
  }: { icon: string; title: string; tagline: string; note?: string } = $props();
</script>

<section class="placeholder">
  <div class="glyph">
    <Icon name={icon} size={56} stroke={1.4} />
  </div>
  <h2>{title}</h2>
  <p class="tagline">{tagline}</p>
  <span class="chip">In development</span>
  {#if note}
    <p class="note">{note}</p>
  {/if}
</section>

<style>
  .placeholder {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    padding: var(--sp-7);
    text-align: center;
  }
  .glyph {
    color: var(--c-accent);
    opacity: 0.5;
    margin-bottom: var(--sp-2);
    filter: drop-shadow(0 0 22px var(--c-accent-tint));
  }
  h2 {
    margin: 0;
    font-family: var(--font-serif);
    font-weight: 600;
    font-size: var(--ts-2xl);
    letter-spacing: var(--tracking-tight);
    color: var(--c-tx-hi);
  }
  .tagline {
    margin: 0;
    max-width: 42ch;
    font-size: var(--ts-md);
    line-height: var(--lh-snug);
    color: var(--c-tx-muted);
  }
  .chip {
    margin-top: var(--sp-2);
    padding: 4px 12px;
    font-size: var(--ts-xs);
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
    color: var(--c-accent-bright);
    background: var(--c-accent-tint-2);
    border: 1px solid var(--c-accent-tint);
    border-radius: var(--r-pill);
  }
  .note {
    margin: var(--sp-2) 0 0;
    font-size: var(--ts-sm);
    font-style: italic;
    color: var(--c-tx-faint);
  }
</style>
