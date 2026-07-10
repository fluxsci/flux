// Shared owner for every OS process a verify script spawns (WS-0a, fortify plan).
//
// Guarantees, regardless of how the test exits (pass, assertion throw, timeout):
//   - children are killed as a PROCESS GROUP (a wrapper chain like npx→tsx→node
//     can never leak a grandchild; explicit win32 branch via taskkill /t),
//   - every kill is awaited to `close` — no "kill sent" without "child gone",
//   - temp dirs are removed only AFTER the children are provably dead
//     (call scope.dispose() in `finally`, then rm).
//
// Fixture contract: fault children are plain .mjs files under scripts/fixtures/
// launched directly with process.execPath (`--import tsx` so they can import the
// real .ts modules under test) — the child PID IS the process doing the work.
// Each fixture must watch its own stdin and exit when it closes; that covers the
// one hole group-kill can't (this parent itself being SIGKILLed):
//
//   process.stdin.resume();
//   process.stdin.on("end", () => process.exit(0));
//   process.stdin.on("close", () => process.exit(0));
//
// Ready protocol: pass `readyLine` and await `entry.ready` — the fixture prints
// the line once its work loop has genuinely started (e.g. first write completed),
// so fault-injection timing never depends on boot-time sleeps.

import { spawn, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";

const isWin = process.platform === "win32";

export class TestProcessScope {
  #entries = new Set();
  #disposed = false;

  /**
   * Spawn a fixture child owned by this scope.
   * @param {string} file absolute path to the .mjs fixture
   * @param {string[]} args argv for the fixture
   * @param {{readyLine?: string, deadlineMs?: number, cwd?: string, env?: object,
   *          nodeArgs?: string[], label?: string}} [opts]
   * @returns entry with { child, closed, ready?, stdout, stderr }
   */
  spawn(file, args = [], opts = {}) {
    const {
      readyLine = null,
      deadlineMs = 30_000,
      cwd = process.cwd(),
      env = process.env,
      nodeArgs = ["--import", "tsx"],
      label = file,
    } = opts;
    if (this.#disposed) throw new Error("TestProcessScope already disposed");
    const child = spawn(process.execPath, [...nodeArgs, file, ...args], {
      cwd,
      env,
      // stdin stays a pipe: it closes when THIS process dies, and the fixture
      // contract turns that into child exit (see header).
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWin, // own process group on POSIX so kill(-pid) sweeps the tree
    });
    const entry = {
      label,
      child,
      stdout: "",
      stderr: "",
      exited: false,
      deadlineHit: false,
      code: /** @type {number|null} */ (null),
      signal: /** @type {string|null} */ (null),
    };
    child.stdout.on("data", (d) => (entry.stdout += d));
    child.stderr.on("data", (d) => (entry.stderr += d));
    entry.closed = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        entry.exited = true;
        entry.code = code;
        entry.signal = signal;
        clearTimeout(deadline);
        resolve({ code, signal });
      });
    });
    // Hard per-child deadline: dump stderr, kill the group. A hung child must
    // never outlive its test. waitExit() turns this into a test failure.
    const deadline = setTimeout(() => {
      entry.deadlineHit = true;
      console.error(
        `testProcess: DEADLINE ${deadlineMs}ms exceeded for ${label} — killing its group\n` +
          `--- ${label} stderr ---\n${entry.stderr || "(empty)"}\n---`,
      );
      this.kill(entry);
    }, deadlineMs);
    deadline.unref?.();
    if (readyLine) {
      entry.ready = new Promise((resolve, reject) => {
        const onData = () => {
          if (entry.stdout.includes(readyLine)) {
            child.stdout.off("data", onData);
            resolve(undefined);
          }
        };
        child.stdout.on("data", onData);
        child.once("close", () =>
          reject(
            new Error(
              `${label}: exited before printing ${JSON.stringify(readyLine)} (code=${entry.code} sig=${entry.signal})\n` +
                `--- ${label} stderr ---\n${entry.stderr || "(empty)"}\n---`,
            ),
          ),
        );
      });
    }
    this.#entries.add(entry);
    return entry;
  }

  /** SIGKILL the child's whole process group (win32: taskkill tree). Idempotent. */
  kill(entry) {
    const { child } = entry;
    if (entry.exited || child.pid == null) return;
    if (isWin) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      } catch {}
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  }

  /** Kill the group (if still alive) and await `close`. Fault-injection helper. */
  async reap(entry) {
    this.kill(entry);
    return entry.closed;
  }

  /** Await natural exit; throws if the hard deadline killed the child instead. */
  async waitExit(entry) {
    const r = await entry.closed;
    if (entry.deadlineHit) throw new Error(`${entry.label}: hit hard deadline and was group-killed`);
    return r;
  }

  /** Idempotent teardown: kill every group, await every close. Call in `finally`,
   *  BEFORE removing any temp dir a child may write into. */
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const e of this.#entries) this.kill(e);
    await Promise.all([...this.#entries].map((e) => e.closed));
  }
}

/** Post-teardown lifecycle assertion (not process-table scraping): the file has
 *  stopped changing — two stats `settleMs` apart agree. A missing file counts as
 *  quiescent (nothing can be writing it). */
export async function assertFileQuiescent(file, { settleMs = 250 } = {}) {
  const a = await fs.stat(file).catch(() => null);
  if (a === null) return;
  await new Promise((r) => setTimeout(r, settleMs));
  const b = await fs.stat(file).catch(() => null);
  if (b === null || a.mtimeMs !== b.mtimeMs || a.size !== b.size)
    throw new Error(`file still changing after teardown: ${file}`);
}
