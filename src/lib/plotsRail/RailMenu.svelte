<script lang="ts" module>
  export type RailMenuItem =
    | { kind: "action"; label: string; hint?: string; checked?: boolean; disabled?: boolean; danger?: boolean; run: () => void }
    | { kind: "heading"; label: string }
    | { kind: "separator" }
    | { kind: "slider"; label: string; min: number; max: number; step: number; value: number; set: (v: number) => void; unit?: string; hint?: string };
</script>

<script lang="ts">
  // A small popup menu for the Plots rail (the ⋯ view menu, the destination figure switcher, a
  // tile's context menu). Fixed-positioned at an anchor point, clamped to the window; closes on
  // Escape, an outside press, or after an action. Keyboard: ↑/↓ move, Enter runs.
  import { onMount, tick } from "svelte";
  import { yieldsToShellModal, isAnnotateChord } from "../../shell/agent/annotationVisibility";

  let { items, x, y, onClose, label = "Menu", minWidth = 180 }: {
    items: RailMenuItem[];
    x: number;
    y: number;
    onClose: () => void;
    label?: string;
    minWidth?: number;
  } = $props();

  let el = $state<HTMLDivElement>();
  // Sliders show their value live (the items are a snapshot taken when the menu opened).
  let live = $state<Record<number, number>>({});
  let left = $state(0), top = $state(0);

  onMount(() => {
    const doc = el!.ownerDocument;
    const win = doc.defaultView!;
    const r = el!.getBoundingClientRect();
    left = Math.max(4, Math.min(x, win.innerWidth - r.width - 4));
    top = Math.max(4, Math.min(y, win.innerHeight - r.height - 4));
    const down = (e: PointerEvent) => { if (!el?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (yieldsToShellModal(e) || isAnnotateChord(e)) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    // Capture phase: the press that opened the menu has already been handled.
    win.addEventListener("pointerdown", down, true);
    win.addEventListener("keydown", key, true);
    win.addEventListener("blur", onClose);
    void tick().then(() => el?.querySelector<HTMLElement>("button:not(:disabled), input")?.focus());
    return () => {
      win.removeEventListener("pointerdown", down, true);
      win.removeEventListener("keydown", key, true);
      win.removeEventListener("blur", onClose);
    };
  });

  function onKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(el?.querySelectorAll<HTMLElement>("button:not(:disabled), input") ?? [])];
    const i = all.indexOf(el!.ownerDocument.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (i + 1) % all.length : (i - 1 + all.length) % all.length;
    all[next]?.focus();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="rail-menu" role="menu" aria-label={label} tabindex="-1" data-command-scope="plots-rail" bind:this={el} style={`left:${left}px; top:${top}px; min-width:${minWidth}px`} onkeydown={onKey} data-plots-rail-menu>
  {#each items as item, i (i)}
    {#if item.kind === "separator"}
      <div class="sep" role="separator"></div>
    {:else if item.kind === "heading"}
      <div class="heading">{item.label}</div>
    {:else if item.kind === "slider"}
      <label class="slider" title={item.hint}><span>{item.label}</span><input type="range" min={item.min} max={item.max} step={item.step} value={item.value} aria-label={item.label} oninput={(e) => { const v = Number((e.currentTarget as HTMLInputElement).value); live[i] = v; item.set(v); }} /><output>{live[i] ?? item.value}{item.unit ?? ""}</output></label>
    {:else}
      <button
        role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
        aria-checked={item.checked === undefined ? undefined : item.checked}
        class:danger={item.danger}
        disabled={item.disabled}
        onclick={() => { item.run(); onClose(); }}>
        <span class="check" aria-hidden="true">{item.checked ? "✓" : ""}</span>
        <span class="label">{item.label}</span>
        {#if item.hint}<span class="hint">{item.hint}</span>{/if}
      </button>
    {/if}
  {/each}
</div>

<style>
  .rail-menu { position: fixed; z-index: 340; display: flex; flex-direction: column; padding: 4px 0; background: var(--c-surface); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); box-shadow: var(--elev-2); font: 12px var(--font-ui); color: var(--c-tx); outline: none; max-height: calc(100vh - 8px); overflow-y: auto; }
  button { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px 0 4px; border: 0; background: none; color: inherit; font: inherit; text-align: left; white-space: nowrap; cursor: var(--cursor-cross-hover); }
  button:hover:not(:disabled), button:focus-visible { background: var(--c-accent-tint); color: var(--c-tx-hi); outline: none; }
  button:disabled { opacity: .45; cursor: var(--cursor-cross); }
  .danger { color: var(--c-danger); }
  .check { width: 14px; flex: 0 0 14px; text-align: center; color: var(--c-accent); font-size: 11px; }
  .label { flex: 1; }
  .hint { color: var(--c-tx-faint); font: 10.5px var(--font-mono); padding-left: 16px; }
  .heading { padding: 6px 10px 2px 24px; color: var(--c-tx-muted); font: 600 10px var(--font-mono); letter-spacing: .08em; text-transform: uppercase; }
  .sep { height: 1px; margin: 4px 0; background: var(--c-line); }
  .slider { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px 0 24px; color: var(--c-tx-2); white-space: nowrap; }
  .slider input { flex: 1; min-width: 80px; accent-color: var(--c-accent); }
  .slider output { min-width: 40px; text-align: right; color: var(--c-tx-faint); font: 10.5px var(--font-mono); }
</style>
