import type { AgentRuntime } from './fluxPaths.cjs';
export type AgentId = 'claude' | 'codex';
export interface DoctorCheck { id: string; status: 'ok' | 'warn' | 'fail'; message: string; fix?: string; paths?: string[] }
export interface FileSnapshot { path: string; text: string | null; error?: string }
export interface ManagedSkill { owner: 'flux'; version: string; templateHash: string; files: Record<string, string> }
export interface RenderedSkill { files: Record<string, string>; manifest: ManagedSkill }
export interface McpRegistration { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
export interface HookEntry { hooks: Array<{ type: 'command'; command: string; statusMessage: string }> }
export interface AgentStatus {
  id: AgentId; present: boolean; binary: string | null; version?: string | null; home: string; skillDir: string;
  skill: { state: 'missing' | 'unmanaged' | 'edited' | 'current' | 'outdated'; files: Record<string, string | null>; marker: FileSnapshot; managed?: ManagedSkill; error?: string; treeHash?: string };
  rendered: RenderedSkill; config: FileSnapshot; hooks: FileSnapshot;
  capabilities: { promptHook: boolean; hookEnabled: boolean; addJson: boolean };
  runtime: AgentRuntime; launcher: FileSnapshot; owner: { target: string; build: string } | null; ownerAlive: boolean; date: string;
  state: { connected?: boolean; files: Record<string, { path: string; original: string | null; installed: string }>; mcp: { previous: McpRegistration | null; spec: McpRegistration; original: string | null; installed: string } | null;
    publications?: Record<string, { mode: 'symlink' | 'copy'; source: string; hashes?: Record<string, string> }> } | null;
  stateSnapshot: FileSnapshot;
}
export interface SetupAction {
  kind: 'file' | 'claude-mcp' | 'skill-remove'; role?: 'skill' | 'mcp' | 'hook'; agent: AgentId; path: string;
  before: string | null; after: string | null; confirmation?: boolean;
  spec?: McpRegistration | null; previous?: McpRegistration | null; binary?: string | null; addJson?: boolean;
}
export interface SetupPlan {
  kind: 'setup' | 'remove'; runtime?: AgentRuntime; agents: AgentId[]; actions: SetupAction[]; checks: DoctorCheck[];
  createLocalBin?: boolean; useThisInstall?: boolean; probe: AgentStatus[]; nextSteps: string[];
}
export interface SetupReport { checks: DoctorCheck[]; changes: Array<{ agent: string; path: string; action: string }>; backups: string[]; nextSteps: string[] }
export interface ProbeOptions { runtime?: AgentRuntime; templateDir?: string; commands?: boolean }
export interface PlanOptions { probe: AgentStatus[]; agents?: AgentId[] | string; createLocalBin?: boolean; useThisInstall?: boolean }
/** Read-only snapshot, including isolated vendor capability probes. */
export function probeAgents(options?: ProbeOptions): Promise<AgentStatus[]>;
/** Pure over the snapshot returned by probeAgents; performs no IO. */
export function planSetup(options: PlanOptions): SetupPlan;
export function planRemove(options: Pick<PlanOptions, 'probe' | 'agents'>): SetupPlan;
export function applySetup(plan: SetupPlan, options?: { yes?: boolean }): Promise<SetupReport>;
export function applyRemove(plan: SetupPlan, options?: { yes?: boolean }): Promise<SetupReport>;
export function publishUserSkills(options?: { agents?: AgentId[]; copy?: boolean }): Promise<SetupReport>;
export function refreshInstalledSkills(options?: ProbeOptions & { copy?: boolean }): Promise<SetupReport>;
/** File-only status checks; never starts a child process. */
export function probeChecks(options?: ProbeOptions & { probe?: AgentStatus[] }): Promise<DoctorCheck[]>;
export function doctor(options?: ProbeOptions & { probe?: AgentStatus[]; onCheck?: (check: DoctorCheck) => void }): Promise<DoctorCheck[]>;
export function renderSkill(runtime: AgentRuntime, agent: AgentId, templateDir?: string): RenderedSkill;
export function validateSkill(text: string, name: string): { name: string; description?: string; error?: string };
export function registration(runtime: AgentRuntime, agent: string): McpRegistration;
export function hookEntry(runtime: AgentRuntime): HookEntry;
export function splitCodex(text: string | null): { outside: string; managed: string | null; start: number; end: number; tables: Array<{start: number; end: number; keys: string[]}> };
export const HOOK_MARKER: string;
