# Review: annotations, comments and live pairing (stock — shipped with Flux, do not edit)

Handle review items only when asked. Connecting reads the queue for context; it does
not start work or watch it. CONNECT.md is the behavior contract. Use the unified
inbox for discovery so annotations and secondary-document comments are not missed.

## What a packet holds

An **annotation** comes from Ctrl+Shift+M in the app. Its stamp records the surface,
selection and exact `targets`: a figure, plot part, text box, caption block, document
range, slide, beat, animation track, Reader passage or library item. Snapshot marks
carry numbered arrows/boxes/pen strokes and their anchors. Treat the saved picture
as the view at capture time; inspect the current target before editing.

`list_inbox {packets:true}` and `wait_for_inbox` return item packets with threads and
current saved target state. Up to six snapshots are attached inline as PNGs with a
1600 px maximum long edge. Look at the images, including their numbered marks.
For another image, use `flux_verb {verb:"get_inbox_image",args:{id:"<item-id>"}}`;
`get_inbox_image` is not in the compact core toolset. With full tools, call it directly.
Without MCP, read `flux inbox --json` and open the snapshot path with an image viewer.
A missing image does not erase semantic targets; report the missing view if it matters.

`get_target {target:…}` (in the core toolset through `flux_verb`) / `flux inspect <target>` reads current saved state without
rendering. Pass the packet's TargetRef, or a shorthand such as
`part:fig-2/el-9#control` or `doc:paper/notes.qmd@120-180`. Do not guess which object
an arrow means from a nearby name when the packet already supplies its identity.

A **comment** is a Paper margin thread beside its document in
`<base>.comments.json`; legacy mains also use `comments.json`. It never lives inside
the `.qmd`. The anchor contains `start`, `end`, the exact `quote`, and nearby
`prefix`/`suffix`; messages carry author, body and time. Re-read the quote in context
before changing prose. If offsets drifted, use the quote and surrounding text;
ask when the target is ambiguous. Comments on Context documents count too.

`comments` / `list_comments` reads all project documents unless narrowed by `--doc`.
`resolve-comment` resolves only a unique project-wide match when no document is
given. A promoted main document retains discovery of its document-named threads.
Prefer inbox claim/reply/resolve for coordinated work; use the comment tools when
working specifically with margin anchors. Never rewrite sidecars manually.

For a new question about prose, use
`flux add-comment --quote "exact doc text" --body "question" --doc paper/report.qmd`.
Use `--at` to disambiguate a repeated quote. For a question about an existing item,
reply in that item's thread with needs-input instead of opening a second discussion.

## Status, routing and ownership

| Status or state | Meaning / action |
|---|---|
| Open | Pending, without a live assignee/claim; act only within the user's request. |
| Queued | Assigned to a named session; leave other sessions' queues alone. |
| Claimed | Work is held by the named agent; claim successfully before editing. |
| Needs-input | The holder asked a question; wait for the answer on this item and handle others. |
| Resolved | The requested work is done; the closing note says what changed. |
| Withdrawn | The user took the annotation back; do not work on or resolve it. |
| Archived | Hidden from default views without implying completion; archive/unarchive only when asked. |

Routes are **Inbox**, **Any watching agent** (`@any`), **a named session** (`@heron`),
or **a new background agent (when enabled)** (`@new`). Inbox-only items never wake
a watcher. A named route is that session's queue even before it starts watching;
`--mine` selects items assigned to or claimed by your session. Background items are
for the background run, not a competing external watcher.

Explicit MCP project connect publishes presence, with a name in the receipt such
as `claude·cli·heron`. Use that identity in replies. A heartbeat or recent item
activity keeps a claim live. A disconnected/stale holder may leave an Open item with
its last holder retained for context; let the claim tool arbitrate a takeover.
`claimed:false` means skip it. Use `--force` only on explicit user instruction.
`release` relinquishes your claim. A user-released/revoked session must stop writing
that item; it cannot silently reclaim it.

The annotation ledger is append-only at `.meta/feedback.ndjson`; snapshots live
under `.meta/feedback/`. Comment messages remain in their document sidecars; inbox
status/claim overlays use the ledger. Use tools to preserve this split.

## Turn the request into filters

| Request | CLI | MCP list arguments |
|---|---|---|
| Address open annotations and comments | `flux inbox --json` | `{packets:true}` |
| Only comments in draft_1 | `flux inbox --kind comment --doc draft_1 --json` | `{filter:{kind:"comment",doc:"draft_1"},packets:true}` |
| Made in Figure / Slides | `flux inbox --surface figure` / `--surface slide` | `{filter:{surface:"figure"},packets:true}` |
| On Figure 3 | `flux inbox --figure "Figure 3"` | `{filter:{figure:"Figure 3"},packets:true}` |
| Tagged #stats | `flux inbox --tag stats` | `{filter:{tag:["stats"]},packets:true}` |
| In this deck | `flux inbox --deck <id>` | `{filter:{deck:"<id>"},packets:true}` |
| The one I just made | `flux inbox --since <ISO-timestamp> --json` | `{filter:{since:"<ISO-timestamp>"},packets:true}` |
| Check your queue | `flux inbox --mine --json` | `{mine:true,packets:true}` |
| Include resolved or withdrawn | `flux inbox --status all` | `{filter:{status:"all"}}` |
| Search saved text | `flux inbox --text "axis title"` | `{filter:{text:"axis title"},packets:true}` |

`since` must be an ISO timestamp with a timezone; compute it for the requested window.
Items sort by status, then newest within that status: for "the one I just made",
compare timestamps across groups. Default statuses are open, queued, claimed and
needs-input, with archived items hidden. `--archived` includes archives. Additional
filters include `--holder` and `--claimed me|others|none|any`.

Plain-language queries also work: `flux inbox 'draft_1 #stats figure'`, or
`list_inbox {query:"draft_1 #stats figure",packets:true}`. Check the returned filter
and item locations before acting; explicit flags are useful when a phrase is ambiguous.

## Work one item

1. **Claim:** `claim_item {id,note:"Checking the labels."}` or
   `flux claim <id> --note "Checking the labels."`. Inspect the result; move on if refused.
2. **Read and act:** use the packet's targets, thread and image. Do exactly the request;
   read the appropriate authoring manual before changing plots, prose or slides.
3. **Look:** render and inspect the changed figure/canvas, re-read the paragraph or
   check the slide. A successful write alone is not verification.
4. **Resolve or ask:** `resolve_item {id,note:"Updated the labels and checked the figure."}`
   or `flux resolve <id> --note "…"`. If a decision is missing, use
   `reply_item {id,text:"Which scale should I use?",needsInput:true}` or
   `flux reply <id> "Which scale should I use?" --needs-input`. Do not resolve unfinished work.

The app shows named status chips and toasts: Queued → heron, Claimed by heron,
heron needs your input, Resolved by heron. Margin comments refresh in Paper, and the
Inbox panel (Alt+Q) shows annotations and comments together with their threads and
chips. Let a user composing a reply finish; do not replace their sidecar.

## Watch-mode protocol — only when asked

1. **Choose and announce the scope.** "Watch my queue" uses `mode:"queue"`;
   "watch my annotations" uses `mode:"annotations"`; a narrowed request uses
   `mode:"filter"` with `filter` or `query`. The latter two include your named queue
   plus matching `@any` items. Named assignments reach you regardless of the filter;
   they are explicit requests. Inbox-only items remain passive.
2. **List pending work first.** Call `list_inbox {mine:true,packets:true}` for your
   queue, or list with the requested filter for annotations/filter mode. Handle only
   your assignments/claims and matching any-route items. An explicit request to also
   address existing Inbox-only items authorizes those for this initial pass.
3. **Wait.** Loop on `wait_for_inbox` with the chosen mode and filter. The MCP session
   retains a cursor; the CLI variant is `flux wait-inbox --mode annotations --timeout 540
   --cursor <previous-cursor>`. Omit the cursor on the first CLI wait, then pass the
   returned cursor unchanged. An empty timeout means wait again, not that watching ended.
4. **Claim, work, look, reply/resolve.** Use the full packet, call `claim_item`, make
   the requested change, inspect the result, then `resolve_item` or `reply_item` with
   `needsInput:true`. Do not repeat work or questions for an unchanged packet. Track
   items waiting for the user's answer and continue other items meanwhile.
5. **Honor revocation and stop.** Stop writing any item named in `revoked`. Stop the
   loop when told, or when the wait returns `stopped: true`. Do not reconnect or
   restart watching to evade a Stop watching/release action. Report what remains pending.

## Live mode — the user means "this", "here" or "look"

With the app open on this project, start each live turn with `get_app_context`.
Use its surface, selection and targets to identify what the user means. When the user
says this/here/look/what I'm seeing, call `get_view`: it captures the project's Flux
window (unsaved edits included, and while Annotate is open) with its context. Each view
shows "◉ <session name> viewed your window" to the user for two seconds; with Settings →
"Allow agents to view the Flux window" off it refuses with `live-view-disabled`. For a
saved figure or canvas at full resolution, `get_figure_image` / `get_canvas_image`. For
text, read the target/document; Reader's current passage is available through
`get_reading_context` (use `flux_verb` if absent from core).

Sessions connected with `--live` show a **Pairing** badge in Annotate's To: menu:
choose the session there to hand it an annotation directly.

Prefer `dispatch_command` for visible, undoable Figure edits. Discover its exact
allow-list with `flux_verbs {query:"dispatch_command"}`; pass `{command:{type:…}}`.
`act_on_selection` is the convenience tool for the drilled-in plot part, reachable
through `flux_verb`. Say what you will change before doing it. There is no general
live prose/comment dispatch: use the file verbs for those tasks.

If the bridge is unavailable, use saved-file verbs and say the live view is unavailable.
Regenerating data still uses `rerun-plot`, followed by `sync-figure` as needed; a live
restyle changes appearance, not the underlying analysis.
