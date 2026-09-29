// Who is calling Flux: the agent product and the surface it runs on, detected
// from the environment and (over MCP) the client's handshake. Feeds the
// journal/lock identity, `flux log` bylines ("Claude Code · CLI"), presence
// names and inbox claims, so an agent never has to describe itself by hand
// beyond its model name.
//
// Observed facts (2026-09): Claude Code sets CLAUDECODE=1,
// CLAUDE_CODE_ENTRYPOINT (cli | claude-vscode | claude-desktop | sdk-cli |
// sdk-ts | sdk-py | mcp | …) and AI_AGENT=claude-code_<ver>_{agent|harness} in
// the processes it spawns, MCP servers included. Codex exports CODEX_THREAD_ID
// / CODEX_CI / CODEX_SANDBOX to its shell tool but NOTHING to MCP servers, so
// over MCP only clientInfo identifies it. Pure over its inputs.

export interface AgentIdentity {
  vendor: "anthropic" | "openai" | "google" | "other" | null;
  /** "Claude Code", "Codex", "Gemini CLI", … or null when unknown. */
  product: string | null;
  /** "CLI", "VS Code", "desktop app", "headless", "SDK", "MCP", … or null. */
  surface: string | null;
  /** Short journal/lock client id: claude-code, codex, gemini, or the fallback. */
  client: string;
  /** The vendor's own session id when visible (claims prefer it: one agent = one session). */
  sessionId: string | null;
}

export interface ClientInfo {
  name: string;
  version?: string;
}

const CLAUDE_ENTRYPOINTS: Record<string, string> = {
  cli: "CLI",
  "claude-vscode": "VS Code",
  "claude-desktop": "desktop app",
  "claude-desktop-3p": "desktop app",
  "sdk-cli": "headless",
  "sdk-ts": "SDK",
  "sdk-py": "SDK",
  mcp: "MCP",
  "local-agent": "local agent",
  "claude-code-github-action": "GitHub Action",
};

function fromClientInfo(ci: ClientInfo | undefined): Pick<AgentIdentity, "vendor" | "product" | "surface" | "client"> | null {
  const n = ci?.name?.toLowerCase() ?? "";
  if (!n) return null;
  if (n.includes("claude")) return { vendor: "anthropic", product: "Claude Code", surface: null, client: "claude-code" };
  if (n.includes("codex") || n.includes("openai") || n.includes("chatgpt")) {
    const surface = n.includes("vscode") ? "VS Code" : n.includes("desktop") || n.includes("app") ? "desktop app" : null;
    return { vendor: "openai", product: "Codex", surface, client: "codex" };
  }
  if (n.includes("gemini")) return { vendor: "google", product: "Gemini CLI", surface: null, client: "gemini" };
  return { vendor: "other", product: ci!.name, surface: null, client: n.replace(/[^a-z0-9._-]+/g, "-").slice(0, 32) || "mcp" };
}

/** Parse `claude-code_2-1-283_agent` or `name@version` into a product name. */
function fromAiAgent(v: string | undefined): string | null {
  if (!v) return null;
  const name = v.split(/[_@]/)[0].toLowerCase();
  if (name === "claude-code") return "Claude Code";
  if (name.includes("codex")) return "Codex";
  if (name.includes("gemini")) return "Gemini CLI";
  if (name.includes("cursor")) return "Cursor";
  return name || null;
}

export function detectAgentIdentity(
  env: Record<string, string | undefined>,
  clientInfo?: ClientInfo,
  fallbackClient = "cli",
): AgentIdentity {
  const ci = fromClientInfo(clientInfo);
  const entry = env.CLAUDE_CODE_ENTRYPOINT;
  const claude = env.CLAUDECODE === "1" || !!env.CLAUDE_CODE_SESSION_ID || !!entry || (env.AI_AGENT ?? "").startsWith("claude-code");
  if (claude) {
    return {
      vendor: "anthropic",
      product: "Claude Code",
      surface: entry ? CLAUDE_ENTRYPOINTS[entry] ?? entry : ci?.surface ?? null,
      client: "claude-code",
      sessionId: env.CLAUDE_CODE_SESSION_ID || null,
    };
  }
  const codex = !!(env.CODEX_THREAD_ID || env.CODEX_CI || env.CODEX_SANDBOX);
  if (codex) {
    return { vendor: "openai", product: "Codex", surface: ci?.surface ?? null, client: "codex", sessionId: env.CODEX_THREAD_ID || null };
  }
  if (env.GEMINI_CLI) return { vendor: "google", product: "Gemini CLI", surface: "CLI", client: "gemini", sessionId: null };
  if (ci) return { ...ci, sessionId: null };
  const product = fromAiAgent(env.AI_AGENT);
  if (product) return { vendor: "other", product, surface: null, client: product.toLowerCase().replace(/\s+/g, "-"), sessionId: null };
  return { vendor: null, product: null, surface: null, client: env.FLUX_CLIENT || fallbackClient, sessionId: null };
}

/** "Claude Code · CLI" — the byline's who/where half (the agent adds its model name). */
export function describeIdentity(id: AgentIdentity): string {
  return [id.product ?? "unknown agent", id.surface ?? "unknown surface"].join(" · ");
}
