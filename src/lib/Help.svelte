<script lang="ts">
  // Shell-global keyboard reference. Mounted once (Shell — so `?` works on Home
  // too); opened with `?` from anywhere or the title-bar help button (the
  // `helpOpen` store). Tabs cover every mode; opening jumps to the mode you're
  // focused on.
  import { helpOpen } from "./settings";
  import { focusedMode } from "../shell/paneStore";

  type Row = [string, string];
  type Group = { title: string; items: Row[] };
  type Section = { id: string; label: string; groups: Group[] };

  const SECTIONS: Section[] = [
    {
      id: "global",
      label: "Global",
      groups: [
        {
          title: "Everywhere",
          items: [
            ["?", "Show / hide this reference"],
            ["Esc", "Close menus & overlays"],
            ["Click a mode icon (top bar)", "Switch mode"],
            ["⌃1 – ⌃5", "Switch mode (Figure, Paper, Slide, Library, Reader)"],
            ["Alt / ⌘-click a mode icon", "Open that mode in a split pane"],
            ["Flux wordmark", "Back to the start screen"],
            ["⚙", "Settings"],
          ],
        },
      ],
    },
    {
      id: "paper",
      label: "Paper",
      groups: [
        {
          title: "Editing & view",
          items: [
            ["⌘K", "Command palette (everything is here)"],
            ["⌘⇧E", "Toggle edit / preview"],
            ["Esc", "Exit preview"],
            ["⌃⇧[ / ⌃⇧]", "Fold / unfold section"],
          ],
        },
        {
          title: "Panels",
          items: [
            ["Alt+O", "Left panel — outline & documents (drag its edge to resize)"],
            ["⌃⇧B", "Dynamic margin"],
            ["Alt+R", "Reference search"],
            ["Alt+F", "Figures"],
            ["Alt+A", "Comments"],
            ["Alt+T / ⌘`", "Terminal"],
            ["Alt+P / ⌃Alt+P", "Close pane / clear all"],
          ],
        },
        {
          title: "References & figures",
          items: [
            ["Alt+C", "Edit citation at cursor"],
            ["⌘⌥M", "Comment on selection"],
            ["⌘⌥− / ⌘⌥=", "Figure width down / up"],
            ["Alt+D / ⇧Alt+D", "Personal / project dictionary"],
            ["⇧Alt+W", "Word tools and aliases"],
            ["⌘K → Export", "PDF · HTML · Word"],
          ],
        },
      ],
    },
    {
      id: "figure",
      label: "Figure",
      groups: [
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
            ["K", "Scale"],
          ],
        },
        {
          title: "Canvas",
          items: [
            ["Scroll", "Pan"],
            ["⌘ + Scroll", "Zoom"],
            ["Space + drag", "Pan"],
            ["Drag empty", "Marquee select"],
            ["Shift + click", "Add to selection"],
            ["Double-click text", "Edit text inline"],
            ["Double-click group", "Enter group (Esc steps back out)"],
            ["⌃ + click plot", "Deep-select a part (dbl-click too) · drag moves it, arrows nudge"],
            ["⌃ + drag handle", "Crop (content stays pinned; reset in Inspector)"],
            ["F", "Property menu for the selection (or drilled part)"],
            ["Shift + R", "Toggle rulers"],
          ],
        },
        {
          title: "Arrange",
          items: [
            ["Alt + A / W / S / D", "Align L / T / B / R"],
            ["Alt + H / V", "Center horizontally / vertically"],
            ["Shift + H / V", "Flip horizontal / vertical"],
            ["Alt + G", "Arrange mode: snap into a grid"],
            ["⌃⇧I", "Bring selection inside the frame (never resizes)"],
            ["Arrows", "Nudge (Shift = ×10)"],
            ["⌃ + [ / ]", "Send back / bring forward"],
            ["⌃ + Shift + [ / ]", "To back / front"],
            ["⌃ + G / Shift + G", "Group / ungroup"],
            ["Shift (resize)", "Lock aspect ratio"],
            ["Alt (move)", "Disable snapping"],
          ],
        },
        {
          title: "Edit & file",
          items: [
            ["⌃ + Z / Shift + Z", "Undo / redo"],
            ["⌃ + R", "Name figure — family · number · nickname"],
            ["Alt + ↑ / ↓", "Move the figure up / down the sidebar list (drag a row does the same)"],
            ["⌃ + D", "Duplicate"],
            ["⌃ + C / V", "Copy / paste"],
            ["⌃ + B / I / U", "Bold / italic / underline (text or text part)"],
            ["⌘⌥C / ⌘⌥V", "Copy / paste style"],
            ["⌘⇧L", "Lock / unlock selection"],
            ["X", "Hide / show selection (or drilled plot part)"],
            ["D", "Dissect — view the selected plot's companion material"],
            ["Delete", "Delete selection"],
            ["Alt + C / L", "Edit caption / mark panel label"],
            ["⌃⇧K", "Import PNG/SVG files"],
            ["Alt + I / P", "Plot importer / X-ray"],
            ["⌃ + S / Shift + S", "Save / save as"],
          ],
        },
        {
          title: "Panels",
          items: [
            ["⌃ + B", "Hide / show the left sidebar (bold wins when text is selected)"],
            ["⌃⇧B", "Hide / show the right rail (Inspector)"],
            ["Drag a rail edge", "Resize sidebar / Inspector (double-click resets)"],
          ],
        },
      ],
    },
    {
      id: "reader",
      label: "Reader",
      groups: [
        {
          title: "Navigate",
          items: [
            ["PageUp / PageDown", "Previous / next page"],
            ["Home / End", "First / last page"],
          ],
        },
        {
          title: "Tabs",
          items: [
            ["⌃Tab / ⌃⇧Tab", "Next / previous tab (also ⌃PageDown / ⌃PageUp)"],
            ["⌃W", "Close the active tab (middle-click a tab works too)"],
            ["Alt / ⌘-click a tab", "Open that paper in a split pane"],
            ["Drag a tab", "Reorder the strip"],
          ],
        },
        {
          title: "Zoom",
          items: [
            ["+ / −", "Zoom in / out"],
            ["0", "Fit width"],
          ],
        },
        {
          title: "Panels",
          items: [
            ["⌃B / ⌃⇧B", "Show/hide the left / right sidebar"],
            ["⌘F", "Search this PDF (results list in the left sidebar)"],
            ["Alt+R / Alt+A", "Library search / annotations (right sidebar)"],
            ["Alt+T", "Terminal drawer (drag its top edge to resize)"],
          ],
        },
        {
          title: "Actions",
          items: [
            ["✦ on a selection", "Send that passage to the terminal"],
            ["Alt+drag", "Pop a page region out into a floating panel"],
            ["Ctrl+Alt+drag", "Snip a region → PNG in plots/paper_snips (with citation)"],
            ["Esc", "Close the topmost menu / popover"],
          ],
        },
      ],
    },
    {
      id: "library",
      label: "Library",
      groups: [
        {
          title: "Search & navigate",
          items: [
            ["⌘K", "Jump to the add box"],
            ["↑ / ↓", "Move through results"],
            ["Type", "Jump to search"],
            ["Enter", "Copy the citekey"],
            ["Space", "Select / deselect the row"],
            ["Esc", "Back to search"],
          ],
        },
        {
          title: "Actions",
          items: [
            ["Alt+F", "Fetch PDFs for the checked rows"],
            ["Alt+Del", "Delete checked (or highlighted) rows"],
          ],
        },
      ],
    },
    {
      id: "slide",
      label: "Slide",
      groups: [
        {
          title: "Stage",
          items: [
            ["F5", "Present from the start"],
            ["⇧F5", "Present from this slide"],
            ["⌃ + B", "Hide / show the filmstrip (bold wins when text is selected)"],
            ["⌃⇧B", "Hide / show the right rail"],
            ["Drag a rail edge", "Resize filmstrip / right rail"],
          ],
        },
        {
          title: "Arrange",
          items: [
            ["⌘A", "Select all"],
            ["⌘C / ⌘V", "Copy / paste"],
            ["⌘D", "Duplicate"],
            ["⌘G", "Group"],
            ["Arrows", "Nudge · Delete removes · Esc deselects"],
          ],
        },
        {
          title: "Animate (animator open)",
          items: [
            ["⌘⇧A", "Add appearance for the selection"],
            ["⌘⇧D", "Add disappearance"],
            ["⌘⇧T", "Add transform · toggle t₁ ↔ t₂"],
            ["Esc", "Exit an endpoint (t₁/t₂) edit"],
            ["⌘G / ⌘⇧G", "Group / ungroup tracks (dock focused)"],
            ["⌘D", "Duplicate tracks (dock focused)"],
            ["Alt+← / →", "Nudge start"],
            ["Alt+Shift+← / →", "Change duration"],
          ],
        },
      ],
    },
  ];

  let tab = $state("global");
  let modalEl = $state<HTMLDivElement | null>(null);
  let prevFocus: HTMLElement | null = null;

  const section = $derived(SECTIONS.find((s) => s.id === tab) ?? SECTIONS[0]);

  // When the overlay opens, jump to the mode you're working in and move focus
  // into the dialog; restore focus to wherever it was on close.
  $effect(() => {
    if ($helpOpen) {
      prevFocus = document.activeElement as HTMLElement | null;
      const fm = $focusedMode;
      tab = SECTIONS.some((s) => s.id === fm) ? fm : "global";
      queueMicrotask(() => modalEl?.focus());
    } else if (prevFocus) {
      prevFocus.focus?.();
      prevFocus = null;
    }
  });

  function isTyping(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return (
      !!el &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
    );
  }

  function onKey(e: KeyboardEvent) {
    if ($helpOpen && e.key === "Escape") {
      e.preventDefault();
      helpOpen.set(false);
      return;
    }
    if (isTyping(e.target)) return; // never hijack "?" typed into an editor/field
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      helpOpen.set(!$helpOpen);
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if $helpOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
  <div class="backdrop" onclick={() => helpOpen.set(false)}>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      tabindex="-1"
      bind:this={modalEl}
      onclick={(e) => e.stopPropagation()}>
      <div class="head">
        <h2>Keyboard shortcuts</h2>
        <div class="tabs" role="tablist" aria-label="Modes">
          {#each SECTIONS as s (s.id)}
            <button
              class="tab"
              class:on={tab === s.id}
              role="tab"
              aria-selected={tab === s.id}
              onclick={() => (tab = s.id)}>{s.label}</button>
          {/each}
        </div>
      </div>

      <div class="cols">
        {#each section.groups as g (g.title)}
          <div class="grp">
            <h3>{g.title}</h3>
            {#each g.items as [k, d]}
              <div class="row"><kbd>{k}</kbd><span>{d}</span></div>
            {/each}
          </div>
        {/each}
      </div>

      <div class="foot">
        <span class="legend">⌘ = Ctrl on Windows/Linux · Alt = Option</span>
        <button class="close" onclick={() => helpOpen.set(false)}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }
  .modal {
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: 10px;
    padding: 18px 22px 16px;
    width: min(760px, 92vw);
    max-height: 86vh;
    overflow: auto;
    color: var(--c-tx);
    box-shadow: var(--elev-3);
  }
  .modal:focus {
    outline: none;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 14px;
  }
  h2 {
    margin: 0;
    font-size: 16px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    flex-wrap: wrap;
  }
  .tab {
    background: transparent;
    border: 1px solid transparent;
    color: var(--c-tx-muted);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard);
  }
  .tab:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .tab.on {
    background: var(--c-accent-tint-2);
    color: var(--c-accent-bright);
    border-color: var(--c-accent);
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px 28px;
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
    min-width: 104px;
    text-align: center;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .row span {
    opacity: 0.85;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 18px;
  }
  .legend {
    font-size: 11px;
    opacity: 0.5;
  }
  .close {
    background: var(--c-accent);
    color: var(--c-on-accent);
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    cursor: pointer;
    font-size: 13px;
  }
</style>
