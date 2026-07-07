<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import TitleBar from "./TitleBar.svelte";
  import Home from "./Home.svelte";
  import Workspace from "./Workspace.svelte";
  import Toasts from "./Toasts.svelte";
  import { view } from "./shellStore";
  import { DUR } from "../lib/motion/tokens";
  import { get } from "svelte/store";
  import { fileBridge } from "../lib/project/types";
  import { pushToast, type ToastLevel } from "../lib/toast";
  import { settings } from "../lib/settings";
  import { installLifecycle } from "./lifecycle";
  import { warmModes, ALL_MODES } from "./modeRegistry";
  import { addUrlOrDoiToLibrary } from "./modes/paper/scholar/bibLoad";
  import { pdfFetchJob } from "../lib/references/pdfFetchJob.svelte";
  import { assignJob } from "../lib/references/assignJob.svelte";

  // Web capture (flux://): the main process delivers { doi?, url? } here regardless
  // of the active mode/view — we add it to the global FluxLib and toast the result.
  let capture = $state<{ kind: "busy" | "ok" | "err"; msg: string } | null>(null);
  let captureTimer: ReturnType<typeof setTimeout> | undefined;

  function showCapture(kind: "busy" | "ok" | "err", msg: string, ttl = 0) {
    capture = { kind, msg };
    clearTimeout(captureTimer);
    if (ttl) captureTimer = setTimeout(() => (capture = null), ttl);
  }

  async function onCapturePayload(payload: { doi?: string; url?: string }) {
    const input = (payload?.doi || payload?.url || "").trim();
    if (!input) return;
    showCapture("busy", "Adding to FluxLib…");
    const r = await addUrlOrDoiToLibrary(input);
    if ("error" in r) showCapture("err", r.error || "Couldn't add that paper.", 4200);
    else showCapture("ok", `Added “${r.title || r.key}” to FluxLib ✓`, 3200);
  }

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
    warmModes(["paper"]); // the default first mode — ready before Home → Workspace
    // In Electron the preload sets window.fig before this runs; under the dev
    // fixture it can arrive a beat late, so retry briefly until the bridge appears.
    let unsub: (() => void) | undefined;
    let unsubErr: (() => void) | undefined;
    let tries = 0;
    function attach() {
      const fb = fileBridge();
      if (fb?.onCapture) {
        unsub = fb.onCapture(onCapturePayload);
        // Main-process failures (watcher death, spawn errors) surface as toasts
        // instead of dying in the main console (V1 review, W1).
        unsubErr = fb.onAppError?.((p: { level?: string; msg: string; detail?: string }) =>
          pushToast((p.level as ToastLevel) || "error", p.msg, { detail: p.detail }),
        );
        void maybeCheckForUpdate(); // packaged-only, throttled; no-op in dev
      } else if (tries++ < 40) {
        setTimeout(attach, 100);
      }
    }
    attach();
    return () => {
      unsub?.();
      unsubErr?.();
    };
  });
</script>

<div class="shell">
  <TitleBar />
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
