(function(root,factory){const model=factory();if(typeof module==='object'&&module.exports)module.exports=model;else root.UserStateModel=model;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const fields={calculator:['symbol','side','balance','risk','entry','stop','target','leverage','fee','quantity','mmr','fundingRate','periods'],'journal-draft':['symbol','side','entry','exit','size','emotion','note','thesis','lesson','clientId'],'screen-filters':['query','filter','sort','minVolume'],'journal-filters':['query','filter','period']};
  const labels={calculator:'Расчёт сделки','calculator-exits':'Частичные выходы',favorites:'Избранные монеты','journal-draft':'Черновик сделки','screen-filters':'Фильтры скринера','journal-filters':'Фильтры дневника','profile-drafts':'Черновики разборов','pump-direction':'Вкладка Pump / Dump'};
  const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  function valid(key,v){
    if(!Object.hasOwn(labels,key))return false;
    if(fields[key]){
      if(!object(v)||Object.keys(v).length!==fields[key].length||!fields[key].every(k=>typeof v[k]==='string'&&v[k].length<=({thesis:1000,lesson:1000,note:280}[k]||100)))return false;
      if(key==='screen-filters')return ['all','favorites','gain','lose'].includes(v.filter)&&['volume','move','gain','lose','name'].includes(v.sort)&&['0','1000000','10000000','100000000'].includes(v.minVolume);
      if(key==='journal-filters')return ['all','win','lose','review'].includes(v.filter)&&['all','7','30'].includes(v.period);
      return ['long','short'].includes(v.side);
    }
    if(key==='favorites')return Array.isArray(v)&&v.length<=500&&new Set(v).size===v.length&&v.every(s=>typeof s==='string'&&/^[A-Z0-9]{1,15}-USDT$/.test(s));
    if(key==='calculator-exits')return Array.isArray(v)&&v.length===3&&v.every(r=>object(r)&&Object.keys(r).length===2&&typeof r.price==='string'&&r.price.length<=100&&typeof r.share==='string'&&r.share.length<=100);
    if(key==='pump-direction')return ['pump','dump'].includes(v);
    if(key==='profile-drafts')return object(v)&&Object.keys(v).length<=20&&Object.entries(v).every(([k,r])=>/^(summary|weekly:\d{4}-\d{2}-\d{2})$/.test(k)&&object(r)&&Object.keys(r).every(p=>['body','saved','baseBody'].includes(p))&&typeof r.body==='string'&&r.body.length<=2000&&(r.saved===undefined||typeof r.saved==='boolean')&&(r.baseBody===undefined||typeof r.baseBody==='string'&&r.baseBody.length<=2000));
    return false;
  }
  function stable(v){return JSON.stringify(v,(_,x)=>object(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);}
  const same=(a,b)=>stable(a)===stable(b);
  return{valid,same,labels,fields};
});
