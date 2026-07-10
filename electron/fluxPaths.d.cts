// Type surface of electron/fluxPaths.cjs for the TypeScript consumers
// (flux-core/fluxlib.ts, verify scripts). Keep in sync with the .cjs exports.

export interface FluxPrefs {
  schemaVersion?: string;
  fluxConfigPath?: string;
  /** Deprecated — only present pre-migration or after an EXDEV-deferred move. */
  fluxLibPath?: string;
  [k: string]: unknown;
}

export interface FluxConfigInfo {
  fluxConfigPath: string;
  fluxLibPath: string;
  guidelinesPath: string;
  userDataDir: string;
  /** Present only on the run that performed migration/seeding work. */
  events?: Array<{ ts: string; action: string; detail: string }>;
}

/** Machine config dir — lowercase "flux" on every platform. */
export function userDataDir(platform?: NodeJS.Platform): string;

/** Legacy capital-F dir — migration source only, never write here. */
export function legacyUserDataDir(platform?: NodeJS.Platform): string;

/** First-run default for the user-facing FluxConfig folder (~/FluxConfig). */
export function defaultFluxConfigPath(): string;

/** FluxConfig: preferences pointer → default ~/FluxConfig. */
export function resolveFluxConfigPathSync(prefs?: FluxPrefs): string;

/** FluxLib: derived <FluxConfig>/FluxLib, with pre-migration fallbacks. */
export function resolveFluxLibPathSync(prefs?: FluxPrefs): string;

/** Guidelines folder: <FluxConfig>/Guidelines. */
export function guidelinesPathSync(prefs?: FluxPrefs): string;

/** Raw prefs — {} when missing/corrupt. */
export function readPrefsRawSync(): FluxPrefs;

/** Atomic prefs write; undefined values drop their key. */
export function writePrefsAtomic(next: FluxPrefs): void;

/** One-time machine init/migration (idempotent, locked, fast after first run). */
export function ensureFluxConfig(): Promise<FluxConfigInfo>;

/** Move the whole FluxConfig folder under a new parent dir (Settings "Move…"). */
export function moveFluxConfig(
  parentDir: string,
): Promise<{ ok: true; path: string } | { error: string }>;

/** Resolve all machine paths without running migration. */
export function configInfoSync(prefs?: FluxPrefs): FluxConfigInfo;

export const GUIDELINES_README: string;
export const GUIDELINES_BASE_RULES: string;
