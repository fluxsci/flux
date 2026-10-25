import type { SemanticPlotElement } from '../../types';
import type { FluxPlotManifest } from '../types';
import { applyOverrides } from '../parse';
import { restorePtTrue } from '../compensate';
import { resetProjectionBindings,preparePlotView,applyPlotView } from '../projectDom';
import { relayoutPlot,restoreRelayout } from './index';
import { registerRelayoutPreview as register } from './preview';
/** Loaded with mount.ts, never by the canvas's transient gesture registry. */
export function registerRelayoutPreview(root:Element,manifest:FluxPlotManifest|undefined,element:SemanticPlotElement){
  return register(root,manifest,element,next=>{
    restorePtTrue(root);resetProjectionBindings(root);restoreRelayout(root);
    const result=relayoutPlot(root,manifest,next,'exact');
    preparePlotView(root,result.manifest,next.view,next.id);
    applyOverrides(root,next.overrides,next.id,result.manifest);
    applyPlotView(root,result.manifest,next.view,next.id);
  });
}
