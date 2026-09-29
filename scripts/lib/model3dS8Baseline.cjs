'use strict';
const assert=require('node:assert/strict');

/** Validate native DOM evidence before capturing a matched image control. */
function s8CaptureRect({clip,box,hit}) {
  const finite=r=>r&&['x','y','right','bottom','width','height'].every(k=>Number.isFinite(r[k]))&&r.width>0&&r.height>0&&r.right>r.x&&r.bottom>r.y;
  if(!finite(clip)||!finite(box)||box.x<clip.x||box.y<clip.y||box.right>clip.right||box.bottom>clip.bottom||hit!==true)throw Error('S8 capture must be wholly visible and hittable inside the canvas');
  return {x:Math.floor(box.x),y:Math.floor(box.y),width:Math.ceil(box.right)-Math.floor(box.x),height:Math.ceil(box.bottom)-Math.floor(box.y)};
}

/** Assert the copied public artwork differs only in the four raster placements. */
function verifyS8RasterReplacement(before,after,figureId,captures) {
  assert.equal(captures.length,4,'S8 needs exactly four captures');
  const byId=new Map(captures.map(c=>[c.elementId,c]));assert.equal(byId.size,4,'S8 captures must be distinct');
  const {assets:oldAssets,...oldIndex}=before.index,{assets:newAssets,...newIndex}=after.index;
  assert.deepEqual(newIndex,oldIndex,'S8 index metadata changed');
  assert.equal(newAssets.length,oldAssets.length+4,'S8 must add exactly four raster assets');
  assert.deepEqual(newAssets.slice(0,oldAssets.length),oldAssets,'S8 original assets changed');
  const {figures:oldFigures,...oldCanvas}=before.canvas,{figures:newFigures,...newCanvas}=after.canvas;
  assert.deepEqual(newCanvas,oldCanvas,'S8 canvas metadata changed');assert.equal(newFigures.length,oldFigures.length,'S8 figure count changed');
  let replacements=0,preservedOriginalElements=0,preservedOtherFigures=0;
  oldFigures.forEach((oldFigure,i)=>{
    const newFigure=newFigures[i];
    if(oldFigure.id!==figureId){assert.deepEqual(newFigure,oldFigure,'S8 other public figure changed');preservedOtherFigures++;return}
    const {elements:oldElements,...oldFigureProps}=oldFigure,{elements:newElements,...newFigureProps}=newFigure;
    assert.deepEqual(newFigureProps,oldFigureProps,'S8 target figure extent or metadata changed');assert.equal(newElements.length,oldElements.length,'S8 element count changed');
    oldElements.forEach((original,j)=>{
      const replacement=newElements[j],capture=byId.get(original.id);
      if(!capture){assert.deepEqual(replacement,original,'S8 original artwork changed');preservedOriginalElements++;return}
      assert.equal(original.type,'model3d');assert.equal(original.assetId,capture.assetId);assert.equal(replacement.type,'image');
      const assetId=capture.assetId+'-flat';
      assert.deepEqual(replacement,{id:original.id,type:'image',assetId,x:original.x,y:original.y,width:original.width,height:original.height,rotation:original.rotation},'S8 raster placement geometry changed');
      const asset=newAssets.slice(oldAssets.length).find(a=>a.id===assetId);
      assert.ok(asset,'S8 raster asset missing');assert.equal(asset.kind,'png');assert.equal(asset.path,`assets/${assetId}.png`);
      assert.equal(asset.naturalWidth,capture.pixelSize.width);assert.equal(asset.naturalHeight,capture.pixelSize.height);
      replacements++;
    });
  });
  assert.equal(replacements,4,'S8 replacement census is incomplete');
  return {figuresIdenticalExceptFourRasterReplacements:true,preservedOriginalElements,preservedOtherFigures,replacements};
}
module.exports={s8CaptureRect,verifyS8RasterReplacement};
