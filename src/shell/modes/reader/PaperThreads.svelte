<script lang="ts">
  // The Reader's "Flux AI" list: every conversation about this paper, whichever project it was
  // asked in (they are kept with the paper: src/lib/references/conversations.ts). One quiet row
  // per conversation (the question, where it is, where it came from); the answers appear only
  // when a row is opened, and opening a row takes the page to the passage it is about.
  import FluxAiMark from "../../agent/FluxAiMark.svelte";
  import { markdown } from "../../agent/markdown";
  import { hlSwatch } from "../../../lib/references/annotationColors";
  import { threadQuestion, threadState, type PaperThread } from "../../../lib/references/conversations";
  import type { Annotation } from "../../../lib/references/annotations";

  let {
    threads,
    highlights,
    here,
    open = $bindable(null),
    onJump,
    onInbox,
    onAsk,
    onRemove,
  }: {
    threads: PaperThread[];
    /** The highlight each thread hangs on, by thread id (none: it hangs on its page). */
    highlights: ReadonlyMap<string, Annotation>;
    /** Was this thread made in the project that is open now? */
    here: (t: PaperThread) => boolean;
    /** The id of the one opened thread. */
    open?: string | null;
    onJump?: (t: PaperThread) => void;
    /** Its home is this project's Inbox: go there to answer or reopen it. */
    onInbox?: (t: PaperThread) => void;
    /** Ask about the same passage again (the earlier answers go along as context). */
    onAsk?: (t: PaperThread) => void;
    onRemove?: (t: PaperThread) => void;
  } = $props();

  function age(ts: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(ts)) / 60000));
    if (!Number.isFinite(minutes)) return "";
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes} m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
    if (minutes < 43200) return `${Math.floor(minutes / 1440)} d`;
    return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short" });
  }
  const when = (ts: string) => { const d = new Date(ts); return Number.isNaN(d.getTime()) ? ts : d.toLocaleString(); };
  const tone = (t: PaperThread) => (t.status === "needs-input" ? "wait" : t.status === "claimed" ? "live" : "ready") as "wait" | "live" | "ready";
  const replies = (t: PaperThread) => t.messages.filter(m => m.kind === "agent").length;
  /** The messages under the header: the opening question is the header itself. */
  const rest = (t: PaperThread) => (t.messages[0]?.kind === "human" ? t.messages.slice(1) : t.messages);
  function toggle(t: PaperThread) {
    if (open === t.id) { open = null; return; }
    open = t.id;
    onJump?.(t);
  }
</script>

<ul class="tlist" aria-label="Conversations about this paper">
  {#each threads as t (t.id)}
    {@const on = highlights.get(t.id)}
    {@const isOpen = open === t.id}
    {@const state = threadState(t)}
    {@const n = replies(t)}
    <li class="talk" class:open={isOpen} data-thread={t.id} data-status={t.status} data-origin={t.origin.kind}>
      {#if on}<span class="swatch" style:background={hlSwatch(on.color)}></span>{/if}
      <button class="thead" aria-expanded={isOpen} title={isOpen ? "Close" : "Read this conversation"} onclick={() => toggle(t)}>
        <span class="tmark"><FluxAiMark still size={14} tone={tone(t)} /></span>
        <span class="tq">{threadQuestion(t)}</span>
        {#if t.page}<span class="tpage">p.{t.page}</span>{/if}
      </button>
      <div class="tmeta">
        {#if !here(t) && t.origin.project}<span class="tfrom" title={`Asked in the project “${t.origin.project.title}”`}>{t.origin.project.title}</span>{/if}
        <span title={when(t.createdAt)}>{age(t.createdAt)}</span>
        {#if state}<span class="tstate" data-status={t.status}>{state}</span>
        {:else if n}<span>{n} {n === 1 ? "reply" : "replies"}</span>{/if}
      </div>
      {#if isOpen}
        <div class="tbody">
          {#if t.anchor}<blockquote class="tquote" title={t.anchor.quote}>{t.anchor.quote}</blockquote>{/if}
          {#each rest(t) as m, i (i)}
            <article class:human={m.kind === "human"} class:agent={m.kind === "agent"}>
              <div class="tby"><b>{m.author}</b><span title={when(m.ts)}>{age(m.ts)}</span></div>
              <div class="agent-prose compact" class:you={m.kind === "human"} use:markdown={{ text: m.text }}></div>
            </article>
          {/each}
          {#if !rest(t).length}<p class="tnone">No answer yet.</p>{/if}
          <div class="tacts">
            {#if t.origin.kind === "item" && here(t)}
              <button class="tbtn" title="Reply to it, or reopen it, in this project's Inbox" onclick={() => onInbox?.(t)}>Open in Inbox</button>
            {:else}
              <button class="tbtn" title="Ask about this passage again: the earlier answers go along" onclick={() => onAsk?.(t)}>Ask a follow-up</button>
            {/if}
            <span class="spacer"></span>
            <button class="tbtn quiet" title={t.origin.kind === "item" ? "Take this conversation off the paper (its Inbox item stays in its project)" : "Take this conversation off the paper"} onclick={() => onRemove?.(t)}>Remove</button>
          </div>
        </div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .tlist {
    list-style: none;
    margin: 0;
    padding: 0 0 6px;
  }
  /* A conversation: its highlight's colour as the row's rail (as in Highlights), the question in
     your voice, then where it came from. */
  .talk {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 8px 8px 16px;
    border-bottom: 1px solid var(--c-line);
  }
  .talk:hover,
  .talk.open {
    background: var(--c-surface-2);
  }
  .swatch {
    position: absolute;
    left: 6px;
    top: 9px;
    bottom: 9px;
    width: 3px;
    border-radius: 1px;
  }
  .thead {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    width: 100%;
    padding: 0;
    border: none;
    background: none;
    color: var(--c-tx);
    font: 12.5px/1.4 var(--font-serif);
    text-align: left;
    cursor: var(--cursor-cross-hover);
  }
  .thead:focus-visible {
    outline: 1px solid var(--c-accent);
    outline-offset: 2px;
  }
  .tmark {
    flex: 0 0 auto;
    padding-top: 1px;
  }
  .tq {
    flex: 1 1 auto;
    min-width: 0;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .talk:hover .tq,
  .talk.open .tq {
    color: var(--c-tx-hi);
  }
  .talk.open .tq {
    display: block;
    white-space: pre-wrap;
  }
  .tpage {
    flex: 0 0 auto;
    padding-top: 2px;
    font: 10.5px var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--c-tx-faint);
  }
  .tmeta {
    display: flex;
    align-items: baseline;
    gap: 0;
    padding-left: 21px;
    min-width: 0;
    color: var(--c-tx-muted);
    font: 10.5px var(--font-mono);
    white-space: nowrap;
  }
  .tmeta > span + span::before {
    content: "·";
    margin: 0 5px;
    color: var(--c-tx-faint);
  }
  .tfrom {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--c-tx-2);
  }
  .tstate[data-status="needs-input"] {
    color: var(--c-warning, #ad8301);
  }
  .tstate[data-status="claimed"] {
    color: var(--c-accent-bright);
  }
  .tbody {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 6px 2px 2px 21px;
    cursor: auto;
  }
  .tquote {
    margin: 0;
    padding-left: 9px;
    box-shadow: inset 2px 0 0 var(--c-line-strong);
    font: italic 12px/1.4 var(--font-serif);
    color: var(--c-tx-2);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  article {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .tby {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font: 10.5px var(--font-mono);
    color: var(--c-tx-muted);
  }
  .tby b {
    font: 600 11.5px var(--font-ui);
    color: var(--c-tx-2);
  }
  article.agent .tby b {
    color: var(--c-tx-hi);
  }
  .tbody :global(.agent-prose) {
    font: 12.5px/1.5 var(--font-serif);
    max-width: none;
    user-select: text;
    cursor: text;
  }
  .tbody :global(.agent-prose.you) {
    font: 12.5px/1.5 var(--font-serif);
    color: var(--c-tx-2);
  }
  .tnone {
    margin: 0;
    font: italic 12px var(--font-serif);
    color: var(--c-tx-muted);
  }
  .tacts {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 1px;
  }
  .spacer {
    flex: 1 1 auto;
  }
  .tbtn {
    height: 22px;
    padding: 0 9px;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
    background: transparent;
    color: var(--c-tx-2);
    font: 12px var(--font-serif);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
    transition: background-color 80ms linear, border-color 80ms linear, color 80ms linear;
  }
  .tbtn:hover {
    background: var(--c-surface);
    border-color: var(--c-tx-muted);
    color: var(--c-tx-hi);
  }
  .tbtn.quiet {
    border-color: transparent;
    color: var(--c-tx-muted);
  }
  .tbtn.quiet:hover {
    border-color: var(--c-danger);
    background: color-mix(in oklab, var(--c-danger) 12%, transparent);
    color: var(--c-danger);
  }
  @media (prefers-reduced-motion: reduce) {
    .tbtn {
      transition: none;
    }
  }
</style>
