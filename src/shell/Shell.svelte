<script lang="ts">
  import { onMount } from "svelte";
  import { fade } from "svelte/transition";
  import TitleBar from "./TitleBar.svelte";
  import Home from "./Home.svelte";
  import Workspace from "./Workspace.svelte";
  import { view } from "./shellStore";
  import { DUR } from "../lib/motion/tokens";
  import { fileBridge } from "../lib/project/types";
  import { addUrlOrDoiToLibrary } from "./modes/paper/scholar/bibLoad";

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

  onMount(() => {
    // In Electron the preload sets window.fig before this runs; under the dev
    // fixture it can arrive a beat late, so retry briefly until the bridge appears.
    let unsub: (() => void) | undefined;
    let tries = 0;
    function attach() {
      const fb = fileBridge();
      if (fb?.onCapture) {
        unsub = fb.onCapture(onCapturePayload);
      } else if (tries++ < 40) {
        setTimeout(attach, 100);
      }
    }
    attach();
    return () => unsub?.();
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
</style>
