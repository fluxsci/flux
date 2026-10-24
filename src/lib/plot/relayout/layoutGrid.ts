// Matplotlib 3.11 _layoutgrid.LayoutGrid's constraint system, in SVG pt.
// Rows run top-to-bottom here; the algebra is the y-reflection of matplotlib.
import { Solver,Variable,Expression,Constraint,Operator,Strength } from "@lume/kiwi";
import type { Box } from "./model";
export { Solver };
type Term=Variable|Expression|number;
const e=(...terms:Term[])=>new Expression(...terms);
const neg=(t:Term)=>typeof t==="number"?-t:new Expression([-1,t]);
export class LayoutGrid {
  left:Variable[];right:Variable[];top:Variable[];bottom:Variable[];
  margins:Record<string,Variable[]>={};values:Record<string,number[]>={};
  constructor(public solver:Solver,public rows:number,public cols:number,wr:number[],hr:number[],
    parent:LayoutGrid|Box,parentRows=[0,0],parentCols=[0,0],inner=false){
    const vars=(n:number)=>Array.from({length:n},()=>new Variable());
    this.left=vars(cols);this.right=vars(cols);this.top=vars(rows);this.bottom=vars(rows);
    for(const side of ["left","right","leftcb","rightcb","top","bottom","topcb","bottomcb"]){
      const n=["left","right","leftcb","rightcb"].includes(side)?cols:rows;
      this.margins[side]=vars(n);this.values[side]=Array(n).fill(0);
      for(const v of this.margins[side]){solver.addEditVariable(v,Strength.strong);solver.suggestValue(v,0);}
    }
    const eq=(lhs:Term,rhs:Term,strength=Strength.required)=>solver.addConstraint(new Constraint(e(lhs),Operator.Eq,e(rhs),strength));
    const ge=(lhs:Term,rhs:Term)=>solver.addConstraint(new Constraint(e(lhs),Operator.Ge,e(rhs),Strength.required));
    for(let c=0;c<cols;c++){
      ge(this.right[c],this.left[c]);
      ge(e(this.right[c],neg(this.margins.right[c]),neg(this.margins.rightcb[c])),e(this.left[c],neg(this.margins.left[c]),neg(this.margins.leftcb[c])));
    }
    for(let r=0;r<rows;r++){
      ge(this.bottom[r],this.top[r]);
      ge(e(this.bottom[r],neg(this.margins.bottom[r]),neg(this.margins.bottomcb[r])),e(this.top[r],neg(this.margins.top[r]),neg(this.margins.topcb[r])));
    }
    const bounds=parent instanceof LayoutGrid?parent.bounds(parentRows,parentCols,inner):{x0:parent.x0,x1:parent.x1,y0:parent.y0,y1:parent.y1};
    eq(this.left[0],bounds.x0);eq(this.right[cols-1],bounds.x1);eq(this.top[0],bounds.y0);eq(this.bottom[rows-1],bounds.y1);
    const iw=(c:number)=>e(this.right[c],neg(this.margins.right[c]),neg(this.margins.rightcb[c]),neg(this.left[c]),neg(this.margins.left[c]),neg(this.margins.leftcb[c]));
    const ih=(r:number)=>e(this.bottom[r],neg(this.margins.bottom[r]),neg(this.margins.bottomcb[r]),neg(this.top[r]),neg(this.margins.top[r]),neg(this.margins.topcb[r]));
    for(let c=1;c<cols;c++){eq(iw(c),iw(0).multiply(wr[c]/wr[0]),Strength.strong);eq(this.right[c-1],this.left[c],Strength.strong);}
    for(let r=1;r<rows;r++){eq(ih(r),ih(0).multiply(hr[r]/hr[0]),Strength.strong);eq(this.bottom[r-1],this.top[r],Strength.strong);}
  }
  bounds(rows:number[],cols:number[],inner:boolean){
    const [r0,r1]=rows,[c0,c1]=cols;
    return {x0:inner?e(this.left[c0],this.margins.left[c0],this.margins.leftcb[c0]):e(this.left[c0]),
      x1:inner?e(this.right[c1],neg(this.margins.right[c1]),neg(this.margins.rightcb[c1])):e(this.right[c1]),
      y0:inner?e(this.top[r0],this.margins.top[r0],this.margins.topcb[r0]):e(this.top[r0]),
      y1:inner?e(this.bottom[r1],neg(this.margins.bottom[r1]),neg(this.margins.bottomcb[r1])):e(this.bottom[r1])};
  }
  box(rows:number[],cols:number[],inner=true):Box {const b=this.bounds(rows,cols,inner);return {x0:b.x0.value(),x1:b.x1.value(),y0:b.y0.value(),y1:b.y1.value()};}
  cbBox(rows:number[],cols:number[]):Box {const [r0,r1]=rows,[c0,c1]=cols;return {x0:this.left[c0].value()+this.margins.leftcb[c0].value(),x1:this.right[c1].value()-this.margins.rightcb[c1].value(),y0:this.top[r0].value()+this.margins.topcb[r0].value(),y1:this.bottom[r1].value()-this.margins.bottomcb[r1].value()};}
  edit(side:string,index:number,value:number){if(value>this.values[side][index]){this.values[side][index]=value;this.solver.suggestValue(this.margins[side][index],value);}}
  reset(){for(const [side,vars]of Object.entries(this.margins))vars.forEach((v,i)=>{this.values[side][i]=0;this.solver.suggestValue(v,0);});}
}
