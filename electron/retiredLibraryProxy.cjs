"use strict";
// Upgrade cleanup for the retired university-library sign-in.
//
// Flux 0.3 could sign in to a university library (EZProxy) and download papers through it.
// That feature is gone (owner decision, 2026-11-18): Flux now gets PDFs from open access, the
// browser extension, or a file the user already has. Someone upgrading still has three pieces
// of state on disk that nothing reads any more, and two of them are sensitive:
//
//   <FluxLib>/.proxy.json                 saved username + OS-encrypted password
//   <FluxLib>/keys.json → ezproxyPrefix    the library's sign-in address
//   <userData>/Partitions/fluxproxy/       the saved sign-in session (cookies, cache)
//
// This module is the ONE place that names them. Both engines call it: Electron main and the
// headless CLI/MCP through `fluxPaths.ensureFluxConfig` (the shared machine initialisation),
// and the session partition from Electron main only. `withoutRetiredKeys` is the shared rule
// that keeps the retired key out of every keys.json read and write in both engines.
//
// Rules (and why):
// - The credential file is never read, decrypted, copied, logged or backed up. It is unlinked.
// - Every target is checked with lstat; a symlink is unlinked itself and never followed.
// - Missing is success. A library with neither file is left byte-identical (no lock dir, no
//   keys.json is created), so a run with nothing to do costs a few lstat calls.
// - There is no marker file: cleanup runs on every start, so a library moved in later is
//   cleaned too.
// - Failures are logged by category only (no paths, no contents), never thrown, never shown
//   in a dialog, and retried on the next start. The capability is gone either way: nothing
//   in Flux reads these files any more.

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const leases = require("./operationLease.cjs");
const { shareRetry } = require("./fsRetry.cjs");

/** keys.json entries that belonged to removed features. Dropped on every write, never returned on read. */
const RETIRED_KEYS = Object.freeze(["ezproxyPrefix"]);
const CREDENTIAL_FILE = ".proxy.json";
/** Electron stores `persist:fluxproxy` as `<userData>/Partitions/fluxproxy` (checked on Electron 43). */
const SESSION_PARTITION = "fluxproxy";

/** A copy of a keys map without the retired keys. Anything that is not a plain object is returned as-is. */
function withoutRetiredKeys(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return map;
  if (!RETIRED_KEYS.some((k) => Object.prototype.hasOwnProperty.call(map, k))) return map;
  const out = { ...map };
  for (const k of RETIRED_KEYS) delete out[k];
  return out;
}

function report(category, error) {
  const code = error && error.code ? ` (${error.code})` : "";
  console.error(`flux: retired library sign-in cleanup: ${category}${code}; will retry on next start`);
}

async function lstatOrNull(p) {
  try {
    return await fsp.lstat(p);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Unlink `<lib>/.proxy.json` (or a symlink of that name, never its target). */
async function removeCredentialFile(lib) {
  const p = path.join(lib, CREDENTIAL_FILE);
  const st = await lstatOrNull(p);
  if (!st) return "absent";
  if (st.isDirectory()) return "not-a-file"; // never Flux's; leave it alone
  await shareRetry(() => fsp.unlink(p));
  return "removed";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Remove the retired keys from `<lib>/keys.json` under the shared "keys" lease. */
async function dropRetiredKeysFrom(lib, client) {
  const p = path.join(lib, "keys.json");
  const st = await lstatOrNull(p);
  if (!st) return "absent";
  if (!st.isFile()) return "not-a-file"; // a symlinked or odd keys.json is the user's arrangement
  const parse = async () => {
    const value = JSON.parse(await fsp.readFile(p, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("keys.json is not an object");
    return value;
  };
  let current;
  try {
    current = await parse();
  } catch (error) {
    if (error instanceof SyntaxError) return "malformed";
    throw error;
  }
  if (withoutRetiredKeys(current) === current) return "clean";
  // Same lease as desktop keys:set and headless saveKeys (<lib>/.fluxlib/locks, "keys").
  return leases.queued(path.join(lib, ".fluxlib", "locks"), "keys", async (dir) => {
    let got = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const r = await leases.acquire(dir, "keys", client);
      if (r.ok) {
        got = r;
        break;
      }
      await sleep(250);
    }
    if (!got) return "busy";
    try {
      // Re-read under the lease: a writer may have changed the file since the check above.
      const st2 = await lstatOrNull(p);
      if (!st2) return "absent";
      if (!st2.isFile()) return "not-a-file";
      let value;
      try {
        value = await parse();
      } catch (error) {
        if (error instanceof SyntaxError) return "malformed";
        throw error;
      }
      const next = withoutRetiredKeys(value);
      if (next === value) return "clean";
      await leases.assertOwned(got.lease);
      const tmp = `${p}.tmp-${randomUUID()}`;
      try {
        const fh = await fsp.open(tmp, "wx", 0o600);
        try {
          await fh.writeFile(JSON.stringify(next, null, 2) + "\n", "utf8");
          await fh.sync();
        } finally {
          await fh.close();
        }
        await shareRetry(() => fsp.rename(tmp, p));
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
      await fsp.chmod(p, 0o600).catch(() => {});
      return "removed";
    } finally {
      await leases.release(got.lease).catch(() => {});
    }
  });
}

/**
 * Remove the retired sign-in state from one FluxLib: the credential file and the retired
 * key. Never throws; returns what happened to each, by category.
 * @param {{ fluxLibDir: string, client?: string }} opts
 */
async function cleanupRetiredLibraryProxy({ fluxLibDir, client = "upgrade" }) {
  const out = { credentials: "skipped", keys: "skipped" };
  if (typeof fluxLibDir !== "string" || !fluxLibDir) return out;
  try {
    out.credentials = await removeCredentialFile(fluxLibDir);
  } catch (error) {
    out.credentials = "failed";
    report("saved library credentials could not be removed", error);
  }
  try {
    out.keys = await dropRetiredKeysFrom(fluxLibDir, client);
  } catch (error) {
    out.keys = "failed";
    report("retired key could not be removed from keys.json", error);
  }
  if (out.keys === "malformed") report("keys.json is not valid JSON; retired key left in place", null);
  if (out.keys === "busy") report("keys.json is being written; retired key left in place", null);
  return out;
}

/**
 * Remove the retired sign-in session (`<userData>/Partitions/fluxproxy`). Electron only; call
 * it before anything could open that partition (nothing in Flux does any more). If the
 * directory cannot be deleted and an Electron `session` module is given, the partition's
 * storage, cache and auth cache are cleared through the session API instead.
 * @param {{ userDataDir: string, session?: any }} opts
 */
async function removeRetiredSessionPartition({ userDataDir, session }) {
  if (typeof userDataDir !== "string" || !userDataDir) return "skipped";
  const dir = path.join(userDataDir, "Partitions", SESSION_PARTITION);
  try {
    const st = await lstatOrNull(dir);
    if (!st) return "absent";
    if (st.isSymbolicLink() || !st.isDirectory()) await shareRetry(() => fsp.unlink(dir));
    else await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return "removed";
  } catch (error) {
    report("saved library session could not be deleted", error);
    if (!session || typeof session.fromPartition !== "function") return "failed";
    try {
      const s = session.fromPartition(`persist:${SESSION_PARTITION}`);
      await s.clearStorageData();
      await s.clearCache();
      await s.clearAuthCache();
      return "cleared";
    } catch (clearError) {
      report("saved library session could not be cleared", clearError);
      return "failed";
    }
  }
}

module.exports = {
  RETIRED_KEYS,
  withoutRetiredKeys,
  cleanupRetiredLibraryProxy,
  removeRetiredSessionPartition,
};
