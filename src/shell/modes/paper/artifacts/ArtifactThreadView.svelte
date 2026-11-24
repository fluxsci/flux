<script lang="ts">
  // One comment on an artifact page: what it is on, what was said, and what you can do. It is
  // the manuscript's comment thread view (CommentThreadView), fed an Inbox item: so a comment on
  // a page reads and answers exactly like one on your text. A new comment is written here too.
  import CommentThreadView from "../comments/CommentThreadView.svelte";
  import RecipientList from "../../../agent/RecipientList.svelte";
  import FluxAiMark from "../../../agent/FluxAiMark.svelte";
  import { annotationRoute, rememberRoute } from "../../../agent/annotationStore";
  import { describeRoute, type Route } from "../../../../lib/project/annotations";
  import { messageParts, threadSubject, type ArtifactTarget, type ArtifactThread, type ThreadPlace } from "../../../../lib/artifacts/comments";
  import type { CommentMessage } from "../comments/comments";
  import "../margin/marginKit.css";

  let { thread = null, draft = null, place = "here", lead = false, inRail = false, onSend, onCancel, onReply, onResolve, onReopen, onDelete, onGo, onLink, onInbox, onFocus }: {
    /** An existing comment, or … */
    thread?: ArtifactThread | null;
    /** … the target of one being written. */
    draft?: ArtifactTarget | null;
    place?: ThreadPlace;
    /** Take the keyboard when it appears (a card opened to write in). */
    lead?: boolean;
    /** Listed beside the page (where "Show" takes the page to it) and not in the card on its mark. */
    inRail?: boolean;
    onSend?: (text: string, route: Route) => void;
    onCancel?: () => void;
    onReply?: (text: string) => void;
    onResolve?: () => void;
    onReopen?: () => void;
    onDelete?: () => void;
    /** Take the page to this comment (its page, its view, its passage). */
    onGo?: () => void;
    /** A link in a message: take the page to that view (and page). */
    onLink?: (view: string, page?: string) => void;
    onInbox?: () => void;
    onFocus?: () => void;
  } = $props();

  const target = $derived(draft ?? thread!.target);
  const subject = $derived(threadSubject(target));
  const model = $derived({
    id: thread?.id ?? "draft",
    draft: !thread,
    resolved: thread?.resolved ?? false,
    anchor: { start: 0, end: 0, quote: subject.text, prefix: "", suffix: "" },
    messages: (thread?.item.thread ?? []).map((m) => ({ author: m.author, body: m.text, createdAt: m.ts, kind: m.kind })),
  });
  let routeOpen = $state(false);
  const route = $derived($annotationRoute);
  const none = () => {};
  const api = {
    onSubmitNew: (_id: string, text: string) => onSend?.(text, route),
    onCancelNew: () => onCancel?.(),
    onReply: (_id: string, text: string) => onReply?.(text),
    onResolve: () => onResolve?.(),
    onReopen: () => onReopen?.(),
    onDelete: () => onDelete?.(),
    onFocus: () => onFocus?.(),
    tagDefs: [], onEdit: none, onTags: none, onInbox: none, onDefineTag: () => "",
  };
  const pageName = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1).replace(/\.html?$/i, "");
  const about = $derived(subject.kind === "passage" ? "passage" : subject.kind === "element" ? (target.element?.what ?? "part of the page") : "page");
</script>

{#snippet recipient()}
  {#if thread}
    <span class="status" data-status={thread.item.status} title="Where this comment stands in the AI Inbox">{thread.item.chip || "In the Inbox"}</span>
  {:else}
    <div class="to">
      <button class="route" aria-expanded={routeOpen} aria-label="Who this comment goes to" title="Who this comment goes to. Every comment is kept in the AI Inbox." onclick={() => (routeOpen = !routeOpen)}>
        <FluxAiMark still size={12} tone={route === "none" ? "ready" : "live"} /><span class="mk-eyebrow">To</span><span class="name">{describeRoute(route)}</span>
        <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
      </button>
      {#if routeOpen}<div class="routes"><RecipientList label="Comment recipient" choose={(r) => { rememberRoute(r); routeOpen = false; }} /></div>{/if}
    </div>
  {/if}
{/snippet}

{#snippet body(msg: CommentMessage)}
  {#each messageParts(msg.body) as part}{#if "view" in part}<button class="viewlink" title={`Take the page to ${part.page ? part.page + part.view : part.view}`} onclick={(e) => { e.stopPropagation(); onLink?.(part.view, part.page); }}>{part.label}<svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M3 2h5v5M8 2L2.500 7.500" /></svg></button>{:else}{part.text}{/if}{/each}
{/snippet}

{#snippet more()}
  {#if thread && onGo && (inRail ? place !== "page" && place !== "lost" : place === "other-page" || place === "other-view")}<button class="act" onclick={onGo} title="Take the page to this comment">Show</button>{/if}
  {#if thread && onInbox}<button class="act" onclick={onInbox} title="Open it in the AI Inbox, with its picture">Inbox</button>{/if}
{/snippet}

<div class="athread" data-artifact-thread={model.id} data-place={place}>
  <p class="about mk-clip" title={subject.text}>
    <span class="mk-eyebrow">{thread ? "On" : "New comment on"}</span>
    {#if subject.kind === "passage"}<q>{subject.text.trim()}</q>{:else}<span class="what">{subject.text}</span>{/if}
  </p>
  {#if thread && (place === "other-page" || place === "other-view" || place === "lost")}
    <p class="where" data-where={place}>
      {#if place === "other-page"}<button onclick={onGo} title="Go to that page">on the page <b>{pageName(thread.page)}</b></button>
      {:else if place === "other-view"}<button onclick={onGo} title="Take the page to the view this was made on">made on the view <code>{thread.view || "the page as it opens"}</code></button>
      {:else}<span title="The page was rewritten and this is no longer in it. The comment and its picture are kept.">no longer on the page</span>{/if}
    </p>
  {/if}
  <CommentThreadView thread={model} {api} {lead} editable={false} {recipient} {body} {more} {about} onDone={none} />
</div>

<style>
  .athread { display: grid; gap: 8px; min-width: 0; }
  /* What it is about, in a line: the comment card's own first line. */
  .about { display: flex; align-items: baseline; gap: 7px; margin: 0; min-width: 0; padding-bottom: 7px; border-bottom: 1px solid var(--c-line); color: var(--c-tx-muted); font-size: var(--ts-xs); }
  .about q, .about .what { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .about q { font-style: italic; quotes: "“" "”"; }
  .about .what { color: var(--c-tx-2); }
  .where { margin: -3px 0 0; font-size: var(--ts-xs); color: var(--c-tx-faint); font-style: italic; }
  .where button { padding: 0; border: 0; background: none; font: inherit; color: var(--pane-c); cursor: var(--cursor-cross-hover); text-align: left; }
  .where button:hover { text-decoration: underline; }
  .where b { font-weight: 600; font-style: normal; }
  .where code { font: normal .95em var(--font-mono); }
  .status { display: inline-flex; align-items: center; height: calc(18px * var(--ts-scale, 1)); padding: 0 6px; border: 1px solid var(--mk-edge, var(--c-line-strong)); border-radius: var(--r-ui); font: var(--ts-xs) / 1 var(--font-serif); color: var(--c-tx-muted); white-space: nowrap; }
  .status[data-status="claimed"], .status[data-status="queued"] { border-color: color-mix(in oklab, var(--c-accent) 45%, transparent); color: color-mix(in oklab, var(--c-accent) 80%, var(--c-tx)); background: color-mix(in oklab, var(--c-accent) 9%, transparent); font-weight: 600; }
  .status[data-status="needs-input"] { border-color: color-mix(in oklab, var(--c-warning) 55%, transparent); color: var(--c-warning); background: color-mix(in oklab, var(--c-warning) 9%, transparent); font-weight: 600; }
  .status[data-status="resolved"] { color: var(--c-success); }
  .to { position: relative; display: grid; gap: 4px; }
  .route { justify-self: start; display: inline-flex; align-items: center; gap: 5px; height: calc(20px * var(--ts-scale, 1)); padding: 0 7px 0 4px; border: 1px solid color-mix(in oklab, var(--c-accent) 45%, transparent); border-radius: var(--r-ui); background: color-mix(in oklab, var(--c-accent) 9%, transparent); color: color-mix(in oklab, var(--c-accent) 80%, var(--c-tx)); font: var(--ts-xs) / 1 var(--font-serif); cursor: var(--cursor-cross-hover); }
  .route:hover { border-color: var(--c-accent); background: color-mix(in oklab, var(--c-accent) 15%, transparent); }
  .route .name { font-weight: 600; }
  .route svg { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .routes { border-radius: var(--r-1); overflow: hidden; box-shadow: var(--elev-2); }
  /* The thread view's own action buttons, for the two this view adds beside them. */
  .act { height: calc(22px * var(--ts-scale, 1)); padding: 0 6px; border: 0; border-radius: var(--r-1); background: none; color: var(--c-tx-muted); font: var(--ts-xs) var(--font-serif); white-space: nowrap; cursor: var(--cursor-cross-hover); transition: color 80ms linear, background 80ms linear; }
  .act:hover { color: var(--pane-c); background: var(--mk-tint-2); }
  .viewlink { display: inline-flex; align-items: baseline; gap: 3px; margin: 0 1px; padding: 0 5px; border: 1px solid color-mix(in oklab, var(--pane-c) 40%, transparent); border-radius: var(--r-ui); background: color-mix(in oklab, var(--pane-c) 7%, transparent); color: var(--pane-c); font: inherit; font-size: .95em; cursor: var(--cursor-cross-hover); }
  .viewlink:hover { background: color-mix(in oklab, var(--pane-c) 15%, transparent); border-color: var(--pane-c); }
  .viewlink svg { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  .viewlink:focus-visible, .route:focus-visible, .where button:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 1px; }
</style>
