// The transcript model and the inert Markdown renderer every AI surface shares
// (Ask, the Inbox's background activity, the kept thread). Pure: the reducer
// runs on a fake clock, the renderer builds into a linkedom document.
import { parseHTML } from "linkedom";
import { harness } from "./lib/harness.mjs";
import { emptyTranscript, askTurn, reduceTranscript, cancelTranscript, openTurn, toolSummary, toolKind, toolName, toolImages,
  toolGroupSummary, toolGroupStatus, toolDetail, lastAnswer, transcriptMessages, transcriptMarkdown, transcriptActivity,
  type Transcript } from "../src/lib/agent/transcript";
import { renderMarkdown, markdownText } from "../src/lib/agent/markdownDom";
import { shortTarget, targetPrompt } from "../src/lib/project/targets";
import type { RunnerPayload } from "../src/lib/project/types";

const h = harness("verify-transcript");
const fold = (t: Transcript, events: RunnerPayload[], now = 1000) => events.reduce((acc, e) => reduceTranscript(acc, e, now), t);

h.section("reducer: a question, streamed deltas, tools and a completed envelope");
let t = askTurn(emptyTranscript(), "Why is this different?", { now: 1 });
h.eq(t.turns.map(x => x.role), ["human", "agent"], "a question opens a human turn and the agent turn that answers it");
h.eq(t.state, "starting", "the run is starting until the runner reports");
t = fold(t, [{ type: "session", sessionId: "s-1" }, { type: "status", state: "running" }]);
h.eq([t.sessionId, t.state], ["s-1", "running"], "session and running status are recorded");
t = fold(t, [{ type: "thought.delta", text: "Let me look " }, { type: "thought.delta", text: "at the figure." }]);
h.eq(openTurn(t)!.blocks.map(b => b.kind), ["thinking"], "consecutive thinking deltas fold into one thinking block");
h.eq((openTurn(t)!.blocks[0] as { text: string }).text, "Let me look at the figure.", "thinking text accumulates");
t = fold(t, [
  { type: "tool", toolId: "t1", title: "mcp__flux__get_figure_image", input: { id: "fig-1" }, status: "started" },
  { type: "tool", toolId: "t2", title: "Read", input: { file_path: "/p/paper/draft.qmd", offset: 120, limit: 30 }, status: "started" },
]);
h.eq(openTurn(t)!.blocks.map(b => b.kind), ["thinking", "tools"], "a tool call after thinking closes it and opens a tool group");
h.ok(!(openTurn(t)!.blocks[0] as { streaming: boolean }).streaming, "the thinking block stops streaming when a tool starts");
h.eq((openTurn(t)!.blocks[1] as { calls: unknown[] }).calls.length, 2, "consecutive tool calls join the same group");
t = fold(t, [{ type: "tool", toolId: "t1", title: "mcp__flux__get_figure_image", input: { id: "fig-1" }, status: "done", output: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] }]);
const group = openTurn(t)!.blocks[1] as { calls: { id: string; status: string; images: string[] }[] };
h.eq(group.calls.map(c => c.status), ["done", "started"], "a finished tool updates its own row in place");
h.eq(group.calls[0].images, ["data:image/png;base64,iVBORw0KGgo="], "an image block in a tool result becomes a data URL the surface can show");
h.eq(toolGroupStatus(group.calls as never), "started", "a group with a running call reads as running");
t = fold(t, [{ type: "tool", toolId: "t2", title: "Read", input: { file_path: "/p/paper/draft.qmd", offset: 120, limit: 30 }, status: "done", output: "lines" }]);
h.eq(toolGroupStatus((openTurn(t)!.blocks[1] as { calls: never }).calls), "done", "…and done once every call finished");
t = fold(t, [{ type: "message.delta", messageId: "m1", text: "**Answer**" }, { type: "message.delta", messageId: "m1", text: " with `code`" }]);
h.eq(openTurn(t)!.blocks.map(b => b.kind), ["thinking", "tools", "text"], "prose after tools is a new text block");
h.eq((openTurn(t)!.blocks[2] as { text: string; streaming: boolean }).text, "**Answer** with `code`", "message deltas accumulate");
h.ok((openTurn(t)!.blocks[2] as { streaming: boolean }).streaming, "a delta-fed block is streaming");
t = fold(t, [{ type: "message", messageId: "m1", text: "**Answer** with `code` and more" }]);
h.eq(openTurn(t)!.blocks.filter(b => b.kind === "text").length, 1, "the completed envelope replaces its streamed text (never duplicates)");
h.ok(!(openTurn(t)!.blocks[2] as { streaming: boolean }).streaming, "a completed message is no longer streaming");
h.eq(transcriptActivity(t), "Working…", "between a completed message and idle the line reads as working");
t = fold(t, [{ type: "usage", costUsd: 0.0123, inputTokens: 1200, outputTokens: 80 }, { type: "status", state: "idle" }], 5000);
const done = t.turns[1];
h.eq([done.state, done.endedAt, t.state], ["done", 5000, "idle"], "idle closes the agent turn with its end time");
h.eq(done.usage, { costUsd: 0.0123, inputTokens: 1200, outputTokens: 80 }, "usage lands on the turn");
h.eq(lastAnswer(t), "**Answer** with `code` and more", "lastAnswer is the agent's prose");
h.eq(transcriptMessages(t).map(m => m.role), ["human", "agent"], "messages are the question/answer pairs (what Keep saves)");
h.ok(transcriptMarkdown(t).includes("**You**") && transcriptMarkdown(t).includes("> get_figure_image · Read 1 file") && transcriptMarkdown(t).includes("**Answer**"), "copy-as-markdown names both voices and summarises tools");

h.section("reducer: a second question, a failure, Stop");
t = askTurn(t, "And this?", { now: 6000, images: ["blob:x"] });
h.eq(t.turns.length, 4, "a follow-up appends a new pair");
h.eq(t.turns[2].images, ["blob:x"], "a human turn keeps its attached pictures");
h.eq(transcriptActivity({ ...t, reason: "Preparing agent…" }), "Preparing agent…", "while starting, the activity line is the runner's reason");
t = fold(t, [{ type: "status", state: "running" }, { type: "tool", toolId: "t3", title: "Grep", input: { pattern: "TODO", path: "/p/paper" }, status: "started" }]);
h.eq(transcriptActivity(t), "Searching TODO in p/paper…", "a running search names what it searches");
t = fold(t, [{ type: "error", message: "Claude Code failed" }, { type: "status", state: "failed" }], 7000);
h.eq([t.state, t.error, t.turns[3].state], ["failed", "Claude Code failed", "failed"], "an error closes the turn as failed and keeps the message");
h.eq(t.turns[3].blocks.map(b => b.kind), ["tools", "error"], "the error is a block after the tools");
t = askTurn(t, "Try again", { now: 8000 });
t = fold(t, [{ type: "message.delta", messageId: "m9", text: "Half an ans" }]);
h.eq(transcriptActivity(t), "Writing…", "streaming prose reads as writing");
t = cancelTranscript(t, 9000);
h.eq([t.state, t.turns[5].state, (t.turns[5].blocks[0] as { streaming: boolean }).streaming], ["cancelled", "cancelled", false], "Stop cancels the open turn and stops its streaming");
const lone = fold(emptyTranscript(), [{ type: "message", text: "Hello from a resumed session" }]);
h.eq(lone.turns.map(x => x.role), ["agent"], "events without a question open an agent turn (a background task)");

h.section("tool descriptions");
h.eq(toolName("mcp__flux__get_figure_image"), "get_figure_image", "Claude's MCP prefix is dropped");
h.eq(toolName("flux.list_inbox"), "list_inbox", "Codex's prefix is dropped");
h.eq([toolKind("mcp__flux__get_view"), toolKind("Read"), toolKind("Grep"), toolKind("Glob"), toolKind("Edit"), toolKind("Bash"), toolKind("WebFetch"), toolKind("Mystery")], ["flux", "read", "search", "search", "edit", "shell", "web", "other"], "tool kinds by name");
h.eq(toolSummary("Read", { file_path: "/home/u/proj/paper/draft.qmd", offset: 120, limit: 40 }), "paper/draft.qmd:120–160", "Read summarises as path:lines");
h.eq(toolSummary("Grep", { pattern: "needsLayout", path: "/home/u/proj/src/lib" }), "needsLayout in src/lib", "Grep summarises pattern and place");
h.eq(toolSummary("Bash", { command: "ls   -la\n/tmp" }), "ls -la /tmp", "Bash summarises the command on one line");
h.eq(toolSummary("mcp__flux__get_figure_image", { id: "fig-2", maxEdge: 1600 }), "fig-2", "a Flux figure tool names the figure by its id");
h.eq(toolSummary("mcp__flux__search_references", { query: "sleep homeostasis" }), "“sleep homeostasis”", "a Flux search quotes its query");
h.eq(toolSummary("Other", "plain string"), "plain string", "a string input is shown as is");
h.eq(toolSummary("Other", { a: 1, b: "two", c: { nested: true } }), "a: 1 · b: two", "an unknown shape shows its first scalar fields");
h.ok(toolSummary("Bash", { command: "x".repeat(200) }).length <= 72, "summaries are clipped");
h.eq(toolImages({ content: [{ type: "text", text: "ok" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "abc" } }] }), ["data:image/jpeg;base64,abc"], "nested image blocks are found");
h.eq(toolImages("data:image/png;base64,QUJD"), ["data:image/png;base64,QUJD"], "a bare data URL string counts");
h.eq(toolImages({ type: "image", source: { type: "base64", media_type: "text/html", data: "x" } }), [], "non-image media is ignored");
h.eq(toolGroupSummary([
  { kind: "read", name: "Read" }, { kind: "read", name: "Read" }, { kind: "read", name: "Read" }, { kind: "search", name: "Grep" }, { kind: "flux", name: "get_figure_image" }, { kind: "flux", name: "get_figure_image" },
] as never), "Read 3 files · Searched once · get_figure_image ×2", "group summaries count by kind and name Flux tools");
h.ok(toolDetail({ output: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x".repeat(100) } }] }).includes("(image)") && !toolDetail({ big: "data:image/png;base64," + "y".repeat(100) }).includes("yyyy"), "detail text replaces image payloads with a marker");
h.ok(toolDetail("z".repeat(5000)).endsWith("more characters)") && toolDetail("z".repeat(5000)).length < 4100, "detail text is capped with a count");
h.eq(toolDetail([{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }]), "line 1\nline 2", "text-block results read as text");

h.section("markdown → inert DOM");
const { document } = parseHTML("<html><body></body></html>");
const render = (src: string) => { const host = document.createElement("div"); host.appendChild(renderMarkdown(src, document as unknown as Document, { linkAttr: "data-external" })); return host; };
let el = render("# Title\n\nA paragraph with **bold**, _em_, `code`, ~~gone~~ and snake_case_name.\nSecond line.\n\n## Sub");
h.eq(el.querySelector("h1")?.textContent, "Title", "ATX heading");
h.eq(el.querySelectorAll("p").length, 1, "lines without a blank between them are one paragraph");
h.ok(el.querySelector("p")?.textContent?.includes("bold, em, code, gone and snake_case_name. Second line."), "soft breaks join with a space; snake_case keeps its underscores");
h.eq([!!el.querySelector("strong"), !!el.querySelector("em"), !!el.querySelector("code"), !!el.querySelector("s")], [true, true, true, true], "inline bold / em / code / strike");
h.eq(el.querySelector("h2")?.textContent, "Sub", "second-level heading");
el = render("Steps:\n\n1. First\n2. Second\n   - nested a\n   - nested b\n3. Third\n\n- [x] done task\n- [ ] open task");
h.eq(el.querySelectorAll("ol > li").length, 3, "ordered list items");
h.eq(el.querySelectorAll("ol > li > ul > li").length, 2, "a nested list by indent");
h.eq([...el.querySelectorAll("ul > li[data-task]")].map(li => li.getAttribute("data-task")), ["done", "open"], "task items");
el = render("Look:\n\n```python\nimport numpy as np\nx = \"<b>\"\n```\n\n> quoted **wisdom**\n> continues\n\n---\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n| 3 | 4 |");
h.eq(el.querySelector("pre")?.getAttribute("data-lang"), "python", "fenced code keeps its language");
h.eq(el.querySelector("pre code")?.textContent, 'import numpy as np\nx = "<b>"', "code content is verbatim text (no formatting, no HTML)");
h.ok(!el.querySelector("pre b"), "HTML inside a code fence is not markup");
h.ok(el.querySelector("blockquote strong")?.textContent === "wisdom" && el.querySelector("blockquote")?.textContent?.includes("continues"), "block quotes render their inline markdown and join lines");
h.ok(!!el.querySelector("hr"), "a rule");
h.eq(el.querySelectorAll("table thead th").length, 2, "table header cells");
h.eq(el.querySelectorAll("table tbody tr").length, 2, "table body rows");
h.eq(el.querySelector("table tbody td:last-child")?.getAttribute("style"), "text-align:right", "column alignment from the separator row");
el = render('Evil <img src=x onerror=alert(1)> and <script>alert(2)</script> and [click](javascript:alert(3)) and [ok](https://example.org/a?b=1) and https://flux.sci/x.');
h.ok(!el.querySelector("img, script"), "HTML in the text is never markup");
h.ok(el.textContent?.includes("<img src=x onerror=alert(1)>") && el.textContent?.includes("<script>"), "…it stays literal text");
h.ok(!el.querySelector("a[href^='javascript']") && el.textContent?.includes("click (javascript:alert(3))"), "non-http links are plain text with the URL shown");
const links = [...el.querySelectorAll("a")];
h.eq(links.map(a => a.getAttribute("href")), ["https://example.org/a?b=1", "https://flux.sci/x"], "http(s) links and bare URLs are anchors (a trailing period is not part of the URL)");
h.ok(links.every(a => a.hasAttribute("data-external") && a.getAttribute("rel") === "noopener noreferrer"), "anchors carry the external marker and rel");
el = render("```js\nconst a = 1;\n");
h.eq(el.querySelector("pre code")?.textContent, "const a = 1;", "an unclosed fence (mid-stream) still renders as code");
el = render("Line one  \nLine two\\\nLine three");
h.eq(el.querySelectorAll("p br").length, 2, "two trailing spaces or a backslash make a hard break");
h.eq(markdownText("# Hi\n\n**bold** [l](https://x) `c`"), "Hi\n\nbold l c", "markdownText strips the markup");
h.ok(render("").childNodes.length === 0, "empty input renders nothing");

h.section("short target labels (names, never ids)");
h.eq(shortTarget({ kind: "part", figureId: "fig_1", elementId: "el_9", partId: "pt_3", role: "point", label: "versicolor", elementName: "Density" }), 'plot "Density" › point "versicolor"', "a plot part names plot and part");
h.eq(shortTarget({ kind: "figure", figureId: "fig_x", name: "Annotation figure" }), 'figure "Annotation figure"', "a figure by name");
h.eq(shortTarget({ kind: "figure", figureId: "fig_x" }), "figure fig_x", "…or by id when unnamed");
h.eq(shortTarget({ kind: "passage", citekey: "Simons2005", page: 3, quote: "Change blindness" }), "“Change blindness” · Simons2005 p.3", "a passage shows its words, then citekey and page");
h.eq(shortTarget({ kind: "passage", citekey: "Simons2005", page: 3 }), "Simons2005 p.3", "…or just citekey and page without a quote");
h.eq(shortTarget({ kind: "doc", path: "paper/draft_1.qmd", from: 10, to: 40, quote: "We show that" }), "“We show that” · draft_1.qmd", "a doc selection shows its words and file");
h.eq(shortTarget({ kind: "doc", path: "paper/draft_1.qmd", from: 10, to: 40, heading: "Methods" }), 'draft_1.qmd § "Methods"', "a doc target is its file and heading");
h.eq(shortTarget({ kind: "slide", deckId: "d", slideId: "s", index: 2, name: "Results" }), 'slide 3 "Results"', "a slide is one-based with its name");
h.eq(targetPrompt([{ kind: "passage", citekey: "a", page: 1 }]), "Ask about this passage…", "a passage invites a question about it");
h.eq(targetPrompt([{ kind: "part", figureId: "f", elementId: "e", partId: "p", elementName: "Density", role: "series", label: "control" }]), 'Ask about plot "Density" › series "control"…', "a part invites by its short label");
h.eq(targetPrompt(undefined, "Annotate"), "Annotate what you see…", "no target: the view");

await h.done();
