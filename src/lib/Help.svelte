<script lang="ts">
  let open = false;

  const groups: { title: string; items: [string, string][] }[] = [
    {
      title: "Tools",
      items: [
        ["V", "Select"],
        ["H", "Pan / hand"],
        ["T", "Text"],
        ["R", "Rectangle"],
        ["O", "Ellipse"],
        ["L / A", "Line / Arrow"],
        ["P", "Pen (Enter or dbl-click to finish)"],
      ],
    },
    {
      title: "Canvas",
      items: [
        ["Scroll", "Pan"],
        ["Ctrl/⌘ + Scroll", "Zoom"],
        ["Space + drag", "Pan"],
        ["Drag empty", "Marquee select"],
        ["Shift + click", "Add to selection"],
        ["Double-click text", "Edit text inline"],
        ["F / S", "Quick fill / stroke color picker"],
      ],
    },
    {
      title: "Arrange",
      items: [
        ["Alt + A / W / S / D", "Align L / T / B / R"],
        ["Alt + H / V", "Center horizontally / vertically"],
        ["Alt + G", "Arrange mode: snap selection into a grid"],
        ["a / g", "(in mode) row·column toggle / balanced grid"],
        ["d / f", "(in mode) more / fewer rows · ↵ apply · esc cancel"],
        ["Arrows", "Nudge (Shift = ×10)"],
        ["Ctrl + [ / ]", "Send back / bring forward"],
        ["Ctrl + Shift + [ / ]", "To back / front"],
        ["Ctrl + G / Shift + G", "Group / ungroup"],
        ["Shift (resize)", "Lock aspect ratio"],
        ["Alt (move)", "Disable snapping"],
      ],
    },
    {
      title: "Edit & file",
      items: [
        ["Ctrl + Z / Shift + Z", "Undo / redo"],
        ["Ctrl + D", "Duplicate"],
        ["Ctrl + C / V", "Copy / paste"],
        ["Ctrl + A", "Select all in figure"],
        ["Delete", "Delete selection"],
        ["Ctrl + S / Shift + S", "Save / save as"],
        ["Ctrl + O / I", "Open / import assets"],
      ],
    },
  ];

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      open = !open;
    } else if (e.key === "Escape") {
      open = false;
    }
  }
</script>

<svelte:window on:keydown={onKey} />

<button class="help-btn" title="Keyboard shortcuts (?)" on:click={() => (open = true)}>?</button>

{#if open}
  <div
    class="backdrop"
    role="button"
    tabindex="0"
    on:click={() => (open = false)}
    on:keydown={(e) => e.key === "Enter" && (open = false)}
  >
    <div
      class="modal"
      role="dialog"
      tabindex="-1"
      aria-label="Keyboard shortcuts"
      on:click|stopPropagation
      on:keydown|stopPropagation
    >
      <h2>Keyboard shortcuts</h2>
      <div class="cols">
        {#each groups as g}
          <div class="grp">
            <h3>{g.title}</h3>
            {#each g.items as [k, d]}
              <div class="row"><kbd>{k}</kbd><span>{d}</span></div>
            {/each}
          </div>
        {/each}
      </div>
      <button class="close" on:click={() => (open = false)}>Close</button>
    </div>
  </div>
{/if}

<style>
  .help-btn {
    position: absolute;
    right: 12px;
    bottom: 12px;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--c-ui);
    color: var(--c-tx);
    border: 1px solid var(--c-line-strong);
    cursor: pointer;
    font-size: 15px;
    z-index: 20;
  }
  .help-btn:hover {
    background: var(--c-ui-hover);
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: 10px;
    padding: 20px 24px;
    max-width: 720px;
    color: var(--c-tx);
    box-shadow: var(--elev-3);
  }
  h2 {
    margin: 0 0 14px;
    font-size: 16px;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px 28px;
  }
  h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.6;
    margin: 0 0 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    font-size: 12px;
  }
  kbd {
    background: var(--c-bg-raised);
    border: 1px solid var(--c-line-strong);
    border-radius: 4px;
    padding: 2px 6px;
    font-family: inherit;
    font-size: 11px;
    min-width: 96px;
    text-align: center;
    white-space: nowrap;
  }
  .row span {
    opacity: 0.85;
  }
  .close {
    margin-top: 16px;
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    cursor: pointer;
    font-size: 13px;
  }
</style>
