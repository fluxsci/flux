<script lang="ts" module>
  /** One export, from the press of Export to the file on disk (or the reason there is none). */
  export interface ExportRun {
    id: number;
    /** "PDF", "Word", "HTML" */
    label: string;
    /** The file being written (name only) and its full path. */
    file: string;
    outPath: string;
    state: "running" | "done" | "failed" | "cancelled";
    /** The stages this export goes through, and the one it is in. */
    steps: readonly string[];
    step: number;
    /** The engine's last line (Quarto streams its log), when there is one. */
    log: string;
    startedAt: number;
    endedAt?: number;
    cancellable: boolean;
    cancelling?: boolean;
    /** Appended to the success line, e.g. "12 live citations". */
    note?: string;
    /** Things worth knowing that did not stop the export. */
    warnings: string[];
    error?: { title: string; detail?: string };
  }
</script>

<script lang="ts">
  // The export receipt: ONE place that says what an export is doing and how it ended.
  //
  // It replaces three notices that used to overlap (owner, 2026-11-18: "I hate the little
  // popups that happen in the bottom right, they are ugly and confusing"): a progress card
  // that sat on the dynamic margin's corner, an "Exported ✓" pill, and a shell toast saying the
  // same thing in the same spot. The receipt rises from the status bar's Export button (where
  // the export was asked for), names the stage it is in, and stays there to become the result:
  // the file with Reveal and Open, or the failure with its reason and the engine's log.
  import { onDestroy } from "svelte";

  let {
    run,
    onCancel,
    onReveal,
    onOpen,
    onDismiss,
  }: {
    run: ExportRun;
    onCancel: () => void;
    onReveal?: (path: string) => void;
    onOpen?: (path: string) => void;
    onDismiss: () => void;
  } = $props();

  // Elapsed seconds while it runs (a 1 s tick that exists only for the length of an export).
  let now = $state(Date.now());
  let tick: ReturnType<typeof setInterval> | undefined;
  $effect(() => {
    clearInterval(tick);
    if (run.state === "running") tick = setInterval(() => (now = Date.now()), 1000);
  });
  const seconds = $derived(Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000)));
  const took = $derived(seconds < 1 ? "under a second" : seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`);

  // A finished receipt lingers long enough to act on, and waits while the pointer or the
  // keyboard is on it. A failure stays until it is dismissed.
  let held = $state(false);
  let leave: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    clearTimeout(leave);
    const rest = run.state === "done" ? (run.warnings.length ? 12000 : 7000) : run.state === "cancelled" ? 2600 : 0;
    if (rest && !held) leave = setTimeout(onDismiss, rest);
  });
  onDestroy(() => {
    clearInterval(tick);
    clearTimeout(leave);
  });

  let showDetail = $state(false);
  let copied = $state(false);
  async function copyDetail() {
    try {
      await navigator.clipboard.writeText(`${run.error?.title ?? ""}\n\n${run.error?.detail ?? ""}`.trim());
      copied = true;
      setTimeout(() => (copied = false), 1400);
    } catch {
      /* the clipboard can refuse; the text stays selectable */
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="receipt ts-scaled"
  data-export-receipt
  data-state={run.state}
  role={run.state === "failed" ? "alert" : "status"}
  aria-live="polite"
  onpointerenter={() => (held = true)}
  onpointerleave={() => (held = false)}
  onfocusin={() => (held = true)}
  onfocusout={() => (held = false)}>
  <div class="line">
    <span class="mark" aria-hidden="true">
      {#if run.state === "running"}
        <svg class="spin" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" /><path d="M8 2a6 6 0 0 1 6 6" /></svg>
      {:else if run.state === "done"}
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>
      {:else if run.state === "failed"}
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 3.2v6M8 12.2v.6" /></svg>
      {:else}
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 8h8" /></svg>
      {/if}
    </span>
    <div class="what">
      <div class="head">
        {#if run.state === "running"}Exporting {run.label}
        {:else if run.state === "done"}Exported
        {:else if run.state === "failed"}{run.error?.title ?? `${run.label} export failed`}
        {:else}Export cancelled{/if}
      </div>
      {#if run.state !== "cancelled"}
        <div class="file" title={run.outPath}>{run.file}{#if run.state === "done" && run.note}<span class="note"> · {run.note}</span>{/if}</div>
      {/if}
    </div>
    {#if run.state === "running"}
      <span class="time">{seconds} s</span>
      {#if run.cancellable}
        <button class="rbtn" disabled={run.cancelling} onclick={onCancel}>{run.cancelling ? "Cancelling…" : "Cancel"}</button>
      {/if}
    {:else}
      {#if run.state === "done"}
        {#if onOpen}<button class="rbtn" onclick={() => onOpen?.(run.outPath)} title="Open the file in its application">Open</button>{/if}
        {#if onReveal}<button class="rbtn" onclick={() => onReveal?.(run.outPath)} title="Show the file in its folder">Reveal</button>{/if}
      {:else if run.state === "failed" && run.error?.detail}
        <button class="rbtn" aria-expanded={showDetail} onclick={() => (showDetail = !showDetail)}>{showDetail ? "Hide details" : "Details"}</button>
      {/if}
      <button class="rx" onclick={onDismiss} aria-label="Dismiss" title="Dismiss">
        <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg>
      </button>
    {/if}
  </div>

  {#if run.state === "running"}
    <ol class="steps" aria-label="Export stages">
      {#each run.steps as name, i (name)}
        <li class:past={i < run.step} class:now={i === run.step} aria-current={i === run.step ? "step" : undefined}>{name}</li>
      {/each}
    </ol>
    <div class="bar" aria-hidden="true"><i></i></div>
    {#if run.log}<div class="log" title={run.log}>{run.log}</div>{/if}
  {:else if run.state === "done"}
    <div class="sub">in {took}{#if run.warnings.length} · {run.warnings.length} note{run.warnings.length === 1 ? "" : "s"}{/if}</div>
    {#if run.warnings.length}
      <ul class="notes">
        {#each run.warnings as w (w)}<li>{w}</li>{/each}
      </ul>
    {/if}
  {:else if run.state === "failed"}
    {#if run.error?.detail && !showDetail}
      <div class="sub reason">{run.error.detail.split("\n")[0]}</div>
    {/if}
    {#if showDetail && run.error?.detail}
      <!-- focusable so a long log can be scrolled and selected from the keyboard -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre class="detail" tabindex="0">{run.error.detail}</pre>
      <div class="tools"><button class="rbtn" onclick={copyDetail}>{copied ? "Copied" : "Copy"}</button></div>
    {/if}
  {/if}
</div>

<style>
  /* Chrome inside a scaled panel opts back out of the text-size slider (like the status bar). */
  .receipt {
    --ts-scale: 1;
    --tone: var(--c-accent);
    position: absolute;
    z-index: 6;
    right: 18px;
    bottom: 96px;
    width: min(400px, calc(100% - 36px));
    box-sizing: border-box;
    display: grid;
    gap: 8px;
    padding: 11px 12px 12px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-2);
    background: var(--flx-paper);
    box-shadow:
      inset 3px 0 0 var(--tone),
      0 14px 34px -14px rgba(40, 30, 10, 0.5),
      0 3px 8px -3px rgba(40, 30, 10, 0.25);
    color: var(--c-tx);
    font-family: var(--font-serif);
    font-size: 12.5px;
    animation: receipt-in var(--dur-fade-slow) var(--ease-enter) both;
  }
  .receipt[data-state="done"] {
    --tone: var(--c-success);
  }
  .receipt[data-state="failed"] {
    --tone: var(--c-danger);
    width: min(460px, calc(100% - 36px));
  }
  .receipt[data-state="cancelled"] {
    --tone: var(--c-tx-faint);
  }
  @keyframes receipt-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
  .line {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding-left: 4px;
  }
  .mark {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: color-mix(in oklab, var(--tone) 13%, transparent);
    color: var(--tone);
  }
  .mark svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .spin circle {
    opacity: 0.22;
  }
  .spin {
    animation: receipt-spin 900ms linear infinite;
  }
  @keyframes receipt-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .what {
    flex: 1 1 auto;
    min-width: 0;
    display: grid;
    gap: 1px;
  }
  .head {
    font-weight: 600;
    color: var(--c-tx-hi);
    line-height: 1.25;
  }
  .file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 11px/1.35 var(--font-mono);
    color: var(--c-tx-muted);
  }
  .note {
    font-family: var(--font-serif);
    font-style: italic;
  }
  .time {
    flex: 0 0 auto;
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--c-tx-faint);
  }
  .rbtn {
    flex: 0 0 auto;
    height: 24px;
    padding: 0 9px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx-2);
    font: 600 11px var(--font-serif);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      color 80ms linear,
      border-color 80ms linear,
      transform 60ms linear;
  }
  .rbtn:hover:not(:disabled) {
    background: color-mix(in oklab, var(--tone) 9%, transparent);
    border-color: color-mix(in oklab, var(--tone) 45%, var(--c-line-strong));
    color: var(--c-tx);
  }
  .rbtn:active:not(:disabled) {
    transform: translateY(0.5px) scale(0.985);
  }
  .rbtn:disabled {
    opacity: 0.5;
    cursor: var(--cursor-cross);
  }
  .rx {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--r-1);
    background: transparent;
    color: var(--c-tx-faint);
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      color 80ms linear;
  }
  .rx svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  .rx:hover {
    background: var(--c-ui);
    color: var(--c-tx);
  }
  .rbtn:focus-visible,
  .rx:focus-visible,
  .detail:focus-visible {
    outline: 2px solid var(--tone);
    outline-offset: 1px;
  }
  /* The stages, in order: done ones recede, the current one is named in the tone. */
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 0;
    margin: 0;
    padding: 0 0 0 35px;
    list-style: none;
    font: 600 9.5px/1.3 var(--font-mono);
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--c-tx-faint);
  }
  .steps li + li::before {
    content: "›";
    margin: 0 6px;
    color: var(--c-line-strong);
    font-weight: 400;
  }
  .steps li.past {
    color: var(--c-tx-muted);
  }
  .steps li.now {
    color: var(--tone);
  }
  .bar {
    position: relative;
    height: 2px;
    margin-left: 35px;
    border-radius: 1px;
    background: var(--c-line);
    overflow: hidden;
  }
  .bar i {
    position: absolute;
    inset: 0;
    width: 34%;
    border-radius: 1px;
    background: var(--tone);
    animation: receipt-run 1250ms cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }
  @keyframes receipt-run {
    from {
      transform: translateX(-105%);
    }
    to {
      transform: translateX(300%);
    }
  }
  .log,
  .sub {
    margin-left: 35px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--c-tx-faint);
  }
  .log {
    font: 10.5px/1.35 var(--font-mono);
  }
  .sub {
    font-size: 11px;
    font-style: italic;
    margin-top: -4px;
  }
  .sub.reason {
    color: var(--c-tx-2);
    font-style: normal;
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
  }
  .notes {
    display: grid;
    gap: 3px;
    margin: 0 0 0 35px;
    padding: 0 0 0 14px;
    color: var(--c-tx-2);
    font-size: 11px;
    line-height: 1.4;
  }
  .detail {
    max-height: 190px;
    margin: 0 0 0 35px;
    padding: 8px 9px;
    overflow: auto;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-1);
    background: var(--c-surface);
    color: var(--c-tx-2);
    font: 10.5px/1.5 var(--font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    scrollbar-width: thin;
    user-select: text;
  }
  .tools {
    display: flex;
    justify-content: flex-end;
  }
</style>
