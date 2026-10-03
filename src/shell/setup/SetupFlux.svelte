<script lang="ts">
  // "Set up Flux…": each companion with live detection, its status and one action — no terminal
  // and no admin rights needed. Opens on an installed app's first launch; reopen it from
  // Settings or the command palette. State and actions: ./setupState.ts.
  import { modalFocus } from "../../lib/ui/modalFocus";
  import { fullscreenPortal } from "../../lib/ui/portal";
  import { fileBridge } from "../../lib/project/types";
  import { openAI } from "../agent/aiMonitorState";
  import {
    setupStatus, setupProgress, setupRunning, setupErrors, closeSetup,
    installQuarto, installTinytex, cancelSetupTask, addFluxToTerminal,
  } from "./setupState";

  const AGENT_LINKS = { claude: "https://www.anthropic.com/claude-code", codex: "https://github.com/openai/codex" };
  let copied = $state("");

  const s = $derived($setupStatus);
  const quartoBusy = $derived($setupRunning.has("quarto"));
  const texBusy = $derived($setupRunning.has("tinytex"));
  const quartoPct = $derived(Math.round(($setupProgress.quarto?.fraction ?? 0) * 100));
  const quartoPhase = $derived($setupProgress.quarto?.phase ?? "download");
  const quartoWhere = $derived(
    !s?.quarto.installed ? "" : s.quarto.origin === "managed" ? "installed by Flux" : "your own installation",
  );

  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); copied = text; setTimeout(() => { if (copied === text) copied = ""; }, 1600); } catch { /* clipboard denied */ }
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); closeSetup(); }
    e.stopPropagation(); // the window owns the keyboard while it is open
  }
  function connectAgents() { closeSetup(); openAI(); }
</script>

<div class="setup-layer" use:fullscreenPortal>
  <div class="setup-panel" role="dialog" aria-modal="true" aria-labelledby="setup-title" tabindex="-1" use:modalFocus onkeydown={onKey} data-setup-flux>
    <header>
      <h2 id="setup-title">Set up Flux</h2>
      <p class="lede">Flux works as installed. These optional pieces add the terminal command, Word export and AI agents. Reopen this any time from Settings.</p>
    </header>

    {#if !s}
      <p class="muted" data-setup-loading>Checking this computer…</p>
    {:else}
      <section class="row" data-setup-row="terminal">
        <div class="what">
          <h3>The <code>flux</code> command</h3>
          <p>Lets you and your AI agents drive Flux from a terminal.</p>
        </div>
        <div class="state">
          {#if s.launcher.installed && s.launcher.onPath}
            <span class="ok" data-status="ready">Ready — works in new terminal windows</span>
          {:else}
            <span class="todo" data-status="missing">Not set up</span>
            <button disabled={$setupRunning.has("terminal")} onclick={addFluxToTerminal} data-action="terminal">Add to terminal</button>
          {/if}
          {#if $setupErrors.terminal}<p class="err" role="alert">{$setupErrors.terminal}</p>{/if}
        </div>
      </section>

      <section class="row" data-setup-row="quarto">
        <div class="what">
          <h3>Word export · Quarto</h3>
          <p>Word (.docx) export and <code>flux compile</code> run through Quarto. PDF export inside Flux needs nothing.</p>
        </div>
        <div class="state">
          {#if s.quarto.installed}
            <span class="ok" data-status="ready">Quarto {s.quarto.version} — {quartoWhere}</span>
          {:else if quartoBusy}
            <div class="progress" data-status="installing">
              <progress max="100" value={quartoPhase === "download" ? quartoPct : undefined}></progress>
              <span>{quartoPhase === "download" ? `Downloading… ${quartoPct}%` : quartoPhase === "verify" ? "Checking the download…" : "Unpacking…"}</span>
              <button onclick={() => cancelSetupTask("quarto")} data-action="cancel-quarto">Cancel</button>
            </div>
          {:else if s.quartoManageable}
            <span class="todo" data-status="missing">Not installed</span>
            <button onclick={installQuarto} data-action="quarto">Install Quarto {s.quartoPinned}</button>
            <span class="muted small">≈ 130–210 MB, into your FluxConfig folder</span>
          {:else}
            <span class="todo" data-status="missing">Not installed — get it from quarto.org</span>
          {/if}
          {#if $setupErrors.quarto}<p class="err" role="alert">{$setupErrors.quarto}</p>{/if}
        </div>
      </section>

      <section class="row" data-setup-row="tinytex">
        <div class="what">
          <h3>PDF through Quarto · TinyTeX</h3>
          <p>Only for PDFs built by Quarto (<code>flux compile --to pdf</code>, agents). Needs Quarto first.</p>
        </div>
        <div class="state">
          {#if s.tex.installed}
            <span class="ok" data-status="ready">{s.tex.kind === "tinytex" ? "TinyTeX installed" : "LaTeX found on this computer"}</span>
          {:else if texBusy}
            <div class="progress" data-status="installing">
              <progress></progress>
              <span class="small">{$setupProgress.tinytex?.line ?? "Installing TinyTeX…"}</span>
              <button onclick={() => cancelSetupTask("tinytex")} data-action="cancel-tinytex">Cancel</button>
            </div>
          {:else}
            <span class="todo" data-status="missing">Not installed</span>
            <button disabled={!s.quarto.installed} onclick={installTinytex} data-action="tinytex" title={s.quarto.installed ? "" : "Install Quarto first"}>Add PDF support</button>
          {/if}
          {#if $setupErrors.tinytex}<p class="err" role="alert">{$setupErrors.tinytex}</p>{/if}
        </div>
      </section>

      <section class="row" data-setup-row="fluxplot">
        <div class="what">
          <h3>Plots · fluxplot</h3>
          <p>fluxplot is a Python library that lives in <em>your</em> analysis environment, beside your own code. Add it there:</p>
        </div>
        <div class="state cmds">
          {#each ["uv add fluxplot", "pip install fluxplot"] as cmd (cmd)}
            <button class="cmd" onclick={() => copy(cmd)} data-copy={cmd} title="Copy">
              <code>{cmd}</code><span class="small">{copied === cmd ? "Copied" : "Copy"}</span>
            </button>
          {/each}
        </div>
      </section>

      <section class="row" data-setup-row="agents">
        <div class="what">
          <h3>AI agents</h3>
          <p>Claude Code and Codex can read and edit your Flux projects.</p>
        </div>
        <div class="state">
          {#each [["claude", "Claude Code"], ["codex", "Codex"]] as [id, name] (id)}
            <div class="agent" data-agent={id}>
              {#if s.agents[id as "claude" | "codex"]}
                <span class="ok" data-status="ready">{name} found</span>
              {:else}
                <span class="todo" data-status="missing">{name} not found</span>
                <button class="link" onclick={() => fileBridge()?.openExternal?.(AGENT_LINKS[id as "claude" | "codex"])}>Install…</button>
              {/if}
            </div>
          {/each}
          <button disabled={!s.agents.claude && !s.agents.codex} onclick={connectAgents} data-action="connect">Connect…</button>
        </div>
      </section>
    {/if}

    <footer>
      <button class="primary" onclick={closeSetup} data-action="done">Done</button>
    </footer>
  </div>
</div>

<style>
  .setup-layer { position: fixed; inset: 0; z-index: 2900; display: grid; place-items: center; background: #0006; }
  .setup-panel { width: min(760px, 92vw); max-height: 88vh; overflow: auto; padding: 22px 24px 18px; border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); background: var(--c-bg-raised); color: var(--c-tx); box-shadow: 0 18px 48px #0007; }
  h2 { margin: 0 0 4px; font-size: var(--ts-md); color: var(--c-tx-hi); }
  h3 { margin: 0 0 3px; font-size: 1em; color: var(--c-tx-hi); }
  .lede, .what p { margin: 0; color: var(--c-tx-muted); line-height: 1.45; }
  header { margin-bottom: 10px; }
  .row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; padding: 12px 0; border-top: 1px solid var(--c-line); }
  .state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; align-content: center; }
  .cmds { flex-direction: column; align-items: stretch; }
  .ok { color: var(--c-accent-bright); }
  .todo, .muted { color: var(--c-tx-muted); }
  .small { font-size: 0.85em; }
  .err { flex-basis: 100%; margin: 2px 0 0; color: var(--c-danger); font-size: 0.85em; }
  .progress { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; width: 100%; }
  progress { flex: 1 1 140px; accent-color: var(--c-accent); }
  .agent { display: flex; align-items: center; gap: 8px; flex-basis: 100%; }
  button { font: inherit; color: inherit; background: var(--c-surface); padding: 5px 11px; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); }
  button:disabled { opacity: 0.5; }
  button.link { background: none; border: none; padding: 0; color: var(--c-accent); }
  button.cmd { display: flex; justify-content: space-between; gap: 12px; text-align: left; }
  button.primary { background: var(--c-accent); color: var(--c-on-accent); border-color: var(--c-accent); }
  code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 0.92em; }
  footer { display: flex; justify-content: end; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--c-line); }
</style>
