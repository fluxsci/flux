// Versioned reversible item identity. Conventional historical names stay intact;
// unsafe names resolve explicitly to an existing unique legacy directory or v1
// encoding. Ambiguity never authorizes a merge, overwrite or migration.
export const legacyItemName = (key: string) => key.replace(/[\\/]+/g, "-").replace(/\.{2,}/g, ".").trim();
const identity = (name: string) => name.normalize("NFC").toLowerCase();
export function conventionalItemName(key: string): boolean {
  return !!key && !/[\\/\x00-\x1f<>:"|?*]/.test(key) && !/^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(key) && !/[. ]$/.test(key) && new TextEncoder().encode(key).length <= 180 && !key.startsWith("~flux-v1-");
}
export function encodedItemName(key: string): string {
  // A byte encoding is collision-free, including Unicode normalization variants.
  const bytes = new TextEncoder().encode(key);
  if (bytes.length > 120) throw new Error("This legacy citekey needs an explicit item locator migration before creating artifacts (more than 120 UTF-8 bytes)");
  return "~flux-v1-" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
interface Locators { byKey: Map<string, string>; byName: Map<string, string>; errors: Map<string, string> }
const libraries = new Map<string, Locators>();
const rootIdentity = (root: string) => root.replace(/\\/g, "/").replace(/\/$/, "");
export function configureItemLocators(root: string, keys: string[], directories: string[]): void {
  const byKey = new Map<string, string>(), byName = new Map<string, string>(), errors = new Map<string, string>();
  const actual = new Map<string, string[]>();
  for (const name of directories) actual.set(identity(name), [...(actual.get(identity(name)) ?? []), name]);
  const legacyKeys = new Map<string, string[]>();
  for (const key of new Set(keys)) { const name = identity(legacyItemName(key)); legacyKeys.set(name, [...(legacyKeys.get(name) ?? []), key]); }
  for (const key of new Set(keys)) {
    const legacy = legacyItemName(key), legacyDirs = actual.get(identity(legacy)) ?? [];
    const ambiguous = legacyKeys.get(identity(legacy))!;
    try {
      if (legacyDirs.length > 1 || (ambiguous.length > 1 && (legacyDirs.length || conventionalItemName(key)))) throw new Error(`Ambiguous item identity for ${ambiguous.join(", ")}; both bibliography records and item bytes were preserved. Select an explicit migration before editing artifacts.`);
      let name = key;
      if (!conventionalItemName(key)) {
        const usableLegacy = legacyDirs.length && legacy !== "." && legacy !== ".." && legacy;
        let encoded: string;
        try { encoded = encodedItemName(key); } catch (error) { if (usableLegacy) { byKey.set(key, legacyDirs[0]); byName.set(identity(legacyDirs[0]), key); continue; } throw error; }
        const encodedDirs = actual.get(identity(encoded)) ?? [];
        if (encodedDirs.length && usableLegacy) throw new Error(`Both legacy and v1 item directories exist for ${key}; resolve the ambiguity before editing artifacts`);
        name = encodedDirs[0] ?? (usableLegacy ? legacyDirs[0] : encoded);
      } else name = legacyDirs[0] ?? key;
      // Encoded components can be up to the platform's 255-byte component bound.
      if (new TextEncoder().encode(name).length > 255) throw new Error(`Item directory for ${key} exceeds the platform filename bound; explicit migration required`);
      byKey.set(key, name); byName.set(identity(name), key);
    } catch (error) { errors.set(key, String((error as Error).message)); }
  }
  libraries.set(rootIdentity(root), {byKey, byName, errors});
}
export function itemName(root: string, key: string): string {
  const locators = libraries.get(rootIdentity(root));
  const error = locators?.errors.get(key); if (error) throw new Error(error);
  const known = locators?.byKey.get(key); if (known) return known;
  if (conventionalItemName(key)) return key;
  return encodedItemName(key);
}
export function itemKey(root: string, directory: string): string {
  return libraries.get(rootIdentity(root))?.byName.get(identity(directory)) ?? directory;
}
