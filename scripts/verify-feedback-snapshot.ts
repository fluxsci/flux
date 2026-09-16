#!/usr/bin/env -S npx tsx
// 2026-09-15 Snapshot & annotate — the pure half of "point at it" feedback
// (src/lib/project/feedbackCapture.ts + the stamp in feedback.ts) gates
// hermetically: the crop law, badge/target points, the DOM-anchor path builder
// (fed fake nodes), the stamp's one-line description and the ledger roundtrip.
//   Run: npx tsx scripts/verify-feedback-snapshot.ts
import {
  anchorPathOf,
  arrowHead,
  describeSnapshot,
  markBadgePoint,
  markTargetPoint,
  snapshotCrop,
  SNAPSHOT_PAD,
  ARROW_HEAD,
  type FeedbackMark,
  type FeedbackSnapshot,
  type AnchorNode,
} from "../src/lib/project/feedbackCapture";
import { describeStamp, foldLedger, makeNote, parseLedger, serializeEvent } from "../src/lib/project/feedback";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
const win = { w: 1400, h: 900 };
const arrow: FeedbackMark = { kind: "arrow", n: 1, points: [[400, 300], [520, 260]] };
const box: FeedbackMark = { kind: "box", n: 2, points: [[700, 500], [640, 420]] };
const pen: FeedbackMark = { kind: "pen", n: 3, points: [[100, 100], [110, 120], [130, 118]] };

// (1) the crop law
{
  const all = snapshotCrop([], win);
  assert(all.x === 0 && all.y === 0 && all.w === 1400 && all.h === 900, "no marks → the whole window");
  const c = snapshotCrop([arrow], win);
  const g = SNAPSHOT_PAD + ARROW_HEAD;
  assert(c.x === 400 - g && c.y === 260 - g && c.x + c.w === 520 + g && c.y + c.h === 300 + g, `one arrow → its bounds padded (${JSON.stringify(c)})`);
  const tiny = snapshotCrop([{ kind: "pen", n: 1, points: [[700, 450]] }], win);
  assert(tiny.w >= 240 && tiny.h >= 160 && tiny.x + tiny.w / 2 === 700 && tiny.y + tiny.h / 2 === 450, `a dot grows to the minimum crop around itself (${JSON.stringify(tiny)})`);
  const edge = snapshotCrop([{ kind: "arrow", n: 1, points: [[1380, 20], [1395, 5]] }], win);
  assert(edge.x >= 0 && edge.y === 0 && edge.x + edge.w <= 1400 && edge.y + edge.h <= 900, `the crop clamps to the window (${JSON.stringify(edge)})`);
  const multi = snapshotCrop([arrow, box, pen], win);
  assert(multi.x === 100 - g && multi.y === 100 - g && multi.x + multi.w === 700 + g && multi.y + multi.h === 500 + g, "several marks → the union of their bounds");
  assert(Number.isInteger(multi.x) && Number.isInteger(multi.w), "integer pixels");
}
// (2) badge and target points
{
  assert(markBadgePoint(arrow).join() === "520,260" && markTargetPoint(arrow).join() === "520,260", "an arrow's badge and target are its head");
  assert(markBadgePoint(box).join() === "640,420" && markTargetPoint(box).join() === "670,460", "a box badges its top-left and targets its centre");
  assert(markBadgePoint(pen).join() === "100,100" && markTargetPoint(pen).join() === "100,100", "a stroke badges and targets its start");
  const head = arrowHead([0, 0], [100, 0]);
  assert(head[0].join() === "100,0" && head[1][0] === 100 - ARROW_HEAD && Math.abs(head[1][1]) > 0, "the arrow head triangle sits at the tip");
}
// (3) the anchor path builder (fake DOM)
{
  const node = (tagName: string, o: Partial<AnchorNode> & { attrs?: Record<string, string> } = {}): AnchorNode => ({
    tagName,
    id: o.id,
    className: o.className,
    textContent: o.textContent ?? "",
    parentElement: o.parentElement ?? null,
    attributes: Object.entries(o.attrs ?? {}).map(([name, value]) => ({ name, value })),
  });
  const body = node("BODY");
  const app = node("DIV", { parentElement: body }); // anonymous wrapper — skipped
  const rail = node("ASIDE", { className: "inspector svelte-1abc", parentElement: app });
  const sec = node("SECTION", { className: "part", parentElement: rail });
  const row = node("DIV", { className: "pf", attrs: { "data-key": "opacity" }, parentElement: sec, textContent: "o  opacity  1" });
  const input = node("INPUT", { attrs: { "aria-label": "Opacity value", title: "" }, parentElement: row, textContent: "" });
  const a = anchorPathOf(input);
  assert(a?.path === 'aside.inspector > section.part > div.pf[data-key=opacity] > input[aria-label="Opacity value"]', `a named ancestor chain, hashed classes dropped (${a?.path})`);
  assert(a && !("text" in a), "an input without text carries no text");
  const r = anchorPathOf(row);
  assert(r?.text === "o opacity 1", `the element's own text, whitespace collapsed (${r?.text})`);
  const long = node("BUTTON", { className: "tool", textContent: "x".repeat(60), parentElement: app });
  assert(anchorPathOf(long)?.text?.length === 38, "long text is cut to 37 chars + ellipsis");
  const deep = node("SPAN", { parentElement: node("DIV", { className: "l5", parentElement: node("DIV", { className: "l4", parentElement: node("DIV", { className: "l3", parentElement: node("DIV", { className: "l2", parentElement: node("DIV", { className: "l1", parentElement: body }) }) }) }) }) });
  assert(anchorPathOf(deep)?.path === "div.l3 > div.l4 > div.l5 > span", `at most four segments, nearest first (${anchorPathOf(deep)?.path})`);
  assert(anchorPathOf(null) === null && anchorPathOf(body) === null, "nothing under the tip → no anchor");
  const svgish = node("g", { className: { baseVal: "mark svelte-x" }, parentElement: body });
  assert(anchorPathOf(svgish)?.path === "g.mark", "SVGAnimatedString classes read through baseVal");
}
// (4) description + ledger roundtrip
{
  const snap: FeedbackSnapshot = {
    image: ".meta/feedback/fbabc.png",
    rect: { x: 10, y: 20, w: 300, h: 200 },
    window: { w: 1400, h: 900, dpr: 2 },
    marks: [
      { ...arrow, anchor: { path: "header.toolbar > button.tool", text: "Gallery" } },
      { ...box, anchor: { path: "aside.inspector > div.pf[data-key=opacity]" } },
      { ...pen, anchor: null },
      { kind: "arrow", n: 4, points: [[1, 1], [2, 2]], anchor: { path: "div.x" } },
    ],
  };
  const d = describeSnapshot(snap);
  assert(d === 'snapshot ×4 (1 → header.toolbar > button.tool "Gallery", 2 → aside.inspector > div.pf[data-key=opacity], 3 → ?, +1)', `one line, three anchors then a count (${d})`);
  assert(describeSnapshot({ ...snap, image: null, marks: [] }) === "snapshot (no screenshot)", "a browser-build snapshot says so");
  const stamp = describeStamp({ surface: "figure", activeFigureId: "f1", selection: ["e1"], snapshot: { ...snap, marks: snap.marks.slice(0, 1) } });
  assert(stamp === 'figure · fig:f1 · sel:1 · snapshot ×1 (1 → header.toolbar > button.tool "Gallery")', `the stamp line carries the snapshot (${stamp})`);
  const ev = makeNote("1 is too big, move 2 up", { surface: "figure", snapshot: snap }, "human");
  const st = foldLedger(parseLedger(serializeEvent(ev)));
  const back = st.notes[0]?.context?.snapshot;
  assert(back && back.image === snap.image && back.marks.length === 4 && back.marks[0].anchor?.text === "Gallery" && back.rect.w === 300, "the snapshot survives the NDJSON ledger roundtrip");
}
console.log("VERIFY-FEEDBACK-SNAPSHOT PASS");
