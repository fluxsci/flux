// Plots rail layout (pure): the justified-row engine (src/lib/plotsRail/justify.ts) and the
// middle ellipsis for plot names (src/lib/plotsRail/ellipsis.ts).
//   * rows fill the width exactly, keep reading order, start fresh at each section;
//   * tiles-per-row at the rail's real widths (220–360 px) — the v1 review caught a greedy rule
//     that put ONE 4:3 tile per row at 320 px;
//   * the last row of a section is not blown up; a wide panel gets a row of its own; blocks
//     (table cards, "Show all") sit alone, full width, without a caption strip;
//   * keyboard movement between rows by nearest centre;
//   * cost is linear in the item count (relative timing, not a wall-clock budget — §9).
//   Run: node scripts/run-verifies.mjs --tier pure --only verify-plots-rail-layout
import { harness } from "./lib/harness.mjs";
import { layoutJustified, firstRowAt, sectionAt, moveIndex, LAST_ROW_STRETCH } from "../src/lib/plotsRail/justify";
import { middleEllipsis } from "../src/lib/plotsRail/ellipsis";

const h = harness("verify-plots-rail-layout");
const opts = (width: number, extra = {}) => ({ width, rowHeight: 112, gap: 6, captionH: 14, ...extra });
const sec = (aspects: number[], key = "s", headerH = 24, blocks?: number[]) => ({ key, headerH, aspects, ...(blocks ? { blocks } : {}) });

h.section("rows fill the width exactly and keep order");
{
  for (const W of [220, 280, 320, 360, 600]) {
    const aspects = [4 / 3, 1.5, 0.75, 2, 1, 1.33, 3, 0.6, 1.2, 1.8, 1, 1];
    const L = layoutJustified([sec(aspects)], opts(W));
    let order: number[] = [];
    let exact = true;
    for (const [ri, r] of L.rows.entries()) {
      order = order.concat(r.items.map((i) => i.index));
      const last = r.items[r.items.length - 1];
      const end = last.x + last.w;
      const isLastRow = ri === L.rows.length - 1;
      if (!isLastRow && Math.abs(end - W) > 0.5) exact = false;
      if (end > W + 0.5) exact = false;
    }
    h.ok(exact, `W=${W}: every full row ends at the width (±0.5 px), none overflows`);
    h.eq(order.join(","), aspects.map((_, i) => i).join(","), `W=${W}: reading order is preserved`);
  }
}

h.section("tiles per row at the rail's widths (the v1 one-per-row defect)");
{
  const per = (W: number, aspects: number[]) => layoutJustified([sec(aspects)], opts(W)).rows.map((r) => r.items.length);
  const four3 = Array(8).fill(4 / 3);
  for (const W of [220, 280, 320, 360]) {
    const counts = per(W, four3);
    h.ok(counts.slice(0, -1).every((n) => n >= 2), `W=${W}: 4:3 plots share rows (${counts.join(",")})`);
  }
  h.ok(per(360, Array(9).fill(1)).slice(0, -1).every((n) => n === 3), "W=360: square plots go three to a row");
  const wide = per(320, [4, 4 / 3, 4 / 3]);
  h.eq(wide[0], 1, "a 4:1 panel takes a row of its own at 320 px");
  const rowsH = layoutJustified([sec(four3)], opts(320)).rows.map((r) => r.h);
  h.ok(rowsH.slice(0, -1).every((x) => x > 112 * 0.7 && x < 112 * 1.5), "full rows land within [0.7h, 1.5h] of the target");
}

h.section("the last row, clamps, blocks and sections");
{
  const L = layoutJustified([sec([4 / 3, 4 / 3, 4 / 3])], opts(320));
  const last = L.rows[L.rows.length - 1];
  h.ok(last.h <= 112 * LAST_ROW_STRETCH + 1e-6, "a section's ragged last row is not stretched past 1.15 × the target");
  const tall = layoutJustified([sec([0.1])], opts(320));
  h.ok(tall.rows[0].h <= 112 * 1.5 + 1e-6, "an extreme portrait is clamped for layout (the image keeps its aspect inside)");
  const strip = layoutJustified([sec([20])], opts(320));
  h.ok(strip.rows[0].h >= 40 - 1e-6, "an extreme strip keeps the 40 px minimum row");
  const B = layoutJustified([sec([1, 1, 1, 1, 1], "s", 24, [0, 0, 120, 0, 30])], opts(300));
  const kinds = B.rows.map((r) => (r.block ? `B${r.items[0].index}` : `R${r.items.map((i) => i.index).join("")}`)).join(" ");
  h.eq(kinds, "R01 B2 R3 B4", "blocks sit alone on full-width rows, splitting the runs around them");
  h.ok(B.rows.filter((r) => r.block).every((r) => r.cap === 0 && r.items[0].w === 300), "blocks have no caption strip and span the width");
  const S = layoutJustified([sec([1, 1], "a"), sec([1], "b"), sec([], "c")], opts(320, { sectionGap: 4 }));
  h.eq(S.sections.map((s) => s.firstRow).join(","), "0,1,2", "every section starts a new row (an empty one holds just its header)");
  h.ok(S.sections[1].y > S.rows[0].y + S.rows[0].h, "a section's header sits below the previous section's rows");
  h.eq(sectionAt(S, S.sections[1].y + 1), 1, "sectionAt finds the section under a scroll position");
  h.eq(firstRowAt(S, S.rows[1].y + 1), 1, "firstRowAt binary-searches rows");
}

h.section("keyboard movement");
{
  const L = layoutJustified([sec([1, 1, 1, 1, 1, 1])], opts(330, { rowHeight: 100 }));
  h.eq(L.rows[0].items.length, 3, "fixture: three to a row");
  h.eq(moveIndex(L, 1, "down"), 4, "down from the middle tile lands on the middle tile below");
  h.eq(moveIndex(L, 4, "up"), 1, "up returns");
  h.eq(moveIndex(L, 0, "left"), 0, "left at the start stays");
  h.eq(moveIndex(L, 2, "right"), 3, "right walks reading order across rows");
  h.eq(moveIndex(L, 5, "down"), 5, "down on the last row stays");
}

h.section("cost is linear in the item count");
{
  const run = (n: number) => {
    const aspects = Array.from({ length: n }, (_, i) => 0.5 + (i % 7) * 0.4);
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t = performance.now();
      layoutJustified([sec(aspects)], opts(320));
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  run(2000); // warm the JIT
  const small = run(5000), big = run(20000);
  h.ok(big / Math.max(small, 0.05) < 8, `20,000 items cost ≈ 4× 5,000 (measured ${(big / Math.max(small, 0.05)).toFixed(1)}×, best of five) — no quadratic run scan`);
}

h.section("middle ellipsis keeps the distinguishing end");
{
  const measure = (s: string) => s.length * 6;
  const name = "latency_raincloud_by_region_v2";
  const short = middleEllipsis(name, 120, measure);
  h.ok(short.includes("…") && short.length * 6 <= 120, `fits the width (“${short}”)`);
  h.ok(short.endsWith("_v2"), "the variant suffix survives");
  h.ok(short.startsWith("lat"), "the start survives too");
  h.eq(middleEllipsis("s07", 120, measure), "s07", "a name that fits is untouched");
  h.eq(middleEllipsis(name, 3, measure), "", "no room → empty (the caption hides)");
  const a = middleEllipsis("subject_cohort_A_session_07", 100, measure), b = middleEllipsis("subject_cohort_A_session_08", 100, measure);
  h.ok(a !== b, `two variants stay distinguishable (“${a}” vs “${b}”)`);
}

await h.done();
