// Public monitor data contains paths and diagnoses, never vendor config snapshots.
import type { DoctorCheck, AgentId } from '../../../electron/agentSetup.cjs';
export type { AgentId, DoctorCheck };
export interface MonitorAgent {
  id: AgentId; present: boolean; connected: boolean; binary: string | null;
  version: string | null; skillDir: string;
}
export interface MonitorCheck extends DoctorCheck { checkedAt?: string; pending?: boolean }
export interface AgentMonitorStatus {
  checkedAt: string | null; agents: MonitorAgent[]; checks: MonitorCheck[];
  launcher: string; owner: string | null; version: string; skillsPath: string;
  project?: { root: string; bridge: boolean; lastConnected: string | null } | null;
}
export interface MonitorPlan {
  token: string; kind: 'setup' | 'remove'; agents: AgentId[]; checks: DoctorCheck[];
  nextSteps: string[]; replacements: { path: string; before: string | null; after: string | null }[];
}
export type MonitorMutation = { agents: AgentId[]; useThisInstall?: boolean } | { token: string; confirm: true };
export type MonitorMutationResult = { plan: MonitorPlan } | { applied: true; checks: DoctorCheck[]; nextSteps: string[] };
export interface MonitorSkill { name: string; path: string; description?: string; error?: string }
export interface MonitorSkills { path: string; skills: MonitorSkill[]; created?: string; checks?: DoctorCheck[] }
export const emptyMonitorStatus = (): AgentMonitorStatus => ({ checkedAt: null, agents: [], checks: [], launcher: '', owner: null, version: '', skillsPath: '' });
export function monitorColor(status: AgentMonitorStatus, dismissed = false): 'green' | 'amber' | 'red' {
  const connected = status.agents.filter(a => a.connected);
  const relevant = status.checks.filter(c => {
    const id = c.id.split('.')[0];
    return id !== 'claude' && id !== 'codex' || connected.some(a => a.id === id);
  });
  if (relevant.some(c => c.status === 'fail')) return 'red';
  // Dismissing first-run removes only the connection nag, never a real problem.
  if (relevant.some(c => c.status === 'warn') || !status.checkedAt) return 'amber';
  if (!connected.length) return dismissed ? 'green' : 'amber';
  if (status.agents.some(a => a.present && !a.connected)) return 'amber';
  return 'green';
}
export function agentChecks(status: AgentMonitorStatus, id: AgentId): MonitorCheck[] {
  const checks = status.checks.filter(c => c.id.startsWith(id + '.'));
  const rows = ['skill', 'mcp', 'published', ...(id === 'claude' || checks.some(c => c.id === `${id}.hook`) ? ['hook'] : [])];
  const result = rows.flatMap(part => {
    const found = checks.filter(c => c.id === `${id}.${part}` || c.id.startsWith(`${id}.${part}.`));
    return found.length ? found : [{ id: `${id}.${part}`, status: 'warn' as const, message: 'Not checked yet.', pending: true }];
  });
  const responds = status.checks.find(c => c.id === 'mcp');
  result.splice(2, 0, responds ? { ...responds, id: `${id}.responds` } : { id: `${id}.responds`, status: 'warn', message: 'Run doctor to check the full toolset. Agent registrations use the core toolset.', pending: true });
  return [...result, ...checks.filter(c => !result.some(r => r.id === c.id))];
}
export function checkLabel(id: string): string {
  const part = id.replace(/^(claude|codex)\./, '');
  const names: Record<string, string> = { skill: 'flux-connect skill', mcp: id === 'mcp' ? 'MCP responds' : 'MCP registration', responds: 'MCP responds · core / full', published: 'Your skills published', hook: 'Auto-refresh hook', launcher: 'Launcher + CLI', 'launcher.node': 'Node runtime', 'launcher.dist': 'CLI bundle', rendering: 'Figure rendering', 'context.stock': 'FluxContext synced', 'context.user': 'UserContext files', projects: 'Project history' };
  return names[part] ?? (part.startsWith('published.') ? `Your skill: ${part.slice(10)}` : part.startsWith('context.skill.') ? `Skill: ${part.slice(13)}` : part);
}
