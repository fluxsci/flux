import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TestProcessScope } from "./testProcess.mjs";
import { scratchProject, installTestLauncher, rawMcp } from "./mcpFixture";
import { createFigure, importPlots, addComment, loadFigModel } from "../../flux-core/index";
import { appendAnnotationEvent } from "../../flux-core/annotations";
import { makeNote, type SessionRef, type Route } from "../../src/lib/project/annotations";
import { buildPartIndex } from "../../src/lib/plot/parse";
import { presenceFileRel, type PresenceSession } from "../../src/lib/project/presence";
import { atomicWrite } from "../../flux-core/fsx";

export const repo = path.resolve(import.meta.dirname, "../..");
export { TestProcessScope, installTestLauncher, rawMcp };
export const textOf = (r: any): string => r.content.find((c: any) => c.type === "text")?.text ?? "";
export const dataOf = (r: any) => { if (r.isError) throw new Error(textOf(r)); return JSON.parse(textOf(r)); };
export function cleanEnv(extra: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of ["FLUX_PROJECT", "FLUX_CLIENT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_SANDBOX", "GEMINI_CLI"]) delete env[key];
  return { ...env, FLUX_NO_MIGRATE: "1", ...extra };
}
export async function until<T>(fn: () => T | Promise<T>, label: string, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20)); // condition polling, not a start-time assumption
  }
}
export async function writePresence(root: string, session: SessionRef, ago = 0, options: Partial<Pick<PresenceSession, "watching" | "watchMode" | "filter" | "live" | "product" | "surface">> = {}) {
  const file = path.join(root, presenceFileRel(session.id));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const value = { v: 1, ...session, display: session.name, product: "Codex", surface: "CLI", client: "codex", pid: process.pid,
    host: os.hostname(), startedAt: new Date().toISOString(), heartbeatAt: new Date(Date.now() - ago).toISOString(), watching: false, live: false, ...options };
  await atomicWrite(file, JSON.stringify(value) + "\n");
  return value;
}
export async function fixture(root: string) {
  root = await scratchProject(root, "Inbox gate");
  const docs = ["paper/draft_1.qmd", "paper/draft_2.qmd", "Context/ProjectContext.qmd"];
  const comments = [];
  for (const [i, doc] of docs.entries()) {
    await fs.mkdir(path.dirname(path.join(root, doc)), { recursive: true });
    await fs.writeFile(path.join(root, doc), `# Heading ${i}\n\nThe density changed. The density changed again.\n`);
    comments.push(await addComment(root, { docRel: doc, quote: "changed again", body: `Review document ${i} #stats`, author: "You" }));
  }
  await createFigure(root, { id: "review", nickname: "Density" });
  const { panels } = await importPlots(root, "review", [path.join(repo, "scripts/fixtures/fluxplot03/panels-a.svg")]);
  const plot = panels[0];
  const manifest = JSON.parse(await fs.readFile(path.join(root, `fig/assets/${plot.assetId}.fluxplot.json`), "utf8"));
  const partId = Object.keys(buildPartIndex(manifest))[0];
  const deck = { schemaVersion: "0.5.0", id: "talk", title: "Review talk", created: new Date().toISOString(), modified: new Date().toISOString(),
    stage: { width: 640, height: 360 }, theme: "flux-dark", defaults: { transition: "none", buildEasing: "standard", advance: "click" }, assets: [],
    slides: [{ id: "s1", name: "Results", elements: [], beats: [{ id: "b0", tracks: [] }, { id: "b1", label: "Reveal", tracks: [{ id: "t1", target: "el-1", preset: "fade", start: 20, duration: 320 }] }] }] };
  await fs.mkdir(path.join(root, "slides/talk"), { recursive: true });
  await fs.writeFile(path.join(root, "slides/talk/deck.json"), JSON.stringify(deck));
  const notes = [
    makeNote("Tidy the plot #stats", { surface: "figure", activeFigureId: "review", targets: [{ kind: "part", figureId: "review", elementId: plot.elementId, partId }] }, "human", "any"),
    makeNote("Check paragraph #prose", { surface: "paper", doc: { path: docs[0], from: 13, to: 33, quote: "The density changed." } }, "human", "any"),
    makeNote("Slow the reveal #motion", { surface: "slide", targets: [{ kind: "track", deckId: "talk", slideId: "s1", trackId: "t1" }] }, "human", "any"),
    makeNote("Explain passage #stats", { surface: "reader", reader: { citekey: "fixture2026", page: 2, selection: "the result" } }, "human", "any"),
  ];
  for (const note of notes) await appendAnnotationEvent(root, note);
  const model = await loadFigModel(root);
  return { root, docs, comments, notes, plot, partId, figure: model.project.figures.find(f => f.id === "review")! };
}
export async function note(root: string, text: string, route: Route = "any") {
  const event = makeNote(text, { surface: "figure" }, "human", route);
  await appendAnnotationEvent(root, event);
  return event;
}
export function worker(scope: TestProcessScope, root: string, action: string, args: Record<string, unknown> = {}) {
  return scope.spawn(path.join(repo, "scripts/fixtures/inbox-worker.mjs"), [root, action, JSON.stringify(args)], { readyLine: "READY", deadlineMs: 30000 });
}
export function cli(scope: TestProcessScope, root: string, args: string[], env = cleanEnv()) {
  return scope.spawn(path.join(repo, "flux-cli.ts"), [...args, "--root", root], { env, deadlineMs: 30000 });
}
