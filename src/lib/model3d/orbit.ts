import { modelDefaultStates } from './stateDefaults';
import type { Model3dElement, Model3dAsset, ModelBounds, Scene3dManifest, Vec3, OrbitProjection } from './types';

const rad = Math.PI / 180;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const finite = (n: number | undefined, fallback: number) => Number.isFinite(n) ? n! : fallback;
export const normalizeAzimuth = (degrees: number) => ((degrees % 360) + 360) % 360;
export const nearestEquivalent = (angle: number, current: number) => angle + 360 * Math.round((current - angle) / 360);
export const lerpOrbitZoom = (a: number, b: number, t: number) => Math.exp(Math.log(clamp(a,.02,50)) * (1-t) + Math.log(clamp(b,.02,50)) * t);
export interface Viewport { width: number; height: number; x?: number; y?: number }
export interface OrbitPose {
  center: Vec3; radius: number; target: Vec3; position: Vec3; right: Vec3; up: Vec3; direction: Vec3;
  projection: OrbitProjection; near: number; far: number; halfWidth: number; halfHeight: number;
  fovY: number; zoom: number; distance: number;
}
export type OrbitProps = Pick<Model3dElement, 'orbitAzimuth' | 'orbitElevation' | 'orbitRoll' | 'orbitZoom' | 'orbitPanX' | 'orbitPanY' | 'orbitProjection' | 'orbitFov'>;
export function boundsSphere(bounds: ModelBounds): {center: Vec3; radius: number} {
  const center = bounds.min.map((v,i) => (v + bounds.max[i]) / 2) as Vec3;
  return {center, radius: Math.max(Math.hypot(...bounds.max.map((v,i) => v-center[i])), 1e-9)};
}
export function orbitPose(el: OrbitProps, bounds: ModelBounds, viewport: Viewport): OrbitPose {
  const {center, radius:R} = boundsSphere(bounds);
  const theta=normalizeAzimuth(finite(el.orbitAzimuth,30))*rad, phi=clamp(finite(el.orbitElevation,20),-90,90)*rad;
  const roll=finite(el.orbitRoll,0)*rad, zoom=clamp(finite(el.orbitZoom,.9),.02,50);
  const px=finite(el.orbitPanX,0), py=finite(el.orbitPanY,0), fov=clamp(finite(el.orbitFov,30),5,120)*rad;
  const direction:Vec3=[Math.sin(theta)*Math.cos(phi),Math.sin(phi),Math.cos(theta)*Math.cos(phi)];
  const right0:Vec3=[Math.cos(theta),0,-Math.sin(theta)];
  const up0:Vec3=[-Math.sin(theta)*Math.sin(phi),Math.cos(phi),-Math.cos(theta)*Math.sin(phi)];
  const right=right0.map((v,i)=>v*Math.cos(roll)+up0[i]*Math.sin(roll)) as Vec3;
  const up=up0.map((v,i)=>v*Math.cos(roll)-right0[i]*Math.sin(roll)) as Vec3;
  const target=center.map((v,i)=>v+R*(px*right[i]+py*up[i])) as Vec3;
  const a=Math.max(viewport.width,1e-9)/Math.max(viewport.height,1e-9), s=R/zoom;
  const projection=el.orbitProjection==='perspective'?'perspective':'orthographic';
  const distance=projection==='perspective'?s/Math.sin(fov/2):3*R;
  const near=projection==='perspective'?Math.max(.001*distance,distance-1.2*R*Math.max(1,1/zoom)):.01*R;
  const far=projection==='perspective'?distance+1.2*R*(1+Math.abs(px)+Math.abs(py)):6*R*(1+Math.abs(px)+Math.abs(py));
  return {center,radius:R,target,position:target.map((v,i)=>v+direction[i]*distance) as Vec3,right,up,direction,projection,
    near,far,halfWidth:s*Math.max(a,1),halfHeight:s*Math.max(1/a,1),fovY:(a>=1?fov:2*Math.atan(Math.tan(fov/2)/a))/rad,zoom,distance};
}
export function project(point: Vec3, pose: OrbitPose, viewport: Viewport): {x:number;y:number;depth:number} {
  const relative=point.map((v,i)=>v-pose.position[i]);
  const dot=(axis:Vec3)=>relative.reduce((n,v,i)=>n+v*axis[i],0);
  const depth=-dot(pose.direction), x=dot(pose.right), y=dot(pose.up);
  const h=pose.projection==='perspective'?depth*Math.tan(pose.fovY*rad/2):pose.halfHeight;
  const w=pose.projection==='perspective'?h*viewport.width/viewport.height:pose.halfWidth;
  return {x:(viewport.x??0)+viewport.width*(.5+x/(2*w)),y:(viewport.y??0)+viewport.height*(.5-y/(2*h)),depth};
}
export function pixelsPerUnit(pose: OrbitPose, viewport: Viewport): number | null {
  return pose.projection==='orthographic'?viewport.height/(2*pose.halfHeight):null;
}
export type AxisView = 'front'|'back'|'right'|'left'|'top'|'bottom';
export function axisView(name: AxisView, current=0): Pick<OrbitProps,'orbitAzimuth'|'orbitElevation'|'orbitRoll'> {
  const views:Record<AxisView,[number,number]>={front:[0,0],back:[180,0],right:[90,0],left:[-90,0],top:[current,90],bottom:[current,-90]};
  const pair=views[name]; if(!pair) throw new Error(`Unknown 3D axis view: ${name}`);
  return {orbitAzimuth:nearestEquivalent(pair[0],current),orbitElevation:pair[1],orbitRoll:0};
}
export function homeView(asset?: Model3dAsset | null, manifest?: Scene3dManifest | null): OrbitProps & {modelStates?:Record<string,number>} {
  const v=manifest?.view;
  const states=modelDefaultStates(manifest??undefined,asset?.model.states??Object.keys(v?.states??{}));
  return {orbitAzimuth:v?.azimuth??30,orbitElevation:v?.elevation??20,orbitRoll:v?.roll??0,orbitZoom:v?.zoom??.9,
    orbitPanX:v?.panX??0,orbitPanY:v?.panY??0,orbitProjection:v?.projection??'orthographic',orbitFov:v?.fov??30,
    ...(Object.keys(states).length?{modelStates:states}:{})};
}
/** Frame zero is the base; frame 1..N selects target 0..N-1. */
export function statesAtFrame(names: readonly string[], frame: number): Record<string,number> {
  const f=clamp(finite(frame,0),0,names.length), lo=Math.floor(f), hi=Math.ceil(f), out:Record<string,number>=Object.create(null);
  if(lo===hi){if(lo>0) out[names[lo-1]]=1;} else {if(lo>0) out[names[lo-1]]=hi-f; if(hi>0) out[names[hi-1]]=f-lo;}
  return out;
}
