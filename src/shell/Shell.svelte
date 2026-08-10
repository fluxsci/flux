<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import TitleBar from "./TitleBar.svelte";
  import Home from "./Home.svelte";
  import Workspace from "./Workspace.svelte";
  import Toasts from "./Toasts.svelte";
  import SyncConflicts from "./SyncConflicts.svelte";
  import Help from "../lib/Help.svelte";
  import { view } from "./shellStore";
  import { DUR } from "../lib/motion/tokens";
  import { get } from "svelte/store";
  import { fileBridge } from "../lib/project/types";
  import { pushToast, type ToastLevel } from "../lib/toast";
  import { settings } from "../lib/settings";
  import { installLifecycle } from "./lifecycle";
  import { warmModes, ALL_MODES } from "./modeRegistry";
  // (bibLoad is dynamic-imported in onCapturePayload — a static edge from the
  // eager Shell chained the whole paper/scholar stack into Home; W15 gate.)
  import { pdfFetchJob } from "../lib/references/pdfFetchJob.svelte";
  import { assignJob } from "../lib/references/assignJob.svelte";
  import { captureStatus } from "../lib/references/captureStatus";
  import { captureIntakeOnStartup } from "../lib/references/captureIntake.svelte";

  // Web capture: the bookmarklet downloads a file, the capture watcher files it, and the
  // result surfaces HERE — shell-level, so it shows in any mode and even on Home (a capture
  // can land while you're writing). captureIntake owns the state; this only renders it.
  let capture = $state<{ kind: "busy" | "ok" | "err"; msg: string } | null>(null);
  $effect(() => captureStatus.subscribe((v) => (capture = v)));

  // 5.3 update check: packaged builds ping GitHub for a newer release at most once a
  // day; the opt-out lives here (settings.updateCheck), main owns the throttle/fetch.
  // Best-effort — a sticky info toast with a Download action, never blocks startup.
  async function maybeCheckForUpdate() {
    try {
      if (!get(settings).updateCheck) return; // user opted out in Settings
      const u = await fileBridge()?.checkForUpdate?.();
      if (!u) return; // dev / non-packaged / throttled / already current
      pushToast("info", `Flux ${u.version} is available`, {
        ttl: 0, // sticky: the daily throttle + newer-only guard mean it won't nag
        action: { label: "Download", run: () => void fileBridge()?.openExternal?.(u.url) },
      });
    } catch {
      /* update check is best-effort; swallow everything */
    }
  }

  // W15: the workspace opens in paper mode — warm its chunk while the user is
  // still on Home so the first entry is instant; once the workspace is showing,
  // prefetch the remaining modes during idle time.
  $effect(() => {
    if ($view !== "home") warmModes(ALL_MODES);
  });

  onMount(() => {
    installLifecycle(); // W5: consolidated beforeunload + quit-flush answering
    // W15: warm paper (the default first mode) during Home IDLE — after first
    // paint, so the 920KB chunk never competes with Home interactivity (the
    // startup gate snapshots at .wordmark and asserts no mode chunk landed).
    const idle: (fn: () => void) => void =
      typeof requestIdleCallback === "function" ? (fn) => requestIdleCallback(fn) : (fn) => void setTimeout(fn, 250);
    idle(() => warmModes(["paper"]));
    // Zotero startup sync (2026-07-29): pull anything new from the connected BBT
    // auto-export once the app is idle. Dynamic import — the job (and, through it,
    // the bib/import stack) must never ride the eager Home bundle (W15).
    idle(() => {
      void import("../lib/references/zoteroSyncJob.svelte").then(({ zoteroSyncJob }) => zoteroSyncJob.maybeAutoSync());
    });
    // In Electron the preload sets window.fig before this runs; under the dev
    // fixture it can arrive a beat late, so retry briefly until the bridge appears.
    let unsub: (() => void) | undefined;
    let tries = 0;
    function attach() {
      const fb = fileBridge();
      if (fb?.onAppError) {
        // Main-process failures (watcher death, spawn errors) surface as toasts
        // instead of dying in the main console (V1 review, W1).
        unsub = fb.onAppError((p: { level?: string; msg: string; detail?: string }) =>
          pushToast((p.level as ToastLevel) || "error", p.msg, { detail: p.detail }),
        );
        void maybeCheckForUpdate(); // packaged-only, throttled; no-op in dev
        // Web capture: pull in anything captured while Flux was closed. The only other pull is
        // the Library's Assign button — never on focus, never on a watcher event.
        captureIntakeOnStartup();
      } else if (tries++ < 40) {
        setTimeout(attach, 100);
      }
    }
    attach();
    return () => {
      unsub?.();
    };
  });
</script>

<div class="shell">
  <TitleBar />
  <!-- Sync conflicts: shell-level so the banner shows in every mode, and directly under
       the title bar so it reads as a condition of the window rather than of one pane. -->
  <SyncConflicts />
  <div class="shell-body">
    {#if $view === "home"}
      <div
        class="surface"
        in:fade={{ duration: DUR.gentle }}
        out:fade={{ duration: DUR.quick }}>
        <Home />
      </div>
    {:else}
      <div
        class="surface"
        in:fade={{ duration: DUR.gentle }}
        out:fade={{ duration: DUR.quick }}>
        <Workspace />
      </div>
    {/if}
  </div>

  <Toasts raised={capture !== null} />

  <!-- Keyboard reference: mounted at the Shell so "?" works on Home too, not
       just inside a project (its own listener ignores typing targets). -->
  <Help />

  {#if capture}
    <div
      class="capture-toast"
      class:err={capture.kind === "err"}
      class:ok={capture.kind === "ok"}
      role="status"
      transition:fade={{ duration: DUR.quick }}>
      {capture.msg}
    </div>
  {/if}

  <!-- Global PDF-fetch progress chip: a bulk "Get all PDFs" run lives in a module-level job,
       so it keeps going (and stays visible + cancellable) in every mode, not just Library. -->
  {#if pdfFetchJob.running}
    <div class="fetch-chip" role="status" transition:fade={{ duration: DUR.quick }}>
      <span class="fc-spin" aria-hidden="true"></span>
      <span class="fc-label"
        >{pdfFetchJob.phase === "proxy" ? "Library PDFs" : "PDFs"}
        {pdfFetchJob.done}/{pdfFetchJob.total}</span>
      <button class="fc-cancel" title="Stop fetching" onclick={() => pdfFetchJob.cancel()}>✕</button>
    </div>
  {/if}

  <!-- Global "Assign PDFs" progress chip — the inbox scan is also a module-level job. -->
  {#if assignJob.running}
    <div class="fetch-chip" role="status" transition:fade={{ duration: DUR.quick }}>
      <span class="fc-spin" aria-hidden="true"></span>
      <span class="fc-label">Assigning {assignJob.done}/{assignJob.total}</span>
      <button class="fc-cancel" title="Stop assigning" onclick={() => assignJob.cancel()}>✕</button>
    </div>
  {/if}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    background: var(--c-bg);
  }
  .shell-body {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .surface {
    position: absolute;
    inset: 0;
  }
  /* Global web-capture toast — mirrors PaperMode's .doi-toast, but shell-level so it
     shows in any mode and even on Home. */
  .capture-toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    z-index: 200;
    padding: 9px 18px;
    border-radius: var(--r-pill);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    color: var(--c-tx);
    font-size: var(--ts-sm);
    box-shadow: var(--elev-2);
    max-width: 70vw;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .capture-toast.ok {
    border-color: var(--c-accent-bright);
  }
  .capture-toast.err {
    border-color: var(--c-danger);
  }
  /* Global fetch-progress chip, pinned bottom-right (clear of the centered capture toast). */
  .fetch-chip {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 200;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 10px 7px 12px;
    border-radius: var(--r-pill);
    background: var(--c-surface);
    border: 1px solid var(--c-accent);
    color: var(--c-tx);
    font-size: var(--ts-sm);
    box-shadow: var(--elev-2);
  }
  .fc-spin {
    width: 12px;
    height: 12px;
    border: 2px solid var(--c-line-strong);
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: fc-spin 0.8s linear infinite;
  }
  @keyframes fc-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .fc-label {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .fc-cancel {
    border: none;
    background: transparent;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 0 2px;
    line-height: 1;
  }
  .fc-cancel:hover {
    color: var(--c-danger);
  }
</style>
