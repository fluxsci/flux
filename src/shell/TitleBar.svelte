<script lang="ts">
  import { onMount } from "svelte";
  import Logomark from "./Logomark.svelte";
  import Icon from "./Icon.svelte";
  import { currentProject, goHome, view, type ModeId } from "./shellStore";
  import { focusedMode, setFocusedMode, splitWith } from "./paneStore";
  import { helpOpen, settingsOpen } from "../lib/settings";
  import { dirtyPulse } from "../lib/autosave";
  import { anyDirty } from "./lifecycle";
  import { fileBridge } from "../lib/project/types";
  import { pushToast } from "../lib/toast";

  const fig = fileBridge();
  const win = fig?.win;
  // On macOS we defer to the native traffic-light controls (see main.cjs
  // titleBarStyle:"hidden"), so we hide our custom min/max/close buttons there.
  const isMac = fig?.platform === "darwin";

  // The five modes, in strip order (Ctrl+1…Ctrl+5 follows this order too).
  const modes: { id: ModeId; label: string; icon: string }[] = [
    { id: "figure", label: "Figure", icon: "figure" },
    { id: "paper", label: "Paper", icon: "paper" },
    { id: "slide", label: "Slide", icon: "slide" },
    { id: "library", label: "Library", icon: "library" },
    { id: "reader", label: "Reader", icon: "reader" },
  ];

  const activeIndex = $derived(modes.findIndex((m) => m.id === $focusedMode));

  function pick(e: MouseEvent, mode: ModeId) {
    if (e.altKey || e.metaKey) splitWith(mode);
    else setFocusedMode(mode);
  }

  // Launch the Lighttable sidecar app (a separate image-set viewer — no
  // project integration; the main process just spawns it).
  async function launchLighttable() {
    const res = await fileBridge()?.launchLighttable?.();
    if (res && !res.ok) pushToast("error", "Could not launch Lighttable", { detail: res.error });
  }

  // Open the user documentation (the rendered docs/ site) in the OS browser.
  async function openDocs() {
    const res = await fileBridge()?.openDocs?.();
    if (res && !res.ok) pushToast("error", "Could not open the docs", { detail: res.error });
  }

  let maximized = $state(false);

  // SHL-12: a dirty indicator. Re-evaluate the flush registry whenever any autosave controller
  // changes status (dirtyPulse), and mirror it to the OS window (macOS close-button dot).
  let dirty = $state(false);
  $effect(() => {
    void $dirtyPulse;
    dirty = anyDirty();
    win?.setDocumentEdited?.(dirty);
  });

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
    <Logomark size={22} />
    <span class="wordmark">Flux</span>
  </button>

  {#if $view === "workspace" && $currentProject}
    <span class="divider" aria-hidden="true"></span>
    <span class="project">{$currentProject.name}</span>
    {#if dirty}<span class="dirtydot" title="Unsaved changes" aria-label="Unsaved changes">●</span>{/if}

    <nav class="modestrip no-drag" aria-label="Modes" style="--mi:{activeIndex}">
      <span class="mindicator" class:hidden={activeIndex < 0} aria-hidden="true"></span>
      {#each modes as m, i (m.id)}
        <button
          class="mbtn"
          class:active={$focusedMode === m.id}
          title={`${m.label} — Ctrl+${i + 1}  (Alt-click to split)`}
          aria-label={m.label}
          aria-current={$focusedMode === m.id}
          onclick={(e) => pick(e, m.id)}>
          <Icon name={m.icon} size={19} />
        </button>
      {/each}
    </nav>
  {/if}

  <div class="spacer"></div>

  <!-- Utility strip: deliberately smaller + fainter than the mode strip (the
       "secondary chrome" register), and available on Home too. -->
  <div class="utils no-drag">
    <button class="ubtn" title="Lighttable — browse image sets" aria-label="Lighttable" onclick={launchLighttable}>
      <Icon name="lighttable" size={17} />
    </button>
    <button class="ubtn" title="Documentation — the Flux user guide" aria-label="Documentation" onclick={openDocs}>
      <Icon name="bookText" size={17} />
    </button>
    <button class="ubtn" title="Settings" aria-label="Settings" onclick={() => settingsOpen.set(true)}>
      <Icon name="settings" size={17} />
    </button>
    <button class="ubtn" title="Keyboard shortcuts  (?)" aria-label="Keyboard shortcuts" onclick={() => helpOpen.set(true)}>
      <Icon name="help" size={17} />
    </button>
  </div>

  {#if win && !isMac}
    <span class="divider" aria-hidden="true"></span>
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

  .titlebar button:focus-visible {
    outline: 2px solid var(--c-accent);
    outline-offset: -2px;
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
    flex: 0 0 auto;
  }
  .project {
    font-size: var(--ts-sm);
    color: var(--c-tx-muted);
    letter-spacing: 0.01em;
    max-width: 220px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dirtydot {
    margin-left: 6px;
    font-size: 10px;
    line-height: 1;
    color: var(--c-warning, #d0a215);
    transform: translateY(-1px);
  }

  /* ---- mode strip (the former activity rail, gone horizontal) ------------ */
  .modestrip {
    position: relative;
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: var(--sp-2);
  }
  .mbtn {
    width: 32px;
    height: 28px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    border-radius: var(--r-1);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard),
      transform var(--dur-instant) var(--ease-standard);
  }
  .mbtn:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
  }
  .mbtn:active {
    transform: scale(0.92);
  }
  .mbtn.active {
    color: var(--c-accent-bright);
    background: var(--c-accent-tint-2);
  }

  /* Sliding accent marker — the horizontal twin of the old rail indicator
     (Tier-1 transform, style_principles.md P5). Hugs the titlebar's bottom
     border. Button stride = 32 width + 2 gap = 34; centred: (32-18)/2 = 7. */
  .mindicator {
    position: absolute;
    left: 7px;
    bottom: 0;
    width: 18px;
    height: 2px;
    border-radius: var(--r-pill);
    background: var(--c-accent);
    box-shadow: 0 0 10px var(--c-accent-glow);
    transform: translateX(calc(var(--mi) * 34px));
    transition: transform var(--dur-quick) var(--ease-standard);
  }
  .mindicator.hidden {
    opacity: 0;
  }

  .spacer {
    flex: 1 1 auto;
  }

  /* ---- utility strip (secondary register) -------------------------------- */
  .utils {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .ubtn {
    width: 28px;
    height: 24px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-faint);
    border-radius: var(--r-1);
    cursor: pointer;
    transition:
      background var(--dur-instant) var(--ease-standard),
      color var(--dur-instant) var(--ease-standard);
  }
  .ubtn:hover {
    background: var(--c-ui-hover);
    color: var(--c-tx);
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
    color: var(--flx-red-200); /* gentle, not alarming */
  }
</style>
