"use strict";
// Small durable language profiles; there is no inference provider or network
// service here. Project profiles are bound to the sender's current project.
const fs = require("node:fs");
const path = require("node:path");

function registerLanguageProfiles(ipc, { configRoot, rootForSender, atomicWrite }) {
  function confinedFile(root, ...parts) {
    const base = fs.realpathSync(root);
    const file = path.join(root, ...parts);
    let existing = file;
    for (;;) {
      try {
        const real = fs.realpathSync(existing);
        const rel = path.relative(base, real);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Language profile path escapes its root");
        return file;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
  }
  const personalFile = () => confinedFile(configRoot(), "Language", "corrections.json");
  const projectFile = (root) => confinedFile(root, ".flux", "corrections.json");
  function safeProject(event, root) {
    const current = rootForSender(event);
    if (!current || (root && path.resolve(root) !== path.resolve(current))) throw new Error("Language profile project is not active");
    return path.resolve(root || current);
  }
  function validateProfile(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Language profile is not an object");
    if (value.words !== undefined && (!Array.isArray(value.words) || value.words.some(word => typeof word !== "string"))) throw new Error("Language profile words are invalid");
    if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.some(alias => !alias || typeof alias !== "object" || typeof alias.trigger !== "string" || typeof alias.expansion !== "string"))) throw new Error("Language profile aliases are invalid");
    if (value.blockedPairs !== undefined && (!Array.isArray(value.blockedPairs) || value.blockedPairs.some(pair => typeof pair !== "string"))) throw new Error("Language profile correction vetoes are invalid");
    if (value.scientificSeedWords !== undefined && (!Array.isArray(value.scientificSeedWords) || value.scientificSeedWords.some(word => typeof word !== "string"))) throw new Error("Language profile seed provenance is invalid");
    if (value.scientificVocabularyVersion !== undefined && (!Number.isSafeInteger(value.scientificVocabularyVersion) || value.scientificVocabularyVersion < 0)) throw new Error("Language profile vocabulary version is invalid");
    return value;
  }
  function readProfile(file, fallback) {
    let text;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Language profile is not a bounded regular file");
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw new Error(`Could not read language profile. Its existing contents were preserved: ${error.message}`);
    }
    try { return validateProfile(JSON.parse(text)); }
    catch (error) { throw new Error(`Language profile is corrupt. Its existing contents were preserved: ${error.message}`); }
  }
  ipc.handle("correction:profileGet", (event, projectRoot) => {
    const current = rootForSender(event);
    if (!current && projectRoot) throw new Error("Language profile project is not active");
    const root = current ? safeProject(event, projectRoot) : "";
    return {
      version: 1,
      personal: readProfile(personalFile(), { words: [], aliases: [] }),
      project: root ? readProfile(projectFile(root), { words: [], aliases: [], blockedPairs: [] }) : { words: [], aliases: [], blockedPairs: [] },
    };
  });
  ipc.handle("correction:profileSet", (event, payload) => {
    if (payload?.scope !== "personal" && payload?.scope !== "project") throw new Error("Invalid language profile scope");
    const root = payload.scope === "project" ? safeProject(event, payload.projectRoot) : "";
    const data = validateProfile(payload.data);
    const raw = JSON.stringify(data);
    if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("Language profile exceeds its bound");
    const file = payload.scope === "personal" ? personalFile() : projectFile(root);
    // Only ENOENT means a new profile. A corrupt/unreadable existing file must
    // never be treated as empty and overwritten by initial vocabulary seeds.
    readProfile(file, null);
    atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
    return true;
  });
}
module.exports = { registerLanguageProfiles };
