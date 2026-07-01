<script lang="ts">
  // The title｜authors pill atop the editor (Redesign v2). Reads from the
  // manuscript front-matter (passed in by PaperMode). Click-to-edit is wired in
  // Phase B via onEdit; until then it is a quiet display.
  let {
    title,
    authors,
    status = "saved",
    onEdit,
  }: {
    title: string;
    authors: string[];
    status?: "demo" | "saved" | "saving" | "error";
    onEdit?: () => void;
  } = $props();

  const authorLine = $derived(authors.filter(Boolean).join(", "));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions, a11y_no_noninteractive_tabindex -->
<div
  class="pill"
  class:clickable={!!onEdit}
  role={onEdit ? "button" : undefined}
  tabindex={onEdit ? 0 : undefined}
  onclick={onEdit}
  onkeydown={(e) => {
    if (onEdit && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onEdit();
    }
  }}>
  <span class="t">{title || "Untitled"}</span>
  {#if authorLine}
    <span class="bar"></span>
    <span class="a">{authorLine}</span>
  {/if}
  {#if status !== "saved"}
    <span
      class="dot {status}"
      title={status === "saving"
        ? "Saving…"
        : status === "error"
          ? "Autosave failed — your edits are in memory; it retries on the next change"
          : "Demo · not saved"}></span>
  {/if}
</div>

<style>
  .pill {
    display: inline-flex;
    align-items: baseline;
    gap: 0.7em;
    max-width: min(70ch, 82%);
    padding: 7px 20px;
    background: var(--flx-paper);
    border: 1.5px solid var(--c-edge);
    border-radius: var(--r-2);
    box-shadow: var(--elev-2);
    font-family: var(--font-serif);
    font-size: 15px;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
  }
  .pill.clickable {
    cursor: pointer;
    transition: border-color var(--dur-quick) var(--ease-standard);
  }
  .pill.clickable:hover {
    border-color: var(--c-accent);
  }
  .t {
    font-weight: 600;
    font-style: italic;
    color: var(--c-tx-hi);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bar {
    flex: 0 0 auto;
    align-self: stretch;
    width: 1px;
    background: var(--c-line-strong);
    margin: 2px 0;
  }
  .a {
    font-style: italic;
    color: var(--c-tx-2);
    font-size: 0.94em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    flex: 0 0 auto;
    align-self: center;
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .dot.saving {
    background: var(--c-accent);
  }
  .dot.demo {
    background: var(--c-tx-faint);
  }
  .dot.error {
    background: var(--c-danger);
  }
</style>
