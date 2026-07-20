// The GlobalPalette command list (non-paper modes; PaperMode appends the same
// entries to its own palette). Context-doc commands switch to Paper and open
// the doc; machine-context commands open the file in the OS editor.

import { get } from "svelte/store";
import type { Command } from "./commands";
import { requestOpenDoc, feedbackCaptureOpen } from "./commandBus";
import { setFocusedMode } from "../paneStore";
import { currentProject } from "../shellStore";
import { fileBridge } from "../../lib/project/types";
import { CONTEXT_PATHS } from "../../lib/project/contextTemplates";
import { pushToast } from "../../lib/toast";

/** Copy the principal's boot prompt for pasting into the user's OWN terminal
 *  session (the drawer-free path — no transcript capture there, by design). */
export async function copyPrincipalPrompt(): Promise<void> {
  const fb = fileBridge();
  const spec = await fb?.agentPrincipalSpec?.().catch(() => null);
  if (!spec?.ok || !spec.prompt) {
    pushToast("error", "Couldn't resolve the principal prompt", spec?.error ? { detail: spec.error } : undefined);
    return;
  }
  try {
    await navigator.clipboard.writeText(spec.prompt);
    pushToast("success", "Principal prompt copied", {
      detail: "Paste into your own terminal session. Note: only drawer sessions get transcripts.",
    });
  } catch {
    pushToast("error", "Clipboard unavailable");
  }
}

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
      { id: "agent-note", title: "Note to agent", hint: "Agent", keywords: "feedback capture tell", run: () => feedbackCaptureOpen.set(true) },
      {
        id: "agent-copy-prompt",
        title: "Copy principal prompt",
        hint: "Agent",
        keywords: "clipboard boot terminal external paste",
        run: () => void copyPrincipalPrompt(),
      },
    );
  }
  return cmds;
}
