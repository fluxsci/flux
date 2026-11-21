// Split channels in colour or in gray (fluximg stage 2, F4): the panels' views for both looks, how a panel's look is
// read against its composite, the flip of an existing split (a panel recoloured by hand keeps its colour), and the
// linked colour: a composite's channel colour reaches the panels coloured like it (ops.setFluximgView, the one merge
// law the app and set-image-view share), never a gray panel or a hand-recoloured one, and never the other way round.
//
// Pure tier: plain objects, no browser, no files.
// Run: npx tsx scripts/verify-fluximg-split-look.ts
import "./lib/cssStub.mjs";
import { harness } from "./lib/harness.mjs";

const { colouring, flipPlan, followPatch, lookOf, panelChannel, splitLookOf, splitPanelView, splitPanels } = await import("../src/lib/fluximg/splitLook");
const { patchView } = await import("../src/lib/fluximg/viewOps");
const ops = await import("../src/lib/ops");
type Project = import("../src/lib/types").Project;
type FluximgView = import("../src/lib/fluximg/view").FluximgView;

const h = harness("verify-fluximg-split-look");
const show = (v: unknown): string => JSON.stringify(v);

h.section("the panels' views, in colour and in gray");
{
  const src: FluximgView = { link: "L", index: { z: 3 }, channels: [{ color: "#ff00ff", range: [10, 900], invert: true, visible: false }, { lut: "magma", norm: "log" }, null] };
  const colour = splitPanelView(src, 0, 3, "L", "color"), gray = splitPanelView(src, 0, 3, "L", "gray");
  h.eq([colour.composite, colour.solo, colour.link, colour.index], ["single", 0, "L", { z: 3 }], "a panel shows its channel alone, linked, at the composite's position");
  h.eq(colour.channels?.[0], { color: "#ff00ff", range: [10, 900], invert: true }, "in colour: the channel as it is in the merged image (colour, window, invert), without the composite's eye");
  h.eq(colouring(gray.channels?.[0]), { color: null, lut: "gray", invert: true }, "in gray: the gray map (its window and invert kept)");
  h.eq((gray.channels?.[0] as { range?: unknown }).range, [10, 900], "…its window too");
  h.eq(splitPanelView(src, 1, 3, "L", "color").channels?.[1], { lut: "magma", norm: "log" }, "a channel with a colour map keeps the map in colour");
  h.eq(colouring(splitPanelView(src, 2, 3, "L", "color").channels?.[2]), { color: null, lut: null, invert: false }, "a channel the composite never recoloured stays the image's own (no override: it draws in the image's colour)");
  h.eq(panelChannel(null, "gray"), { lut: "gray", color: null }, "gray from nothing: just the map");
  h.eq(colour.furniture, { channelLabels: {} }, "each panel names its channel");
}

h.section("a panel's look, read against its composite");
{
  h.eq(lookOf({ color: "#FF00FF" }, { color: "#ff00ff", range: [1, 2] }), "color", "coloured as the composite (case and window aside): colour");
  h.eq(lookOf(null, null), "color", "both the image's own colour: colour");
  h.eq(lookOf({ lut: "gray", color: null as unknown as undefined }, { color: "#00ff00" }), "gray", "the gray map, the composite green: gray");
  h.eq(lookOf({ color: "#ffff00" }, { color: "#00ff00" }), "hand", "a colour of its own: recoloured by hand");
  h.eq(lookOf({ color: "#00ff00", invert: true }, { color: "#00ff00" }), "hand", "inverted on its own: by hand too");
}

/** One figure: a composite, its panels, and an unrelated image. */
function figure(panels: Array<{ id: string; solo: number; ch: Record<string, unknown> | null }>, composite: Record<string, unknown>[] = [{ color: "#ff00ff" }, { color: "#00ff00" }]): Project {
  const el = (id: string, view: FluximgView) => ({ type: "fluximg", id, assetId: "a", x: 0, y: 0, width: 10, height: 10, rotation: 0, view });
  const elements = [
    el("comp", { link: "L", channels: composite as FluximgView["channels"] }),
    ...panels.map((p) => { const channels: Array<Record<string, unknown> | null> = [null, null]; channels[p.solo] = p.ch; return el(p.id, { link: "L", composite: "single", solo: p.solo, channels: channels as FluximgView["channels"] }); }),
    el("other", { link: "M", composite: "single", solo: 0, channels: [{ lut: "gray" }] }),
  ];
  return { figures: [{ id: "f", elements }] } as unknown as Project;
}
const view = (p: Project, id: string): FluximgView => (p.figures[0].elements.find((e) => e.id === id) as { view: FluximgView }).view;

h.section("the flip of an existing split");
{
  const gray = { lut: "gray", color: null };
  const p = figure([{ id: "p0", solo: 0, ch: gray }, { id: "p1", solo: 1, ch: gray }]);
  const els = p.figures[0].elements as never[], comp = els[0];
  h.eq(splitPanels(els, comp).panels.map((e: { id: string }) => e.id), ["p0", "p1"], "the split's panels: the linked ones showing one channel (not another link's)");
  h.eq(splitLookOf(els, comp), "gray", "a gray split reads gray");
  const toColour = flipPlan(els, comp)!;
  h.eq([toColour.to, toColour.patches.map((q) => q.id)], ["color", ["p0", "p1"]], "flipped: every gray panel takes its colour");
  for (const q of toColour.patches) { const e = els.find((x: { id: string }) => x.id === q.id) as { view: FluximgView }; e.view = patchView(e.view, q.view); }
  h.eq([colouring(view(p, "p0").channels?.[0]), colouring(view(p, "p1").channels?.[1])], [{ color: "#ff00ff", lut: null, invert: false }, { color: "#00ff00", lut: null, invert: false }], "…its channel's colour in the merged image");
  h.eq(splitLookOf(els, comp), "color", "…and the split now reads colour");
  const back = flipPlan(els, comp)!;
  h.eq([back.to, back.patches.length], ["gray", 2], "flipped again: back to gray");
  // A panel recoloured by hand keeps the hand's choice, both ways.
  const q = figure([{ id: "p0", solo: 0, ch: gray }, { id: "p1", solo: 1, ch: { color: "#ffff00" } }]);
  const plan = flipPlan(q.figures[0].elements as never[], q.figures[0].elements[0] as never)!;
  h.eq([plan.to, plan.patches.map((x) => x.id)], ["color", ["p0"]], "a panel recoloured by hand is left out of the flip");
  // From a panel: the composite is found through the link.
  h.eq(flipPlan(els, els[1])?.to, "gray", "opened on a panel, the flip is the same (its siblings and itself)");
  // The image's own colour (no override on the composite): the coloured form clears the gray map.
  const own = figure([{ id: "p0", solo: 0, ch: gray }], [{}, {}]);
  const op = flipPlan(own.figures[0].elements as never[], own.figures[0].elements[0] as never)!;
  h.eq(colouring(patchView(view(own, "p0"), op.patches[0].view).channels?.[0]), { color: null, lut: null, invert: false }, "a composite drawing its image's own colour: the panel's gray map is cleared (the image's colour again)");
  h.eq(flipPlan([els[0]] as never[], els[0]), null, "an image with no split: nothing to flip");
}

h.section("the linked colour: the composite's channel colour reaches the panels coloured like it");
{
  const p = figure([{ id: "c0", solo: 0, ch: { color: "#ff00ff" } }, { id: "g0", solo: 0, ch: { lut: "gray" } }, { id: "h0", solo: 0, ch: { color: "#ffff00" } }, { id: "c1", solo: 1, ch: { color: "#00ff00" } }]);
  ops.setFluximgView(p, "comp", { channels: [{ color: "#00ffff" }] });
  h.eq(colouring(view(p, "c0").channels?.[0]).color, "#00ffff", "a coloured panel of that channel follows the composite's new colour");
  h.eq(colouring(view(p, "g0").channels?.[0]), { color: null, lut: "gray", invert: false }, "a gray panel stays gray");
  h.eq(colouring(view(p, "h0").channels?.[0]).color, "#ffff00", "a panel recoloured by hand keeps the hand's choice");
  h.eq(colouring(view(p, "c1").channels?.[1]).color, "#00ff00", "a panel of another channel is not touched");
  ops.setFluximgView(p, "comp", { channels: [{ lut: "magma" }] });
  h.eq(colouring(view(p, "c0").channels?.[0]), { color: null, lut: "magma", invert: false }, "a colour map follows too");
  ops.setFluximgView(p, "comp", { channels: [{ invert: true }] });
  h.eq(colouring(view(p, "c0").channels?.[0]).invert, true, "…and invert");
  ops.setFluximgView(p, "comp", { channels: [{ range: [5, 50] }] });
  h.eq([view(p, "c0").channels?.[0]?.range, view(p, "g0").channels?.[0]?.range, view(p, "h0").channels?.[0]?.range], [[5, 50], [5, 50], [5, 50]], "the window is linked to every panel, as before");
  ops.setFluximgView(p, "c0", { channels: [{ color: "#0000ff" }] });
  h.eq(colouring(view(p, "comp").channels?.[0]), { color: null, lut: "magma", invert: true }, "recolouring a panel does not reach the composite (a panel's look is its own)");
  ops.setFluximgView(p, "comp", { channels: [{ lut: "viridis" }] });
  h.eq(colouring(view(p, "c0").channels?.[0]).color, "#0000ff", "…and from then on that panel keeps its own colour");
  h.eq(colouring(view(p, "other").channels?.[0]).lut, "gray", "another link is never reached");
  h.eq(followPatch({ range: [1, 2] }, null, null), null, "an edit without colour hands nothing on");
}

await h.done();
