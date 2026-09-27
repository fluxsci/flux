<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { aiOpen, aiDetached, aiStatus, aiRequest, refreshAI } from './aiMonitorState';
  import { annotationOpen } from './annotationVisibility';
  import { sessions } from './sessionState';
  import { inboxItems, inboxError, initInboxStore } from '../inbox/inboxStore';
  import SessionRows from './SessionRows.svelte';
  import { currentProject } from '../shellStore';
  import { fileBridge, joinPath } from '../../lib/project/types';
  import { agentChecks, type AgentId, type MonitorCheck, type MonitorPlan, type MonitorMutation, type MonitorSkills } from '../../lib/project/agentMonitor';
  import { openUtilityWindow } from '../../lib/plot/galleryWindow';
  import { modalFocus } from '../../lib/ui/modalFocus';
  import AICheckRow from './AICheckRow.svelte';
  import AIBundleTable from './AIBundleTable.svelte';

  let host: HTMLDivElement;
  let popup: ReturnType<typeof openUtilityWindow> | undefined;
  let alive = true, busy = false, error = '', notice = '', progress = '';
  let confirm: MonitorPlan | null = null;
  let skills: MonitorSkills = { path: '', skills: [] };
  let newSkill = false, skillName = '', nameInput: HTMLInputElement;
  // RunnerSettings probes the installed CLIs: it mounts only when asked (refresh stays file-only).
  let launchOpen = false;
  let completed: MonitorCheck[] = [];
  let projectRoot = get(currentProject)?.path ?? null;
  $: checks = $aiStatus.checks;
  $: bundleChecks = checks.filter(c => !/^(claude|codex)\./.test(c.id));
  $: inbox = $inboxItems;
  $: openItems = inbox.filter(i => !i.archived && i.status !== 'resolved' && i.status !== 'withdrawn');
  $: if (($currentProject?.path ?? null) !== projectRoot) { projectRoot = $currentProject?.path ?? null; aiOpen.set(false); }
  $: if ($aiRequest) { const request = $aiRequest; aiRequest.set(null); if (request.newSkill) void promptSkill(); if (request.connect) void mutate(request.connect); popup?.focus(); }

  async function task(work: () => Promise<void>) {
    if (busy) return;
    busy = true; error = ''; notice = '';
    try { await work(); } catch (e) { if (alive) error = (e as Error).message || String(e); }
    finally { if (alive) { busy = false; progress = ''; } }
  }
  async function readSkills() {
    const result = await fileBridge()?.agentSetupSkills?.({ action: 'list' });
    if (alive && result) skills = result;
  }
  async function mutate(id: AgentId, remove = false, useThisInstall = false, request?: MonitorMutation) {
    await task(async () => {
      const fb = fileBridge();
      const call = remove ? fb?.agentSetupRemove : fb?.agentSetupApply;
      if (!call) throw new Error('Connecting agents is available in the Flux desktop app.');
      progress = remove ? 'Planning disconnect…' : 'Checking agent setup…';
      const result = await call(request ?? { agents: [id], useThisInstall });
      if (!alive) return;
      if ('plan' in result) confirm = result.plan;
      else {
        confirm = null;
        notice = [...result.checks.map(c => c.message), ...result.nextSteps].join('\n');
        await refreshAI(); await readSkills();
      }
    });
  }
  async function doctor(copy = false) {
    await task(async () => {
      const fb = fileBridge();
      if (!fb?.agentSetupDoctor) throw new Error('Run doctor is available in the Flux desktop app.');
      completed = []; progress = 'Checking launcher, MCP, rendering, context and agents…';
      const report = await fb.agentSetupDoctor();
      if (copy) { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); notice = 'Doctor JSON copied.'; }
      else notice = `Doctor finished: ${report.checks.filter(c => c.status === 'ok').length} OK, ${report.checks.filter(c => c.status === 'warn').length} warnings, ${report.checks.filter(c => c.status === 'fail').length} failures.`;
      await refreshAI();
    });
  }
  async function copyLine(id: AgentId) {
    await task(async () => {
      await navigator.clipboard.writeText(`${id === 'claude' ? '/' : '$'}flux-connect ${projectRoot ?? 'global'}`);
      notice = 'Connection command copied.';
    });
  }
  function fixFor(check: MonitorCheck, id?: AgentId): (() => void) | undefined {
    if (check.pending || check.id.endsWith('.responds') || check.id === 'mcp' || check.id === 'rendering' || check.id === 'status') return () => void doctor();
    if (id && check.status !== 'ok') return () => void mutate(id);
    if (check.id.startsWith('launcher') && check.status !== 'ok') return () => void mutate('claude', false, true, { agents: [], useThisInstall: true });
    if (check.id === 'context.user' && check.paths?.[0]) return () => void task(async () => { await fileBridge()?.openPath?.(check.paths![0]); });
    if (check.id.startsWith('context.skill.') && check.paths?.[0]) return () => void task(async () => { await fileBridge()?.openPath?.(joinPath(check.paths![0], 'SKILL.md')); });
    return undefined;
  }
  async function promptSkill() { newSkill = true; await tick(); nameInput?.focus(); }
  async function createSkill() {
    await task(async () => {
      const fb = fileBridge();
      if (!fb?.agentSetupSkills) throw new Error('Creating skills is available in the Flux desktop app.');
      const result = await fb.agentSetupSkills({ action: 'new', name: skillName.trim() });
      if (alive) { skills = result; newSkill = false; skillName = ''; notice = [`Created ${result.created}`, ...(result.checks ?? []).map(c => c.message)].join('\n'); }
      await refreshAI();
    });
  }
  function pin() {
    if (popup) { popup.close(); popup = undefined; aiDetached.set(false); return; }
    try {
      popup = openUtilityWindow(host, close, () => void tick().then(() => host.querySelector<HTMLElement>('.close')?.focus()), { page: 'ai-status.html', frame: 'flux-ai-status', title: 'AI status', focus: '.close' });
      aiDetached.set(true);
    } catch (e) { error = String(e); }
  }
  function close() { confirm = null; aiOpen.set(false); }
  function keys(e: KeyboardEvent) {
    if (get(annotationOpen)) return;
    if (e.key === 'Escape') { e.preventDefault(); if (confirm) confirm = null; else if (newSkill) newSkill = false; else close(); }
    // The utility owns its key events; editor shortcuts must never act beneath it.
    if (!(e.ctrlKey || e.metaKey) || !(e.shiftKey && e.code === 'KeyM')) e.stopPropagation();
  }
  onMount(() => {
    initInboxStore();
    const off = fileBridge()?.onAgentSetupProgress?.(({ check, checkedAt }) => {
      if (!busy) return;
      completed = [...completed.filter(c => c.id !== check.id), { ...check, checkedAt }];
      progress = `Checked ${completed.length} parts · ${check.id}`;
    });
    void readSkills().catch(e => error = String(e));
    void refreshAI();
    return () => { off?.(); };
  });
  onDestroy(() => { alive = false; popup?.close(); aiDetached.set(false); });
</script>

<div class="ai-scrim" class:detached={$aiDetached} role="presentation" on:click|self={close}></div>
<div class="ai-panel" class:detached={$aiDetached} bind:this={host} role="dialog" aria-label="AI status" aria-modal={!$aiDetached} tabindex="-1" use:modalFocus on:keydown={keys}>
  <header><strong>AI status</strong><span>Flux AI Bundle</span><button class="pin" on:click={pin}>{$aiDetached ? 'Dock' : 'Pin'}</button><button class="close" aria-label="Close AI status" on:click={close}>×</button></header>
  <div class="tools"><button disabled={busy} on:click={() => void doctor()}>Run doctor</button><button disabled={busy} on:click={() => void doctor(true)}>Copy diagnostics</button><small>{$aiStatus.checkedAt ? `Last check ${new Date($aiStatus.checkedAt).toLocaleTimeString()}` : 'Status not checked yet'}</small></div>
  <div class="body">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if progress}<p role="status">{progress}</p>{/if}
    {#if notice}<p class="notice" role="status">{notice}</p>{/if}
    {#if completed.length}<details class="doctor-progress" open={busy}><summary tabindex="0">Doctor results · {completed.length}</summary>{#each completed as check}<AICheckRow {check} version={$aiStatus.version} />{/each}</details>{/if}
    {#if confirm}
      <div class="confirmation" role="alertdialog" aria-label="Confirm agent setup" tabindex="-1" use:modalFocus>
        <h2>{confirm.kind === 'remove' ? 'Disconnect agent' : 'Confirm replacement'}</h2>
        <p>Review the exact file changes. Flux checks these originals again before writing and keeps backups.</p>
        {#each confirm.replacements as change}<details open><summary tabindex="0">{change.path}</summary><strong>Before</strong><pre>{change.before ?? '(file absent)'}</pre><strong>After</strong><pre>{change.after ?? '(removed)'}</pre></details>{/each}
        {#each confirm.checks as check}<p>{check.message}</p>{/each}
        {#each confirm.nextSteps as step}<p>{step}</p>{/each}
        <button disabled={busy || confirm.checks.some(c => c.status === 'fail')} on:click={() => confirm && void mutate(confirm.agents[0], confirm.kind === 'remove', false, { token: confirm.token, confirm: true })}>Confirm changes</button>
        <button disabled={busy} on:click={() => confirm = null}>Cancel</button>
      </div>
    {/if}
    <section aria-label="Agents"><h2>Agents</h2>
      {#each ['claude', 'codex'] as key}
        {@const id = key as AgentId}
        {@const agent = $aiStatus.agents.find(a => a.id === id)}
        <article data-agent={id}><div class="agent-heading"><h3>{id === 'claude' ? 'Claude Code' : 'Codex'}</h3><span>{agent?.present ? `Installed · ${agent.version ?? 'version not checked'}` : 'Not detected'}</span></div>
          <div class="actions"><button disabled={busy || !!confirm} on:click={() => void mutate(id)}>{agent?.connected ? 'Repair' : 'Connect'}</button>{#if agent?.connected}<button disabled={busy || !!confirm} on:click={() => void mutate(id, true)}>Disconnect</button>{/if}</div>
          {#each agentChecks($aiStatus, id) as check}<AICheckRow {check} version={agent?.version ?? ''} {busy} paths={check.id.endsWith('.skill') && agent ? [agent.skillDir] : []} fix={fixFor(check, id)} />{/each}
          <button class="copy-line" on:click={() => void copyLine(id)} title="Copy connection command"><code>{id === 'claude' ? '/' : '$'}flux-connect {projectRoot ?? 'global'}</code><span>Copy</span></button>
        </article>
      {/each}
      <details class="other-agents"><summary tabindex="0">Other agents…</summary><p>Register a stdio MCP server named <code>flux</code>, with command <code>{$aiStatus.launcher || '<launcher>'}</code> and argument <code>mcp</code>. It starts with the core toolset; use <code>--toolset full</code> for every tool.</p><p>In your agent, run <code>flux connect {projectRoot ?? 'global'}</code>, then follow its brief. Use your own agent app or terminal.</p></details>
      <details class="launch-settings" on:toggle={(e) => (launchOpen = e.currentTarget.open)}><summary tabindex="0">Agent that Flux launches (Ask)…</summary>{#if launchOpen}{#await import("./RunnerSettings.svelte") then module}<module.default heading={false} />{/await}{/if}</details>
    </section>
    <section aria-label="Bundle"><h2>Bundle</h2>
      <p class="muted">CLI {$aiStatus.version || 'version not checked'} · Owned by {$aiStatus.owner || 'no install detected'}</p>
      {#each bundleChecks as check}<AICheckRow {check} version={$aiStatus.version} {busy} fix={fixFor(check)} fixLabel={check.id.startsWith('launcher') ? 'Use this Flux for agents' : 'Fix'} />{/each}
      {#if !bundleChecks.some(c => c.id === 'rendering')}<AICheckRow check={{ id: 'rendering', status: 'warn', message: 'Run doctor to render a test figure.', pending: true }} {busy} fix={() => void doctor()} />{/if}
      <section aria-label="Skills" class="skills"><h3>Skills</h3><p>Your procedures, available by name in every connected agent.</p><div class="actions"><button disabled={busy} on:click={promptSkill}>New skill…</button><button disabled={busy} on:click={() => void task(async () => { await fileBridge()?.agentSetupSkills?.({ action: 'reveal' }); })}>Reveal in folder</button><button disabled={busy} on:click={() => void task(async () => { const result = await fileBridge()?.agentSetupSkills?.({ action: 'publish' }); if (result) { skills = result; notice = result.checks?.map(c => c.message).join('\n') || 'Skills published.'; } await refreshAI(); })}>Re-publish</button></div>
        {#if newSkill}<form on:submit|preventDefault={createSkill}><label>Skill name <input bind:this={nameInput} bind:value={skillName} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="64" required placeholder="stats-conventions" /></label><button disabled={busy}>Create and open</button><button type="button" on:click={() => newSkill = false}>Cancel</button></form>{/if}
        <code class="path">{skills.path || $aiStatus.skillsPath}</code>
        {#each skills.skills as skill}<details><summary tabindex="0">{skill.name}</summary><p>{skill.error || skill.description}</p><code class="path">{skill.path}</code><p class="muted">Version: user-authored · Last check: {$aiStatus.checkedAt ? new Date($aiStatus.checkedAt).toLocaleString() : 'Not checked yet'}</p><div class="actions"><button on:click={() => void task(async () => { await fileBridge()?.openPath?.(skill.path); })}>Open SKILL.md</button><button on:click={() => void task(async () => { await fileBridge()?.agentSetupSkills?.({ action: 'reveal', name: skill.name }); })}>Reveal in folder</button></div></details>{/each}
        {#if !skills.skills.length}<p class="muted">No user skills yet.</p>{/if}
      </section>
      <AIBundleTable />
    </section>
    <section aria-label="Sessions"><h2>Sessions</h2>
      <SessionRows onshow={close} />
    </section>
    <section aria-label="This project"><h2>This project</h2>
      {#if projectRoot}
        <AICheckRow check={{ id: 'Live bridge', status: $aiStatus.project?.root === projectRoot && $aiStatus.project.bridge ? 'ok' : 'warn', message: $aiStatus.project?.root === projectRoot && $aiStatus.project.bridge ? 'Running for this window.' : 'Live bridge is unavailable for this window.', paths: [joinPath(projectRoot, '.meta/live/')], checkedAt: $aiStatus.checkedAt ?? undefined }} />
        <details><summary tabindex="0">Inbox · {openItems.length} open · {inbox.filter(i => i.status === 'resolved').length} resolved</summary><p>{openItems.filter(i => i.kind === 'annotation').length} annotations · {openItems.filter(i => i.kind === 'comment').length} comments</p><code class="path">{projectRoot}/.meta/feedback.ndjson · document comment sidecars</code>{#if $inboxError}<p class="error">Inbox could not be read: {$inboxError}</p>{/if}</details>
        <details><summary tabindex="0">Last connect</summary><p>{$aiStatus.project?.root === projectRoot && $aiStatus.project.lastConnected ? new Date($aiStatus.project.lastConnected).toLocaleString() : $sessions.length ? new Date(Math.max(...$sessions.map(s => Date.parse(s.startedAt)))).toLocaleString() : 'No recorded connection'}</p><code class="path">{projectRoot}</code></details>
      {:else}<p class="muted">Open a project to see its bridge, inbox and connections.</p>{/if}
    </section>
  </div>
</div>
<style>
  .ai-scrim { position: fixed; inset: var(--titlebar-h) 0 0; background: #0005; z-index: 180; }
  .ai-scrim.detached { display: none; }
  .ai-panel { position: fixed; z-index: 181; top: calc(var(--titlebar-h) + 12px); right: 16px; bottom: 16px; width: min(700px, calc(100vw - 32px)); display: flex; flex-direction: column; background: var(--c-bg-raised); color: var(--c-tx); border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); font: 12px var(--font-ui); box-shadow: 0 8px 32px #0005; }
  .ai-panel.detached { inset: 0; width: 100%; height: 100%; border: none; box-shadow: none; }
  header, .tools, .actions, .agent-heading { display: flex; align-items: center; gap: 8px; }
  header { padding: 10px 14px; border-bottom: 1px solid var(--c-line); }
  header strong { font-size: 15px; } header span { color: var(--c-tx-muted); } .pin { margin-left: auto; }
  .tools { padding: 10px 14px; flex-wrap: wrap; border-bottom: 1px solid var(--c-line); }
  .tools small { margin-left: auto; color: var(--c-tx-muted); }
  .body { overflow: auto; min-height: 0; padding: 0 18px 18px; }
  section { padding: 14px 0; border-bottom: 1px solid var(--c-line); }
  h2 { font: 12px var(--font-mono); text-transform: uppercase; letter-spacing: .07em; margin: 0 0 12px; }
  h3 { margin: 0; font-size: 14px; } p { line-height: 1.5; margin: 8px 0; }
  .agent-heading { flex-wrap: wrap; margin-bottom: 10px; } .agent-heading span, small, .muted { color: var(--c-tx-muted); }
  article { border: 1px solid var(--c-line); border-radius: var(--r-panel); padding: 12px; margin-bottom: 12px; }
  .actions { flex-wrap: wrap; margin: 8px 0; }
  button { background: transparent; border: 1px solid var(--c-line); color: var(--c-tx); padding: 5px 9px; border-radius: var(--r-ui); font: inherit; }
  button:hover { background: var(--c-ui-hover); } button:disabled { opacity: .5; }
  summary { cursor: var(--cursor-cross-hover); padding: 9px 0; } details { border-top: 1px solid var(--c-line); }
  .copy-line { display: flex; width: 100%; gap: 10px; margin-top: 8px; text-align: left; } .copy-line code { overflow-wrap: anywhere; } .copy-line span { margin-left: auto; color: var(--c-tx-muted); }
  .path { display: block; overflow-wrap: anywhere; font-size: 11px; margin: 8px 0; }
  .error { color: var(--c-danger, #d14d41); white-space: pre-wrap; overflow-wrap: anywhere; }
  .notice { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--c-tx-muted); }
  .confirmation { border: 1px solid var(--c-accent); padding: 12px; margin-top: 14px; } pre { overflow: auto; max-height: 240px; background: var(--c-bg); padding: 10px; font-size: 11px; }
  form { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; padding: 12px 0; }
  label { display: flex; flex-direction: column; gap: 6px; } input { background: var(--c-bg); color: var(--c-tx); border: 1px solid var(--c-line-strong); padding: 6px; }
</style>
