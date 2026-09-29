<script lang="ts">
  import type { MonitorCheck } from '../../lib/project/agentMonitor';
  import { checkLabel } from '../../lib/project/agentMonitor';
  export let check: MonitorCheck;
  export let version = '';
  export let paths: string[] = [];
  export let busy = false;
  export let fix: (() => void) | undefined = undefined;
  export let fixLabel = 'Fix';
</script>
<details class="ai-check" data-check={check.id}>
  <summary tabindex="0"><span class="dot" data-status={check.status} aria-label={check.pending ? 'Not checked' : check.status}></span><span>{checkLabel(check.id)}</span><small>{check.pending ? 'Not checked' : check.status}</small></summary>
  <div class="detail">
    <p class="message">{check.message}</p>
    {#each [...new Set([...(check.paths ?? []), ...paths])] as path}<code>{path}</code>{/each}
    <dl><dt>Version</dt><dd>{version || 'Not reported'}</dd><dt>Last check</dt><dd>{check.checkedAt ? new Date(check.checkedAt).toLocaleString() : 'Not checked yet'}</dd></dl>
    {#if check.fix}<p>{check.fix}</p>{/if}
    {#if fix}<button disabled={busy} on:click={fix}>{fixLabel}</button>{/if}
  </div>
</details>
<style>
  details { border-top: 1px solid var(--c-line); }
  summary { display: flex; align-items: center; gap: 8px; padding: 9px 0; cursor: var(--cursor-cross-hover); }
  summary::before { content: '›'; color: var(--c-tx-muted); }
  details[open] > summary::before { content: '⌄'; }
  small { margin-left: auto; color: var(--c-tx-muted); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--flx-yellow-400, #d0a215); }
  .dot[data-status="ok"] { background: var(--flx-green-400, #879a39); }
  .dot[data-status="fail"] { background: var(--flx-red-400, #d14d41); }
  .detail { padding: 0 8px 12px 20px; color: var(--c-tx-muted); }
  p { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  code { display: block; overflow-wrap: anywhere; font-size: 11px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 11px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  button { background: transparent; border: 1px solid var(--c-line); color: var(--c-tx); border-radius: var(--r-ui); padding: 4px 9px; }
</style>
