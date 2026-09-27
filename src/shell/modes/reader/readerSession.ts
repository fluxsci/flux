/** One source request owner. Both the root and epoch must still match at commit. */
export function createReaderSourceOwner(rootFor: () => Promise<string | null>) {
  let epoch=0,alive=true;
  return {
    invalidate(){epoch++;},dispose(){alive=false;epoch++;},
    async run<T>(load:(root:string|null)=>Promise<T>,commit:(value:T,root:string|null)=>void,onError?:(error:unknown)=>void) {
      const mine=++epoch;
      try {
        const root=await rootFor();if(!alive||mine!==epoch)return false;
        const value=await load(root);if(!alive||mine!==epoch)return false;
        const current=await rootFor();if(!alive||mine!==epoch||root!==current)return false;
        commit(value,root);return true;
      }catch(error){if(alive&&mine===epoch)onError?.(error);return false;}
    }
  };
}
