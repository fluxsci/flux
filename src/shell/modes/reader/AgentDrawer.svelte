<script lang="ts">
  // The FluxReader agent drawer — a bottom panel running Claude Code (`claude`) in an
  // xterm, spawned via the pty bridge (electron/main.cjs pty:create) in the open
  // PROJECT root. R3 makes the session actually SEE the paper: it launches with
  // `--mcp-config` registering the flux MCP server (agent:mcpSpec resolves the
  // absolute command — projects don't carry a .mcp.json), pre-allows those tools,
  // and opens with an initial prompt naming the paper + telling it to call
  // get_reading_context (live page/selection/highlights; falls back to reading
  // ~/FluxLib/.fluxlib/reader-context.json directly when no MCP spec resolves).
  // ask(text) prefills a question into the session (popover "Ask Claude", ✦ on the
  // selection menu) — typed, not submitted, so the human finishes the thought.
  // Self-contained (its own xterm + pty) so it's independent of the Paper module's
  // singleton terminal. With no desktop bridge it shows a notice.
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import { fileBridge } from "../../../lib/project/types";

  let {
    paper = null,
    onClose,
  }: {
    paper?: { citekey: string; title?: string } | null;
    onClose?: () => void;
  } = $props();

  // SHL-16: the PTY bridge is typed centrally on FileBridge (TermBridge); reach it through
  // fileBridge() rather than an ad-hoc window cast.
  const bridge = () => fileBridge()?.term;

  let host = $state<HTMLDivElement | undefined>();
  let status = $state<"connecting" | "running" | "exited" | "unavailable">("connecting");
  let info = $state<{ cwd: string; pid: number } | null>(null);

  let term: Terminal | undefined;
  let fit: FitAddon | undefined;
  let ptyId: string | null = null;
  let offData: (() => void) | undefined;
  let offExit: (() => void) | undefined;
  let ro: ResizeObserver | undefined;

  const cssVar = (n: string, f: string) => {
    try {
      return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
    } catch {
      return f;
    }
  };

  // Questions injected before claude is ready queue up and flush shortly after boot
  // (the TUI needs a beat before it accepts input).
  const pendingAsks: string[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  function flushAsks() {
    const br = bridge();
    if (!ptyId || !br) return;
    while (pendingAsks.length) br.write(ptyId, pendingAsks.shift()!);
    term?.focus();
  }
  /** Prefill a question into the running session (no submit — the human finishes it). */
  export function ask(text: string) {
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) return;
    pendingAsks.push(t + " ");
    if (status === "running") flushAsks();
  }

  function initialPrompt(hasMcp: boolean): string {
    const t = paper?.title ? `“${paper.title}”` : "a paper";
    const k = paper?.citekey ? ` (citekey: ${paper.citekey})` : "";
    return hasMcp
      ? `I'm reading ${t}${k} in FluxReader. First call the flux MCP tool get_reading_context to see my live page, selection, and highlights (get_paper_text returns the full text; search_annotations finds my notes). Confirm in one line which paper you can see, then wait for my question.`
      : `I'm reading ${t}${k} in FluxReader. My live reading context (page, selection, highlights, pdfPath) is the JSON at ~/FluxLib/.fluxlib/reader-context.json — read it first, confirm in one line which paper you can see, then wait for my question.`;
  }

  async function boot() {
    const br = bridge();
    if (!term || !br) return;
    status = "connecting";
    // Register the flux MCP server (projects have no .mcp.json) + pre-allow its tools
    // so get_reading_context runs without a permission prompt.
    const spec = await fileBridge()?.agentMcpSpec?.()?.catch(() => undefined);
    const args: string[] = [];
    if (spec?.ok && spec.command) {
      const server: Record<string, unknown> = { command: spec.command, args: spec.args ?? [] };
      if (spec.env) server.env = spec.env;
      args.push("--mcp-config", JSON.stringify({ mcpServers: { flux: server } }), "--allowedTools", "mcp__flux");
    }
    args.push(initialPrompt(!!spec?.ok));
    const res = await br.create({ command: "claude", args, cols: term.cols, rows: term.rows });
    if (res.ok) {
      ptyId = res.id;
      info = { cwd: res.cwd, pid: res.pid };
      status = "running";
      try {
        fit?.fit();
        br.resize(res.id, term.cols, term.rows);
      } catch {
        /* not laid out */
      }
      term.focus();
      clearTimeout(flushTimer);
      // Fallback only — the onData quiet-period handler flushes as soon as the TUI
      // actually painted; this catches a claude that produces no output at all.
      flushTimer = setTimeout(flushAsks, 4000);
    } else {
      status = "exited";
      term.write(`\r\n\x1b[31m${res.error}\x1b[0m\r\n\x1b[90mIs \`claude\` (Claude Code) installed and on your PATH?\x1b[0m\r\n`);
    }
  }

  async function restart() {
    // In-flight guard: a second ↻ while (re)booting would spawn a second `claude`
    // pty and orphan one. Set connecting eagerly — the kill await below yields, and
    // boot() only flips status after its own bridge check. Unavailable = no pty
    // bridge at all; restarting can never succeed there.
    if (status === "connecting" || status === "unavailable") return;
    status = "connecting";
    const br = bridge();
    if (ptyId && br) await br.kill(ptyId);
    ptyId = null;
    term?.reset();
    await boot();
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: cssVar("--font-mono", "ui-monospace, Menlo, Consolas, monospace"),
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 8000,
      theme: { background: cssVar("--c-bg", "#100f0f"), foreground: cssVar("--c-tx-1", "#cecdc3"), cursor: cssVar("--c-accent", "#4385be") },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    if (host) term.open(host);

    const br = bridge();
    if (!br) {
      status = "unavailable";
      term.write("\r\n\x1b[90mThe agent terminal needs the Flux desktop app (node-pty).\x1b[0m\r\n");
      return;
    }
    term.onData((d) => {
      if (ptyId) br.write(ptyId, d);
    });
    offData = br.onData((m) => {
      if (m.id === ptyId) {
        term?.write(m.data);
        // Readiness = the TUI painted and went quiet, not a fixed 1.8s guess (a slow
        // `claude` boot used to swallow prefilled questions): (re)arm the flush 400ms
        // after the LAST output chunk while asks are pending.
        if (status === "running" && pendingAsks.length) {
          clearTimeout(flushTimer);
          flushTimer = setTimeout(flushAsks, 400);
        }
      }
    });
    offExit = br.onExit((m) => {
      if (m.id === ptyId) {
        ptyId = null;
        status = "exited";
        term?.write(`\r\n\x1b[90m[claude exited${typeof m.exitCode === "number" ? ` · code ${m.exitCode}` : ""}] — ↻ to restart\x1b[0m\r\n`);
      }
    });
    requestAnimationFrame(() => {
      try {
        fit?.fit();
      } catch {
        /* not laid out */
      }
      void boot();
    });
    ro = new ResizeObserver(() => {
      try {
        fit?.fit();
        if (ptyId) br.resize(ptyId, term!.cols, term!.rows);
      } catch {
        /* ignore */
      }
    });
    if (host) ro.observe(host);
  });

  onDestroy(() => {
    clearTimeout(flushTimer);
    ro?.disconnect();
    offData?.();
    offExit?.();
    const br = bridge();
    if (ptyId && br) void br.kill(ptyId);
    term?.dispose();
  });
</script>

<div class="agentdrawer">
  <div class="ahead">
    <span class="atitle">Claude Code</span>
    <span class="astatus" class:run={status === "running"}>{status}{info ? ` · pid ${info.pid}` : ""}</span>
    <span class="spacer"></span>
    <button class="ab" title="Restart claude" aria-label="Restart" disabled={status === "connecting"} onclick={restart}>↻</button>
    <button class="ab" title="Close (Esc)" aria-label="Close" onclick={() => onClose?.()}>✕</button>
  </div>
  <div class="aterm" bind:this={host}></div>
</div>

<style>
  .agentdrawer {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--c-bg);
  }
  .ahead {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: 4px 8px;
    border-bottom: 1px solid var(--c-line);
    background: var(--c-surface);
  }
  .atitle {
    font-size: var(--ts-xs);
    font-weight: 600;
    color: var(--c-tx-1);
  }
  .astatus {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    font-variant-numeric: tabular-nums;
  }
  .astatus.run {
    color: var(--c-accent);
  }
  .spacer {
    flex: 1 1 auto;
  }
  .ab {
    border: none;
    background: none;
    color: var(--c-tx-faint);
    cursor: pointer;
    font-size: var(--ts-sm);
    padding: 2px 5px;
    border-radius: var(--r-1);
  }
  .ab:hover:not(:disabled) {
    color: var(--c-accent-bright);
  }
  .ab:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .aterm {
    flex: 1 1 auto;
    min-height: 0;
    padding: 4px 6px;
    overflow: hidden;
  }
</style>
