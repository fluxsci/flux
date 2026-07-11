// ---------------------------------------------------------------------------
// WS-4.1 (fortify plan): THE front-matter parser. Thirteen call sites used to
// parse YAML front matter independently, split across two mutually-DISAGREEING
// camps: a string camp (`startsWith("---")` + `indexOf("\n---", 3)` — which
// mis-fires on a `----` first body line, leaves a stray leading newline via
// `end + 4`, and leaves `\r` in extracted titles under CRLF) and a line-exact
// camp (`line.trim() === "---"` — correct, but two sites capped the close
// search at 100 lines). This module is the single source of truth:
//
//   · boundary detection is LINE-EXACT (a close line is exactly `---` after
//     trim — `----` is body), CRLF-safe, uncapped (early-exits at the close);
//   · an UNTERMINATED opener means "no front matter": the whole doc is body
//     (every reader camp already degraded that way);
//   · the sync tier (bounds/field/meta/strip) is allocation-light — it runs
//     per keystroke in chips/math/livePreview; the async YAML tier is for the
//     two render/save paths only.
//
// Keep this module dependency-light: no Svelte, no DOM (chips/math import it
// inside StateFields; scripts import it under plain Node).
// ---------------------------------------------------------------------------

import type { Text } from "@codemirror/state";

export interface FmBounds {
  /** Properly opened AND closed front matter exists. */
  has: boolean;
  /** An opener exists but no close (malformed) — treated as body by readers. */
  open: boolean;
  /** Char offset of the first body character (0 when no/unterminated fm). */
  bodyStart: number;
  /** Char offset of the END of the closing `---` line (before its newline);
   *  -1 when `has` is false. The title-save replace range uses this. */
  closeEnd: number;
  /** The YAML text between the fences (no fence lines; "" when none). */
  fmText: string;
}

const NONE: FmBounds = { has: false, open: false, bodyStart: 0, closeEnd: -1, fmText: "" };

/** Line-exact, CRLF-safe boundary scan (cheap, sync). */
export function frontMatterBounds(src: string): FmBounds {
  // Opener must be the FIRST line, exactly `---` after trim (BOM tolerated).
  let firstEnd = src.indexOf("\n");
  if (firstEnd < 0) firstEnd = src.length;
  const first = src.slice(0, firstEnd).replace(/^﻿/, "").trim();
  if (first !== "---") return NONE;
  let pos = firstEnd + 1;
  while (pos <= src.length) {
    let nl = src.indexOf("\n", pos);
    if (nl < 0) nl = src.length;
    const line = src.slice(pos, nl);
    if (line.trim() === "---") {
      return {
        has: true,
        open: false,
        bodyStart: Math.min(nl + 1, src.length),
        closeEnd: nl,
        fmText: src.slice(firstEnd + 1, pos),
      };
    }
    if (nl >= src.length) break;
    pos = nl + 1;
  }
  return { ...NONE, open: true };
}

/** Body text (the whole doc when no/unterminated front matter). */
export function stripFrontMatter(src: string): string {
  const b = frontMatterBounds(src);
  return b.has ? src.slice(b.bodyStart) : src;
}

/** One scalar field from the front matter, unquoted. undefined when absent
 *  (or no closed front matter). CRLF-safe (values are trimmed). */
export function frontMatterField(src: string, key: string): string | undefined {
  const b = frontMatterBounds(src);
  if (!b.has) return undefined;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:[ \\t]*(.*)$`, "m");
  const m = re.exec(b.fmText);
  if (!m) return undefined;
  const raw = m[1].trim();
  const q = /^(["'])(.*)\1$/.exec(raw);
  return (q ? q[2] : raw).trim();
}

/** Title + authors, regex/scan tier (NOT js-yaml — per-keystroke affordable).
 *  Handles: quoted/unquoted scalars, inline `[a, b]` lists, and block
 *  `- name: …` / `- plain` sequences under `author:`/`authors:`. */
export function frontMatterMeta(src: string): { title?: string; authors: string[] } {
  const b = frontMatterBounds(src);
  if (!b.has) return { authors: [] };
  const unquote = (s: string) => {
    const t = s.trim();
    const q = /^(["'])(.*)\1$/.exec(t);
    return (q ? q[2] : t).trim();
  };
  let title: string | undefined;
  const tm = /^title:[ \t]*(.+?)[ \t]*$/m.exec(b.fmText);
  if (tm) title = unquote(tm[1]);
  const authors: string[] = [];
  const lines = b.fmText.split(/\r\n|\n|\r/);
  for (let i = 0; i < lines.length; i++) {
    const am = /^authors?:[ \t]*(.*)$/.exec(lines[i]);
    if (!am) continue;
    const inline = am[1].trim();
    if (inline.startsWith("[")) {
      for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
        const v = unquote(part);
        if (v) authors.push(v);
      }
    } else if (inline) {
      authors.push(unquote(inline));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        const ln = lines[j];
        if (!/^[ \t]/.test(ln) && ln.trim() !== "") break; // dedent = end of block
        const item = /^[ \t]*-[ \t]*(.*)$/.exec(ln);
        if (item) {
          const nameField = /^name:[ \t]*(.*)$/.exec(item[1].trim());
          const v = unquote(nameField ? nameField[1] : item[1]);
          if (v) authors.push(v);
        } else {
          const nameLine = /^[ \t]+name:[ \t]*(.*)$/.exec(ln);
          if (nameLine) {
            const v = unquote(nameLine[1]);
            if (v) authors.push(v);
          }
        }
      }
    }
    break;
  }
  return { title, authors };
}

/** CM-doc overload — the line NUMBER of the closing `---` (0 = no closed
 *  front matter). No doc.toString(): per-keystroke consumers (chips, math,
 *  livePreview) derive their offsets from this. Uncapped, early-exit. */
export function frontMatterEndLine(doc: Text): number {
  if (doc.lines < 2) return 0;
  if (doc.line(1).text.trim() !== "---") return 0;
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text.trim() === "---") return i;
  }
  return 0;
}

/** Full-YAML tier (render/export/title-save only — js-yaml is lazy-loaded). */
export async function parseFrontMatterYaml(src: string): Promise<{ meta: Record<string, unknown>; body: string }> {
  const b = frontMatterBounds(src);
  if (!b.has) return { meta: {}, body: src };
  let meta: Record<string, unknown> = {};
  try {
    const yaml = await import("js-yaml");
    meta = (yaml.load(b.fmText) as Record<string, unknown>) ?? {};
  } catch {
    meta = {};
  }
  return { meta, body: src.slice(b.bodyStart) };
}
