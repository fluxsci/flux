<script lang="ts">
  // The agent's working notes: consecutive tool calls folded into one line
  // ("Read 3 files · Searched once · get_figure_image") with a status dot, which
  // opens into one row per call — verb, humanised object, raw tool name — and
  // each row into its input and result. Pictures a tool returned (the figure
  // the agent looked at) show inline. Everything here is text and data; the
  // tool JSON is pretty-printed into a <pre>, never innerHTML.
  import { toolGroupSummary, toolGroupStatus, toolDetail, type ToolCall } from "../../lib/agent/transcript";
  let { calls, open = false, label = "" }: { calls: ToolCall[]; open?: boolean; label?: string } = $props();
  const status = $derived(toolGroupStatus(calls));
  const summary = $derived(toolGroupSummary(calls));
  const running = $derived(calls.filter(c => c.status === "started").length);
  const verb = (c: ToolCall) => c.kind === "read" ? "Read" : c.kind === "search" ? "Searched" : c.kind === "edit" ? "Edited" : c.kind === "shell" ? "Ran" : c.kind === "web" ? "Fetched" : c.kind === "flux" ? friendly(c.name) : c.name;
  const friendly = (name: string) => ({ get_figure_image: "Viewed figure", get_canvas_image: "Looked at the canvas", get_view: "Looked at the window", get_pack_image: "Viewed the pack", read_pack: "Read plot data", get_manuscript: "Read the manuscript", list_documents: "Listed documents", list_project: "Listed the project", search_references: "Searched references", list_inbox: "Checked the inbox", read_log: "Read the log", read_delta: "Read recent changes", get_app_context: "Read the app context", validate_project: "Validated the project", rerun_plot: "Re-ran a plot", set_manuscript: "Wrote the manuscript", compose_figure: "Composed a figure", restyle_part: "Restyled a part", sync_figure: "Synced a figure", set_caption: "Set a caption", cite_doi: "Cited a DOI", claim_item: "Claimed an item", reply_item: "Replied", resolve_item: "Resolved an item", write_log: "Wrote the log" } as Record<string, string>)[name] ?? name;
</script>

<details class="activity" data-status={status} {open}>
  <summary><span class="dot" aria-hidden="true"></span><span class="text">{label ? `${label} · ` : ""}{summary}</span>{#if running}<span class="faint mono">{running} running</span>{/if}<span class="n faint mono">{calls.length}</span></summary>
  <div class="rows">
    {#each calls as c (c.id)}
      <details class="tool-line" data-status={c.status} data-kind={c.kind}>
        <summary><span class="dot" aria-hidden="true"></span><span class="verb">{verb(c)}</span><span class="object mono" title={c.summary}>{c.summary}</span><span class="raw faint mono">{c.name}</span></summary>
        <div class="detail">
          {#if c.images.length}<div class="images">{#each c.images as src, i (i)}<img {src} alt={`Picture returned by ${c.name}`} data-flux-image loading="lazy" decoding="async" />{/each}</div>{/if}
          {#if c.input !== undefined && c.input !== null && (typeof c.input !== "object" || Object.keys(c.input as object).length)}<div class="kv"><span class="k faint mono">Input</span><pre>{toolDetail(c.input)}</pre></div>{/if}
          {#if c.output !== undefined}<div class="kv"><span class="k faint mono">{c.status === "failed" ? "Error" : "Result"}</span><pre>{toolDetail(c.output)}</pre></div>{/if}
        </div>
      </details>
    {/each}
  </div>
</details>

<style>
  .activity { font: var(--ts-xs) var(--font-ui); color: var(--c-tx-muted); }
  summary { display: flex; align-items: center; gap: 7px; min-height: 22px; padding: 1px 4px 1px 2px; border-radius: var(--r-ui); list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: var(--c-surface-2); color: var(--c-tx-2); }
  .activity > summary::before, .tool-line > summary::before { content: ""; width: 8px; height: 8px; flex-shrink: 0; background: currentColor; opacity: .45; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m9 6 6 6-6 6'/%3E%3C/svg%3E") center / contain no-repeat; transition: rotate var(--dur-instant) var(--ease-standard); }
  details[open] > summary::before { rotate: 90deg; }
  .text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n { margin-left: auto; font-size: 10px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--c-tx-faint); }
  [data-status="started"] > summary > .dot { background: var(--c-accent); animation: tool-pulse 1.2s ease-in-out infinite; }
  [data-status="failed"] > summary > .dot { background: var(--c-danger); }
  [data-status="done"] > summary > .dot { background: var(--c-success); opacity: .8; }
  @keyframes tool-pulse { 50% { opacity: .3; } }
  .rows { display: flex; flex-direction: column; padding: 2px 0 2px 14px; }
  .tool-line > summary { min-height: 20px; }
  .verb { color: var(--c-tx-2); white-space: nowrap; }
  .object { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-tx-muted); font-size: 10.5px; }
  .raw { margin-left: auto; font-size: 10px; white-space: nowrap; }
  .detail { display: flex; flex-direction: column; gap: 6px; padding: 4px 0 8px 15px; }
  .kv { display: grid; grid-template-columns: 44px 1fr; gap: 6px; align-items: start; }
  .k { font-size: 10px; padding-top: 4px; letter-spacing: .04em; }
  pre { margin: 0; padding: 6px 8px; background: var(--c-bg); border: 1px solid var(--c-line); border-radius: var(--r-ui); font: 10.5px/1.45 var(--font-mono); color: var(--c-tx-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
  .images { display: flex; flex-wrap: wrap; gap: 6px; }
  .images img { max-width: 100%; max-height: 260px; border: 1px solid var(--c-line); border-radius: var(--r-ui); background: var(--flx-paper); }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .faint { color: var(--c-tx-faint); }
</style>
