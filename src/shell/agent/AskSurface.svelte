<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { closeAsk, type AskRequest } from "./askChord";
  import { fileBridge, type RunnerDriver, type RunnerEvent } from "../../lib/project/types";
  import { askPacket, type AskMessage } from "../../lib/project/ask";
  import { describeStamp, type ContextStamp } from "../../lib/project/annotations";
  import { anchorPanel, reanchorPanel } from "../../lib/ui/anchor";
  import { mdInlineFragment } from "../modes/paper/science/mdInline";
  import { modalFocus } from "../../lib/ui/modalFocus";
  import { fullscreenPortal } from "../../lib/ui/portal";
  import { initAnnotationStore, keepAsk } from "./annotationStore";
  let { request }: { request: AskRequest } = $props();
  const req = untrack(() => request);
  const fb = fileBridge();
  type ToolEvent = Extract<RunnerEvent, { type: "tool" }>;
  // One list in arrival order, so each turn reads question → tools it used → answer.
  let entries = $state<({ key: string; message: AskMessage; tool?: undefined } | { key: string; tool: ToolEvent; message?: undefined })[]>([]);
  const messages = $derived(entries.flatMap(e => e.message ? [e.message] : []));
  let busy = $state(false), keeping = $state(false), error = $state(""), reason = $state("");
  let sessionId = $state(""), driver = $state<RunnerDriver>("claude"), copied = $state(false);
  let runId: string | null = null, disposed = false, turn = 0, seq = 0, generation = 0;
  let prepared: Promise<void> | null = null;
  let preview = $state("");
  const pending: RunnerEvent[] = [];
  const stamp: ContextStamp = structuredClone(req.stamp);
  const shot = req.shot.then(async image => {
    if (!image) return undefined;
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(image.png)], { type: "image/png" }));
    try {
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("Could not capture Ask view")), "image/png"));
      const png = new Uint8Array(await blob.arrayBuffer());
      stamp.snapshot = { image: null, rect: { x: 0, y: 0, w: req.size.w, h: req.size.h }, window: req.size, marks: [] };
      if (!disposed) preview = URL.createObjectURL(blob);
      return png;
    } finally { bitmap.close(); }
  }).catch(e => { if (!disposed) error = String(e); return undefined; });

  function receive(event: RunnerEvent) {
    if (disposed) return;
    if (!runId) { if (pending.length < 200) pending.push(event); return; }
    if (event.runId !== runId || event.seq <= seq) return;
    seq = event.seq;
    if (event.type === "session") sessionId = event.sessionId;
    else if (event.type === "message" || event.type === "message.delta") {
      const id = `${turn}:${event.messageId ?? "answer"}`;
      const i = entries.findIndex(e => e.message?.id === id);
      if (i < 0) entries = [...entries, { key: `a:${id}`, message: { role: "agent", id, text: event.text } }];
      else { const m = entries[i].message!; entries[i] = { key: entries[i].key, message: { ...m, text: event.type === "message" ? event.text : m.text + event.text } }; }
    } else if (event.type === "tool") {
      const id = `${turn}:${event.toolId}`, i = entries.findIndex(e => e.tool?.toolId === id);
      const next = { ...event, toolId: id };
      if (i < 0) entries = [...entries, { key: `t:${id}`, tool: next }]; else entries[i] = { key: entries[i].key, tool: next };
    } else if (event.type === "error") { error = event.message; busy = false; }
    else if (event.type === "status") {
      if (event.reason) reason = event.reason;
      if (["idle", "done", "failed", "cancelled"].includes(event.state)) { busy = false; reason = event.reason ?? ""; }
    }
  }
  const unsubscribe = fb?.onRunnerEvent?.(receive);
  async function prepare(warmOnly = false) {
    if (prepared) return prepared;
    const started = generation;
    prepared = (async () => {
      if (!fb?.runnerStart || !fb.runnerCapabilities) throw new Error("Ask requires the desktop app with Claude Code or Codex installed and signed in");
      const [caps, prefs] = await Promise.all([fb.runnerCapabilities(), fb.prefsGet?.()]);
      if (disposed || started !== generation) return;
      const saved = (prefs?.fluxchat as { driver?: RunnerDriver } | undefined)?.driver;
      const cap = saved ? caps.find(c => c.driver === saved) : caps.find(c => c.available);
      if (!cap?.available) throw new Error(cap?.reason || "Install and sign in to Claude Code or Codex, then choose it in Settings → Agent that Flux launches");
      driver = cap.driver;
      if (disposed || (warmOnly && driver !== "claude")) return;
      const run = await fb.runnerStart({ driver, mode: "ask", root: req.root, firstMessage: "", ...(sessionId ? { resume: sessionId } : {}) });
      if (disposed || started !== generation) { await fb.runnerCancel?.({ runId: run.runId }); return; }
      runId = run.runId; seq = 0;
      for (const event of pending.splice(0)) receive(event);
    })().finally(() => { prepared = null; });
    return prepared;
  }
  async function warm() {
    const started = generation;
    try { if (!runId) await prepare(true); } catch (e) { if (!disposed && started === generation) error = (e as Error).message; }
  }
  async function send() {
    const text = req.input.value.trim();
    if (!text || busy || keeping || disposed) return;
    const started = generation;
    busy = true; error = ""; reason = "Preparing agent…";
    req.input.value = "";
    entries = [...entries, { key: `q:${turn}`, message: { role: "human", text } }]; turn++;
    try {
      if (!runId) await prepare();
      if (disposed || started !== generation) return;
      // A Codex pre-warm probes capabilities only; Send starts its process.
      if (!runId && !disposed) await prepare();
      const png = await shot;
      if (disposed || started !== generation || !runId) return;
      busy = true; reason = "Reading the captured context…";
      await fb!.runnerSend!({ runId, text: askPacket(text, stamp), ...(png ? { images: [{ png }] } : {}) });
    } catch (e) { if (!disposed && started === generation) { error = (e as Error).message; busy = false; } }
  }
  async function stop() {
    generation++;
    pending.length = 0;
    const id = runId; runId = null; busy = false; reason = "Stopped";
    if (id) try { await fb?.runnerCancel?.({ runId: id }); } catch (e) { if (!disposed) error = (e as Error).message; }
  }
  async function keep() {
    if (keeping || busy) return;
    keeping = true; error = "";
    try {
      const png = await shot;
      if (disposed) return;
      await keepAsk(req.root, $state.snapshot(messages), stamp, driver === "claude" ? "Claude Code" : "Codex", png);
      closeAsk();
    } catch (e) { error = (e as Error).message; keeping = false; }
  }
  async function copyResume() {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return;
    try { await navigator.clipboard.writeText(driver === "claude" ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`); copied = true; }
    catch (e) { error = `Could not copy: ${(e as Error).message}`; }
  }
  /** "get_figure_image", not "mcp__flux__get_figure_image" (Claude) or "flux.get_figure_image" (Codex). */
  const toolName = (title: string) => title.replace(/^mcp__flux__|^flux\./, "");
  function markdown(node: HTMLElement, text: string) {
    const update = (value: string) => node.replaceChildren(mdInlineFragment(value));
    update(text); return { update };
  }
  function attachInput(node: HTMLElement) {
    const focused = document.activeElement === req.input;
    node.append(req.input); req.bootstrap.remove();
    if (focused) req.input.focus({ preventScroll: true });
  }
  function place(node: HTMLElement) {
    let at = anchorPanel({ avoid: req.avoid, size: { w: node.offsetWidth, h: node.offsetHeight }, viewport: { w: innerWidth, h: innerHeight } });
    const layout = () => {
      at = { ...at, ...reanchorPanel(at, { avoid: req.avoid, size: { w: node.offsetWidth, h: node.offsetHeight }, viewport: { w: innerWidth, h: innerHeight } }) };
      node.style.left = `${at.x}px`; node.style.top = `${at.y}px`;
    };
    layout(); const observer = new ResizeObserver(layout); observer.observe(node); window.addEventListener("resize", layout);
    return { destroy() { observer.disconnect(); window.removeEventListener("resize", layout); } };
  }
  initAnnotationStore();
  req.onInput = () => void warm(); req.onSubmit = () => void send();
  const dispose = () => { if (disposed) return; disposed = true; unsubscribe?.(); void stop(); if (preview) URL.revokeObjectURL(preview); };
  req.onClose = dispose;
  if (req.typed) void warm();
  if (req.submitPending) { req.submitPending = false; void tick().then(send); }
  onDestroy(dispose);
</script>

<div class="ask-layer" use:fullscreenPortal>
  <div class="ask-backdrop" aria-hidden="true"></div>
  <div class="ask-panel" data-ask-surface role="dialog" aria-modal="true" aria-label="Ask about this" tabindex="-1" use:place use:modalFocus>
    <header><strong>Ask about this</strong><span>read-only</span><button aria-label="Close Ask" title="Discard this exchange. The CLI's own session history remains." onclick={closeAsk}>×</button></header>
    <div class="context" title={describeStamp(stamp)}>{describeStamp(stamp)}</div>
    {#if preview}<details class="view"><summary>Captured view</summary><img src={preview} alt="View captured when Ask opened" /></details>{/if}
    <div class="exchange" aria-live="polite" aria-relevant="additions text">
      {#each entries as entry (entry.key)}
        {#if entry.message}<div class:question={entry.message.role === "human"} class="message" use:markdown={entry.message.text}></div>
        {:else}{@const tool = entry.tool}
        <details class="tool-line"><summary>{tool.status === "started" ? "Reading" : tool.status === "failed" ? "Failed" : "Used"} · {toolName(tool.title)} · {typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input)}</summary>
          <pre>{JSON.stringify({ input: tool.input, output: tool.output }, null, 2)}</pre>
        </details>{/if}
      {/each}
    </div>
    {#if busy || reason}<div class="progress" role="status">{busy ? reason || "Working…" : reason}</div>{/if}
    {#if error}<div class="error" role="alert">{error}</div>{/if}
    <div class="input" use:attachInput></div>
    <footer>
      <span>Enter sends · Shift+Enter newline</span>
      {#if busy}<button onclick={() => void stop()}>Stop</button>{:else}<button onclick={() => void send()}>Ask</button>{/if}
      <button disabled={busy || keeping || !messages.some(m => m.role === "agent" && m.text.trim())} onclick={() => void keep()}>{keeping ? "Keeping…" : "Keep"}</button>
    </footer>
    {#if sessionId}<button class="resume" onclick={() => void copyResume()}>{copied ? "Copied resume command" : "Copy resume command"}</button>{/if}
  </div>
</div>

<style>
  .ask-layer { position: fixed; inset: 0; z-index: 2001; }
  .ask-backdrop { position: absolute; inset: 0; }
  .ask-panel { position: fixed; box-sizing: border-box; width: min(440px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: auto; padding: 12px; border: 1px solid var(--c-line-strong); border-radius: var(--r-panel); background: var(--c-surface); color: var(--c-tx); font: var(--ts-sm) var(--font-ui); box-shadow: var(--elev-2); }
  header, footer { display: flex; gap: 8px; align-items: center; }
  header span, footer span, .context, .progress { color: var(--c-tx-muted); font-size: var(--ts-xs); }
  header button { margin-left: auto; }
  .context { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 7px 0; }
  .exchange { max-height: 40vh; overflow: auto; overflow-wrap: anywhere; }
  .message { white-space: pre-wrap; margin: 10px 0; line-height: 1.5; }
  .question { border-left: 2px solid var(--c-accent); padding-left: 8px; }
  .tool-line { font-size: var(--ts-xs); margin: 6px 0; }
  .tool-line summary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .error { color: var(--c-danger); margin: 8px 0; }
  .input :global(textarea) { box-sizing: border-box; width: 100%; min-height: 62px; resize: vertical; background: var(--c-bg); color: var(--c-tx); border: 1px solid var(--c-line); padding: 8px; font: inherit; margin: 8px 0; }
  button { padding: 4px 8px; background: transparent; color: inherit; border: 1px solid var(--c-line); border-radius: var(--r-ui); }
  button:disabled { opacity: .45; }
  footer span { flex: 1; }
  .resume { margin-top: 8px; }
  .view { font-size: var(--ts-xs); } .view img { display: block; max-width: 100%; margin-top: 6px; }
</style>
