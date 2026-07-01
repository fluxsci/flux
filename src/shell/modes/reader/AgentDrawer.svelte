<script lang="ts">
  // The FluxReader agent drawer — a bottom panel running Claude Code (`claude`) in an
  // xterm, spawned via the pty bridge (electron/main.cjs pty:create, extended to accept
  // a command). It runs in the open PROJECT root so the flux MCP server is available, so
  // the agent can call get_reading_context / get_paper_text / search_annotations to SEE
  // the paper the human is reading (written to ~/FluxLib/.fluxlib/reader-context.json).
  // Self-contained (its own xterm + pty) so it's independent of the Paper module's
  // singleton terminal. With no desktop bridge it shows a notice.
  import { onMount, onDestroy } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  let { onClose }: { onClose?: () => void } = $props();

  interface TermBridge {
    create(opts?: {
      cols?: number;
      rows?: number;
      cwd?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }): Promise<{ ok: true; id: string; shell: string; cwd: string; pid: number } | { ok: false; error: string }>;
    write(id: string, data: string): void;
    resize(id: string, cols: number, rows: number): void;
    kill(id: string): Promise<boolean>;
    onData(cb: (m: { id: string; data: string }) => void): () => void;
    onExit(cb: (m: { id: string; exitCode: number; signal?: number }) => void): () => void;
  }
  const bridge = (): TermBridge | undefined => (window as unknown as { fig?: { term?: TermBridge } }).fig?.term;

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

  async function boot() {
    const br = bridge();
    if (!term || !br) return;
    status = "connecting";
    const res = await br.create({ command: "claude", cols: term.cols, rows: term.rows });
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
    } else {
      status = "exited";
      term.write(`\r\n\x1b[31m${res.error}\x1b[0m\r\n\x1b[90mIs \`claude\` (Claude Code) installed and on your PATH?\x1b[0m\r\n`);
    }
  }

  async function restart() {
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
      if (m.id === ptyId) term?.write(m.data);
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
    <button class="ab" title="Restart claude" aria-label="Restart" onclick={restart}>↻</button>
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
  .ab:hover {
    color: var(--c-accent-bright);
  }
  .aterm {
    flex: 1 1 auto;
    min-height: 0;
    padding: 4px 6px;
    overflow: hidden;
  }
</style>
