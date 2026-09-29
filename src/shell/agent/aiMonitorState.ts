// Small eager store; the panel and its IO actions are loaded on demand.
import { derived, get, writable } from 'svelte/store';
import { setShellPanel } from './annotationVisibility';
import { fileBridge } from '../../lib/project/types';
import { emptyMonitorStatus, monitorColor, type AgentId, type AgentMonitorStatus } from '../../lib/project/agentMonitor';
export const aiOpen = writable(false);
export const aiDetached = writable(false);
// The docked panel owns the keyboard like a modal (a pinned window does not).
derived([aiOpen, aiDetached], ([open, detached]) => open && !detached).subscribe(v => setShellPanel('ai', v));
export const aiRequest = writable<{ connect?: AgentId; newSkill?: boolean } | null>(null);
export const aiStatus = writable<AgentMonitorStatus>(emptyMonitorStatus());
let dismissed = false;
try { dismissed = localStorage.getItem('flux.ai.dismissed') === 'true'; } catch { /* unavailable */ }
export const aiDismissed = writable(dismissed);
export const aiColor = derived([aiStatus, aiDismissed], ([status, hidden]) => monitorColor(status, hidden));
export function dismissAI(): void {
  aiDismissed.set(true);
  try { localStorage.setItem('flux.ai.dismissed', 'true'); } catch { /* unavailable */ }
}
export function openAI(request: { connect?: AgentId; newSkill?: boolean } = {}): void {
  aiRequest.set(request); aiOpen.set(true);
  void refreshAI();
}
let refreshing: Promise<void> | undefined;
export function refreshAI(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const status = await fileBridge()?.agentSetupStatus?.({ refresh: true });
      if (status) {
        const latest = get(aiStatus);
        aiStatus.set(latest.checkedAt && (!status.checkedAt || latest.checkedAt > status.checkedAt) ? { ...latest, project: status.project } : status);
        if (status.agents.some(a => a.connected)) dismissAI();
      }
    } catch (e) {
      aiStatus.update(s => ({ ...s, checks: [{ id: 'status', status: 'fail', message: String(e) }] }));
    }
  })().finally(() => refreshing = undefined);
  return refreshing;
}
export function startAIMonitor(): () => void {
  let off: (() => void) | undefined, retry: ReturnType<typeof setTimeout> | undefined, attempts = 0;
  const attach = () => {
    const fb = fileBridge();
    if (!fb?.agentSetupStatus) { if (++attempts < 40) retry = setTimeout(attach, 100); return; }
    off = fb.onAgentSetupChanged?.(status => aiStatus.set({ ...status, project: get(aiStatus).project }));
    void refreshAI();
  };
  attach();
  const timer = setInterval(() => void refreshAI(), 10 * 60_000);
  return () => { clearInterval(timer); clearTimeout(retry); off?.(); };
}
