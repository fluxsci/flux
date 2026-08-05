import { correctionPairKey } from "./localCorrectionCore";

export interface LocalCorrectionProfileData {
  words: string[];
  blockedPairs: string[];
}

interface StoredProfiles {
  version: 1;
  projects: Record<string, LocalCorrectionProfileData>;
}

const STORAGE_KEY = "flux.paper.localCorrections.v1";
export const LOCAL_CORRECTION_RESET_EVENT = "flux:local-corrections-reset";
const EMPTY: LocalCorrectionProfileData = { words: [], blockedPairs: [] };

function readAll(storage: Pick<Storage, "getItem">): StoredProfiles {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as StoredProfiles | null;
    if (parsed?.version === 1 && parsed.projects && typeof parsed.projects === "object") return parsed;
  } catch {
    // A corrupt preference must never interfere with typing.
  }
  return { version: 1, projects: {} };
}

export function clearLocalCorrectionProfiles(
  storage: Pick<Storage, "removeItem"> = localStorage,
): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Storage failure must not affect the editor. Live in-memory profiles are
    // still reset by LOCAL_CORRECTION_RESET_EVENT.
  }
}

export class LocalCorrectionProfile {
  private data: LocalCorrectionProfileData;

  constructor(
    private readonly projectKey: string,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  ) {
    const stored = readAll(storage).projects[projectKey] ?? EMPTY;
    this.data = {
      words: [...new Set(stored.words.filter((w) => typeof w === "string"))].slice(-500),
      blockedPairs: [...new Set(stored.blockedPairs.filter((p) => typeof p === "string"))].slice(-500),
    };
  }

  words(): string[] {
    return [...this.data.words];
  }

  blockedPairs(): ReadonlySet<string> {
    return new Set(this.data.blockedPairs);
  }

  addWord(word: string): void {
    const clean = word.trim();
    if (!clean || this.data.words.some((w) => w.toLocaleLowerCase() === clean.toLocaleLowerCase())) return;
    this.data.words = [...this.data.words, clean].slice(-500);
    this.persist();
  }

  block(original: string, replacement: string): void {
    const key = correctionPairKey(original, replacement);
    if (this.data.blockedPairs.includes(key)) return;
    this.data.blockedPairs = [...this.data.blockedPairs, key].slice(-500);
    this.persist();
  }

  private persist(): void {
    try {
      const all = readAll(this.storage);
      all.projects[this.projectKey] = this.data;
      this.storage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Private mode/storage exhaustion degrades to this session's in-memory profile.
    }
  }
}
