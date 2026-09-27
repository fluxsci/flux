import type { ReaderContext } from '../../../lib/references/items';
export interface ContextTransport {
  claim(root:string,owner:string):Promise<{token:string;root:string}|null>;
  publish(token:string,generation:number,context:ReaderContext):Promise<boolean>;
  renew?(token:string,generation:number):Promise<boolean>;
  release(token:string):Promise<unknown>;
}
/** Per-view publisher; native claims arbitrate focused ownership across windows. */
export function createReaderContextPublisher(transport:ContextTransport,owner:string,opts:{heartbeatMs?:number;onError?:(error:unknown)=>void}={}) {
  let desired:{root:string;context:ReaderContext;foreground:boolean}|null=null,claim:{token:string;root:string}|null=null;
  let epoch=0,disposed=false,timer:ReturnType<typeof setInterval>|undefined,chain=Promise.resolve(),running=false;
  const release=(token:string)=>transport.release(token).catch(error=>opts.onError?.(error));
  function queue() {
    const mine=++epoch;
    chain=chain.catch(()=>{}).then(async()=>{
      running=true;
      const current=desired;if(disposed||!current||mine!==epoch)return;
      if(claim&&claim.root!==current.root){const old=claim;claim=null;await release(old.token);}
      if(!claim&&!current.foreground)return;
      if(!claim){const got=await transport.claim(current.root,owner);if(disposed||mine!==epoch||desired!==current){if(got)await release(got.token);return;}claim=got;}
      if(!claim||disposed||mine!==epoch||desired!==current)return;
      const token=claim.token;
      const accepted=current.foreground?await transport.publish(token,mine,current.context):await transport.renew?.(token,mine);
      if(!accepted) {if(claim?.token===token)claim=null;}
    }).catch(error=>opts.onError?.(error)).finally(()=>{running=false;});
    return chain;
  }
  return {
    update(root:string|null,context:ReaderContext|null,focused:boolean,foreground=true) {
      if(disposed)return;
      if(!root||!context||!focused){desired=null;epoch++;clearInterval(timer);timer=undefined;const old=claim;claim=null;if(old)void release(old.token);return;}
      // A heartbeat NEVER preempts a pass that is still running: `queue` bumps the
      // epoch, which cancels the in-flight claim/publish, so a tick that arrives
      // while a pass is mid-flight would discard it and start over — permanent
      // starvation whenever one atomic write outlasts the interval (Windows fsync
      // against a 5ms heartbeat never published at all). A skipped tick costs
      // nothing: the next one renews. Only `update` — a real state change — preempts.
      desired={root,context,foreground};if(!timer)timer=setInterval(()=>{if(!running)void queue();},opts.heartbeatMs??10000);void queue();
    },
    async flush(){await chain;},
    async dispose(){disposed=true;desired=null;epoch++;clearInterval(timer);const old=claim;claim=null;if(old)await release(old.token);await chain;}
  };
}
