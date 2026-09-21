import type { FileBridge } from '../../../lib/project/types';
import { dataUrlToBytes } from '../../../lib/assets';
import { injectPngDpi, injectPngText } from '../../../lib/figure/pngDpi';
import { SNIP_DIR, SNIP_SCALE, SNIP_TEXT_KEYWORD, sanitizeSnipName, dedupSnipName, normSnipRect, snipRasterPlan, encodeSnipMeta, sidecarText, type SnipMeta, type SnipRect } from '../../../lib/references/snips';

export interface ReaderSnipRequest {
  citekey: string; page: number; rect: SnipRect; name: string; citation: string;
  projectRoot: string; sourceEpoch: number; sourcePdf: SnipMeta['sourcePdf'];
  view: { pageBox(page: number): Promise<SnipRect | null>; renderRegion(page: number, rect: SnipRect, width: number, options: {scale: number}): Promise<string | null> } | null | undefined;
}
type SnipFiles=Pick<FileBridge,'mkdir'|'exists'|'writeText'|'writeFile'>;
/** One Reader instance owns its source snapshot; UI drafts remain with the view. */
export function createReaderSnipController(deps: {
  current(request: ReaderSnipRequest): boolean;
  bridge(): SnipFiles | null | undefined;
  withLease(root: string, publish: (assertOwned: () => Promise<void>) => Promise<void>): Promise<void>;
}) {
  const check=(request: ReaderSnipRequest)=>{if(!deps.current(request))throw Error('The snip source changed; select the original PDF and capture again.');};
  return {async save(request: ReaderSnipRequest, rawName: string) {
    // Snapshot before the first await, including metadata and the public view handle.
    const req={...request,rect:[...request.rect] as SnipRect,sourcePdf:typeof request.sourcePdf==='string'?request.sourcePdf:{...request.sourcePdf}};
    const root=req.projectRoot,base=sanitizeSnipName(rawName)||req.name;
    check(req);
    const box=await req.view?.pageBox(req.page);check(req);
    const rect=box?normSnipRect(req.rect,box):req.rect;
    const src=await req.view?.renderRegion(req.page,rect,460,{scale:SNIP_SCALE});check(req);
    if(!src)throw Error("couldn't render the region");
    const meta: SnipMeta={citekey:req.citekey,page:req.page,rect,sourcePdf:req.sourcePdf,capturedAt:new Date().toISOString(),citation:req.citation};
    let bytes=dataUrlToBytes(src);
    bytes=injectPngDpi(bytes,snipRasterPlan(rect,SNIP_SCALE).dpi);
    bytes=injectPngText(bytes,SNIP_TEXT_KEYWORD,encodeSnipMeta(meta));
    const fb=deps.bridge();if(!fb)throw Error('no file bridge available');
    check(req);await fb.mkdir(`${root}/plots`);check(req);await fb.mkdir(`${root}/${SNIP_DIR}`);
    let name=base;
    await deps.withLease(root,async assertOwned=>{
      check(req);
      name=await dedupSnipName(base,async n=>await fb.exists(`${root}/${SNIP_DIR}/${n}.png`)||await fb.exists(`${root}/${SNIP_DIR}/${n}.snip.json`));
      check(req);await assertOwned();check(req);
      await fb.writeText(`${root}/${SNIP_DIR}/${name}.snip.json`,sidecarText(meta),{createOnly:true});
      await assertOwned();check(req);
      await fb.writeFile(`${root}/${SNIP_DIR}/${name}.png`,bytes);
    });
    return {base,name,meta};
  }};
}
