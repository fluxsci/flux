<script lang="ts">
  // The conversation, rendered as correspondence: your words typed in the UI
  // face, the agent's answer written in the manuscript's serif with its seed
  // in the gutter, its working notes folded into ToolTrail rows, thinking in a
  // quiet disclosure, errors as cards with a way forward, and a faint meta line
  // once a turn is done. One component for Ask, the Inbox's live run and the
  // kept thread, over the one transcript model (src/lib/agent/transcript.ts).
  import AgentMark from "./AgentMark.svelte";
  import ToolTrail from "./ToolTrail.svelte";
  import { markdown } from "./markdown";
  import { type Transcript, type Turn, type Block } from "../../lib/agent/transcript";
  let { transcript, agent = "Agent", seed = "", showMeta = true, dense = false, onretry }:
    { transcript: Transcript; agent?: string; seed?: string; showMeta?: boolean; dense?: boolean; onretry?: () => void } = $props();
  const fmtTokens = (n?: number) => n === undefined ? "?" : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
  const seconds = (t: Turn) => t.endedAt ? Math.max(1, Math.round((t.endedAt - t.startedAt) / 1000)) : 0;
  const toolCount = (t: Turn) => t.blocks.reduce((n, b) => n + (b.kind === "tools" ? b.calls.length : 0), 0);
  const thinkingOpen = (t: Turn, b: Block) => b.kind === "thinking" && b.streaming && t.state === "streaming";
  const hasText = (t: Turn) => t.blocks.some(b => b.kind === "text" && b.text.trim());
  function metaLine(t: Turn): string {
    const parts = [agent];
    const tools = toolCount(t);
    if (tools) parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
    if (t.usage?.inputTokens !== undefined) parts.push(`${fmtTokens(t.usage.inputTokens)} in → ${fmtTokens(t.usage.outputTokens)} out`);
    if (t.usage?.costUsd !== undefined) parts.push(`$${t.usage.costUsd.toFixed(t.usage.costUsd < 0.1 ? 3 : 2)}`);
    if (t.state === "cancelled") parts.push("stopped");
    const s = seconds(t); if (s) parts.push(`${s} s`);
    return parts.join(" · ");
  }
</script>

<div class="transcript" class:dense>
  {#each transcript.turns as turn (turn.id)}
    {#if turn.role === "human"}
      <div class="turn you arrive">
        {#each turn.blocks as b (b.id)}{#if b.kind === "text"}<div class="message question agent-prose you" use:markdown={{ text: b.text }}></div>{/if}{/each}
        {#if turn.images?.length}<div class="attachments">{#each turn.images as src, i (i)}<img {src} alt="Attached view" data-flux-image title="The view that was sent with the question" />{/each}</div>{/if}
      </div>
    {:else}
      <div class="turn agent" data-state={turn.state}>
        <div class="gutter"><AgentMark size={dense ? 12 : 14} state={turn.state === "streaming" ? "working" : turn.state === "failed" ? "error" : "done"} {seed} /></div>
        <div class="body">
          {#each turn.blocks as b (b.id)}
            {#if b.kind === "text"}
              <div class="message agent-prose arrive" class:streaming={b.streaming} use:markdown={{ text: b.text, streaming: b.streaming }}></div>
            {:else if b.kind === "thinking"}
              <details class="thinking arrive" open={thinkingOpen(turn, b)}><summary>Thinking{b.streaming && turn.state === "streaming" ? "…" : ""}</summary><div class="thought agent-prose compact" use:markdown={{ text: b.text, streaming: b.streaming }}></div></details>
            {:else if b.kind === "tools"}
              <div class="arrive"><ToolTrail calls={b.calls} /></div>
            {:else if b.kind === "error"}
              <div class="error-card arrive" role="alert"><div class="msg">{b.message}</div>{#if onretry}<div class="acts"><button onclick={onretry}>Retry</button></div>{/if}</div>
            {/if}
          {/each}
          {#if turn.state === "cancelled" && !hasText(turn)}<div class="stopped faint">Stopped</div>{/if}
          {#if showMeta && turn.state !== "streaming" && (turn.usage || toolCount(turn) || seconds(turn))}
            <div class="meta mono faint arrive" title="This turn">{metaLine(turn)}</div>
          {/if}
        </div>
      </div>
    {/if}
  {/each}
</div>

<style>
  .transcript { display: flex; flex-direction: column; gap: var(--sp-4); }
  .transcript.dense { gap: var(--sp-3); }
  .turn.you { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .question { width: fit-content; max-width: 100%; padding: 6px 11px; background: var(--c-surface-2); border-radius: var(--r-1); border-bottom-right-radius: var(--r-ui); }
  .attachments { display: flex; gap: 6px; }
  .attachments img { max-height: 40px; max-width: 72px; border: 1px solid var(--c-line); border-radius: var(--r-ui); object-fit: cover; opacity: .9; }
  .turn.agent { display: grid; grid-template-columns: 16px 1fr; gap: 0 8px; align-items: start; }
  .gutter { padding-top: 5px; }
  .body { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0; }
  .thinking { font: var(--ts-xs) var(--font-ui); color: var(--c-tx-muted); }
  .thinking summary { list-style: none; cursor: default; display: inline-flex; align-items: center; gap: 6px; padding: 2px 4px 2px 0; border-radius: var(--r-ui); }
  .thinking summary::-webkit-details-marker { display: none; }
  .thinking summary::before { content: ""; width: 8px; height: 8px; background: currentColor; opacity: .5; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat; transition: rotate var(--dur-instant) var(--ease-standard); }
  .thinking[open] summary::before { rotate: 90deg; }
  .thinking summary:hover { color: var(--c-tx-2); }
  .thought { margin: 4px 0 4px 14px; padding-left: 10px; border-left: 2px solid var(--c-line); color: var(--c-tx-muted); font-style: italic; }
  .error-card { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; background: var(--c-surface-2); border-left: 2px solid var(--c-danger); border-radius: var(--r-ui); font: var(--ts-sm)/1.5 var(--font-ui); color: var(--c-tx); overflow-wrap: anywhere; }
  .acts { display: flex; gap: 6px; }
  .acts button { height: 22px; padding: 0 8px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); font: var(--ts-xs) var(--font-ui); }
  .acts button:hover { background: var(--c-ui-hover); color: var(--c-tx); }
  .stopped { font: var(--ts-xs) var(--font-ui); }
  .meta { font-size: 10.5px; letter-spacing: .01em; }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .faint { color: var(--c-tx-faint); }
</style>
