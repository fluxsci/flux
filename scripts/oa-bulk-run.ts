// Standalone bulk OA acquisition through the REAL app engine — the netGet (Chromium
// cookie-jar fetch) path that the "Get open access PDF" button uses, over EVERY library
// paper that has no PDF yet. Plain Node fetch (the CLI) is bot-blocked by many publishers
// (Hindawi/RoyalSociety 403, MDPI HTML interstitial); Chromium's network stack + TLS
// fingerprint + cookie jar pass, which is why the button works and the CLI doesn't.
//
// Runs Phase A (OA) only — repositories + ordinary/gold-OA publishers, skipping the
// ban-prone ones (Elsevier/Cell Press → left for the app's proxy phase). Isolated userData
// + partition so it never collides with a running Flux instance.
//
//   Build: esbuild scripts/oa-bulk-run.ts --bundle --platform=node --format=cjs \
//            --external:electron --outfile=.oa-run.cjs
//   Run:   DISPLAY=:0 ./node_modules/.bin/electron .oa-run.cjs --no-sandbox [--limit N] [--keys a,b]
import { app, session } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNetGet } from "../electron/netFetch.cjs";
import { runWaterfall, bareDoi, isPdfBytes, type FetchDeps } from "../src/lib/references/pdfFinder";
import { getLimiter, hostGroup, doiGroup, interleaveByGroup, GET_COST } from "../src/lib/references/hostLimiter";
import { safeKey, oaSig, isFreshOaMiss, type OaMissMap } from "../src/lib/references/items";
import { writePdf, loadOaMisses, saveOaMisses } from "../flux-core/items";
// NB: fulltext extraction (pdfjs) is done in a separate tsx backfill pass, not here —
// pdfjs's worker doesn't survive esbuild bundling into the Electron main process.

import { resolveFluxLibPathSync } from "../electron/fluxPaths.cjs";
const LIB = resolveFluxLibPathSync(); // derived from FluxConfig (legacy fallbacks pre-migration)
const LOG = path.join(process.cwd(), ".oa-run.log");
// FRESH isolated profile per launch (mkdtemp) — never reuse a dir: a hard-killed prior run
// leaves a stale Chromium profile lock that silently breaks ses.fetch (every fetch fails →
// every paper looks like a false "no-oa", poisoning the ledger — the run-2 bug). A brand-new
// dir also can't lock-conflict with the running app.
const USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), "flux-oa-run-"));
app.setPath("userData", USERDATA);

const argv = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = argOf("--limit") ? Number(argOf("--limit")) : undefined;
const ONLY_KEYS = argOf("--keys")?.split(",").map((s) => s.trim()).filter(Boolean);

function logLine(s: string): void {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG, line + "\n");
  } catch {
    /* ignore */
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function main() {
  const mailto: string = (() => {
    try {
      return readJson(path.join(LIB, "keys.json")).mailto || "flux";
    } catch {
      return "flux";
    }
  })();
  const idx = readJson(path.join(LIB, ".fluxlib", "index.json")).entries as Record<string, any>;
  const enrich = readJson(path.join(LIB, ".fluxlib", "enrich.json")) as Record<string, any>;

  const inputsFor = (key: string) => {
    const e = idx[key];
    const en = enrich[key];
    return {
      doi: e?.doi || en?.doi,
      openAccessUrl: en?.openAccess?.url,
      isOa: en?.openAccess?.isOa,
      pmid: en?.ids?.pmid,
      pmcid: en?.ids?.pmcid,
    };
  };

  // Chromium cookie-jar netGet on an isolated persistent partition (real browser TLS
  // fingerprint + one session per host) — the same backend as the app's pdf:netGet.
  const getKey = (k: string) => (k === "mailto" ? mailto : null);
  // Tighter timeouts than the app default (120s/30s): in a 900-paper sweep a hung publisher
  // server must not stall the run for two minutes. 45s is ample for any real OA PDF.
  const netGet = createNetGet({ session, getKey, partition: "persist:fluxoa", timeouts: { bytes: 45_000, meta: 15_000 } });
  // Set when a candidate fetch fails at the TRANSPORT level (timeout/network) rather than a
  // definitive HTTP status — such a paper is NOT recorded as a firm "no-oa" (that would be a
  // false miss); it stays missing and is retried next run.
  let curPaperFetchErr = false;
  const transient = (err?: string) => !!err && !/^HTTP \d/.test(err);
  // Count netGet calls that came back OK (any 2xx, even a non-PDF body). In a healthy run
  // this climbs immediately (every unpaywall metadata call succeeds); if it stays 0 the
  // engine is dead and we must stop rather than record a wave of false "no-oa" misses.
  let netOk = 0;
  const deps: FetchDeps = {
    email: mailto,
    getJson: async (u) => {
      const r = await netGet(u, "json");
      if (r && !r.error) {
        netOk++;
        return r.json;
      }
      if (transient(r?.error)) curPaperFetchErr = true;
      return null;
    },
    getText: async (u) => {
      const r = await netGet(u, "text");
      if (r && !r.error) {
        netOk++;
        return r.text ?? null;
      }
      if (transient(r?.error)) curPaperFetchErr = true;
      return null;
    },
    getBytes: async (u) => {
      const group = hostGroup(u);
      if (group) await getLimiter.acquire(group, GET_COST);
      const r = await netGet(u, "bytes");
      if (!r || r.error || !r.bytesB64) {
        if (transient(r?.error)) curPaperFetchErr = true;
        return null;
      }
      netOk++;
      const finalUrl = r.finalUrl ?? u;
      const landed = hostGroup(finalUrl);
      if (landed && landed !== group) getLimiter.record(landed, GET_COST);
      return { bytes: new Uint8Array(Buffer.from(r.bytesB64, "base64")), finalUrl, contentType: r.contentType ?? "" };
    },
  };

  // STARTUP SELF-TEST: prove netGet can actually fetch a known OA PDF before we attempt the
  // library. If a stale profile / broken network service makes every fetch fail, abort here
  // — recording hundreds of false "no-oa" misses is far worse than not running.
  const SELFTEST = [
    "https://arxiv.org/pdf/1706.03762",
    "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC/PMC1790863/fullTextPDF",
  ];
  let selfOk = false;
  for (const t of SELFTEST) {
    const got = await deps.getBytes(t).catch(() => null);
    if (got && isPdfBytes(got.bytes)) {
      selfOk = true;
      logLine(`netGet self-test OK — fetched ${(got.bytes.length / 1024).toFixed(0)}KB PDF from ${new URL(t).hostname}`);
      break;
    }
    logLine(`netGet self-test miss for ${new URL(t).hostname}`);
  }
  if (!selfOk) {
    logLine("FATAL: netGet cannot fetch a known OA PDF — engine is not working; aborting WITHOUT touching the ledger.");
    await new Promise((res) => setTimeout(res, 200));
    return app.exit(2);
  }

  // Work list: every library key with no PDF on disk (optionally narrowed by --keys/--limit),
  // skipping papers the OA-miss ledger already knows are no-OA (unchanged identifiers).
  const misses: OaMissMap = await loadOaMisses(LIB);
  const missKey = (key: string) => safeKey(key).normalize("NFC");
  const sigOf = (key: string) => oaSig(inputsFor(key));
  const hasPdf = (key: string) => fs.existsSync(path.join(LIB, "items", key, "paper.pdf"));

  let keys = Object.keys(idx).filter((k) => !hasPdf(k));
  if (ONLY_KEYS) keys = ONLY_KEYS.filter((k) => idx[k]);
  keys = keys.filter((k) => !isFreshOaMiss(misses[missKey(k)], sigOf(k)));
  const ordered = interleaveByGroup(keys, (k) => doiGroup(bareDoi(inputsFor(k).doi)));
  const work = LIMIT ? ordered.slice(0, LIMIT) : ordered;

  logLine(`=== OA bulk run START — ${work.length} papers to attempt (of ${Object.keys(idx).length} in library) ===`);
  let got = 0;
  let noOa = 0;
  let noId = 0;
  let err = 0;
  let missDirty = 0;
  let done = 0;
  let deadStreak = 0; // consecutive papers that MADE fetch calls but none succeeded
  for (const key of work) {
    const x = inputsFor(key);
    if (!x.doi && !x.openAccessUrl && !x.pmcid) {
      noId++;
      done++;
      continue;
    }
    const netOkBefore = netOk;
    curPaperFetchErr = false;
    let outcome = "";
    try {
      const r = await runWaterfall(x, deps, { bulkMode: true });
      const w = r ? await writePdf(key, r.bytes, { source: r.source, url: r.url, finalUrl: r.finalUrl, isOa: r.source !== "crossref" ? true : x.isOa }, LIB) : null;
      // The resolver handed back supplementary material, not the article: it's been filed
      // under supplements/, but the paper is still missing — don't count it as fetched, and
      // don't clear its OA miss.
      const supplement = w && w.ok === false ? w : null;
      if (supplement) {
        outcome = `SUPPLEMENT (${supplement.signal}) — filed under supplements/, main text still missing`;
        noOa++;
      } else if (r) {
        got++;
        const mk = missKey(key);
        if (misses[mk]) {
          delete misses[mk];
          missDirty++;
        }
        outcome = `GOT ${(r.bytes.length / 1024 / 1024).toFixed(2)}MB via ${r.source} @ ${(() => {
          try {
            return new URL(r.url).hostname;
          } catch {
            return "?";
          }
        })()}`;
      } else if (curPaperFetchErr) {
        // A candidate existed but its fetch timed out / errored at the transport level —
        // transient, NOT a firm no-oa. Leave the ledger untouched so it retries next run.
        err++;
        outcome = "fetch-error (retry, not recorded)";
      } else {
        noOa++;
        const mk = missKey(key);
        misses[mk] = { at: new Date().toISOString(), attempts: (misses[mk]?.attempts ?? 0) + 1, sig: sigOf(key) };
        missDirty++;
        outcome = "no-oa";
      }
    } catch (e) {
      err++;
      outcome = `ERROR ${String((e as Error)?.message || e)}`;
    }
    done++;
    // Dead-engine guard: this paper had identifiers so runWaterfall issued ≥1 netGet call;
    // if NONE succeeded, count it. A long streak = the engine died mid-run (as in the run-2
    // stale-lock bug) → abort before persisting a wave of false "no-oa" misses.
    deadStreak = netOk > netOkBefore ? 0 : deadStreak + 1;
    if (deadStreak >= 25) {
      logLine(`FATAL: ${deadStreak} consecutive papers with zero successful netGet calls — engine died mid-run; aborting, misses NOT saved.`);
      await new Promise((res) => setTimeout(res, 200));
      return app.exit(3);
    }
    if (done % 10 === 0 || outcome.startsWith("GOT")) {
      logLine(`(${done}/${work.length}) ${outcome}  [${key}]  {got:${got} noOa:${noOa} err:${err} netOk:${netOk}}`);
    }
    if (missDirty >= 12) {
      missDirty = 0;
      await saveOaMisses(misses, LIB);
    }
    // politeness between papers (the limiter handles per-publisher pacing)
    await new Promise((res) => setTimeout(res, 120));
  }
  if (missDirty) await saveOaMisses(misses, LIB);
  logLine(`=== OA bulk run DONE — got:${got} noOa:${noOa} noId:${noId} err:${err} of ${work.length} attempted ===`);
  await new Promise((res) => setTimeout(res, 300));
  app.exit(0);
}

app.whenReady().then(main).catch((e) => {
  logLine(`FATAL ${String((e as Error)?.message || e)}`);
  app.exit(1);
});
