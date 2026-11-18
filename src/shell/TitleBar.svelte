<script lang="ts">
  import { inboxCount, inboxNeedsInput, requestInbox } from "./inbox/inboxState";
  import { onMount } from "svelte";
  import Logomark from "./Logomark.svelte";
  import Icon from "./Icon.svelte";
  import { currentProject, goHome, view, type ModeId } from "./shellStore";
  import { focusedMode, setFocusedMode, splitWith } from "./paneStore";
  import { MODE_LABEL, MODE_ORDER } from "./modeOrder";
  import { docsTarget, openDocs } from "./docsLink";
  import { helpOpen, settingsOpen } from "../lib/settings";
  import { dirtyPulse } from "../lib/autosave";
  import { anyDirty } from "./lifecycle";
  import { fileBridge } from "../lib/project/types";
  import { pushToast } from "../lib/toast";
  import { lastAgentView } from "../lib/bridge/liveView";
  import { aiColor, aiOpen, openAI } from "./agent/aiMonitorState";
  import { sessions } from "./agent/sessionState";
  let agentsOpen = $state(false);
  let AgentsPopover = $state<typeof import("./agent/AgentsPopover.svelte").default>();
  async function toggleAgents() {
    agentsOpen = !agentsOpen;
    if (agentsOpen && !AgentsPopover) AgentsPopover = (await import("./agent/AgentsPopover.svelte")).default;
  }
  $effect(() => {
    const root = $currentProject?.path;
    agentsOpen = false;
    if (!root) return;
    let active = true, release: (() => void) | undefined;
    void import("./agent/annotationStore").then(m => { if (active) release = m.retainPresence(); });
    return () => { active = false; release?.(); };
  });
  $effect(() => { if (!$sessions.length) agentsOpen = false; });
  const fig = fileBridge();
  const win = fig?.win;
  // On macOS we defer to the native traffic-light controls (see main.cjs
  // titleBarStyle:"hidden"), so we hide our custom min/max/close buttons there.
  const isMac = fig?.platform === "darwin";

  // The five modes, in strip order (Ctrl+1…Ctrl+5 follows the same list). Each mode's icon
  // is named after its id (Icon.svelte).
  const modes: { id: ModeId; label: string; icon: string }[] = MODE_ORDER.map((id) => ({ id, label: MODE_LABEL[id], icon: id }));

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

  // The Docs button opens the guide's page for where you are: the focused mode in a project,
  // the guide's start on Home (docsLink.ts; the copy inside the app when offline).
  const docs = $derived(docsTarget({ view: $view, mode: $focusedMode }));

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
  <!-- Three tracks: the two sides are equal, so the mode strip between them is the middle of
       the WINDOW whatever either side holds (see the grid note in the styles). -->
  <div class="side left">
    <button class="brand no-drag" onclick={goHome} title="Flux — Home">
      <Logomark size={22} />
      <span class="wordmark">Flux</span>
    </button>
    {#if $view === "workspace" && $currentProject}
      <span class="divider" aria-hidden="true"></span>
      <span class="project">{$currentProject.name}</span>
      {#if dirty}<span class="dirtydot" title="Unsaved changes" aria-label="Unsaved changes">●</span>{/if}
    {/if}
  </div>

  <div class="middle">
  {#if $view === "workspace" && $currentProject}
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
  </div>

  <div class="side right">
  {#if $lastAgentView}
    <span class="agent-view" role="status" title={`${$lastAgentView.name} viewed your window`}>◉ {$lastAgentView.name} viewed your window</span>
  {/if}

  <!-- Utility strip: deliberately smaller + fainter than the mode strip (the
       "secondary chrome" register), and available on Home too. -->
  <div class="utils no-drag">
    {#if $view === "workspace" && $currentProject?.path && $sessions.length}
      <button class="ubtn agents-chip" aria-label="Connected agents" aria-expanded={agentsOpen} onclick={toggleAgents}>{$sessions.length} {$sessions.length === 1 ? "agent" : "agents"} ▾</button>
      {#if agentsOpen && AgentsPopover}<AgentsPopover close={() => agentsOpen = false} />{/if}
    {/if}
    <button class="ubtn ai-indicator" data-status={$aiColor} title={`AI status — ${$aiColor === 'green' ? 'ready' : $aiColor === 'red' ? 'broken' : 'needs attention'}`} aria-label="AI status" aria-expanded={$aiOpen} onclick={() => openAI()}>
      <span>AI</span><span class="ai-dot" aria-hidden="true"></span>
    </button>
    {#if $view === "workspace" && $currentProject?.path}<button class="ubtn inbox-button" class:needs={$inboxNeedsInput > 0} title={$inboxNeedsInput ? `Inbox — ${$inboxNeedsInput} need${$inboxNeedsInput === 1 ? "s" : ""} you · Alt+Q` : "Inbox — Alt+Q"} aria-label={`Inbox · ${$inboxCount} open${$inboxNeedsInput ? ` · ${$inboxNeedsInput} need input` : ""}`} onclick={() => requestInbox()}><Icon name="inbox" size={17} />{#if $inboxCount}<span class="inbox-badge">{$inboxCount}</span>{/if}</button>{/if}
    <button class="ubtn" title="Lighttable — browse image sets" aria-label="Lighttable" onclick={launchLighttable}>
      <Icon name="lighttable" size={17} />
    </button>
    <button class="ubtn" title={docs.label === "Flux" ? "Documentation: the Flux user guide" : `Documentation: the ${docs.label} guide`} aria-label="Documentation" data-docs-url={docs.url} onclick={() => void openDocs({ view: $view, mode: $focusedMode })}>
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
  </div>
</header>

<style>
  .ubtn.agents-chip { width:auto;white-space:nowrap;padding:0 7px;font:11px var(--font-ui); }
  .ai-indicator { position: relative; font: 11px var(--font-ui); }
  .ai-dot { position: absolute; right: 1px; bottom: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--flx-yellow-400, #d0a215); }
  .ai-indicator[data-status="green"] .ai-dot { background: var(--flx-green-400, #879a39); }
  .ai-indicator[data-status="red"] .ai-dot { background: var(--flx-red-400, #d14d41); }
  .inbox-button { position:relative; }
  .inbox-badge { font:9px var(--font-mono);min-width:12px;color:var(--c-accent); }
  /* An agent is waiting on you: the count turns the annotation gold. */
  .inbox-button.needs .inbox-badge { color: var(--c-comment); font-weight: 700; }
  .titlebar {
    height: var(--titlebar-h);
    flex: 0 0 auto;
    /* The mode strip sits in the middle of the window. Two equal 1fr tracks around an auto
       one put it there exactly, and the edge padding lives INSIDE the side tracks so it cannot
       shift the middle (macOS's 76 px for the traffic lights would move it 34 px). The right
       track may not shrink below its controls: on a narrow window it takes what it needs and
       the strip gives way to the left instead of sliding under them. */
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(min-content, 1fr);
    align-items: center;
    column-gap: var(--sp-3);
    background: var(--c-bg-raised);
    border-bottom: 1px solid var(--c-line);
    -webkit-app-region: drag;
    user-select: none;
  }
  .side {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    min-width: 0;
    height: 100%;
  }
  .side.left {
    padding-left: var(--sp-3);
    overflow: hidden;
  }
  .side.right {
    justify-content: flex-end;
    padding-right: var(--sp-2);
  }
  /* macOS: leave room on the left for the native traffic-light controls. */
  .titlebar.mac .side.left {
    padding-left: 76px;
  }
  .brand,
  .dirtydot {
    flex: 0 0 auto;
  }
  .middle {
    display: flex;
    align-items: center;
    height: 100%;
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
    cursor: var(--cursor-cross-hover);
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
    min-width: 0;
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

  /* ---- mode strip: a glass pill floating in the middle of the bar ----------
     (owner, 2026-11-17: "dead middle … in their own little panel that looks like it is
     just very subtly floating above the app"). The one fully round surface in the shell:
     lighter than the bar, a pale rim, a highlight along the top and a soft shadow under it.
     No backdrop-filter: the bar behind it is one flat colour, so a blur would buy nothing
     and cost a compositor layer. */
  .modestrip {
    --strip-pad: 8px;
    --mode-w: 32px;
    --mode-gap: 2px;
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--mode-gap);
    height: 30px;
    /* The bar is 38 px with its 1 px bottom line: 4 px above the pill and 4 px below it to the
       bar's outer edge, on whole pixels (centring in the 37 px inside lands on a half). */
    margin-top: 1px;
    padding: 0 var(--strip-pad);
    background: color-mix(in oklab, var(--c-surface-2) 78%, var(--c-bg-raised));
    border: 1px solid color-mix(in oklab, var(--c-tx-hi) 12%, transparent);
    border-radius: var(--r-pill);
    box-shadow:
      inset 0 1px 0 color-mix(in oklab, var(--c-tx-hi) 9%, transparent),
      0 2px 10px rgba(0, 0, 0, 0.5);
  }
  .mbtn {
    width: var(--mode-w);
    height: 24px;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--c-tx-muted);
    border-radius: var(--r-pill);
    cursor: var(--cursor-cross-hover);
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

  /* Sliding accent marker (Tier-1 transform, style_principles.md P5): the stretch of the
     pill's own lower rim under the active mode, lit. It lies ON the rim (over the 1 px
     border), where the rim is still straight even under the first and last mode. Centred
     under its button: (32 - 18) / 2 = 7; one mode further is width + gap. */
  .mindicator {
    position: absolute;
    left: calc(var(--strip-pad) + (var(--mode-w) - 18px) / 2);
    bottom: -1px;
    width: 18px;
    height: 2px;
    border-radius: var(--r-pill);
    background: var(--c-accent);
    box-shadow: 0 0 10px var(--c-accent-glow);
    transform: translateX(calc(var(--mi) * (var(--mode-w) + var(--mode-gap))));
    transition: transform var(--dur-quick) var(--ease-standard);
  }
  .mindicator.hidden {
    opacity: 0;
  }

  /* A passing notice: it shortens before the strip is asked to move. */
  .agent-view {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--c-tx-muted);
    font-size: var(--ts-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    cursor: var(--cursor-cross-hover);
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
    cursor: var(--cursor-cross-hover);
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
