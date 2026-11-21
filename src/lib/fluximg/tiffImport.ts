/**
 * A TIFF dropped on Flux (or picked, pasted, or placed from the Plots rail) becomes an image: probed in the converter
 * child, answered, converted with progress and cancel, then placed through the ordinary bundle path
 * (`import.ts` `readMadeFluximg`: dedupe by content id, install, ONE undo step for the placement).
 *
 * Ask only when needed (never convert a file without metadata on a guess: a wrong page order is a plausible, wrong
 * image). The top proposal is `ready` (OME, ImageJ, per-page JSON that partitions the pages, shaped JSON with axis
 * names, a single plane, a remembered rule): it converts at once and the progress toast says what was understood,
 * with Change beside it (cancels and opens the asking surface). Otherwise the ASKING SURFACE opens on the canvas
 * where the image will land (`TiffAskSurface.svelte`, mounted by Canvas from `tiffAsk`). A drop of several files of
 * one family asks once: the answer becomes a rule (`answerRule`) applied to the rest (`applyRule`).
 *
 * State lives here; the surface only reads `tiffAsk` and calls the `ask*` functions.
 */
import { get, writable } from "svelte/store";
import { project, activeFigureId } from "../store";
import { storeTenant } from "../tenancy";
import { fileBridge, joinPath } from "../project/types";
import { updateManifest } from "../project/manifestBridge";
import { pushToast, pushJobToast, updateToast, dismissToast, errMsg } from "../toast";
import { placeIncoming, type Incoming, type PlaceAt } from "../io";
import { assertFluximgDestination, ensureFluximgImportRoot, fluximgImportRoot, readMadeFluximg } from "./import";
import { fluximgSourceRecord } from "./importCore";
import { answerRule, applyRule, describeAnswer, validateAnswer } from "../tiff/infer";
import { consultedRules, forgetRule, rememberRule, sanitizeRules, type RememberedRule } from "../tiff/remember";
import type { DimsAnswer, DimsProposal, TiffProbe } from "../tiff/types";
import type { TiffConvertResult, TiffPreviewPng, TiffProbeResult, TiffProgress } from "../tiff/bridge";
import type { FluximgImportResult } from "./bridge";

/** A file name that is a TIFF. */
export const isTiffName = (name: string): boolean => /\.tiff?$/i.test(name || "");

/** Where a TIFF comes from: a path the window may read, or a File the person dropped or pasted. */
export type TiffSource = { path: string } | { file: File };
const labelOf = (s: TiffSource): string => ("file" in s ? s.file.name : s.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? s.path);

// ---------------------------------------------------------------------------------------------------------------
// The asking surface's state
// ---------------------------------------------------------------------------------------------------------------

export { tiffAsk, type AskState, type RememberScope } from "./tiffAsk";
import { tiffAsk, type AskState, type RememberScope } from "./tiffAsk";

interface Open { token: string; resolve: (a: { answer: DimsAnswer; remember: RememberScope } | null) => void; root: string; seq: number; inflight: boolean; queued: DimsAnswer | null; hoverSeq: number }
let open: Open | null = null;
let askSeq = 0;

function fileSays(probe: TiffProbe): Record<string, string> {
  const out: Record<string, string> = {};
  const name: Record<string, string> = { ome: "OME metadata", imagej: "ImageJ metadata", pagejson: "the pages' own data", shaped: "the file's shape note", resolution: "the resolution tags" };
  for (const h of probe.hints) {
    if (h.pixelSize && !out.pixelSize) out.pixelSize = name[h.source] ?? "the file";
    if (h.time && !out.time) out.time = name[h.source] ?? "the file";
    if (h.z && !out.z) out.z = name[h.source] ?? "the file";
    if (h.channels?.some((c) => c.name || c.color) && !out.channels) out.channels = name[h.source] ?? "the file";
  }
  return out;
}

/** Open the asking surface for one file; resolves with the answer, or null when the person cancels. */
function ask(token: string, root: string, r: TiffProbeResult, figureId: string, at: { x: number; y: number }, start: DimsAnswer | null, remembered: AskState["remembered"], batch: AskState["batch"]): Promise<{ answer: DimsAnswer; remember: RememberScope } | null> {
  return new Promise((resolve) => {
    const answer: DimsAnswer = JSON.parse(JSON.stringify(start ?? r.proposals[0]?.answer ?? { dims: [] }));
    open = { token, resolve, root, seq: 0, inflight: false, queued: null, hoverSeq: 0 };
    tiffAsk.set({
      id: ++askSeq, figureId, at, name: r.name, probe: r.probe, proposals: r.proposals, answer, chosen: start ? -1 : 0, fileSays: fileSays(r.probe),
      preview: start ? null : r.preview, hover: null, problem: validateAnswer(r.probe, answer), remember: "off", remembered, batch,
    });
    if (start) requestPreview(answer);
  });
}

/** Ask the child for pictures of `answer`; keeps only the newest (one in flight, the latest queued). */
function requestPreview(answer: DimsAnswer): void {
  const o = open, bridge = fileBridge();
  if (!o || !bridge?.previewTiff) return;
  if (o.inflight) { o.queued = answer; return; }
  o.inflight = true;
  const seq = ++o.seq;
  bridge.previewTiff({ root: o.root, token: o.token, answer, max: 192 }).then((p) => {
    if (open === o && seq === o.seq) tiffAsk.update((s) => (s ? { ...s, preview: p } : s));
  }).catch(() => { /* the surface keeps the last picture; Convert's reason says what is wrong */ }).finally(() => {
    o.inflight = false;
    const next = o.queued;
    o.queued = null;
    if (next && open === o) requestPreview(next);
  });
}

/** Replace the answer (the surface's every edit): re-validated and re-pictured at once. */
export function askSet(next: DimsAnswer, opts: { chosen?: number } = {}): void {
  const s = get(tiffAsk);
  if (!s) return;
  tiffAsk.set({ ...s, answer: next, chosen: opts.chosen ?? -1, problem: validateAnswer(s.probe, next), hover: null });
  requestPreview(next);
}
/** Show what a hovered key would make (null: back to the answer). Nothing is written. */
export function askHover(candidate: DimsAnswer | null): void {
  const o = open, bridge = fileBridge();
  if (!o || !bridge?.previewTiff) return;
  const seq = ++o.hoverSeq;
  if (!candidate) { tiffAsk.update((s) => (s ? { ...s, hover: null } : s)); return; }
  bridge.previewTiff({ root: o.root, token: o.token, answer: candidate, max: 192 }).then((p) => {
    if (open === o && seq === o.hoverSeq) tiffAsk.update((s) => (s ? { ...s, hover: p } : s));
  }).catch(() => {});
}
export function askChoose(i: number): void {
  const s = get(tiffAsk);
  const p = s?.proposals[i];
  if (!s || !p) return;
  askSet(JSON.parse(JSON.stringify(p.answer)), { chosen: i });
}
export function askRemember(scope: RememberScope): void { tiffAsk.update((s) => (s ? { ...s, remember: scope } : s)); }
/** Convert with the answer as it stands (refused with the reason while it does not fit). */
export function askConvert(): boolean {
  const s = get(tiffAsk), o = open;
  if (!s || !o || s.problem) return false;
  close({ answer: s.answer, remember: s.remember });
  return true;
}
/** Esc or ×: nothing is converted, nothing is left. */
export function askCancel(): void { close(null); }
function close(result: { answer: DimsAnswer; remember: RememberScope } | null): void {
  const o = open;
  open = null;
  tiffAsk.set(null);
  o?.resolve(result);
}
/** Forget the rule remembered for files like the one being asked about. */
export async function askForget(): Promise<void> {
  const s = get(tiffAsk), o = open;
  if (!s?.remembered || !o) return;
  await forget(o.root, s.probe.fingerprint, s.remembered.scope);
  tiffAsk.update((x) => (x ? { ...x, remembered: null } : x));
}

// ---------------------------------------------------------------------------------------------------------------
// Remembered answers: the project's (project.json `tiffRules`) and the machine's (FluxConfig)
// ---------------------------------------------------------------------------------------------------------------

async function projectRules(root: string): Promise<RememberedRule[]> {
  const bridge = fileBridge();
  try { return sanitizeRules(JSON.parse(await bridge!.readText(joinPath(root, "project.json"))).tiffRules); } catch { return []; }
}
async function machineRules(): Promise<RememberedRule[]> {
  try { return sanitizeRules(await fileBridge()?.readTiffRules?.()); } catch { return []; }
}
async function remember(root: string, probe: TiffProbe, answer: DimsAnswer, scope: "project" | "machine"): Promise<void> {
  const rule = answerRule(answer, probe), summary = describeAnswer(probe, rule.answer).replace(/^[a-z_][a-z0-9_]* \d+ ×/, (m) => m.replace(/ \d+ ×/, " ×")), saved = new Date().toISOString().slice(0, 10);
  if (scope === "machine") { await fileBridge()!.writeTiffRules!(rememberRule(await machineRules(), rule, summary, saved)); return; }
  await updateManifest(root, (m) => { (m as { tiffRules?: unknown }).tiffRules = rememberRule(sanitizeRules((m as { tiffRules?: unknown }).tiffRules), rule, summary, saved); });
}
async function forget(root: string, fingerprint: string, scope: "project" | "machine"): Promise<void> {
  if (scope === "machine") { await fileBridge()!.writeTiffRules!(forgetRule(await machineRules(), fingerprint)); return; }
  await updateManifest(root, (m) => {
    const next = forgetRule(sanitizeRules((m as { tiffRules?: unknown }).tiffRules), fingerprint);
    if (next.length) (m as { tiffRules?: unknown }).tiffRules = next; else delete (m as { tiffRules?: unknown }).tiffRules;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Progress (the import toast, grown for a multi-second job)
// ---------------------------------------------------------------------------------------------------------------

const fmtBytes = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const fmtTime = (s: number): string => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);

/** The progress line: phase in words, planes done of total, bytes read, and time left once the estimate is steady. */
export function progressWords(p: TiffProgress, est: { left: number | null }): string {
  if (p.queued) return "waiting for the conversion before it";
  if (!p.phase) return "starting";
  const parts = [`${p.phase === "learn" ? "reading" : "storing"} ${(p.done ?? 0).toLocaleString("en-US")} of ${(p.total ?? 0).toLocaleString("en-US")} planes`];
  if (p.bytesRead) parts.push(`${fmtBytes(p.bytesRead)} read`);
  if (est.left !== null) parts.push(`${fmtTime(est.left)} left`);
  return parts.join(" · ");
}
/** Time left, shown only once it is steady: after 1.5 s and 10 %, smoothed, and only while successive estimates agree. */
export function timeLeft(prev: { left: number | null; raw: number[] }, p: TiffProgress): { left: number | null; raw: number[] } {
  const f = p.fraction ?? 0, t = (p.elapsedMs ?? 0) / 1000;
  if (!(f > 0.1 && t > 1.5 && f < 1)) return { left: f >= 1 ? 0 : prev.left, raw: prev.raw };
  const raw = [...prev.raw, (t * (1 - f)) / f].slice(-4);
  const steady = raw.length >= 3 && Math.max(...raw) <= 1.35 * Math.min(...raw);
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return { left: steady ? mean : prev.left, raw };
}

// ---------------------------------------------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------------------------------------------

interface Item { source: TiffSource; label: string; result: TiffProbeResult }
let jobSeq = 0;
const uniq = (): string => `${Date.now().toString(36)}${(++jobSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** What the gates read: the jobs of this window as they run. */
export const tiffJobs = writable<Array<{ jobId: string; label: string; summary: string; state: "converting" | "placed" | "cancelled" | "failed"; progress: TiffProgress | null }>>([]);

/**
 * Bring TIFFs onto figure `figId` (or a slide). Resolves with how many were placed. Refusals and failures are
 * toasts naming the cause and a way out; nothing is ever dropped silently.
 */
export async function importTiffSources(sources: TiffSource[], figId: string, at?: PlaceAt): Promise<number> {
  if (!sources.length) return 0;
  assertFluximgDestination();
  const root = await ensureFluximgImportRoot();
  const bridge = fileBridge();
  if (!bridge?.probeTiff || !bridge.convertTiff) throw new Error("TIFF import needs the Flux desktop app.");
  const tenant = storeTenant();
  const current = (): boolean => fluximgImportRoot() === root && storeTenant() === tenant && get(project).figures.some((f) => f.id === figId);
  const fig = get(project).figures.find((f) => f.id === figId);
  if (!fig) throw new Error("The insertion destination changed");
  const where = at ? { x: at.x, y: at.y } : { x: fig.width / 2, y: fig.height / 2 };
  const [pRules, mRules] = await Promise.all([projectRules(root), machineRules()]);
  const rules = consultedRules(pRules, mRules);

  // 1. Probe every file (a refused one is said, not dropped).
  const refused: string[] = [], items: Item[] = [];
  for (const source of sources) {
    const label = labelOf(source);
    try {
      const result = "file" in source ? await bridge.probeDroppedTiff!(source.file, { root, rules }) : await bridge.probeTiff({ root, sourcePath: source.path, rules });
      if (result.probe.refusals.length) { refused.push(`${label}: ${result.probe.refusals.map((r) => r.message).join("; ")}`); void bridge.releaseTiff?.(result.token); continue; }
      items.push({ source, label, result });
    } catch (error) { refused.push(`${label}: ${errMsg(error)}`); }
  }
  if (refused.length) pushToast("error", refused.length === 1 ? "This TIFF cannot be imported" : `${refused.length} TIFFs cannot be imported`, { detail: refused.join("\n") });
  if (!items.length) return 0;

  // 2. Answers: from the file or a remembered rule at once; otherwise asked, once per family of this drop.
  const family = new Map<string, ReturnType<typeof answerRule>>();
  const skipped = new Set<string>();
  const toAsk = items.filter((it) => !it.result.proposals[0]?.ready);
  let asked = 0;
  const plan: Array<{ item: Item; answer: DimsAnswer; how: "file" | "remembered" | "asked" | "family" }> = [];
  const rememberedOf = (probe: TiffProbe): AskState["remembered"] => {
    const p = pRules.find((r) => r.fingerprint === probe.fingerprint), m = mRules.find((r) => r.fingerprint === probe.fingerprint);
    return p ? { scope: "project", summary: p.summary } : m ? { scope: "machine", summary: m.summary } : null;
  };
  const askFor = async (item: Item, start: DimsAnswer | null): Promise<DimsAnswer | null> => {
    const got = await ask(item.result.token, root, item.result, figId, where, start, rememberedOf(item.result.probe), { index: ++asked, count: Math.max(asked, toAsk.length) });
    if (!got) return null;
    if (got.remember !== "off") {
      try { await remember(root, item.result.probe, got.answer, got.remember); }
      catch (error) { pushToast("error", "The answer could not be remembered", { detail: errMsg(error) }); }
    }
    return got.answer;
  };
  for (const item of items) {
    const fp = item.result.probe.fingerprint, top = item.result.proposals[0];
    if (skipped.has(fp)) continue;
    const rule = family.get(fp);
    if (rule) { const a = applyRule(rule, item.result.probe); if (a.answer && !a.problems.length) { plan.push({ item, answer: a.answer, how: "family" }); continue; } }
    if (top?.ready) { plan.push({ item, answer: top.answer, how: top.from === "remembered" ? "remembered" : "file" }); continue; }
    if (!current()) break;
    const answer = await askFor(item, null);
    if (!answer) { skipped.add(fp); continue; }
    family.set(fp, answerRule(answer, item.result.probe));
    plan.push({ item, answer, how: "asked" });
  }
  for (const item of items) if (!plan.some((p) => p.item === item)) void bridge.releaseTiff?.(item.result.token);
  if (!plan.length) return 0;

  // 3. Convert one by one (the window's child runs one at a time anyway), one toast for the batch.
  const incoming: Incoming[] = [], notes: string[] = [];
  let aborted = false;
  let toast = pushJobToast("info", "Converting…", { tag: "tiff-import", progress: 0 });
  try {
    for (let i = 0; i < plan.length && !aborted; i++) {
      let { answer } = plan[i];
      const { item, how } = plan[i];
      for (;;) {
        if (!current()) { aborted = true; break; }
        const jobId = `tiff-${uniq()}`;
        let change = false, cancel = false;
        const summary = describeAnswer(item.result.probe, answer);
        const head = `${item.label}: ${summary}${how === "remembered" ? " (remembered)" : ""}`;
        const batchWord = plan.length > 1 ? `${i + 1} of ${plan.length} · ` : "";
        let est: { left: number | null; raw: number[] } = { left: null, raw: [] };
        const actions = [
          { label: "Change", run: () => { change = true; void bridge.cancelTiff?.(jobId); } },
          { label: "Cancel", run: () => { cancel = true; void bridge.cancelTiff?.(jobId); } },
        ];
        // Change or Cancel dismissed the toast: the next conversion of the batch brings its own.
        if (!updateToast(toast, { msg: head, detail: `${batchWord}starting`, progress: 0, actions })) toast = pushJobToast("info", head, { tag: "tiff-import", detail: `${batchWord}starting`, progress: 0, actions });
        tiffJobs.update((l) => [...l, { jobId, label: item.label, summary, state: "converting", progress: null }]);
        const off = bridge.onTiffProgress?.((p) => {
          if (p.jobId !== jobId) return;
          est = timeLeft(est, p);
          updateToast(toast, { detail: batchWord + progressWords(p, est), progress: p.fraction ?? 0 });
          tiffJobs.update((l) => l.map((j) => (j.jobId === jobId ? { ...j, progress: p } : j)));
        });
        const made = {
          label: item.label,
          make: async (r: string, assetId: string): Promise<FluximgImportResult> => {
            const res: TiffConvertResult = await bridge.convertTiff!({ root: r, token: item.result.token, answer, assetId, jobId });
            notes.push(...(res.notes ?? []));
            return res;
          },
          source: (r: string, sha256: string) => ({ ...fluximgSourceRecord(r, item.result.sourcePath, sha256), frozen: true }),
        };
        try {
          const inc = await readMadeFluximg(made, figId);
          off?.();
          incoming.push(inc);
          tiffJobs.update((l) => l.map((j) => (j.jobId === jobId ? { ...j, state: "placed" } : j)));
          break;
        } catch (error) {
          off?.();
          tiffJobs.update((l) => l.map((j) => (j.jobId === jobId ? { ...j, state: (error as Error)?.name === "AbortError" || /cancelled/.test(errMsg(error)) ? "cancelled" : "failed" } : j)));
          if (change) {
            const next = await askFor(item, answer);
            if (!next) break; // asked again and cancelled: this file is left out
            answer = next;
            continue;
          }
          if (cancel || /cancelled/.test(errMsg(error))) { aborted = true; break; }
          pushToast("error", `${item.label} could not be converted`, { detail: errMsg(error) });
          break;
        }
      }
    }
  } finally {
    for (const it of items) void bridge.releaseTiff?.(it.result.token);
  }
  if (aborted || !current()) {
    dismissToast(toast);
    tiffAsk.set(null);
    for (const inc of incoming) await inc.discard?.().catch(() => {});
    if (aborted) pushToast("info", incoming.length ? "Import cancelled: nothing was added" : "Import cancelled");
    return 0;
  }
  if (!incoming.length) { dismissToast(toast); return 0; }
  // 4. Place: ONE undo step for everything this drop brought.
  try { placeIncoming(incoming, figId, at); }
  catch (error) { for (const inc of incoming) await inc.discard?.().catch(() => {}); dismissToast(toast); throw error; }
  // The toast's detail is the writer's storage note, as fluxplot prints it.
  const doneMsg = incoming.length === 1 ? `${incoming[0].asset.name} placed` : `${incoming.length} images placed`, detail = [...new Set(notes)].join(" ") || undefined;
  if (!updateToast(toast, { level: "success", msg: doneMsg, detail, progress: undefined, actions: [], ttl: 6000 })) pushToast("success", doneMsg, { detail, ttl: 6000 });
  return incoming.length;
}

/** Probe-free helper for the Plots rail and dialog: TIFF paths among others. */
export const tiffPaths = (paths: string[]): string[] => paths.filter((p) => isTiffName(p));
