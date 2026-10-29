'use strict';
function createMarketProxy({fetchImpl=global.fetch,clock=Date.now,timeoutMs=8000}={}) {
  const base='/openApi/swap/v2/quote/',ttls=new Map([[base+'price',2000],[base+'ticker',15000],[base+'contracts',300000]]);
  const cache=new Map(),pending=new Map();
  async function get(endpoint=base+'price',symbol='') {
    if(!ttls.has(endpoint))return{status:400,body:{error:'path_not_allowed'}};
    if(typeof symbol!=='string'||(symbol&&!/^[A-Z0-9]{1,20}-USDT$/.test(symbol)))return{status:400,body:{error:'invalid_symbol'}};
    const key=endpoint+':'+symbol,old=cache.get(key);
    if(old&&clock()-old.at<ttls.get(endpoint))return old.result;
    if(pending.has(key))return pending.get(key);
    const task=(async()=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        const response=await fetchImpl('https://open-api.bingx.com'+endpoint+(symbol?'?symbol='+encodeURIComponent(symbol):''),{signal:controller.signal});
        const body=await response.json();
        if(!response.ok||body?.code!==0||!body.data)return{status:502,body:{error:'market_unavailable'}};
        const result={status:200,body};
        if(cache.size>=256)cache.delete(cache.keys().next().value);
        cache.set(key,{at:clock(),result});return result;
      } catch(_) {return{status:controller.signal.aborted?504:502,body:{error:'market_unavailable'}};}
      finally {clearTimeout(timer);}
    })();
    pending.set(key,task);try{return await task;}finally{pending.delete(key);}
  }
  return{get};
}
module.exports={createMarketProxy};
