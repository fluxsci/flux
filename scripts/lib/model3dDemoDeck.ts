/** Five focused review slides authored through the same public/pure operations. */
import * as core from '../../flux-core/index';
import { mutateDeck } from '../../flux-core/slides';
import { setTransform, addGhostTransform, becomeTransform } from '../../src/lib/slide/ops';
import { newSlideEmbed, serializeSlideEmbed } from '../../src/lib/slide/embed';
export async function createModel3dDemoDeck(root: string) {
  const {deckId}=await core.createDeck(root,{id:'model3d-review',title:'Flux 3D · motion review',theme:'flux-light'});
  await mutateDeck(root,deckId,'demo_stage',deck=>{deck.slides=[];deck.stage={width:960,height:540};});
  const examples:Record<string,{slideId:string;beatId:string;modelIds:string[];appearanceBeatId?:string}>={};
  async function slide(name:string,stems:string[]) {
    const {slideId}=await core.addSlide(root,deckId,{name,layout:'blank'});
    await core.addTextToSlide(root,deckId,slideId,{text:name,x:45,y:25,width:850,height:55,fontSize:28});
    const {beatId}=await core.addBeat(root,deckId,slideId,{label:name});
    const modelIds:string[]=[];
    for(const [i,stem]of stems.entries()) {
      const result=await core.addSlideModel(root,deckId,slideId,`plots/${stem}.glb`,{x:stems.length>1?75+i*440:260,y:115,width:380,height:340,name:stem,noPoster:true});
      if(result.warnings.length)throw new Error(`Demo model import: ${result.warnings.join('; ')}`);
      modelIds.push(result.elementId);
    }
    examples[name]={slideId,beatId,modelIds};return examples[name];
  }
  const turn=await slide('Turntable',['neuron']);
  await core.addSlideTurntable(root,deckId,turn.slideId,turn.beatId,turn.modelIds[0],{turns:1,durationMs:8000});
  const dendrites=await core.addBeat(root,deckId,turn.slideId,{label:'Dendrites appear'});
  await core.setAnimation(root,deckId,turn.slideId,dendrites.beatId,{
    id:'demo-dendrites-appear',target:turn.modelIds[0],part:'neuron.dendrites',preset:'fade',duration:1200,easing:'linear',
  });
  turn.appearanceBeatId=dendrites.beatId;
  const shape=await slide('Shape change',['cortex-states']);
  await mutateDeck(root,deckId,'demo_shape',deck=>{setTransform(deck,shape.slideId,shape.beatId,shape.modelIds[0],{state:{modelStates:{inflated:1,bent:.25}},duration:2200,curve:'smooth'});});
  const ghost=await slide('Ghost',['neuron']);
  await mutateDeck(root,deckId,'demo_ghost',deck=>{addGhostTransform(deck,ghost.slideId,ghost.beatId,ghost.modelIds[0],{count:2,original:'stay',duration:1800,states:[{x:55,y:160,width:260,height:250,orbitAzimuth:90},{x:645,y:160,width:260,height:250,orbitAzimuth:180}]});});
  for(const [name,stems]of [['Crossfade Become',['neuron','cortex-pial']],['Vertex morph',['cortex-pial','cortex-inflated']]] as const) {
    const item=await slide(name,[...stems]);
    await mutateDeck(root,deckId,'demo_become',deck=>{becomeTransform(deck,item.slideId,item.beatId,item.modelIds[0],item.modelIds[1],{mode:'handoff',duration:2400,curve:'smooth'});});
  }
  const embed=serializeSlideEmbed(newSlideEmbed('paper/notes.qmd',deckId,turn.slideId));
  return {deckId,examples,embed};
}
