// Add to FluxLib — background service worker.
//
// This is where the extension earns its keep. Page scripts (and therefore bookmarklets) are
// subject to the page's Content-Security-Policy, which is why capture silently fails on
// strict-CSP publishers in Firefox and why a fetch can be blocked even in Chrome. A background
// fetch made under host permissions is subject to none of that — and it still carries the
// user's cookies, so it walks through paywalls and the Cloudflare/PerimeterX walls that defeat
// automated browsers.
//
// The transport is deliberately the same as the bookmarklet's: files land in the download
// folder (in a `flux/` subfolder) named `flux-…`, and Flux's existing watcher files them. That
// means the receiver, the filename rules and their gates are shared, and this is a drop-in
// better front end rather than a second pipeline.
//
// TWO RULES LEARNED THE HARD WAY, both from real publisher pages:
//   • EVERY network call is time-boxed. A publisher behind Cloudflare can accept a connection
//     and then never send a byte; without a deadline the worker sits there and the badge stays
//     on "…" forever, which reads to the user as a hang with no way out.
//   • NOTHING fails silently. A swallowed error is worse than a visible one: it makes a
//     capture look complete when files are missing. Failures land on the badge and in the
//     button's tooltip, which needs no extra permission.
import { SUPPLEMENT_URL_PATTERNS, captureSlug, CAPTURE_SUBDIR, isCaptureFile, articleCaptureName, sidecarCaptureName, supplementCaptureName } from "./vendor/captureShared.js";
import { readPaperPage } from "./page.js";

const api = typeof browser !== "undefined" ? browser : chrome;
const RX_SOURCES = SUPPLEMENT_URL_PATTERNS.map((r) => r.source);
const MIN_PDF_BYTES = 1024;
/** A supplement can legitimately be a large movie; past this we skip rather than fill a disk. */
const MAX_SUPPLEMENT_BYTES = 64 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
/** Deadline for any single network call. Generous, but finite — see the header note. */
const NET_TIMEOUT_MS = 15000;
/** Whole-capture deadline, so the badge always resolves even if something exotic wedges. */
const RUN_TIMEOUT_MS = 90000;

const badge = (text, color) => {
  try {
    api.action.setBadgeText({ text });
    if (color) api.action.setBadgeBackgroundColor({ color });
  } catch {
    /* badges are cosmetic */
  }
};
const tip = (s) => {
  try {
    api.action.setTitle({ title: s });
  } catch {
    /* ditto */
  }
};
let badgeTimer;
const clearBadgeSoon = () => { clearTimeout(badgeTimer); badgeTimer = setTimeout(() => badge(""), 6000); };

/** Time-boxed fetch that always carries the user's session. Never hangs. */
let runController = null;
const netFetch = (url, opts = {}, owner = runController) => fetch(url, { credentials: "include", ...opts, signal: owner ? AbortSignal.any([owner.signal, AbortSignal.timeout(NET_TIMEOUT_MS)]) : AbortSignal.timeout(NET_TIMEOUT_MS) });
const currentRun = owner => runController === owner && !owner.signal.aborted;

// Filenames are NOT built here. They come from the shared rules module (articleCaptureName /
// sidecarCaptureName / supplementCaptureName), which sanitizes the publisher's half and THEN
// adds the structure — in that order. This file used to assemble the name itself and run the
// whole thing through a local sanitizer whose job included neutralizing the `@@` that
// separates a supplement's paper-slug from its filename. So every captured supplement landed
// as `flux-supp-<slug>_<name>`, which the receiver does not recognize: the files downloaded,
// the badge went green, and Flux never saw one of them.

// downloads.download() RESOLVES AS SOON AS THE DOWNLOAD IS ACCEPTED — long before the bytes
// arrive. So a publisher that answers 403 produces a perfectly happy promise and a file that
// never lands: exactly the "the supplement is found but the download fails" report, with
// nothing anywhere to explain it. The real outcome only shows up on downloads.onChanged, so
// every capture download is tracked to completion and reports the browser's own error code
// (SERVER_FORBIDDEN, NETWORK_FAILED, …).
const tracked = new Map(); // downloadId -> current operation-owned observation
const ownedCapture = item => item.byExtensionId === api.runtime.id && isCaptureFile(String(item.filename || "").replace(/\\/g,"/").split("/").pop() || "");

// Worker memory can disappear while browser downloads continue. Reconcile before
// accepting another capture. Never cancel an unattributable browser download.
const reconcileDownloads = async () => {
  const pending = await api.downloads.search({ state: "in_progress" });
  const ours = pending.filter(ownedCapture);
  const uncertain = pending.filter(item => !item.byExtensionId && isCaptureFile(String(item.filename || "").replace(/\\/g,"/").split("/").pop() || ""));
  const outcomes = await Promise.allSettled(ours.map(item => api.downloads.cancel(item.id)));
  if(outcomes.some(r=>r.status==="rejected"))throw new Error("Prior capture could not be cancelled; retry");
  if(ours.length || uncertain.length) {
    badge("!", "#8a6d1f");
    const stopped=outcomes.filter(r=>r.status === "fulfilled").length;
    tip(`Add to FluxLib — prior capture interrupted; ${stopped} owned pending transfer${stopped===1?"":"s"} cancelled${uncertain.length?`; ${uncertain.length} unattributable pending transfer${uncertain.length===1?"":"s"} left unchanged`:""}. Completed files are retained.`);
  }
};
let startupReady;
const ready = () => startupReady ??= reconcileDownloads().catch(error => {
  startupReady=undefined;badge("!", "#a02020");tip("Add to FluxLib — previous download state unavailable; retry before capturing");throw error;
});
// Attach rejection ownership immediately even if nobody clicks the action.
void ready().catch(() => {});

api.downloads.onChanged.addListener((d) => {
  const t = tracked.get(d.id);
  if (!t) return;
  const state = d.state?.current;
  if (state === "interrupted") t.fail(new Error(d.error?.current || "interrupted"));
  else void t.inspect(); // final state and byte counts are browser-owned, not event order
});

/** Await actual bytes/state, including completion before downloads.download resolves. */
async function download(url, filename, owner = runController) {
  if (!isCaptureFile(filename)) throw new Error(`internal: "${filename}" is not a name Flux recognises`);
  if (!owner || !currentRun(owner)) throw new Error("Capture cancelled");
  const id = await api.downloads.download({ url, filename: `${CAPTURE_SUBDIR}/${filename}`, conflictAction: "uniquify", saveAs: false });
  if (id === undefined) throw new Error(api.runtime?.lastError?.message || "download refused");
  if(!currentRun(owner)){await api.downloads.cancel(id).catch(()=>{});throw new Error("Capture cancelled");}
  return new Promise((resolve, reject) => {
    let settled=false, inspecting=null;
    const done = (fn,arg) => {
      if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);
      owner.signal.removeEventListener("abort",abort);tracked.delete(id);fn(arg);
    };
    const fail = error => done(reject,error);
    const stop = message => {void api.downloads.cancel(id).catch(()=>{});fail(new Error(message));};
    const abort = () => stop("Capture cancelled or timed out");
    const inspect = () => {
      if(settled)return Promise.resolve();if(inspecting)return inspecting;
      inspecting=(async()=>{
        const [item]=await api.downloads.search({id});if(settled)return;
        if(!item)throw new Error("Download disappeared before completion");
        const size=Math.max(0,Number(item.bytesReceived)||0,Number(item.totalBytes)||0,Number(item.fileSize)||0);
        owner.captureSizes ??= new Map();owner.captureSizes.set(id,Math.max(size,owner.captureSizes.get(id)||0));
        const total=[...owner.captureSizes.values()].reduce((a,b)=>a+b,0);
        if(size>MAX_SUPPLEMENT_BYTES){stop(`larger than ${Math.round(MAX_SUPPLEMENT_BYTES/1e6)}MB`);return;}
        if(total>MAX_CAPTURE_BYTES){stop("capture aggregate byte limit exceeded");owner.abort();if(runController===owner){badge("!","#a02020");tip("Add to FluxLib — capture incomplete: aggregate byte limit exceeded");clearBadgeSoon();}return;}
        if(!currentRun(owner)){abort();return;}
        if(item.state === "complete")done(resolve,id);
        else if(item.state === "interrupted")fail(new Error(item.error || "interrupted"));
      })().catch(error=>{stop(error.message||String(error));}).finally(()=>{inspecting=null;});
      return inspecting;
    };
    // Query the final state at the deadline: a lost complete event is still a
    // completed download; a pending browser transfer is never optimistic success.
    const timer=setTimeout(()=>{void inspect().then(()=>{if(!settled)stop("Download is still pending at its deadline");});},60000);
    const poll=setInterval(()=>void inspect(),250);
    tracked.set(id,{fail,inspect});owner.signal.addEventListener("abort",abort,{once:true});
    if(owner.signal.aborted)abort();else void inspect();
  });
}

/** If this tab is itself a PDF, its own URL is the thing to capture. Query strings are normal
 *  here — publishers sign these links (`…annurev-….pdf?expires=…&checksum=…`) — so the test is
 *  on the PATH, not the whole URL. */
function pdfTabUrl(u) {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && /\.pdf$/i.test(x.pathname) ? u : "";
  } catch {
    return "";
  }
}

/**
 * "yes" | "no" | "unknown" — is this really a PDF?
 *
 * "unknown" matters: a validation that TIMED OUT is not evidence of a bad file, and refusing to
 * capture because our own probe stalled would be the wrong call. The caller downloads anyway on
 * "unknown" — Flux's identifier rejects a non-PDF later, which is the safer place to be strict.
 */
async function looksLikePdf(url, owner) {
  let r;
  try {
    r = await netFetch(url, {}, owner);
  } catch {
    return "unknown"; // timeout / network — inconclusive, not a verdict
  }
  if (!r.ok) return "no";
  const len = Number(r.headers.get("content-length") || 0);
  if (len && len < MIN_PDF_BYTES) return "no";
  const type = (r.headers.get("content-type") || "").toLowerCase();
  if (!r.body) return type.includes("pdf") ? "yes" : "unknown";
  try {
    const reader = r.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    if (!value || value.length < 4) return "unknown";
    return new TextDecoder("latin1").decode(value.subarray(0, 5)).startsWith("%PDF") ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

/** Metadata-only capture, identical in shape to the bookmarklet's `.fluxcap`. */
async function saveSidecar(info, slug, reason, owner) {
  const payload = { v: 1, url: info.pageUrl, doi: info.doi, title: info.title, pdfUrl: info.pdfUrl, reason, capturedAt: new Date().toISOString() };
  const url = "data:application/json;base64," + btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 1))));
  await download(url, sidecarCaptureName(slug), owner);
}

/**
 * Read the page — or, when it can't be read, fall back to the tab itself.
 *
 * Browsers render a PDF in a viewer that is NOT an injectable document: executeScript fails
 * outright there. That used to surface as a red "!" on exactly the pages where capture should
 * be easiest, since the bytes are already fetched and on screen. We don't need the DOM for a
 * PDF anyway — the tab URL is the file.
 */
async function readPage(tab, notes) {
  const asPdf = pdfTabUrl(tab.url || "");
  try {
    const [res] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: readPaperPage, args: [RX_SOURCES] });
    if (res?.result) return res.result;
    if (!asPdf) notes.push("the page returned nothing");
  } catch (e) {
    if (!asPdf) notes.push(`couldn't read the page: ${e?.message || e}`);
  }
  if (!asPdf) return null;
  const seg = (() => {
    try {
      return (new URL(asPdf).pathname.split("/").filter(Boolean).pop() || "").replace(/\.pdf$/i, "");
    } catch {
      return "";
    }
  })();
  return { doi: "", title: tab.title || "", isPdf: true, pdfUrl: asPdf, supplements: [], pageUrl: asPdf, slugHint: seg || "capture" };
}

async function capture(tab, owner) {
  if (!tab?.id) return;
  badge("…", "#8a6d1f");
  tip("Add to FluxLib — working…");
  const notes = [];
  let got = 0, metadataSaved = false, mainMissing = false;

  const info = await readPage(tab, notes);
  if (!currentRun(owner)) return;
  if (!info) {
    badge("!", "#a02020");
    tip(`Add to FluxLib — ${notes[0] || "this page can't be captured"}`);
    clearBadgeSoon();
    return;
  }

  const slug = captureSlug(info.slugHint) || "capture";

  // 1. The article. A PDF tab needs no validation — the browser already rendered it.
  if (info.pdfUrl) {
    const verdict = info.isPdf ? "yes" : await looksLikePdf(info.pdfUrl, owner);
    if (!currentRun(owner)) return;
    if (verdict === "no") {
      mainMissing = true;
      await saveSidecar(info, slug, "pdf-fetch-blocked", owner).then(()=>{metadataSaved=true;}).catch((e) => notes.push(`sidecar: ${e?.message || e}`));
    } else {
      try {
        await download(info.pdfUrl, articleCaptureName(slug), owner);
        got++;
        if (verdict === "unknown") notes.push("couldn't verify the PDF before downloading — Flux will check it");
      } catch (e) {
        mainMissing = true;
        notes.push(`article: ${e?.message || e}`);
        await saveSidecar(info, slug, "pdf-fetch-blocked", owner).then(()=>{metadataSaved=true;}).catch(error=>notes.push(`sidecar: ${error?.message || error}`));
      }
    }
  } else {
    mainMissing = true;
    await saveSidecar(info, slug, "no-pdf-on-page", owner).then(()=>{metadataSaved=true;}).catch((e) => notes.push(`sidecar: ${e?.message || e}`));
  }

  // 2. Its supplementary files — the thing a bookmarklet could never do in one click. Named
  //    `flux-supp-<paperSlug>@@<filename>` so Flux can file each against the right paper once
  //    the article itself has been identified.
  let suppFailed = 0;
  for (const s of info.supplements) {
    if (!currentRun(owner)) return;
    try {
      let name = "supplement";
      try {
        const u = new URL(s.url);
        name = decodeURIComponent(u.searchParams.get("file") || u.pathname.split("/").filter(Boolean).pop() || "supplement");
      } catch {
        /* keep the default */
      }
      await download(s.url, supplementCaptureName(slug, name), owner);
      got++;
    } catch (e) {
      suppFailed++;
      notes.push(`supplement: ${e?.message || e}`);
    }
  }

  if (!currentRun(owner)) return;
  const ok = got > 0 && !suppFailed && !mainMissing;
  badge(String(got || (metadataSaved ? "M" : "!")), ok ? "#1f6d3a" : got || metadataSaved ? "#8a6d1f" : "#a02020");
  const summary = got ? `Captured ${got} file${got === 1 ? "" : "s"}${mainMissing ? " (main PDF unavailable)" : ""}` : metadataSaved ? "Captured metadata only (PDF unavailable)" : "Nothing captured";
  const detail = suppFailed ? ` — ${suppFailed} supplement${suppFailed === 1 ? "" : "s"} failed` : "";
  tip(`Add to FluxLib — ${summary}${detail}${notes.length ? `\n${notes.slice(0, 6).join("\n")}` : ""}`);
  if (notes.length) console.warn("[Add to FluxLib]", { url: info.pageUrl, got, notes });
  if (!ok) console.info("[Add to FluxLib] hover the toolbar button for details, or Inspect this worker.");
  clearBadgeSoon();
}

api.action.onClicked.addListener((tab) => {
  if (runController) return;
  const owner = new AbortController();runController=owner;clearTimeout(badgeTimer);
  const guard = setTimeout(() => {
    if(runController!==owner)return;owner.abort();runController=null;
    badge("!", "#a02020");tip("Add to FluxLib — timed out; capture incomplete");clearBadgeSoon();
  }, RUN_TIMEOUT_MS);
  void ready().then(()=>{if(currentRun(owner))return capture(tab,owner);}).catch(error => {
    if(currentRun(owner)){badge("!", "#a02020");tip(`Add to FluxLib — ${error.message || error}`);}
  }).finally(() => {clearTimeout(guard);if(runController===owner)runController=null;});
});
