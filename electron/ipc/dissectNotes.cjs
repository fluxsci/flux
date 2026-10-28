"use strict";
// Notes can replace only ordinary .txt companions in THIS window's project. This is
// deliberately narrower than the generic filesystem capability (which may approve imports).
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function createDissectNotesFamily({ rootFor, atomicWrite }) {
  const pending = new Map();
  let rules;
  const loadRules = () => rules ??= import(pathToFileURL(path.join(__dirname, "..", "dissectRules.js")).href);
  function safePath(root, rel) {
    const base = fs.realpathSync.native(root);
    let p = base;
    for (const segment of rel.split("/")) {
      p = path.join(p, segment);
      try { if (fs.lstatSync(p).isSymbolicLink()) throw new Error("Plot notes cannot follow symbolic links"); }
      catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    return p;
  }
  async function save(e, request) {
    const { dissectionNoteRel, DISSECT_NOTE_MAX_BYTES } = await loadRules();
    const root = rootFor(e);
    if (!root || !request || path.resolve(request.root || "") !== path.resolve(root)) throw new Error("The plot's project is no longer open");
    const rel = dissectionNoteRel(request.key, request.group || "", request.name);
    if (typeof request.text !== "string" || Buffer.byteLength(request.text, "utf8") > DISSECT_NOTE_MAX_BYTES) throw new Error("Plot notes are limited to 1 MiB");
    if (request.expected !== null && typeof request.expected !== "string") throw new Error("Missing note baseline");
    const target = safePath(root, rel);
    const previous = pending.get(target) || Promise.resolve();
    const work = previous.catch(() => {}).then(async () => {
      const check = () => {
        if (rootFor(e) !== root || safePath(root, rel) !== target) throw new Error("The plot's project changed while saving");
        let current = null;
        try {
          const st = fs.statSync(target);
          if (!st.isFile() || st.size > DISSECT_NOTE_MAX_BYTES) throw new Error("This note is not an editable text file");
          current = fs.readFileSync(target, "utf8");
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (current !== request.expected) throw new Error("This note changed outside Flux. Your draft is kept; reopen the note to compare before saving.");
      };
      check();
      await atomicWrite(target, Buffer.from(request.text, "utf8"), request.expected === null, 0o666, e.sender.id, check);
      return { path: target };
    });
    pending.set(target, work);
    try { return await work; } finally { if (pending.get(target) === work) pending.delete(target); }
  }
  return { save, registerHandlers(ipc) { ipc.handle("dissect:saveNote", save); } };
}
module.exports = { createDissectNotesFamily };
