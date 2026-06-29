<script lang="ts">
  import { onMount } from "svelte";
  import Logomark from "./Logomark.svelte";
  import Icon from "./Icon.svelte";
  import { currentProject, goHome, view } from "./shellStore";

  interface WinBridge {
    minimize: () => void;
    maximizeToggle: () => Promise<boolean> | void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (v: boolean) => void) => () => void;
  }
  const fig = (window as unknown as { fig?: { win?: WinBridge; platform?: string } }).fig;
  const win = fig?.win;
  // On macOS we defer to the native traffic-light controls (see main.cjs
  // titleBarStyle:"hidden"), so we hide our custom min/max/close buttons there.
  const isMac = fig?.platform === "darwin";

  let maximized = $state(false);

  onMount(() => {
    if (!win) return;
    win.isMaximized().then((v) => (maximized = v));
    const off = win.onMaximizeChange((v) => (maximized = v));
    return off;
  });

  function onDblClick() {
    win?.maximizeToggle();
  }
</script>

<header
  class="titlebar"
  class:mac={isMac}
  role="toolbar"
  tabindex="-1"
  aria-label="Window title bar"
  ondblclick={onDblClick}>
  <button class="brand no-drag" onclick={goHome} title="Flux — Home">
    <Logomark size={46} />
    <span class="wordmark">Flux</span>
  </button>

  {#if $view === "workspace" && $currentProject}
    <span class="divider" aria-hidden="true"></span>
    <span class="project">{$currentProject.name}</span>
  {/if}

  <div class="spacer"></div>

  {#if win && !isMac}
    <div class="winctl no-drag">
      <button class="wc" title="Minimize" onclick={() => win.minimize()}>
        <Icon name="min" size={15} stroke={1.6} />
      </button>
      <button
        class="wc"
        title={maximized ? "Restore" : "Maximize"}
        onclick={() => win.maximizeToggle()}>
        <Icon name={maximized ? "restore" : "max"} size={14} stroke={1.6} />
      </button>
      <button class="wc close" title="Close" onclick={() => win.close()}>
        <Icon name="x" size={15} stroke={1.6} />
      </button>
    </div>
  {/if}
</header>

<style>
  .titlebar {
    height: var(--titlebar-h);
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 0 var(--sp-2) 0 var(--sp-3);
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
    -webkit-app-region: drag;
    user-select: none;
  }
  /* macOS: leave room on the left for the native traffic-light controls. */
  .titlebar.mac {
    padding-left: 76px;
  }
  .no-drag {
    -webkit-app-region: no-drag;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    height: 26px;
    padding: 0 var(--sp-2);
    border: none;
    background: transparent;
    border-radius: var(--r-1);
    cursor: pointer;
    transition: background var(--dur-instant) var(--ease-standard);
  }
  .brand:hover {
    background: var(--c-ui-hover);
  }
  .wordmark {
    font-family: var(--font-serif);
    font-size: var(--ts-md);
    font-weight: 600;
    letter-spacing: var(--tracking-tight);
    color: var(--c-tx-hi);
  }

  .divider {
    width: 1px;
    height: 16px;
    background: var(--c-line-strong);
  }
  .project {
    font-size: var(--ts-sm);
    color: var(--c-tx-muted);
    letter-spacing: 0.01em;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .winctl {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .wc {
    width: 34px;
    height: 26px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    border-radius: var(--r-1);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard);
  }
  .wc:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .wc.close:hover {
    background: color-mix(in oklab, var(--flx-base-200) 8%, transparent);
    color: #f89a8a; /* flexoki red-200 — gentle, not alarming */
  }
</style>
