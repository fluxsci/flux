// Ghost transforms through the real CLI and shared persistence/validation seams.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildScaffoldTree } from "../src/lib/project/scaffoldTree";
import { loadDeck, saveDeck, addGhostTransform } from "../flux-core/slides";
import * as ops from "../src/lib/slide/ops";
import { compileSlide } from "../src/lib/slide/compile";
import { validateDeckFile } from "../src/lib/project/validate";
import { DECK_SCHEMA_VERSION } from "../src/lib/slide/types";
import { isNewerSchema } from "../src/lib/project/types";

let checks = 0;
const ok = (condition: unknown, message: string) => { assert.ok(condition, message); checks++; };
const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-ghost-api-"));
const repo = path.resolve(import.meta.dirname, "..");
try {
  const tree = buildScaffoldTree({ title: "Ghost API verification" }, ops.createDeck());
  for (const dir of tree.dirs) await fs.mkdir(path.join(root, dir), { recursive: true });
  for (const [rel, contents] of tree.files) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), contents);
  }
  const deck = ops.createDeck({ id: "ghost-api", withTitleSlide: false });
  const slide = ops.addSlide(deck, { id: "split", layout: "blank" });
  const source = ops.addSlideText(deck, slide.id, { text: "Signal", x: 60, y: 100, width: 140, height: 32 });
  const earlier = ops.addBeat(deck, slide.id, { id: "earlier" })!;
  ops.setTransform(deck, slide.id, earlier.id, source, { state: { x: 110, text: "Signal 2" } });
  const birth = ops.addBeat(deck, slide.id, { id: "birth" })!;
  await saveDeck(root, deck);
  const endpoints = [{ x: 220, y: 50 }, { x: 300, y: 150 }, { x: 410, y: 250 }];
  const cli = spawnSync(process.execPath, ["--import", "tsx", "flux-cli.ts", "ghost-transform", deck.id, slide.id, birth.id, source,
    "--root", root, "--count", "3", "--states", JSON.stringify(endpoints), "--original", "stay", "--duration", "900"],
    { cwd: repo, encoding: "utf8", env: { ...process.env, FLUX_NO_MIGRATE: "1" }, timeout: 30000 });
  ok(cli.status === 0, `CLI succeeds: ${cli.stderr}`);
  const created = JSON.parse(cli.stdout);
  ok(created.elementIds.length === 3 && created.trackIds.length === 3, "CLI returns independent result and track identities");
  const loaded = await loadDeck(root, deck.id);
  ok(loaded.schemaVersion === DECK_SCHEMA_VERSION && isNewerSchema(DECK_SCHEMA_VERSION, "0.3.0"), "old players refuse the ghost birth format");
  ok(validateDeckFile(loaded).length === 0, "ghost deck passes the real shared validator");
  const compiled = compileSlide(loaded.slides[0]);
  ok(created.elementIds.every((id: string) => compiled.sample(1).presentation.unbornElementIds.includes(id)), "CLI copies are unborn before the selected step");
  for (const [i, id] of created.elementIds.entries()) {
    const start = compiled.sample(2, 0).elements.find(e => e.id === id)!;
    const end = compiled.sample(2).elements.find(e => e.id === id)!;
    ok(start.x === 110 && start.type === "text" && start.text === "Signal 2", "copy starts from the original's prior animated state");
    ok(end.x === endpoints[i].x && end.y === endpoints[i].y, "copy reaches its independent saved destination");
  }
  ok(compiled.sample(2).elements.find(e => e.id === source)?.x === 110, "original remains unchanged by the copy transforms");
  const malformed = structuredClone(loaded);
  const track = malformed.slides[0].beats[2].tracks.find(t => t.ghostFrom)!;
  track.preset = "fade";
  ok(validateDeckFile(malformed).length > 0, "birth metadata cannot silently turn into an ordinary appearance");
  track.preset = "transform"; track.part = "axis.x";
  ok(validateDeckFile(malformed).length > 0, "ghost births are whole objects, not ambiguous part targets");
  delete track.part; track.ghostFrom = "";
  ok(validateDeckFile(malformed).length > 0, "empty birth origin is rejected");
  const file = path.join(root, "slides", deck.id, "deck.json");
  const bytes = await fs.readFile(file, "utf8");
  await assert.rejects(addGhostTransform(root, deck.id, slide.id, birth.id, source, { count: 0 }), /copies.*1 to 32/i); checks++;
  ok(await fs.readFile(file, "utf8") === bytes, "invalid copy count cannot partially mutate the deck");
  const again = spawnSync(process.execPath, ["--import", "tsx", "flux-cli.ts", "ghost-transform", deck.id, slide.id, birth.id, source,
    "--root", root, "--count", "33"], { cwd: repo, encoding: "utf8", env: { ...process.env, FLUX_NO_MIGRATE: "1" }, timeout: 30000 });
  ok(again.status !== 0 && await fs.readFile(file, "utf8") === bytes, "CLI rejects an excessive batch without saved changes");
  console.log(`##VERIFY## ${JSON.stringify({ script: "verify-slide-ghost-api", ok: true, checks })}`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
