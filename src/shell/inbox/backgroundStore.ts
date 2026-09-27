import { get } from "svelte/store";
import { fileBridge, type RunnerDriver, type RunnerEvent } from "../../lib/project/types";
import { currentProject } from "../shellStore";
import { backgroundAvailable, backgroundDrivers, backgroundRuns, backgroundPermissions, type BackgroundRun } from "./backgroundState";
let wired = false, epoch = 0, root: string | null = null;
let probing: Promise<void> | undefined;
const starting = new Map<string, Promise<void>>();
const early: RunnerEvent[] = [];
const followUps = new Map<string, string[]>();

function receive(event: RunnerEvent) {
  const runs = new Map(get(backgroundRuns));
  const run = [...runs.values()].find(r => r.runId === event.runId);
  if (!run) { if (starting.size && early.length < 128) early.push(event); return; }
  if (run.root !== root) return;
  const next: BackgroundRun = { ...run };
  if (event.type === "status" && event.state === "cancelled") followUps.delete(run.itemId);
  if (event.type === "session") next.sessionId = event.sessionId;
  else if (event.type === "background") { next.name = event.name; next.display = event.display; }
  else if (event.type === "status") { next.state = event.state; next.reason = event.reason; }
  else if (event.type === "error") next.error = event.message;
  else if (event.type === "message") next.message = event.text;
  else if (event.type === "tool") next.tools = [...next.tools.filter(t => t.toolId !== event.toolId), event].slice(-12);
  else if (event.type === "usage") next.usage = event;
  else if (event.type === "permission") backgroundPermissions.update(p => [...p.filter(e => e.permissionId !== event.permissionId), event]);
  else if (event.type === "permission.closed") backgroundPermissions.update(p => p.filter(e => e.permissionId !== event.permissionId));
  if (event.type === "status" && ["cancelled", "failed", "idle", "done"].includes(event.state)) backgroundPermissions.update(p => p.filter(e => e.runId !== event.runId));
  runs.set(run.itemId, next); backgroundRuns.set(runs);
  if (event.type === "status" && ["idle", "failed", "done"].includes(event.state)) {
    const queued = followUps.get(run.itemId);
    if (queued?.length) {
      followUps.delete(run.itemId);
      void followUpBackground(run.root, run.itemId, queued.join("\n\n")).catch(e => {
        backgroundRuns.update(r => { const m = new Map(r), current = m.get(run.itemId); if (current) m.set(run.itemId, { ...current, error: e.message }); return m; });
      });
    }
  }
}
export function refreshBackgroundCapabilities(): Promise<void> {
  return probing ??= (async () => {
    const caps = await fileBridge()?.runnerCapabilities?.() ?? [];
    backgroundDrivers.set(caps.filter(c => c.available).map(c => c.driver));
    backgroundAvailable.set(caps.some(c => c.available));
  })().catch(() => { backgroundDrivers.set([]); backgroundAvailable.set(false); }).finally(() => { probing = undefined; });
}
export function initBackgroundRuns() {
  if (wired) return;
  wired = true;
  fileBridge()?.onRunnerEvent?.(receive);
  currentProject.subscribe(project => {
    if (root === (project?.path ?? null)) return;
    root = project?.path ?? null; epoch++;
    const previous = [...get(backgroundRuns).values()];
    backgroundRuns.set(new Map()); backgroundPermissions.set([]); early.length = 0; followUps.clear(); starting.clear();
    for (const run of previous) void fileBridge()?.runnerCancel?.({ runId: run.runId }).catch(() => {});
  });
  void refreshBackgroundCapabilities();
}
export async function startBackgroundRun(ownerRoot: string, itemId: string, driver: RunnerDriver, text = ""): Promise<void> {
  initBackgroundRuns();
  if (ownerRoot !== root) throw new Error("Project changed before starting the agent");
  if (starting.has(itemId)) return starting.get(itemId);
  const generation = epoch;
  const task = (async () => {
    const fb = fileBridge();
    if (!fb?.runnerStart) throw new Error("Background runs require the desktop app");
    const previous = get(backgroundRuns).get(itemId);
    if (previous && previous.state !== "cancelled") await fb.runnerCancel?.({ runId: previous.runId });
    const result = await fb.runnerStart({ driver, mode: "task", root: ownerRoot, itemId, firstMessage: text });
    if (epoch !== generation) { await fb.runnerCancel?.({ runId: result.runId }); return; }
    backgroundRuns.update(runs => new Map(runs).set(itemId, { ...result, itemId, root: ownerRoot, state: "starting", tools: [], message: "" }));
    for (const event of early.splice(0)) receive(event);
  })();
  starting.set(itemId, task);
  try { await task; } finally { if (starting.get(itemId) === task) starting.delete(itemId); }
}
export async function followUpBackground(ownerRoot: string, itemId: string, text: string): Promise<void> {
  initBackgroundRuns();
  const pending = starting.get(itemId); if (pending) await pending;
  const run = get(backgroundRuns).get(itemId);
  if (!run || run.root !== ownerRoot) return;
  if (run.sessionId && ["idle", "done"].includes(run.state)) {
    const fb = fileBridge();
    if (!fb?.runnerSend) throw new Error("The app cannot resume this background run");
    // Publish before IPC: a fast first event must not be overwritten by the reply.
    backgroundRuns.update(runs => new Map(runs).set(itemId, { ...run, state: "starting", error: undefined, tools: [], message: "" }));
    try { await fb.runnerSend({ runId: run.runId, text }); }
    catch (e) {
      if (ownerRoot === root) backgroundRuns.update(runs => {
        const current = runs.get(itemId);
        return current?.runId === run.runId ? new Map(runs).set(itemId, { ...current, state: "failed", error: (e as Error).message }) : runs;
      });
      throw e;
    }
  } else if (["starting", "running"].includes(run.state)) {
    followUps.set(itemId, [...(followUps.get(itemId) ?? []), text]);
  } else await startBackgroundRun(ownerRoot, itemId, run.driver, text);
}
export async function stopBackgroundRun(runId: string): Promise<void> { await fileBridge()?.runnerCancel?.({ runId }); }
export async function respondBackground(runId: string, permissionId: string, optionId: "allow" | "deny") {
  const fb = fileBridge();
  if (!fb?.runnerRespond) throw new Error("The app cannot answer this permission request");
  await fb.runnerRespond({ runId, permissionId, optionId });
}
