#!/usr/bin/env -S npx tsx
// The deck load gate (0.6.0, animation v2 — supersedes the 0.5.0 pin):
//   • a good deck validates (pre-generated Ajv, CSP-safe)
//   • malformed decks are REJECTED (missing stage, bad element, wrong version)
//   • 0.2.0–0.5.0 decks are VALID INPUT: the file schema accepts the 0.2–0.5
//     generations and ops.migrateDeck stamps them 0.6.0 at every load seam
//     (pure version stamps preserve existing deck content)
//   • the 0.6 additive fields (to.become, Track.parts/styleId/anchor,
//     deck.animStyles, a plot's view) validate; a malformed one is rejected
//   • an OLD-format (0.1.x) deck fails validation — the sanctioned clean break
//     (owner decision, slide-migration plan §0.2.1): the GUI read seam
//     QUARANTINES it (.corrupt-<ts> copy) and skips, never half-loads
//   • a NEWER deck (0.7.x) is refused by the forward-version guard BEFORE
//     validation
//   • dangling beat targets are WARNINGS (validate_deck), never rejections
//   npx tsx scripts/verify-deck-schema.ts

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateDeckFile } from "../src/lib/project/validate";
import { isNewerSchema } from "../src/lib/project/types";
import { DECK_SCHEMA_VERSION, type Deck } from "../src/lib/slide/types";
import * as slideOps from "../src/lib/slide/ops";
import { validateDeck as validateDeckVerb, saveDeck, loadDeck, mutateDeck } from "../flux-core/slides";
import { scaffold } from "../flux-core/index";

import { harness } from "./lib/harness.mjs";
const h = harness("verify-deck-schema");
function assert(cond: unknown, msg: string) {
  if (!h.ok(cond, msg)) throw new Error("FAIL: " + msg);
}

// --- a good deck (built through the one blank-deck source) validates -----------
const good = slideOps.createDeck({ id: "g", title: "Good" });
slideOps.addSlideText(good, good.slides[0].id, { text: "hi", x: 10, y: 10 });
assert(DECK_SCHEMA_VERSION === "0.6.0", "the animation-v2 format is 0.6.0 (0.x minor = the breaking slot)");
assert(validateDeckFile(good).length === 0, "a createDeck() deck validates against the bundled schema");

// M6: load the same stagger/arc shape on tracks and linked styles.
{
  for (const fields of [
    { stagger: { totalMs: 800, curve: "enter", from: "random", seed: 42 } },
    { stagger: { perMs: 30, curve: { kind: "spring", bounce: .35 } } },
    { stagger: { totalMs: 0, curve: { kind: "steps", n: 8 } } },
    { stagger: { totalMs: 800, curve: { kind: "bezier", p: [.3, 2, .7, -1] } } },
    { arc: -1 }, { arc: 0 }, { arc: 1 },
  ]) {
    const deck = structuredClone(good), slide = deck.slides[0];
    slideOps.addBeat(deck, slide.id)!.tracks = [{ target: slide.elements[0].id, preset: "transform", ...fields }] as any;
    deck.animStyles = [{ id: "motion", name: "Motion", family: "transform", track: { preset: "transform", ...fields } }] as any;
    assert(validateDeckFile(JSON.parse(JSON.stringify(deck))).length === 0, `M6 fields accepted: ${JSON.stringify(fields)}`);
  }
  for (const fields of [
    { stagger: { totalMs: -1 } }, { stagger: { totalMs: "800" } }, { stagger: {} },
    { stagger: { perMs: 3, from: "shuffle" } }, { stagger: { perMs: 3, seed: -1 } },
    { stagger: { totalMs: 3, seed: 1.5 } }, { stagger: { totalMs: 3, seed: 4294967296 } },
    { stagger: { totalMs: 3, curve: "banana" } }, { stagger: { totalMs: 3, curve: { kind: "spring" } } },
    { stagger: { totalMs: 3, curve: { kind: "bezier", p: [0, 0, 1] } } },
    { stagger: { totalMs: 3, curve: { kind: "steps", n: 0 } } }, { arc: -1.01 }, { arc: 1.01 }, { arc: "0" },
  ]) {
    for (const style of [false, true]) {
      const deck = structuredClone(good), slide = deck.slides[0];
      if (style) deck.animStyles = [{ id: "bad", name: "Bad", family: "transform", track: fields }] as any;
      else slideOps.addBeat(deck, slide.id)!.tracks = [{ target: slide.elements[0].id, ...fields }] as any;
      assert(validateDeckFile(deck).length > 0, `bad M6 ${style ? "style" : "track"} refused: ${JSON.stringify(fields)}`);
    }
  }
}

// Camera paths are additive; unknown paths must never silently become Zoom.
{
  const deck = structuredClone(good), slide = deck.slides[0];
  const beat = slideOps.addBeat(deck, slide.id)!;
  for (const path of [undefined, "pole", "fly"] as const) {
    beat.tracks = [{ target: "@camera", preset: "camera", to: { x: 200, y: 100, zoom: 2, ...(path ? { path } : {}) } }];
    assert(validateDeckFile(deck).length === 0, `camera path ${path ?? "absent"} validates without a version bump`);
  }
  for (const path of ["linear", "Fly", 3, null, {}]) {
    (beat.tracks[0].to as Record<string, unknown>).path = path;
    assert(validateDeckFile(deck).length > 0, `garbage camera path ${JSON.stringify(path)} is refused`);
  }
}

// --- 0.2.0–0.5.0 → 0.6.0: valid input, migrated at the chokepoint -----------------------
{
  for (const version of ["0.2.0", "0.3.0", "0.4.0", "0.5.0"]) {
    const v02 = structuredClone(good) as unknown as { schemaVersion: string };
    v02.schemaVersion = version;
    assert(validateDeckFile(v02).length === 0, `${version} is valid input (auto-migratable generation)`);
    assert(!isNewerSchema(v02.schemaVersion, DECK_SCHEMA_VERSION), "…and not 'newer' — it loads");
    const migrated = slideOps.normalizeDeck(structuredClone(v02) as unknown as typeof good);
    assert(migrated.schemaVersion === "0.6.0", `normalizeDeck stamps ${version} to 0.6.0`);
    const before = JSON.stringify({ ...v02, schemaVersion: "x" });
    const after = JSON.stringify({ ...(migrated as unknown as Record<string, unknown>), schemaVersion: "x" });
    assert(before === after, `${version}→0.6 migration is a PURE stamp — no other byte changes`);
  }
}

// --- the 0.6 additive fields validate; malformed ones are rejected -----------------
{
  const v6 = structuredClone(good);
  const sid = v6.slides[0].id;
  const el = v6.slides[0].elements[0].id;
  const plot = slideOps.addPlotToSlide(v6, sid, { assetId: "asset-p", x: 0, y: 0, width: 200, height: 120 })!;
  const beat = slideOps.addBeat(v6, sid, { label: "step" })!;
  slideOps.setAnimation(v6, sid, beat.id, { target: el, preset: "fade", styleId: "st-1", anchor: { trackId: "t-0", edge: "end", offsetMs: 50 } });
  slideOps.setTransform(v6, sid, beat.id, el, { state: {} });
  const tf = beat.tracks.find((t) => t.preset === "transform")!;
  tf.to = { become: { ref: { element: plot, parts: ["axis.x.spine", "axis.y.spine"] }, mode: "handoff", pair: "auto" }, state: {} };
  slideOps.setAnimation(v6, sid, beat.id, { target: plot, parts: ["peaches.box", "oranges.box"], preset: "fade" });
  v6.animStyles = [{ id: "st-1", name: "Soft fade", family: "appearance", track: { preset: "fade", duration: 400 } }];
  (v6.slides[0].elements.find((e) => e.id === plot) as { view?: unknown }).view = { x: { domain: [0, 5] }, y: { scale: "log" } };
  assert(validateDeckFile(v6).length === 0, "a 0.6 deck with become/parts/styleId/anchor/animStyles/view validates");
  const badAnchor = structuredClone(v6) as unknown as { slides: { beats: { tracks: { anchor?: unknown }[] }[] }[] };
  badAnchor.slides[0].beats[1].tracks[0].anchor = { trackId: "t-0", edge: "middle" };
  assert(validateDeckFile(badAnchor).length > 0, "an anchor edge outside start|end → rejected");
  const badStyle = structuredClone(v6) as unknown as { animStyles: { family: string }[] };
  badStyle.animStyles[0].family = "camera";
  assert(validateDeckFile(badStyle).length > 0, "an animStyle with an unknown family → rejected");
  const badView = structuredClone(v6) as unknown as { slides: { elements: { id: string; view?: unknown }[] }[] };
  badView.slides[0].elements.find((e) => e.id === plot)!.view = { x: { domain: [0] } };
  assert(validateDeckFile(badView).length > 0, "a view domain that is not a pair → rejected");
  // Oct-2: a Become destination SET (`ref.members`) — one level of element/part refs.
  const setDeck = structuredClone(v6) as unknown as { slides: { beats: { tracks: { to?: { become?: { ref: Record<string, unknown> } } }[] }[] }[] };
  const setTrack = setDeck.slides[0].beats[1].tracks.find(t => t.to?.become)!;
  setTrack.to!.become!.ref = { element: el, members: [{ element: el }, { element: plot, parts: ["peaches.box"] }] };
  assert(validateDeckFile(structuredClone(setDeck)).length === 0, "a saved destination set (an object + a plot's parts) validates");
  assert(JSON.stringify(slideOps.migrateDeck(structuredClone(setDeck) as unknown as Deck)).includes('"members"'), "migration keeps a saved set record intact");
  for (const [label, members] of [
    ["a nested set member", [{ element: el, members: [{ element: el }] }]],
    ["a group member", [{ element: plot, group: "g" }]],
    ["a member without an element", [{ parts: ["peaches.box"] }]],
    ["an empty set", []],
  ] as const) {
    const bad = structuredClone(setDeck);
    bad.slides[0].beats[1].tracks.find(t => t.to?.become)!.to!.become!.ref = { element: el, members };
    assert(validateDeckFile(bad).length > 0, `a destination set with ${label} → rejected`);
  }
  // The whole `to.become` record is schematized: ref + closed mode/pair/reveal vocabularies.
  const becomeOf = (d: typeof setDeck) => d.slides[0].beats[1].tracks.find(t => t.to?.become)!.to!.become as unknown as Record<string, unknown>;
  for (const [label, patch] of [
    ["an unknown mode", { mode: "absorb" }], ["an unknown pair", { pair: "nearest" }], ["an unknown reveal", { reveal: "wipe" }], ["an unknown method", { method: "explode" }],
    ["no mode", { mode: undefined }], ["no ref", { ref: undefined }], ["a ref without an element", { ref: { parts: ["a"] } }],
    ["non-string parts", { ref: { element: el, parts: [1] } }],
  ] as const) {
    const bad = structuredClone(setDeck);
    const become = becomeOf(bad);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete become[k]; else become[k] = v;
    assert(validateDeckFile(bad).length > 0, `a Become with ${label} → rejected`);
  }
  for (const [label, patch] of [["a group ref", { ref: { element: plot, group: "g" } }], ["pair tile + reveal draw", { pair: "tile", reveal: "draw" }], ["method drain", { method: "drain" }], ["consume provenance", { mode: "consume", ref: { element: el } }]] as const) {
    const ok = structuredClone(setDeck);
    Object.assign(becomeOf(ok), patch);
    assert(validateDeckFile(ok).length === 0, `a Become with ${label} validates`);
  }
}

// Timing specs share the same disk contract on ordinary, ghost and style tracks.
{
  const shapes = [
    { kind: "bezier", p: [0.34, 1.56, 0.64, 1] },
    { kind: "spring", bounce: 0.35 },
    { kind: "spring", bounce: -0.5, velocity: 2 },
    { kind: "steps", n: 8 },
    { kind: "steps", n: 1, jump: "start" },
  ];
  const malformed = [
    { kind: "spring", bounce: "x" }, { kind: "bezier", p: [0.1, 0, 1] },
    { kind: "unknown" }, { kind: "spring", bounce: 0.81 },
    { kind: "spring", bounce: -0.51 }, { kind: "spring", bounce: 0.3, velocity: "x" },
    { kind: "bezier", p: [-0.1, 0, 1, 1] }, { kind: "bezier", p: [0, -1.1, 1, 1] },
    { kind: "bezier", p: [0, 0, 1.1, 1] }, { kind: "bezier", p: [0, 0, 1, 2.1] },
    { kind: "steps", n: 0 }, { kind: "steps", n: 61 }, { kind: "steps", n: 1.5 },
    { kind: "steps", n: 2, jump: "middle" }, null,
  ];
  const failures: string[] = [];
  for (const host of ["track", "ghost", "style"]) for (const [valid, curves] of [[true, shapes], [false, malformed]] as const) {
    for (const curve of curves) {
      const d = structuredClone(good), slide = d.slides[0];
      const beat = slideOps.addBeat(d, slide.id)!;
      const track = { target: slide.elements[0].id, preset: "transform", curve };
      if (host === "style") (d as any).animStyles = [{ id: "curve-style", name: "Curve", family: "transform", track }];
      else beat.tracks.push({ ...track, ...(host === "ghost" ? { ghostFrom: "source" } : {}) } as any);
      const pass = (validateDeckFile(JSON.parse(JSON.stringify(d))).length === 0) === valid;
      const message = `${host}: ${JSON.stringify(curve)} ${valid ? "validates" : "is refused"}`;
      if (pass) console.log("  ok:", message); else failures.push(message);
    }
  }
  assert(!failures.length, `curve schema contracts (${failures.length} failures): ${failures.join("; ")}`);
}

// --- malformed decks are rejected -----------------------------------------------
// M3 integration decision D1: legacy hand-written easing strings use the
// player's default after migration; the on-disk enum remains strict.
{
  const d = structuredClone(good), s = d.slides[0], b = slideOps.addBeat(d, s.id)!;
  b.tracks = [{ id: "unknown-ease", target: s.elements[0].id, preset: "fade", easing: "ease-in-out" as any }];
  d.animStyles = [{ id: "unknown-style", name: "Legacy", family: "appearance", track: { preset: "fade", easing: "ease-in-out" as any } }];
  assert(validateDeckFile(d).length > 0, "D1: unknown easing is still rejected by the disk enum before migration");
  slideOps.migrateDeck(d);
  assert(!Object.hasOwn(b.tracks[0], "easing") && !Object.hasOwn(d.animStyles[0].track, "easing"), "D1: migration drops unknown easing tokens on tracks and styles");
  assert(validateDeckFile(d).length === 0, "D1: a hand-written ease-in-out deck migrates and validates instead of being quarantined");
  const bytes = JSON.stringify(d);
  slideOps.migrateDeck(d);
  assert(JSON.stringify(d) === bytes, "D1: easing migration is idempotent");
}

// --- malformed decks are rejected -----------------------------------------------
{
  const noStage = structuredClone(good) as unknown as Record<string, unknown>;
  delete noStage.stage;
  assert(validateDeckFile(noStage).length > 0, "missing stage → rejected");
}
{
  const badEl = structuredClone(good);
  (badEl.slides[0].elements as unknown[]).push({ id: "z", type: "blob", x: 0 });
  assert(validateDeckFile(badEl).length > 0, "an element outside the figure union (type 'blob') → rejected");
}
{
  const nanGeom = structuredClone(good);
  (nanGeom.slides[0].elements[0] as unknown as { x: unknown }).x = null; // JSON.stringify(NaN)
  assert(validateDeckFile(nanGeom).length > 0, "null-corrupted geometry (the NaN persistence bug) → rejected");
}

// --- the CLEAN BREAK: a 0.1.x deck fails validation -------------------------------
const oldDeck = {
  schemaVersion: "0.1.0",
  id: "old",
  title: "Old",
  stage: { width: 1280, height: 720 },
  theme: "flux-dark",
  assets: [],
  slides: [
    {
      id: "s1",
      elements: [{ type: "textBox", id: "tb", x: 0, y: 0, width: 100, height: 40, rotation: 0, blocks: [{ id: "b", text: "hi" }] }],
      beats: [{ id: "b0", tracks: [] }],
    },
  ],
};
assert(validateDeckFile(oldDeck).length > 0, "a 0.1.x deck (textBox elements) FAILS validation — no migration, no compat shim (owner decision)");
assert(!isNewerSchema(oldDeck.schemaVersion, DECK_SCHEMA_VERSION), "…and it is NOT 'newer' — it takes the quarantine path, not the refuse path");

// --- forward-version guard runs BEFORE validation ---------------------------------
assert(isNewerSchema("0.7.0", DECK_SCHEMA_VERSION), "a 0.7.x deck is NEWER (refuse + toast; never rewritten, never quarantined)");
assert(!isNewerSchema("0.6.9", DECK_SCHEMA_VERSION), "0.6.x patch versions are OUR line (loadable)");
assert(!isNewerSchema("0.5.0", DECK_SCHEMA_VERSION), "0.5.x is OLDER — it takes the migrate path, never the refuse path");
assert(!isNewerSchema("0.2.0", DECK_SCHEMA_VERSION), "0.2.x is OLDER — it takes the migrate path, never the refuse path");

// --- validate_deck: dangling targets are warnings, not errors ---------------------
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-deckschema-"));
try {
  await scaffold(root, { title: "schema" });
  const d = slideOps.createDeck({ id: "dangle", title: "Dangle" });
  const sid = d.slides[0].id;
  const el = slideOps.addSlideText(d, sid, { text: "x", x: 0, y: 0 })!;
  const beat = slideOps.addBeat(d, sid, { label: "b" })!;
  slideOps.setAnimation(d, sid, beat.id, { target: el, preset: "fade" });
  slideOps.setAnimation(d, sid, beat.id, { target: "deleted-el", preset: "fade" });
  await saveDeck(root, d);
  const v = await validateDeckVerb(root, "dangle");
  assert(v.ok, "a deck with a dangling beat target still VALIDATES (ok)");
  assert(v.warnings.some((w) => w.includes("deleted-el")), "…but validate_deck reports the dangling target as a warning");
  assert(slideOps.danglingTrackTargets(d).length === 1, "danglingTrackTargets finds exactly the one dangler");

  // and saving never silently strips it
  const reread = JSON.parse(await fs.readFile(path.join(root, "slides", "dangle", "deck.json"), "utf8"));
  assert(JSON.stringify(reread).includes("deleted-el"), "the save does NOT auto-prune dangling targets (undo may restore the element)");

  // --- flux-core round trip: a 0.2.0 file on disk loads as 0.6.0, and the
  // first mutation persists the stamp (mutateDeck saves the migrated deck) ---
  const legacy = slideOps.createDeck({ id: "legacy", title: "Legacy" });
  (legacy as unknown as { schemaVersion: string }).schemaVersion = "0.2.0";
  const legacyPath = path.join(root, "slides", "legacy", "deck.json");
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, JSON.stringify(legacy, null, 2) + "\n");
  const loaded = await loadDeck(root, "legacy");
  assert(loaded.schemaVersion === "0.6.0", "flux-core loadDeck migrates a 0.2.0 file to 0.6.0 in memory");
  assert(JSON.parse(await fs.readFile(legacyPath, "utf8")).schemaVersion === "0.2.0", "…without rewriting the file on a pure read");
  await mutateDeck(root, "legacy", "noop", () => {});
  assert(JSON.parse(await fs.readFile(legacyPath, "utf8")).schemaVersion === "0.6.0", "the first mutation persists the 0.6.0 stamp to disk");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("\nDECK SCHEMA (0.6.0 load gate + 0.2–0.5 migration + clean break + dangling-target posture): PASS");

await h.done();
