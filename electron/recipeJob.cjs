"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const leases = require("./operationLease.cjs");
async function withRecipeLease(recipePath, fn) {
  const identity = await fs.realpath(recipePath);
  const dir = path.join(path.dirname(identity), ".flux-recipe-locks");
  const name = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return leases.queued(dir, name, async canonical => {
    const got = await leases.acquire(canonical, name, "recipe");
    if (!got.ok) throw new Error("This recipe is already running in another operation");
    let lost = false, stopped = false, beats = Promise.resolve();
    const timer = setInterval(() => { beats = beats.then(async () => { if (!stopped && !await leases.renew(got.lease)) lost = true; }).catch(() => {lost = true;}); }, 10000);
    timer.unref?.();
    try {
      return await fn(async () => { if (lost) throw new Error("Recipe ownership was lost"); await leases.assertOwned(got.lease); });
    } finally { stopped = true; clearInterval(timer); await beats; await leases.release(got.lease); }
  });
}
async function readRecipeText(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > 16 * 1024 * 1024) throw new Error("Recipe metadata exceeds 16 MiB");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function snapshotRecipe(file, text) {
  const backup = `${file}.recovery-${crypto.randomUUID()}`;
  const handle = await fs.open(backup, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
  return backup;
}
async function discardRecipeSnapshot(file) { await fs.rm(file, {force: true}); }
module.exports = { withRecipeLease, readRecipeText, snapshotRecipe, discardRecipeSnapshot };
