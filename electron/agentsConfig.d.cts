// Maintained boundary for the shared CJS roster resolver. Both launch hosts consume this contract.
export interface AgentSelection { family: string; model: string; effort: string }
export interface LaunchSelection { principal: AgentSelection; worker: AgentSelection }
export interface AgentEntry { command: string[]; cwd?: string; env?: Record<string, string> }
export interface AgentFamily { models: string[]; efforts: string[]; interactive: string[]; exec: string[]; cwd?: string; env?: Record<string, string> }
export interface Roster { legacy: boolean; path: string; warning: string | null; families?: Record<string, AgentFamily>; defaults?: Partial<LaunchSelection> & { pass?: AgentSelection }; principal?: AgentEntry; principalPass?: AgentEntry; workers?: Record<string, AgentEntry> }
export interface AgentSpec { command: string; args: string[]; cwd: string; env: Record<string, string> }
export interface LaunchOptions { projectRoot: string; prompt?: string; briefPath?: string; mcpSpec?: { command: string; args?: string[]; env?: Record<string, string> } | null; client?: string; extraEnv?: Record<string, string> }
export const DECIDES: string;
export const DEFAULT_AGENTS: { families: Record<string, AgentFamily>; defaults: LaunchSelection & { pass: AgentSelection } };
export function agentsConfigPathSync(cfg: string): string;
export function seedAgentsConfigSync(cfg: string): boolean;
export function readAgentsConfigSync(cfg: string): Roster;
export function readLastUsedSync(cfg: string): LaunchSelection | null;
export function writeLastUsedSync(cfg: string, sel: LaunchSelection): void;
export function standingSelectionSync(cfg: string, roster: Roster): LaunchSelection;
export function parentIsWorkspaceSync(projectRoot: string): boolean;
export function resolveAgentSpec(entry: AgentEntry, opts: LaunchOptions): AgentSpec;
export function resolveFamilyLaunch(roster: Roster, kind: 'interactive' | 'exec', sel: AgentSelection, opts: LaunchOptions): AgentSpec;
export function workerPolicyEnv(sel: AgentSelection): string;
export function parseWorkerPolicy(raw?: string): AgentSelection | null;
export function workerMenuNote(roster: Roster, sel: AgentSelection, cli: string): string;
export function principalBootPrompt(root: string, cli: string, workerNote?: string): string;
export function passPrompt(root: string, cli: string, workerNote?: string): string;
