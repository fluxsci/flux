// Headless live-command tests still need a resident editor, just as the app
// does. This owns a disposable root and real snapshot writer; it never bypasses
// dispatch ownership checks or changes production behavior.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { get } from 'svelte/store';
import { currentProject, view } from '../../src/shell/shellStore';
import { setFocusedMode } from '../../src/shell/paneStore';
import { registerFlushable } from '../../src/shell/lifecycle';
import { setStoreTenant } from '../../src/lib/tenancy';
import * as store from '../../src/lib/store';
export function mountFigureCommandFixture(existingRoot?: string): () => void {
  const root = existingRoot ?? mkdtempSync(path.join(tmpdir(), 'flux-live-editor-'));
  currentProject.set({ name:'Live command fixture',path:root }); view.set('workspace');
  setFocusedMode('figure');setStoreTenant('figure');store.embeddedProjectRoot.set(root);
  const unregister=registerFlushable({id:'figure',paneId:'fixture',isDirty:()=>get(store.dirty),flush:async()=>{
    writeFileSync(path.join(root,'live-editor-snapshot.json'),JSON.stringify(get(store.project))+'\n');
    store.dirty.set(false);
  }});
  const cleanup=()=>{unregister();if(!existingRoot)rmSync(root,{recursive:true,force:true});};
  process.once('exit',cleanup);
  return cleanup;
}
