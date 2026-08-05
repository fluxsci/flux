import { correctionPairKey } from "./localCorrectionCore";

export type LocalLanguageScope = "project" | "personal";

export interface LocalAlias {
  trigger: string;
  expansion: string;
}

export interface LocalLanguageData {
  words: string[];
  aliases: LocalAlias[];
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
const MAX_WORDS = 500;
const MAX_ALIASES = 300;
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
    if (!ALIAS_TOKEN.test(trigger) || !WORD_TOKEN.test(expansion)) continue;
    out.set(trigger.toLocaleLowerCase(), { trigger, expansion });
  }
  return [...out.values()].slice(-MAX_ALIASES);
}

function cleanLanguage(value: unknown): LocalLanguageData {
  const data = value && typeof value === "object" ? value : {};
  return {
    words: cleanWords("words" in data ? data.words : []),
    aliases: cleanAliases("aliases" in data ? data.aliases : []),
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

  constructor(
    private readonly projectKey: string,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    const stored = readAll(storage);
    this.personal = cleanLanguage(stored.personal);
    this.project = cleanProject(stored.projects[projectKey] ?? emptyProject());
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

  hasWord(word: string, scope: LocalLanguageScope): boolean {
    const key = word.trim().toLocaleLowerCase();
    return (scope === "personal" ? this.personal.words : this.project.words)
      .some((candidate) => candidate.toLocaleLowerCase() === key);
  }

  addWord(word: string, scope: LocalLanguageScope = "project"): boolean {
    const clean = word.trim();
    if (!WORD_TOKEN.test(clean) || this.hasWord(clean, scope)) return false;
    const data = scope === "personal" ? this.personal : this.project;
    data.words = [...data.words, clean].slice(-MAX_WORDS);
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
    if (project) return { ...project, scope: "project" };
    const personal = this.personal.aliases.find((alias) => alias.trigger.toLocaleLowerCase() === key);
    return personal ? { ...personal, scope: "personal" } : null;
  }

  setAlias(trigger: string, expansion: string, scope: LocalLanguageScope): void {
    const cleanTrigger = trigger.trim();
    const cleanExpansion = expansion.trim();
    if (!ALIAS_TOKEN.test(cleanTrigger) || !WORD_TOKEN.test(cleanExpansion)) return;
    const data = scope === "personal" ? this.personal : this.project;
    const key = cleanTrigger.toLocaleLowerCase();
    data.aliases = [
      ...data.aliases.filter((alias) => alias.trigger.toLocaleLowerCase() !== key),
      { trigger: cleanTrigger, expansion: cleanExpansion },
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

  block(original: string, replacement: string): void {
    const key = correctionPairKey(original, replacement);
    if (this.project.blockedPairs.includes(key)) return;
    this.project.blockedPairs = [...this.project.blockedPairs, key].slice(-MAX_BLOCKED_PAIRS);
    this.persist("project");
  }

  private persist(scope: LocalLanguageScope): void {
    try {
      const all = readAll(this.storage);
      if (scope === "personal") all.personal = cleanLanguage(this.personal);
      else all.projects[this.projectKey] = cleanProject(this.project);
      this.storage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Private mode/storage exhaustion degrades to this session's in-memory profile.
    }
  }
}
