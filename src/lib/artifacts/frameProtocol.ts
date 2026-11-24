// What an artifact page may tell the app, and nothing else. The page is someone's program
// running in its own origin; the only line between it and Flux is postMessage, sent by the
// bridge script the server adds to every page (electron/artifactRules.js `artifactBridge`).
// Every message is parsed here as untrusted data: unknown types are dropped, strings are
// clipped, numbers are checked. Pure (no DOM): the pure gate drives it directly.

export interface OutlineEntry { level: 1 | 2 | 3; text: string }

export type FrameMessage =
  | { type: "ready"; path: string; view: string; title: string }
  | { type: "state"; path: string; view: string; title: string; scrollY: number; scrollMax: number; heading: number }
  | { type: "outline"; items: OutlineEntry[] }
  | { type: "selection"; text: string }
  | { type: "key"; key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }
  | { type: "pointer" }
  | { type: "open"; url: string }
  | { type: "blocked"; uri: string; directive: string };

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);

/** A message from the frame as a FrameMessage, or null when it is not one. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.fluxArtifact !== 1 || typeof d.type !== "string") return null;
  switch (d.type) {
    case "ready":
    case "state": {
      const path = str(d.path, 4096), view = str(d.view, 4096);
      if (path === null || view === null || !path.startsWith("/")) return null;
      const title = clip(d.title, 200);
      if (d.type === "ready") return { type: "ready", path, view, title };
      const scrollY = num(d.scrollY, 0, 1e9), scrollMax = num(d.scrollMax, 0, 1e9), heading = num(d.heading, -1, 300);
      if (scrollY === null || scrollMax === null || heading === null) return null;
      return { type: "state", path, view, title, scrollY, scrollMax, heading: Math.round(heading) };
    }
    case "outline": {
      if (!Array.isArray(d.items)) return null;
      const items: OutlineEntry[] = [];
      for (const raw of d.items.slice(0, 300)) {
        const item = raw as { level?: unknown; text?: unknown } | null;
        const level = item && (item.level === 1 || item.level === 2 || item.level === 3) ? item.level : null;
        const text = item ? clip(item.text, 120) : "";
        if (level && text) items.push({ level, text });
        else items.push({ level: 3, text: "" }); // keep positions: an index in a later message names a heading
      }
      return { type: "outline", items };
    }
    case "selection":
      return { type: "selection", text: clip(d.text, 400) };
    case "key": {
      const key = str(d.key, 32), code = str(d.code, 32);
      if (!key || code === null) return null;
      return { type: "key", key, code, ctrlKey: d.ctrlKey === true, metaKey: d.metaKey === true, altKey: d.altKey === true, shiftKey: d.shiftKey === true, repeat: d.repeat === true };
    }
    case "pointer":
      return { type: "pointer" };
    case "open": {
      const url = str(d.url, 2048);
      return url && /^(https?|mailto):/i.test(url) ? { type: "open", url } : null;
    }
    case "blocked":
      return { type: "blocked", uri: clip(d.uri, 300), directive: clip(d.directive, 40) };
    default:
      return null;
  }
}

/**
 * Is this chord one the app should hear from a page? Typing and editing chords stay in the page
 * (Ctrl+C in a table of results must not also be a command in Flux), and so does Escape (the
 * page's own popovers close on it); everything else with a modifier, and the function keys, is
 * offered to the app.
 */
export function appChord(m: Extract<FrameMessage, { type: "key" }>): boolean {
  const mod = m.ctrlKey || m.metaKey;
  if (mod && !m.altKey && !m.shiftKey && /^[acvxz]$/i.test(m.key)) return false;
  if (mod && m.shiftKey && !m.altKey && /^z$/i.test(m.key)) return false;
  return mod || m.altKey || /^F\d{1,2}$/.test(m.key);
}

/** The path of a page below its root, from the frame's location, or null when it is outside the root. */
export function relOfFramePath(rootUrl: string, framePath: string, base = "http://flux.invalid/"): string | null {
  let rootPath: string;
  try { rootPath = new URL(rootUrl, base).pathname.replace(/\/+$/, ""); } catch { return null; }
  if (framePath !== rootPath && !framePath.startsWith(rootPath + "/")) return null;
  const parts: string[] = [];
  for (const raw of framePath.slice(rootPath.length).split("/")) {
    if (!raw) continue;
    try { parts.push(decodeURIComponent(raw)); } catch { return null; }
  }
  if (framePath.endsWith("/") || !parts.length) parts.push("index.html");
  return parts.join("/");
}
