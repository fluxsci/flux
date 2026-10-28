import { RETIRED_SEED_WORDS, SCIENTIFIC_VOCABULARY_BY_VERSION, SCIENTIFIC_VOCABULARY_VERSION } from "./scientificVocabulary";
import { correctionPairKey } from "./localCorrectionCore";
import { fileBridge } from "../../../../lib/project/types";

export type LocalLanguageScope = "project" | "personal";

export interface LocalAlias {
  trigger: string;
  expansion: string;
  learned?: boolean;
}

export interface LocalLanguageData {
  words: string[];
  aliases: LocalAlias[];
  scientificVocabularyVersion?: number;
  /** Only words actually inserted by the seeder; preexisting Personal words stay authored. */
  scientificSeedWords?: string[];
}

export interface LocalCorrectionProjectData extends LocalLanguageData {
  blockedPairs: string[];
}

interface StoredProfilesV2 {
  version: 2;
  personal: LocalLanguageData;
  projects: Record<string, LocalCorrectionProjectData>;
}

interface StoredProfilesV1 {
  version: 1;
  projects: Record<string, { words: string[]; blockedPairs: string[] }>;
}

export interface ResolvedLocalAlias extends LocalAlias {
  scope: LocalLanguageScope;
}

const STORAGE_KEY = "flux.paper.localLanguage.v2";
const LEGACY_STORAGE_KEY = "flux.paper.localCorrections.v1";
export const LOCAL_CORRECTION_RESET_EVENT = "flux:local-corrections-reset";
export const LOCAL_LANGUAGE_CHANGED_EVENT = "flux:local-language-changed";
export const LOCAL_LANGUAGE_ERROR_EVENT = "flux:local-language-error";
const MAX_WORDS = 5000;
const MAX_ALIASES = 2000;
const MAX_BLOCKED_PAIRS = 500;
const WORD_TOKEN = /^[\p{L}\p{M}\d][\p{L}\p{M}\d_'’.-]{0,63}$/u;
const ALIAS_TOKEN = /^[\p{L}\p{M}\d][\p{L}\p{M}\d_-]{0,31}$/u;

const emptyLanguage = (): LocalLanguageData => ({ words: [], aliases: [] });
const emptyProject = (): LocalCorrectionProjectData => ({
  words: [],
  aliases: [],
  blockedPairs: [],
});

function cleanWords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!WORD_TOKEN.test(clean)) continue;
    out.set(clean.toLocaleLowerCase(), clean);
  }
  return [...out.values()].slice(-MAX_WORDS);
}

function cleanAliases(value: unknown): LocalAlias[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, LocalAlias>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const trigger = "trigger" in item && typeof item.trigger === "string" ? item.trigger.trim() : "";
    const expansion = "expansion" in item && typeof item.expansion === "string" ? item.expansion.trim() : "";
    const learned = "learned" in item && item.learned === true;
    if (!(learned ? WORD_TOKEN : ALIAS_TOKEN).test(trigger) || !WORD_TOKEN.test(expansion)) continue;
    out.set(trigger.toLocaleLowerCase(), { trigger, expansion, ...(learned ? { learned: true } : {}) });
  }
  return [...out.values()].slice(-MAX_ALIASES);
}

function cleanLanguage(value: unknown): LocalLanguageData {
  const data = value && typeof value === "object" ? value : {};
  return {
    words: cleanWords("words" in data ? data.words : []),
    aliases: cleanAliases("aliases" in data ? data.aliases : []),
    ...("scientificVocabularyVersion" in data && typeof data.scientificVocabularyVersion === "number" ? { scientificVocabularyVersion: data.scientificVocabularyVersion } : {}),
    ...("scientificSeedWords" in data && Array.isArray(data.scientificSeedWords) ? { scientificSeedWords: cleanWords(data.scientificSeedWords) } : {}),
  };
}

function cleanProject(value: unknown): LocalCorrectionProjectData {
  const data = value && typeof value === "object" ? value : {};
  return {
    ...cleanLanguage(data),
    blockedPairs: [
      ...new Set(
        ("blockedPairs" in data && Array.isArray(data.blockedPairs) ? data.blockedPairs : [])
          .filter((item): item is string => typeof item === "string"),
      ),
    ].slice(-MAX_BLOCKED_PAIRS),
  };
}

function emptyStore(): StoredProfilesV2 {
  return { version: 2, personal: emptyLanguage(), projects: {} };
}

function readAll(storage: Pick<Storage, "getItem">): StoredProfilesV2 {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as StoredProfilesV2 | null;
    if (parsed?.version === 2 && parsed.projects && typeof parsed.projects === "object") {
      return {
        version: 2,
        personal: cleanLanguage(parsed.personal),
        projects: Object.fromEntries(
          Object.entries(parsed.projects).map(([key, value]) => [key, cleanProject(value)]),
        ),
      };
    }

    // The first local-correction release stored only project words and vetoes.
    // Read it losslessly into v2; the next mutation persists the migrated shape.
    const legacy = JSON.parse(storage.getItem(LEGACY_STORAGE_KEY) ?? "null") as StoredProfilesV1 | null;
    if (legacy?.version === 1 && legacy.projects && typeof legacy.projects === "object") {
      return {
        version: 2,
        personal: emptyLanguage(),
        projects: Object.fromEntries(
          Object.entries(legacy.projects).map(([key, value]) => [key, cleanProject(value)]),
        ),
      };
    }
  } catch {
    // Corrupt local preferences must never interfere with typing.
  }
  return emptyStore();
}

export function clearLocalCorrectionProfiles(
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  try {
    storage.removeItem(STORAGE_KEY);
    storage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Storage failure only affects persistence, never the editor.
  }
}

/** Reset automatic-correction vetoes without deleting explicit words/aliases. */
export function clearLocalCorrectionLearning(
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  try {
    const all = readAll(storage);
    for (const project of Object.values(all.projects)) project.blockedPairs = [];
    storage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage failure only affects persistence, never the editor.
  }
}

export class LocalCorrectionProfile {
  private personal: LocalLanguageData;
  private project: LocalCorrectionProjectData;
  private mutationRevision = 0;
  private durableError = "";
  private hydration: Promise<boolean>;

  constructor(
    private readonly projectKey: string,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    const stored = readAll(storage);
    this.personal = cleanLanguage(stored.personal);
    this.project = cleanProject(stored.projects[projectKey] ?? emptyProject());
    const seeded = this.seedScientificVocabulary();
    const bridge = typeof window === "undefined" ? null : fileBridge();
    if (!bridge?.correctionProfileGet || !bridge.correctionProfileSet) {
      if (seeded) this.persist("personal");
      this.hydration = Promise.resolve(false);
    } else {
      this.hydration = this.hydrateDurable().then((hydrated) => {
        if (this.seedScientificVocabulary()) this.persist("personal");
        return hydrated;
      });
    }
  }

  ready(): Promise<boolean> {
    return this.hydration;
  }

  error(): string { return this.durableError; }

  private reportError(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Language profile could not be saved or opened. Existing files are preserved. ${detail}`;
    if (message === this.durableError) return;
    this.durableError = message;
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent(LOCAL_LANGUAGE_ERROR_EVENT, { detail: { projectKey: this.projectKey, message } }));
    }
  }

  words(scope: LocalLanguageScope = "project"): string[] {
    return [...(scope === "personal" ? this.personal.words : this.project.words)];
  }

  allWords(): string[] {
    const words = new Map<string, string>();
    // Personal first, project second: a project can intentionally choose the
    // canonical casing used by its own manuscript.
    for (const word of [...this.personal.words, ...this.project.words]) {
      words.set(word.toLocaleLowerCase(), word);
    }
    return [...words.values()];
  }

  /** Seed words recognize valid science, without widening automatic technical
   * near-match edits to every known sensor/version. Authored Personal/Project
   * terms retain explicit canonical matching, including words that predate the seed. */
  explicitCorrectionWords(): string[] {
    const seeded = new Set((this.personal.scientificSeedWords ?? []).map((word) => word.toLocaleLowerCase()));
    return [...this.personal.words.filter((word) => !seeded.has(word.toLocaleLowerCase())), ...this.project.words];
  }

  hasWord(word: string, scope: LocalLanguageScope): boolean {
    const key = word.trim().toLocaleLowerCase();
    return (scope === "personal" ? this.personal.words : this.project.words)
      .some((candidate) => candidate.toLocaleLowerCase() === key);
  }

  addWord(word: string, scope: LocalLanguageScope = "project"): boolean {
    const clean = word.trim();
    if (!WORD_TOKEN.test(clean)) return false;
    const data = scope === "personal" ? this.personal : this.project;
    const key = clean.toLocaleLowerCase();
    const promoteSeed = scope === "personal" && data.scientificSeedWords?.some(word => word.toLocaleLowerCase() === key);
    if (this.hasWord(clean, scope) && !promoteSeed) return false;
    // Explicitly adding/re-adding a seed word makes it the user's canonical
    // term. The seed's provenance must never erase an authored preference.
    if (promoteSeed) data.scientificSeedWords = data.scientificSeedWords?.filter(word => word.toLocaleLowerCase() !== key);
    data.words = [...data.words.filter(word => word.toLocaleLowerCase() !== key), clean].slice(-MAX_WORDS);
    this.persist(scope);
    return true;
  }

  removeWord(word: string, scope: LocalLanguageScope): boolean {
    const key = word.trim().toLocaleLowerCase();
    const data = scope === "personal" ? this.personal : this.project;
    const words = data.words.filter((candidate) => candidate.toLocaleLowerCase() !== key);
    if (words.length === data.words.length) return false;
    data.words = words;
    this.persist(scope);
    return true;
  }

  toggleWord(word: string, scope: LocalLanguageScope): "added" | "removed" {
    if (this.removeWord(word, scope)) return "removed";
    this.addWord(word, scope);
    return "added";
  }

  aliases(scope: LocalLanguageScope): LocalAlias[] {
    return (scope === "personal" ? this.personal.aliases : this.project.aliases)
      .map((alias) => ({ ...alias }));
  }

  aliasesForExpansion(expansion: string): ResolvedLocalAlias[] {
    const key = expansion.trim().toLocaleLowerCase();
    return [
      ...this.project.aliases
        .filter((alias) => alias.expansion.toLocaleLowerCase() === key)
        .map((alias) => ({ ...alias, scope: "project" as const })),
      ...this.personal.aliases
        .filter((alias) => alias.expansion.toLocaleLowerCase() === key)
        .map((alias) => ({ ...alias, scope: "personal" as const })),
    ];
  }

  resolveAlias(trigger: string): ResolvedLocalAlias | null {
    const key = trigger.trim().toLocaleLowerCase();
    const project = this.project.aliases.find((alias) => alias.trigger.toLocaleLowerCase() === key);
    const personal = this.personal.aliases.find((alias) => alias.trigger.toLocaleLowerCase() === key);
    const alias = project ?? personal;
    if (!alias) return null;
    let expansion = alias.expansion;
    // Explicit aliases keep authored canonical case. A learned ordinary-word
    // correction follows title/upper-case typing, while scientific identifiers
    // (iGluSnFR, NREM) keep their canonical spelling.
    if (alias.learned && expansion === expansion.toLocaleLowerCase()) {
      if (trigger === trigger.toLocaleUpperCase()) expansion = expansion.toLocaleUpperCase();
      else if (/^\p{Lu}\p{Ll}/u.test(trigger)) expansion = expansion[0].toLocaleUpperCase() + expansion.slice(1);
    }
    return { ...alias, expansion, scope: project ? "project" : "personal" };
  }

  setAlias(trigger: string, expansion: string, scope: LocalLanguageScope, learned = false): void {
    const cleanTrigger = trigger.trim();
    const cleanExpansion = expansion.trim();
    if (!(learned ? WORD_TOKEN : ALIAS_TOKEN).test(cleanTrigger) || !WORD_TOKEN.test(cleanExpansion)) return;
    const data = scope === "personal" ? this.personal : this.project;
    const key = cleanTrigger.toLocaleLowerCase();
    data.aliases = [
      ...data.aliases.filter((alias) => alias.trigger.toLocaleLowerCase() !== key),
      { trigger: cleanTrigger, expansion: cleanExpansion, ...(learned ? { learned: true } : {}) },
    ].slice(-MAX_ALIASES);
    this.persist(scope);
  }

  removeAlias(trigger: string, scope: LocalLanguageScope): boolean {
    const key = trigger.trim().toLocaleLowerCase();
    const data = scope === "personal" ? this.personal : this.project;
    const aliases = data.aliases.filter((alias) => alias.trigger.toLocaleLowerCase() !== key);
    if (aliases.length === data.aliases.length) return false;
    data.aliases = aliases;
    this.persist(scope);
    return true;
  }

  blockedPairs(): ReadonlySet<string> {
    return new Set(this.project.blockedPairs);
  }

  blockedCorrections(): Array<{ original: string; replacement: string }> {
    return this.project.blockedPairs.map((pair) => {
      const [original = "", replacement = ""] = pair.split("\u0000");
      return { original, replacement };
    });
  }

  block(original: string, replacement: string): void {
    const key = correctionPairKey(original, replacement);
    if (this.project.blockedPairs.includes(key)) return;
    this.project.blockedPairs = [...this.project.blockedPairs, key].slice(-MAX_BLOCKED_PAIRS);
    this.persist("project");
  }

  unblock(original: string, replacement: string): boolean {
    const key = correctionPairKey(original, replacement);
    const next = this.project.blockedPairs.filter((pair) => pair !== key);
    if (next.length === this.project.blockedPairs.length) return false;
    this.project.blockedPairs = next;
    this.persist("project");
    return true;
  }

  clearBlockedPairs(): void {
    if (!this.project.blockedPairs.length) return;
    this.project.blockedPairs = [];
    this.persist("project");
  }

  /** Adds only the vocabulary blocks newer than the profile's version, so a
   *  removed seed word never returns; a withdrawn seed word leaves only while
   *  it is still seed-provided (re-adding a word makes it the user's). */
  private seedScientificVocabulary(): boolean {
    const from = this.personal.scientificVocabularyVersion ?? 0;
    if (from >= SCIENTIFIC_VOCABULARY_VERSION) return false;
    const known = new Set(this.personal.words.map(word => word.toLocaleLowerCase()));
    const inserted = SCIENTIFIC_VOCABULARY_BY_VERSION.slice(from).flat().filter(word => !known.has(word.toLocaleLowerCase()));
    const seeded = this.personal.scientificSeedWords ?? [];
    const retired = new Set(from ? RETIRED_SEED_WORDS.filter(word => seeded.includes(word)) : []);
    this.personal.words = cleanWords([...inserted, ...this.personal.words.filter(word => !retired.has(word))]);
    this.personal.scientificSeedWords = cleanWords([...seeded.filter(word => !retired.has(word)), ...inserted]);
    this.personal.scientificVocabularyVersion = SCIENTIFIC_VOCABULARY_VERSION;
    return true;
  }

  private hasData(data: LocalLanguageData | LocalCorrectionProjectData): boolean {
    return !!(data.words.length || data.aliases.length || data.scientificVocabularyVersion != null || ("blockedPairs" in data && data.blockedPairs.length));
  }

  private async hydrateDurable(): Promise<boolean> {
    if (typeof window === "undefined") return false;
    const bridge = fileBridge();
    if (!bridge?.correctionProfileGet || !bridge.correctionProfileSet) return false;
    const atStart = this.mutationRevision;
    try {
      const remote = await bridge.correctionProfileGet(this.projectKey) as {
        personal?: unknown; project?: unknown;
      };
      if (this.mutationRevision !== atStart) return false;
      const personal = cleanLanguage(remote?.personal);
      const project = cleanProject(remote?.project);
      const migratePersonal = !this.hasData(personal) && this.hasData(this.personal);
      const migrateProject = !this.hasData(project) && this.hasData(this.project);
      if (migratePersonal) void bridge.correctionProfileSet({ projectRoot: this.projectKey, scope: "personal", data: this.personal }).catch(error => this.reportError(error));
      else this.personal = personal;
      if (migrateProject) void bridge.correctionProfileSet({ projectRoot: this.projectKey, scope: "project", data: this.project }).catch(error => this.reportError(error));
      else this.project = project;
      const all = readAll(this.storage);
      all.personal = cleanLanguage(this.personal);
      all.projects[this.projectKey] = cleanProject(this.project);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(all));
      return true;
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }

  private persist(scope: LocalLanguageScope): void {
    this.mutationRevision += 1;
    try {
      const all = readAll(this.storage);
      if (scope === "personal") all.personal = cleanLanguage(this.personal);
      else all.projects[this.projectKey] = cleanProject(this.project);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(all));
      if (typeof window !== "undefined") {
        const bridge = fileBridge();
        const data = scope === "personal" ? cleanLanguage(this.personal) : cleanProject(this.project);
        if (!this.durableError) void bridge?.correctionProfileSet?.({ projectRoot: this.projectKey, scope, data }).catch(error => this.reportError(error));
      }
    } catch {
      // Private mode/storage exhaustion degrades to this session's in-memory profile.
    }
  }
}
