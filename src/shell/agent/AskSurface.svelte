<script lang="ts">
  // Ask — a margin note that answers back. Read-only: the agent can look at the
  // project but never edits it. The panel grows out of what you selected (its
  // transform origin faces the selection, which stays outlined underneath),
  // adopts the synchronous bootstrap's exact position so nothing shifts when
  // this chunk arrives, and keeps its top edge while the answer streams. The
  // conversation is the shared Transcript over the one transcript model.
  import { onDestroy, tick, untrack } from "svelte";
  import { closeAsk, type AskRequest } from "./askChord";
  import { fileBridge, type RunnerDriver, type RunnerEvent } from "../../lib/project/types";
  import { askPacket } from "../../lib/project/ask";
  import { describeStamp, type ContextStamp } from "../../lib/project/annotations";
  import { shortTarget, describeTarget } from "../../lib/project/targets";
  import { modalFocus } from "../../lib/ui/modalFocus";
  import { fullscreenPortal } from "../../lib/ui/portal";
  import { pushToast } from "../../lib/toast";
  import { initAnnotationStore, keepAsk, addAnnotation } from "./annotationStore";
  import { backgroundAvailable } from "./backgroundAvailability";
  import { refreshBackgroundCapabilities } from "../inbox/backgroundStore";
  import { requestInbox } from "../inbox/inboxState";
  import { aiOpen } from "./aiMonitorState";
  import { emptyTranscript, askTurn, reduceTranscript, cancelTranscript, lastAnswer, transcriptMessages, transcriptActivity, type Transcript } from "../../lib/agent/transcript";
  import Transcript_ from "./Transcript.svelte";
  import WorkingLine from "./WorkingLine.svelte";
  import AgentMark from "./AgentMark.svelte";
  let { request }: { request: AskRequest } = $props();
  const req = untrack(() => request);
  const fb = fileBridge();
  let transcript = $state<Transcript>(emptyTranscript());
  let busy = $state(false), keeping = $state(false), error = $state(""), reason = $state(""), startedAt = $state(0);
  let sessionId = $state(""), driver = $state<RunnerDriver>("claude"), copied = $state(false), copiedAnswer = $state(false);
  let runId: string | null = null, disposed = false, seq = 0, generation = 0;
  let lastQuestion = $state("");
  let prepared: Promise<void> | null = null;
  let preview = $state(""), viewOpen = $state(false), nudge = $state(false), follow = $state(true), unseen = $state(false);
  let exchange = $state<HTMLDivElement>();
  const pending: RunnerEvent[] = [];
  const stamp: ContextStamp = structuredClone(req.stamp);
  const targets = stamp.targets ?? [];
  const passage = targets.find(t => t.kind === "passage" || t.kind === "doc");
  // The header says where in words; the full stamp (with ids) is the tooltip and the hidden .context line.
  const human = targets[0] ? `${stamp.surface} · ${shortTarget(targets[0])}${targets.length > 1 ? ` +${targets.length - 1}` : ""}` : stamp.doc?.path ? `${stamp.surface} · ${stamp.doc.path.split("/").pop()}` : stamp.activeFigureName ? `${stamp.surface} · figure “${stamp.activeFigureName}”` : `${stamp.surface} view`;
  const quote = passage && "quote" in passage ? passage.quote : undefined;
  const driverName = $derived(driver === "claude" ? "Claude Code" : "Codex");
  const messages = $derived(transcriptMessages(transcript));
  const answered = $derived(messages.some(m => m.role === "agent" && m.text.trim()));
  const phase = $derived(busy ? (transcriptActivity(transcript) || reason || "Working…") : "");
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
    transcript = reduceTranscript(transcript, event);
    if (event.type === "error") { error = event.message; busy = false; }
    else if (event.type === "status") {
      if (event.reason) reason = event.reason;
      if (["idle", "done", "failed", "cancelled"].includes(event.state)) { busy = false; reason = event.reason ?? ""; }
    }
    if (!follow) unseen = true;
  }
  const unsubscribe = fb?.onRunnerEvent?.(receive);
  async function prepare(warmOnly = false) {
    if (prepared) return prepared;
    const started = generation;
    prepared = (async () => {
      if (!fb?.runnerStart || !fb.runnerCapabilities) throw new Error("Ask requires the desktop app with Claude Code or Codex installed and signed in");
      void refreshBackgroundCapabilities();
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
  async function send(text = req.input.value.trim()) {
    if (!text || busy || keeping || disposed) return;
    const started = generation;
    busy = true; error = ""; reason = "Preparing agent…"; startedAt = Date.now(); lastQuestion = text;
    req.input.value = "";
    transcript = askTurn(transcript, text, { images: transcript.turns.length === 0 && preview ? [preview] : undefined });
    follow = true; unseen = false;
    try {
      if (!runId) await prepare();
      if (disposed || started !== generation) return;
      // A Codex pre-warm probes capabilities only; Send starts its process.
      if (!runId && !disposed) await prepare();
      const png = await shot;
      if (disposed || started !== generation || !runId) return;
      busy = true; reason = "Reading the captured context…";
      await fb!.runnerSend!({ runId, text: askPacket(text, stamp), ...(png ? { images: [{ png }] } : {}) });
    } catch (e) { if (!disposed && started === generation) { error = (e as Error).message; busy = false; transcript = reduceTranscript(transcript, { type: "error", message: (e as Error).message }); transcript = reduceTranscript(transcript, { type: "status", state: "failed" }); } }
  }
  function retry() { if (!busy && lastQuestion) { error = ""; void send(lastQuestion); } }
  async function stop() {
    generation++;
    pending.length = 0;
    const id = runId; runId = null; busy = false; reason = "Stopped";
    transcript = cancelTranscript(transcript);
    if (id) try { await fb?.runnerCancel?.({ runId: id }); } catch (e) { if (!disposed) error = (e as Error).message; }
  }
  async function keep() {
    if (keeping || busy) return;
    keeping = true; error = "";
    try {
      const png = await shot;
      if (disposed) return;
      const root = req.root;
      const id = await keepAsk(root, $state.snapshot(messages), stamp, driverName, png);
      closeAsk();
      pushToast("success", "Kept in Inbox", { detail: "The question and answer are saved as a resolved note.", action: { label: "Open", run: () => requestInbox(id) } });
    } catch (e) { error = (e as Error).message; keeping = false; }
  }
  /** Hand the question and its answer to a background agent on the same anchor and picture. */
  async function doIt() {
    if (busy || keeping || !answered) return;
    keeping = true; error = "";
    try {
      const png = await shot;
      if (disposed) return;
      const question = messages.find(m => m.role === "human")?.text ?? lastQuestion;
      const answer = lastAnswer(transcript);
      const text = `${question}\n\nCarry out the answer Ask gave:\n\n${answer}`;
      const context = structuredClone(stamp);
      if (!png) context.snapshot = null;
      await addAnnotation(text, context, { background: driver }, { png });
      closeAsk();
      pushToast("success", `${driverName} is on it`, { detail: "The question and answer became a background task.", action: { label: "Open", run: () => requestInbox() } });
    } catch (e) { error = (e as Error).message; keeping = false; }
  }
  async function copyAnswer() {
    const text = lastAnswer(transcript);
    if (!text) return;
    try { await navigator.clipboard.writeText(text); copiedAnswer = true; setTimeout(() => { copiedAnswer = false; }, 1200); }
    catch (e) { error = `Could not copy: ${(e as Error).message}`; }
  }
  async function copyResume() {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return;
    try { await navigator.clipboard.writeText(driver === "claude" ? `claude --resume ${sessionId}` : `codex resume ${sessionId}`); copied = true; setTimeout(() => { copied = false; }, 1600); }
    catch (e) { error = `Could not copy: ${(e as Error).message}`; }
  }
  function attachInput(node: HTMLElement) {
    const focused = document.activeElement === req.input;
    node.prepend(req.input); req.bootstrap.remove();
    if (focused) req.input.focus({ preventScroll: true });
  }
  // The panel keeps the bootstrap's footprint: same left, same top (or the same bottom
  // edge when it opened above the selection), the same width; it grows away from the
  // selection and never re-anchors while text streams. Only a window resize re-clamps.
  function place(node: HTMLElement) {
    const at = req.at;
    const layout = () => {
      const vw = innerWidth, vh = innerHeight, w = Math.min(480, vw - 16);
      const x = Math.max(8, Math.min(at.x, vw - 8 - w));
      node.style.left = `${x}px`; node.style.width = `${w}px`;
      if (at.side === "above") {
        const bottom = Math.max(8, vh - (at.y + 150));
        node.style.top = ""; node.style.bottom = `${bottom}px`;
        node.style.setProperty("--ask-max", `${Math.max(220, vh - bottom - 8)}px`);
      } else {
        const y = Math.max(8, Math.min(at.y, vh - 8 - 220));
        node.style.bottom = ""; node.style.top = `${y}px`;
        node.style.setProperty("--ask-max", `${Math.max(220, vh - y - 8)}px`);
      }
      node.style.transformOrigin = at.side === "right" ? "left top" : at.side === "left" ? "right top" : at.side === "above" ? "left bottom" : at.side === "below" ? "left top" : "center top";
    };
    layout(); window.addEventListener("resize", layout);
    return { destroy() { window.removeEventListener("resize", layout); } };
  }
  // Stick to the bottom while the answer grows, unless the reader scrolled up.
  function follower(node: HTMLDivElement) {
    const onScroll = () => { follow = node.scrollHeight - node.scrollTop - node.clientHeight < 24; if (follow) unseen = false; };
    node.addEventListener("scroll", onScroll, { passive: true });
    const inner = node.firstElementChild as HTMLElement | null;
    const ro = new ResizeObserver(() => { if (follow) node.scrollTop = node.scrollHeight; });
    if (inner) ro.observe(inner);
    return { destroy() { node.removeEventListener("scroll", onScroll); ro.disconnect(); } };
  }
  function toBottom() { if (exchange) { exchange.scrollTop = exchange.scrollHeight; follow = true; unseen = false; } }
  function outside() {
    if (!transcript.turns.length && !busy) { closeAsk(); return; }
    nudge = true; setTimeout(() => { nudge = false; }, 240);
  }
  initAnnotationStore();
  req.onInput = () => void warm(); req.onSubmit = () => void send();
  req.onEscape = () => { if (busy) { void stop(); return true; } return false; };
  const dispose = () => { if (disposed) return; disposed = true; unsubscribe?.(); void stop(); if (preview) URL.revokeObjectURL(preview); };
  req.onClose = dispose;
  if (req.typed) void warm();
  if (req.submitPending) { req.submitPending = false; void tick().then(() => send()); }
  onDestroy(dispose);
  const capabilityError = $derived(/install|sign in|desktop app|Settings →|unavailable|Repair/i.test(error));
</script>

<div class="ask-layer" use:fullscreenPortal>
  <div class="ask-backdrop" aria-hidden="true" onpointerdown={outside}></div>
  {#if req.avoid}<div class="ask-anchor" aria-hidden="true" style={`left:${req.avoid.x - 3}px;top:${req.avoid.y - 2}px;width:${req.avoid.w + 6}px;height:${req.avoid.h + 4}px`}></div>{/if}
  <div class="ask-panel agent-surface" class:nudge data-ask-surface role="dialog" aria-modal="true" aria-label="Ask about this" tabindex="-1" use:place use:modalFocus>
    <header class="surface-head">
      <AgentMark size={14} state={busy ? "working" : answered ? "done" : "idle"} seed={driver} />
      <span class="ttl">Ask</span>
      <span class="vsep"></span>
      <span class="ctx" title={describeStamp(stamp)}>{human}</span>
      <span class="context sr" aria-hidden="true">{describeStamp(stamp)}</span>
      <span class="lock" title="Ask can read this project; it never edits it" aria-label="read-only"></span>
      {#if preview}<button class="shot" class:open={viewOpen} title={viewOpen ? "Hide the captured view" : "Show the captured view"} aria-pressed={viewOpen} onclick={() => viewOpen = !viewOpen}><img src={preview} alt="" /></button>{/if}
      <button class="xbtn" aria-label="Close Ask" title="Discard this exchange. The CLI's own session history remains." onclick={closeAsk}></button>
    </header>
    {#if quote || (targets.length && !passage)}
      <div class="context-card">
        {#if quote}<blockquote class="quote">{quote}</blockquote>{/if}
        <div class="pills">{#each targets.slice(0, 3) as t, i (i)}<span class="pill" data-kind={t.kind} title={describeTarget(t)}>{shortTarget(t)}</span>{/each}{#if targets.length > 3}<span class="pill more">+{targets.length - 3}</span>{/if}</div>
      </div>
    {/if}
    {#if preview && viewOpen}<div class="view"><img src={preview} alt="View captured when Ask opened" /></div>{/if}
    <div class="exchange" class:empty={!transcript.turns.length} role="log" aria-live="off" bind:this={exchange} use:follower>
      <div class="exchange-inner">
        {#if transcript.turns.length}<Transcript_ {transcript} agent={driverName} seed={driver} onretry={retry} />{/if}
      </div>
      {#if unseen && !follow}<button class="new-pill arrive" onclick={toBottom}>↓ New</button>{/if}
    </div>
    {#if busy}<div class="status"><WorkingLine {busy} {phase} seed={driver} {startedAt} onstop={() => void stop()} showStop={false} /></div>{/if}
    {#if error && !transcript.turns.some(t => t.blocks.some(b => b.kind === "error"))}
      <div class="error-card" role="alert"><span>{error}</span>
        {#if capabilityError}<button onclick={() => aiOpen.set(true)}>AI status…</button>{:else if lastQuestion}<button onclick={retry}>Retry</button>{/if}
      </div>
    {/if}
    <div class="flux-composer" use:attachInput>
      <div class="composer-bar">
        <span class="hint">{busy ? "Esc stops" : "Enter sends · Shift+Enter newline"}</span>
        {#if answered && !busy}<button onclick={() => void copyAnswer()} title="Copy the answer as Markdown">{copiedAnswer ? "Copied" : "Copy"}</button>{/if}
        {#if answered}<button disabled={busy || keeping} title="Save this question and answer to the Inbox, resolved" onclick={() => void keep()}>{keeping ? "Keeping…" : "Keep"}</button>{/if}
        {#if answered && !busy && $backgroundAvailable}<button class="doit" disabled={keeping} title={`Hand this question and answer to ${driverName} as a background task on the same anchor`} onclick={() => void doIt()}>Do it ▸</button>{/if}
        {#if busy}<button class="stop" onclick={() => void stop()}>Stop</button>{:else}<button class="primary" onclick={() => void send()}>Ask</button>{/if}
      </div>
    </div>
    {#if sessionId && answered}<div class="after"><button class="resume" onclick={() => void copyResume()} title="Continue this exchange in your terminal">{copied ? "Copied resume command" : "Resume in terminal"}</button><span class="faint mono">{driverName}</span></div>{/if}
  </div>
</div>

<style>
  .ask-layer { position: fixed; inset: 0; z-index: 2001; }
  .ask-backdrop { position: absolute; inset: 0; }
  .ask-anchor { position: fixed; pointer-events: none; border-radius: 3px; box-shadow: 0 0 0 1.5px var(--c-accent), 0 0 0 5px var(--c-accent-tint-2); animation: flux-arrive var(--dur-fade-slow) both; }
  .ask-panel { position: fixed; box-sizing: border-box; display: flex; flex-direction: column; max-height: min(78vh, 720px, var(--ask-max, 720px)); border: 1px solid var(--c-line-strong); border-radius: var(--r-1); background: var(--c-surface); color: var(--c-tx); font: var(--ts-sm) var(--font-ui); box-shadow: var(--elev-3); overflow: hidden; animation: ask-enter var(--dur-instant) var(--ease-enter) both; }
  .ask-panel.nudge { animation: ask-nudge var(--dur-quick) var(--ease-standard); }
  @keyframes ask-enter { from { opacity: 0; transform: scale(.985); } to { opacity: 1; transform: none; } }
  @keyframes ask-nudge { 30% { transform: translateX(3px); } 60% { transform: translateX(-2px); } }
  @media (prefers-reduced-motion: reduce) { .ask-panel { animation-name: flux-arrive; } .ask-panel.nudge { animation: none; } }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .lock { width: 11px; height: 11px; flex-shrink: 0; background: var(--c-tx-faint); -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4' y='11' width='16' height='10' rx='2'/%3E%3Cpath d='M8 11V7a4 4 0 0 1 8 0v4'/%3E%3C/svg%3E") center / contain no-repeat; mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4' y='11' width='16' height='10' rx='2'/%3E%3Cpath d='M8 11V7a4 4 0 0 1 8 0v4'/%3E%3C/svg%3E") center / contain no-repeat; }
  .shot { width: 32px; height: 22px; padding: 0; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); background: var(--c-bg); overflow: hidden; flex-shrink: 0; }
  .shot img { display: block; width: 100%; height: 100%; object-fit: cover; opacity: .85; }
  .shot:hover img, .shot.open img { opacity: 1; } .shot.open { border-color: var(--c-accent); }
  .context-card { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 0; }
  .quote { margin: 0; padding: 1px 0 1px 10px; border-left: 2px solid var(--c-line-strong); font: italic var(--ts-sm)/1.5 var(--font-serif); color: var(--c-tx-2); display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .pills { display: flex; flex-wrap: wrap; gap: 4px; }
  .pill { font: var(--ts-xs) var(--font-ui); color: var(--c-tx-2); background: var(--c-surface-2); border: 1px solid var(--c-line); border-radius: var(--r-ui); padding: 2px 7px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill.more { color: var(--c-tx-muted); }
  .view { padding: 8px 12px 0; } .view img { display: block; max-width: 100%; border: 1px solid var(--c-line); border-radius: var(--r-ui); }
  .exchange { position: relative; flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; padding: 12px 12px 4px; overflow-wrap: anywhere; }
  .exchange.empty { flex: 0 0 0; padding: 0; }
  .exchange-inner { padding-bottom: 8px; }
  .new-pill { position: sticky; bottom: 6px; left: 50%; translate: -50% 0; height: 22px; padding: 0 10px; border: 1px solid var(--c-line-strong); border-radius: var(--r-pill); background: var(--c-surface-2); color: var(--c-tx); font: var(--ts-xs) var(--font-ui); box-shadow: var(--elev-1); }
  .status { padding: 0 12px 4px; }
  .error-card { display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 8px 10px; background: var(--c-surface-2); border-left: 2px solid var(--c-danger); border-radius: var(--r-ui); font: var(--ts-sm)/1.45 var(--font-ui); overflow-wrap: anywhere; }
  .error-card span { flex: 1; }
  .error-card button { height: 22px; padding: 0 8px; background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); color: var(--c-tx-2); font: var(--ts-xs) var(--font-ui); white-space: nowrap; }
  .error-card button:hover { background: var(--c-ui-hover); color: var(--c-tx); }
  .flux-composer { margin: 4px 12px 12px; }
  .flux-composer .composer-bar button.doit { color: var(--c-accent); }
  .after { display: flex; align-items: center; gap: 8px; padding: 0 12px 10px; margin-top: -4px; }
  .resume { padding: 0; background: none; border: 0; color: var(--c-tx-muted); font: var(--ts-xs) var(--font-ui); text-decoration: underline; text-decoration-color: var(--c-line-strong); text-underline-offset: 3px; }
  .resume:hover { color: var(--c-tx); }
  .after .mono { margin-left: auto; font-size: 10px; }
</style>
