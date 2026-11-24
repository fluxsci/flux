// What an artifact page may tell the app, and nothing else. The page is someone's program
// running in its own origin; the only line between it and Flux is postMessage, sent by the
// bridge script the server adds to every page (electron/artifactRules.js `artifactBridge`).
// Every message is parsed here as untrusted data: unknown types are dropped, strings are
// clipped, numbers are checked. Pure (no DOM): the pure gate drives it directly.

export interface OutlineEntry { level: 1 | 2 | 3; text: string }

/** A box in the frame's own viewport, CSS px. */
export interface FrameRect { x: number; y: number; w: number; h: number }
/** The point of a plot under the pointer when it was picked (a Plotly plot knows it). */
export interface PlotPoint { trace?: string; x?: string; y?: string; z?: string; text?: string }

export type FrameMessage =
  | { type: "ready"; path: string; view: string; title: string }
  | { type: "state"; path: string; view: string; title: string; scrollY: number; scrollMax: number; heading: number }
  | { type: "outline"; items: OutlineEntry[] }
  /** The selected words, what surrounds them (white space left out), where they are and under which heading. */
  | { type: "selection"; text: string; prefix?: string; suffix?: string; rect?: FrameRect; heading?: string }
  /** Which of the comments the app sent were found on the page as it is now. */
  | { type: "anchors"; items: { id: string; found: boolean }[] }
  /** The pointer rested on a comment's mark, pressed it, the mark moved, or the pointer left. */
  | { type: "anchor"; id: string; how: "hover" | "click" | "move" | "leave"; rect?: FrameRect }
  /** An element chosen to comment on (a plot, a figure, a table), or the choosing was abandoned. */
  | { type: "pick"; cancel: true }
  | { type: "pick"; cancel?: false; selector: string; tag: string; plot: boolean; label: string; text: string; heading: string; rect: FrameRect; point?: PlotPoint }
  | { type: "key"; key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean }
  | { type: "pointer" }
  | { type: "open"; url: string }
  | { type: "blocked"; uri: string; directive: string };

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
const clip = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, min: number, max: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null);
function rect(v: unknown): FrameRect | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const x = num(r.x, -1e7, 1e7), y = num(r.y, -1e7, 1e7), w = num(r.w, 0, 1e7), h = num(r.h, 0, 1e7);
  return x === null || y === null || w === null || h === null ? null : { x, y, w, h };
}

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
    case "selection": {
      const text = clip(d.text, 600), box = rect(d.rect);
      if (!text) return { type: "selection", text: "" };
      return { type: "selection", text, ...(typeof d.prefix === "string" ? { prefix: clip(d.prefix, 64) } : {}), ...(typeof d.suffix === "string" ? { suffix: clip(d.suffix, 64) } : {}), ...(box ? { rect: box } : {}), ...(typeof d.heading === "string" && d.heading ? { heading: clip(d.heading, 120) } : {}) };
    }
    case "anchors": {
      if (!Array.isArray(d.items)) return null;
      const items: { id: string; found: boolean }[] = [];
      for (const raw of d.items.slice(0, 400)) {
        const item = raw as { id?: unknown; found?: unknown } | null;
        const id = item ? str(item.id, 80) : null;
        if (id) items.push({ id, found: item!.found === true });
      }
      return { type: "anchors", items };
    }
    case "anchor": {
      const id = str(d.id, 80), how = d.how;
      if (id === null || (how !== "hover" && how !== "click" && how !== "move" && how !== "leave")) return null;
      const box = rect(d.rect);
      if (how !== "leave" && (!id || !box)) return null;
      return { type: "anchor", id, how, ...(box ? { rect: box } : {}) };
    }
    case "pick": {
      if (d.cancel === true) return { type: "pick", cancel: true };
      const selector = str(d.selector, 1200), tag = str(d.tag, 40), box = rect(d.rect);
      if (!selector || !tag || !box || !/^[a-z][a-z0-9-]*$/.test(tag)) return null;
      const p = d.point && typeof d.point === "object" ? d.point as Record<string, unknown> : null;
      const point: PlotPoint = {};
      if (p) for (const k of ["trace", "x", "y", "z", "text"] as const) { const v = clip(p[k], 60); if (v) point[k] = v; }
      return { type: "pick", selector, tag, plot: d.plot === true, label: clip(d.label, 100), text: clip(d.text, 80), heading: clip(d.heading, 120), rect: box, ...(Object.keys(point).length ? { point } : {}) };
    }
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
