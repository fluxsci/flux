// The GlobalPalette command list (non-paper modes; PaperMode appends the same
// entries to its own palette). Context-doc commands switch to Paper and open
// the doc; machine-context commands open the file in the OS editor.

import { get } from "svelte/store";
import type { Command } from "./commands";
import { requestOpenDoc, togglePrincipalDrawer, feedbackCaptureOpen } from "./commandBus";
import { setFocusedMode } from "../paneStore";
import { currentProject } from "../shellStore";
import { fileBridge } from "../../lib/project/types";
import { CONTEXT_PATHS } from "../../lib/project/contextTemplates";

function openInPaper(rel: string): void {
  setFocusedMode("paper");
  requestOpenDoc(rel);
}

async function openMachineContext(rel: string): Promise<void> {
  const fb = fileBridge();
  const prefs = (await fb?.prefsGet?.().catch(() => null)) as { contextResolved?: string } | null;
  const base = prefs?.contextResolved;
  if (!base) return;
  await fb?.openPath?.(`${base}/${rel}`);
}

/** Context/agent commands available in EVERY mode. `inPaper` marks the ones the
 *  Paper palette already covers with its own doc handling. */
export function contextCommands(opts: { inPaper: boolean; openDoc?: (rel: string) => void }): Command[] {
  const openDoc = opts.openDoc ?? openInPaper;
  const hasProject = !!get(currentProject)?.path;
  const cmds: Command[] = [];
  if (hasProject) {
    cmds.push(
      { id: "ctx-mission", title: "Open mission", hint: "Context", keywords: "goals project charter briefing", run: () => openDoc(CONTEXT_PATHS.mission) },
      { id: "ctx-notebook", title: "Open notebook", hint: "Context", keywords: "agent memory log", run: () => openDoc(CONTEXT_PATHS.notebook) },
      { id: "ctx-rules", title: "Open project rules", hint: "Context", keywords: "conventions", run: () => openDoc(CONTEXT_PATHS.rules) },
    );
  }
  cmds.push(
    { id: "ctx-global-rules", title: "Open global rules", hint: "Context", keywords: "user conventions machine", run: () => void openMachineContext("UserContext/RULES.md") },
    { id: "ctx-who", title: "Open who-am-I", hint: "Context", keywords: "profile background user", run: () => void openMachineContext("UserContext/WHO-AM-I.md") },
  );
  if (hasProject) {
    cmds.push(
      { id: "agent-drawer", title: "Toggle agent drawer", hint: "Agent", keywords: "principal chat terminal claude codex", run: () => togglePrincipalDrawer() },
      { id: "agent-note", title: "Note to agent", hint: "Agent", keywords: "feedback capture tell", run: () => feedbackCaptureOpen.set(true) },
    );
  }
  return cmds;
}
