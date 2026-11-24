// Comments on an artifact page. A comment IS an Inbox item (an annotation in the project's
// ledger, .meta/feedback.ndjson) whose target is the page: so it is routed to agents, claimed,
// answered and resolved exactly like every other item, with no second store and no second
// protocol. What makes it a comment ON the page is its target's anchor: a passage (quote and the
// words around it) or an element (a path to it). This module reads those items back as threads
// for one artifact and says what to draw where. Pure.
import type { InboxItem } from "../project/inbox";
import { artifactElementName, artifactPointText, type TargetRef } from "../project/targets";
import type { Artifact } from "./types";
import type { FrameRect, PlotPoint } from "./frameProtocol";

export type ArtifactTarget = Extract<TargetRef, { kind: "artifact" }>;

export interface ArtifactThread {
  id: string;
  item: InboxItem;
  target: ArtifactTarget;
  /** The page it is on, below the artifact's root. */
  page: string;
  /** The page's view it was made on ("" when the page had none). */
  view: string;
  resolved: boolean;
  /** It names a passage or an element (and so can be drawn on the page); else it is about the page. */
  anchored: boolean;
}

/** What the page is asked to find and mark for one thread (the bridge's `anchors` items). */
export interface AnchorSpec { id: string; quote?: string; prefix?: string; suffix?: string; selector?: string; tag?: string; label?: string; text?: string }

/** The page of this artifact a target path names, below the root; null when it is not this artifact's. */
export function pageOfRef(artifact: Artifact, ref: string): string | null {
  const base = artifact.ref.slice(0, artifact.ref.length - artifact.entry.length);
  if (!ref.startsWith(base)) return null;
  const rel = ref.slice(base.length);
  if (artifact.kind === "file") return rel === artifact.entry ? rel : null;
  return artifact.rel === "" || rel.startsWith(artifact.rel + "/") ? rel : null;
}

/**
 * The threads of one artifact, oldest first: every Inbox annotation that points at one of its
 * pages, except those taken back or put away (withdrawn, archived).
 */
export function artifactThreads(items: readonly InboxItem[], artifact: Artifact): ArtifactThread[] {
  const out: ArtifactThread[] = [];
  for (const item of items) {
    if (item.kind !== "annotation" || item.status === "withdrawn" || item.archived) continue;
    for (const target of item.targets) {
      if (target.kind !== "artifact") continue;
      const page = pageOfRef(artifact, target.path);
      if (page === null) continue;
      out.push({ id: item.id, item, target, page, view: target.view ?? "", resolved: item.status === "resolved", anchored: !!(target.element || target.quote) });
      break;
    }
  }
  return out.sort((a, b) => (a.item.createdAt < b.item.createdAt ? -1 : a.item.createdAt > b.item.createdAt ? 1 : 0));
}

export function anchorOf(thread: Pick<ArtifactThread, "id" | "target">): AnchorSpec | null {
  const t = thread.target;
  if (t.element) return { id: thread.id, selector: t.element.selector, tag: t.element.tag, label: t.element.label, text: t.element.text };
  if (t.quote) return { id: thread.id, quote: t.quote, prefix: t.prefix, suffix: t.suffix };
  return null;
}

/** The open, anchored threads of one page: what the page draws. */
export function pageAnchors(threads: readonly ArtifactThread[], page: string): AnchorSpec[] {
  return threads.filter((t) => t.page === page && !t.resolved).flatMap((t) => anchorOf(t) ?? []);
}

/**
 * Where a thread stands for the reader, given the page and view on screen and what the page found:
 * - "here": marked on the page as it is now;
 * - "page": about the page as a whole (no passage or element), on this page;
 * - "other-page": on another page of the artifact;
 * - "other-view": on this page, made on another view of it, and not found on this one;
 * - "lost": on this page and this view, and its passage or element is no longer there.
 */
export type ThreadPlace = "here" | "page" | "other-page" | "other-view" | "lost";
export function threadPlace(thread: ArtifactThread, page: string, view: string, found: ReadonlyMap<string, boolean>): ThreadPlace {
  if (thread.page !== page) return "other-page";
  if (!thread.anchored) return "page";
  if (found.get(thread.id)) return "here";
  return thread.view !== view ? "other-view" : "lost";
}

/** What a thread is about, as the card's first line says it. */
export function threadSubject(target: ArtifactTarget): { kind: "passage" | "element" | "page"; text: string } {
  if (target.element) return { kind: "element", text: `${artifactElementName(target)}${!target.element.label && target.heading ? ` under “${target.heading}”` : ""}${target.point ? ` · ${artifactPointText(target.point)}` : ""}` };
  if (target.quote) return { kind: "passage", text: target.quote };
  return { kind: "page", text: target.heading ? `the page, at “${target.heading}”` : "the page" };
}

/** What kind of thing a picked element is, in a word. */
export function elementWhat(tag: string, plot: boolean): string {
  if (plot) return "plot";
  if (/^(svg|canvas|img|figure|video|picture)$/.test(tag)) return "figure";
  if (tag === "table") return "table";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "p" || tag === "li" || tag === "blockquote") return "paragraph";
  if (tag === "pre" || tag === "code") return "code block";
  return "section";
}

/** The target of a new comment: the page and view on screen, plus what was selected or picked. */
export function commentTarget(base: { path: string; view: string; title: string }, on:
  | { quote: string; prefix?: string; suffix?: string; heading?: string }
  | { selector: string; tag: string; plot: boolean; label: string; text: string; heading?: string; point?: PlotPoint }): ArtifactTarget {
  const target: ArtifactTarget = { kind: "artifact", path: base.path, ...(base.view ? { view: base.view } : {}), title: base.title, ...(on.heading ? { heading: on.heading } : {}) };
  if ("selector" in on) {
    target.element = { selector: on.selector, tag: on.tag, what: elementWhat(on.tag, on.plot), ...(on.label ? { label: on.label } : {}), ...(on.text ? { text: on.text } : {}) };
    if (on.point && Object.keys(on.point).length) target.point = on.point;
  } else {
    target.quote = on.quote;
    if (on.prefix !== undefined) target.prefix = on.prefix;
    if (on.suffix !== undefined) target.suffix = on.suffix;
  }
  return target;
}

/**
 * A message's text as parts: plain text, and links INTO the page. An agent answering a comment can
 * point at a state of the page with an ordinary Markdown link whose address is a view
 * (`[recording 12 at K = 5](#rec=12&K=5)`) or another page of the artifact with one
 * (`[the soma page](io.html#rec=12)`); the card makes those a button that takes the page there.
 * Every other link stays as the text it is: a comment card opens nothing on the web.
 */
export type MessagePart = { text: string } | { label: string; view: string; page?: string };
const LINK = /\[([^\]\n]{1,120})\]\(([^)\s]{1,300})\)/g;
export function messageParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const href = m[2];
    let part: MessagePart | null = null;
    if (/^[#?]/.test(href)) part = { label: m[1], view: href };
    else {
      const page = /^((?:[\w.-]+\/)*[\w.-]+\.html?)([?#].*)?$/i.exec(href);
      if (page && !href.includes("..")) part = { label: m[1], page: page[1], view: page[2] ?? "" };
    }
    if (!part) continue;
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push(part);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** The page a link names, below the artifact's root: beside the page the thread is on. */
export function linkedPage(threadPage: string, page: string | undefined): string {
  if (!page) return threadPage;
  const dir = threadPage.includes("/") ? threadPage.slice(0, threadPage.lastIndexOf("/") + 1) : "";
  return dir + page;
}

/** The picture's box mark for a comment: the anchor's rect in WINDOW coordinates (frame rect + frame origin). */
export function markRect(rect: FrameRect, origin: { x: number; y: number }, bounds: { w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y), x1 = Math.min(bounds.w, rect.x + rect.w), y1 = Math.min(bounds.h, rect.y + rect.h);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { x: Math.round(origin.x + x0), y: Math.round(origin.y + y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}
