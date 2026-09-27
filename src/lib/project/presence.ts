// Presence: which agents are flux-connected to a project right now. The MCP
// server writes one heartbeat file per connected session under
// .meta/live/sessions/ after an explicit `connect` (never for a cwd auto-bind);
// the app, the inbox and claim liveness read them. Every connected session gets
// a short readable name ("heron") that the user routes to (`@heron`) and that
// the agent signs with. Pure module: the shape, staleness and naming rules only.

export const PRESENCE_DIR_REL = ".meta/live/sessions";
/** A session whose heartbeat is older than this is gone (heartbeats every 15 s). */
export const PRESENCE_STALE_MS = 60_000;
export const PRESENCE_HEARTBEAT_MS = 15_000;

export type WatchMode = "queue" | "annotations" | "filter";

export interface PresenceSession {
  v: 1;
  /** Stable per session: the vendor session id when visible, else a uuid. */
  id: string;
  /** Short handle, unique among live sessions of this project ("heron", "heron-2"). */
  name: string;
  /** Display form: "claude · cli · heron". */
  display: string;
  product: string;
  surface: string;
  client: string;
  clientVersion?: string;
  pid: number;
  host: string;
  cwd?: string;
  startedAt: string;
  heartbeatAt: string;
  watching: boolean;
  watchMode?: WatchMode;
  /** Serialized inbox filter the session watches with (watchMode "filter"). */
  filter?: Record<string, unknown>;
  live: boolean;
  /** A FluxChat background run (F5) rather than a user-started agent. */
  background?: boolean;
}

export function presenceFileRel(id: string): string {
  return `${PRESENCE_DIR_REL}/${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/**
 * Stale = heartbeat older than PRESENCE_STALE_MS, or (when the caller can see
 * the process table of the same host) the writer process is gone.
 */
export function isPresenceStale(
  s: Pick<PresenceSession, "heartbeatAt" | "pid" | "host">,
  now: number,
  opts: { host?: string; pidAlive?: (pid: number) => boolean } = {},
): boolean {
  const beat = Date.parse(s.heartbeatAt);
  if (!Number.isFinite(beat) || now - beat > PRESENCE_STALE_MS) return true;
  if (opts.host && opts.pidAlive && s.host === opts.host && !opts.pidAlive(s.pid)) return true;
  return false;
}

/** Parse a presence file; null for anything malformed (a torn write is not a session). */
export function parsePresence(text: string): PresenceSession | null {
  try {
    const v = JSON.parse(text);
    if (!v || v.v !== 1 || typeof v.id !== "string" || typeof v.name !== "string" || typeof v.heartbeatAt !== "string") return null;
    return v as PresenceSession;
  } catch {
    return null;
  }
}

export function vendorShort(product: string | null | undefined): "claude" | "codex" | "gemini" | "agent" {
  const p = (product ?? "").toLowerCase();
  if (p.includes("claude")) return "claude";
  if (p.includes("codex") || p.includes("openai") || p.includes("chatgpt")) return "codex";
  if (p.includes("gemini")) return "gemini";
  return "agent";
}

export function surfaceShort(surface: string | null | undefined): "cli" | "vscode" | "desktop" | "headless" | "mcp" {
  const s = (surface ?? "").toLowerCase();
  if (s.includes("vs") || s.includes("code") && !s.includes("claude")) return "vscode";
  if (s.includes("desktop") || s.includes("app")) return "desktop";
  if (s.includes("headless") || s.includes("sdk") || s.includes("background")) return "headless";
  if (s.includes("cli") || s.includes("terminal")) return "cli";
  return "mcp";
}

/** 256 short, distinct, easy-to-type handles (birds and small animals). */
export const PRESENCE_WORDS: readonly string[] = [
  "heron", "wren", "finch", "robin", "lark", "swift", "kite", "tern", "egret", "ibis", "crane", "stork", "plover", "dunlin", "curlew", "godwit",
  "avocet", "stilt", "rail", "coot", "grebe", "loon", "puffin", "auk", "gannet", "petrel", "shag", "cormorant", "pelican", "osprey", "harrier", "merlin",
  "kestrel", "hobby", "falcon", "eagle", "buzzard", "owl", "nightjar", "swallow", "martin", "pipit", "wagtail", "dipper", "thrush", "blackbird", "ouzel", "chat",
  "stonechat", "wheatear", "redstart", "warbler", "chiffchaff", "kinglet", "crest", "tit", "nuthatch", "creeper", "shrike", "jay", "magpie", "chough", "rook", "raven",
  "starling", "sparrow", "linnet", "siskin", "serin", "redpoll", "crossbill", "bullfinch", "bunting", "junco", "tanager", "oriole", "grackle", "cowbird", "bobolink", "meadowlark",
  "vireo", "flicker", "sapsucker", "woodpecker", "toucan", "hornbill", "hoopoe", "roller", "beeeater", "kingfisher", "motmot", "trogon", "quetzal", "hummingbird", "sunbird", "honeyeater",
  "lyrebird", "bowerbird", "fairywren", "pardalote", "thornbill", "whipbird", "bellbird", "tui", "kea", "kaka", "kakapo", "kiwi", "weka", "takahe", "pukeko", "morepork",
  "parrot", "lorikeet", "cockatoo", "galah", "corella", "budgie", "macaw", "conure", "amazon", "caique", "lovebird", "cockatiel", "rosella", "kakariki", "quail", "partridge",
  "grouse", "ptarmigan", "pheasant", "peafowl", "turkey", "guineafowl", "tinamou", "rhea", "emu", "cassowary", "ostrich", "penguin", "albatross", "shearwater", "fulmar", "prion",
  "skua", "jaeger", "gull", "kittiwake", "noddy", "skimmer", "murre", "guillemot", "razorbill", "dovekie", "sandpiper", "knot", "sanderling", "turnstone", "snipe", "woodcock",
  "phalarope", "jacana", "lapwing", "killdeer", "oystercatcher", "courser", "pratincole", "thickknee", "bustard", "seriema", "trumpeter", "limpkin", "bittern", "spoonbill", "flamingo", "hamerkop",
  "shoebill", "stoat", "otter", "marten", "badger", "ferret", "mink", "weasel", "sable", "fisher", "wolverine", "raccoon", "coati", "kinkajou", "fox", "fennec",
  "jackal", "dingo", "lynx", "ocelot", "serval", "caracal", "margay", "civet", "genet", "mongoose", "meerkat", "hyrax", "pika", "hare", "rabbit", "vole",
  "lemming", "marmot", "chipmunk", "squirrel", "dormouse", "gerbil", "hamster", "jerboa", "capybara", "agouti", "paca", "beaver", "muskrat", "porcupine", "hedgehog", "shrew",
  "mole", "tenrec", "bat", "lemur", "loris", "galago", "tarsier", "marmoset", "tamarin", "gibbon", "okapi", "tapir", "zebra", "ibex", "chamois", "gazelle",
  "impala", "kudu", "eland", "oryx", "dikdik", "duiker", "moose", "elk", "caribou", "muntjac", "alpaca", "llama", "vicuna", "guanaco", "bison", "yak",
];

function hash32(s: string): number {
  // FNV-1a: deterministic, well-spread, no dependencies.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function presenceWord(id: string): string {
  return PRESENCE_WORDS[hash32(id) % PRESENCE_WORDS.length];
}

/**
 * Name a new session. `taken` holds the handles of LIVE sessions of the same
 * project; a collision appends -2, -3, … so @mentions stay unambiguous.
 */
export function presenceName(
  s: { id: string; product: string; surface: string; background?: boolean },
  taken: ReadonlySet<string>,
): { name: string; display: string } {
  const word = presenceWord(s.id);
  let name = word;
  for (let n = 2; taken.has(name); n++) name = `${word}-${n}`;
  const display = s.background
    ? `bg · ${vendorShort(s.product)} · ${name}`
    : `${vendorShort(s.product)} · ${surfaceShort(s.surface)} · ${name}`;
  return { name, display };
}

/** Live sessions keyed by id (the snapshot claim liveness and routing read). */
export function liveSessions(
  sessions: readonly PresenceSession[],
  now: number,
  opts?: { host?: string; pidAlive?: (pid: number) => boolean },
): Map<string, PresenceSession> {
  const out = new Map<string, PresenceSession>();
  for (const s of sessions) if (!isPresenceStale(s, now, opts)) out.set(s.id, s);
  return out;
}
