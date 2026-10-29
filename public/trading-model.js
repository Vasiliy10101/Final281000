(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TradingModel=api;})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  function number(value){
    if(typeof value==='number')return Number.isFinite(value)?value:NaN;
    const s=String(value??'').trim().replace(/\s/g,'').replace(',','.');
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)&&Number.isFinite(Number(s))?Number(s):NaN;
  }
  function symbol(value){const s=String(value||'').trim().toUpperCase().replace(/[\s/_-]/g,'').replace(/USDT$/,'');return /^[A-Z0-9]{1,15}$/.test(s)?s+'-USDT':'';}
  function plan(input){
    const d=input.side==='short'?-1:1,e=number(input.entry),s=number(input.stop),t=number(input.target),b=number(input.balance),r=number(input.risk),l=number(input.leverage),f=number(input.fee)/100;
    const errors={};
    if(!symbol(input.symbol))errors.symbol='Укажи тикер, например BTC или BTC-USDT.';
    if(!(b>0))errors.balance='Укажи доступный депозит больше нуля.';
    if(!(r>0&&r<=100))errors.risk='Риск должен быть больше 0 и не больше 100%.';
    if(!(e>0))errors.entry='Укажи цену входа больше нуля.';
    if(!(s>0))errors.stop='Укажи цену стопа больше нуля.';
    else if(e>0&&(e-s)*d<=0)errors.stop=d===1?'Для лонга стоп должен быть ниже входа.':'Для шорта стоп должен быть выше входа.';
    if(!(l>=1&&Number.isFinite(l)))errors.leverage='Плечо должно быть не меньше 1×.';
    if(!(f>=0&&f<1))errors.fee='Комиссия: от 0 до 100%, не включая 100.';
    if(String(input.target??'').trim()&&(!(t>0)||(t-e)*d<=0))errors.target=d===1?'Для лонга цель должна быть выше входа.':'Для шорта цель должна быть ниже входа.';
    const custom=String(input.quantity??'').trim();
    if(custom&&!(number(custom)>0))errors.quantity='Количество монет должно быть больше нуля.';
    if(Object.keys(errors).length)return{valid:false,errors};
    const budget=b*r/100,unitRisk=Math.abs(e-s)+f*(e+s),q=custom?number(custom):budget/unitRisk,n=q*e,margin=n/l,entryFee=q*e*f;
    const at=price=>q*(price-e)*d-q*(e+price)*f;
    const stopPnl=at(s),targetPnl=t>0?at(t):null;
    const result={valid:true,errors,quantity:q,notional:n,margin,entryFee,required:margin+entryFee,budget,stopPnl,targetPnl,rr:targetPnl!==null?targetPnl/-stopPnl:null,breakEven:e*(1+d*f)/(1-d*f),stopDistance:Math.abs(e-s)/e*100,depositShare:(margin+entryFee)/b*100,overBudget:-stopPnl>budget+1e-8,insufficient:margin+entryFee>b,at};
    if(![q,n,margin,entryFee,result.required,budget,stopPnl,result.breakEven,result.stopDistance,result.depositShare].every(Number.isFinite)||(targetPnl!==null&&!Number.isFinite(targetPnl)))return{valid:false,errors:{quantity:'Слишком большие значения для расчёта.'}};
    return result;
  }
  function liquidation(input){
    const e=number(input.entry),l=number(input.leverage),m=number(input.mmr)/100,d=input.side==='short'?-1:1;
    if(!(e>0&&l>=1&&m>=0&&m<1/l))return null;
    const p=e*(1-d/l)/(1-d*m);
    return p>0&&Number.isFinite(p)?p:null;
  }
  function funding(input,notional){const rate=number(input.fundingRate),periods=number(input.periods);if(!Number.isFinite(rate)||!Number.isSafeInteger(periods)||periods<0||!Number.isFinite(notional)||notional<0)return null;const amount=notional*(rate/100)*periods*(input.side==='short'?1:-1);return Number.isFinite(amount)?amount:null;}
  function ladder(input,quantity,rows){
    const e=number(input.entry),f=number(input.fee)/100,d=input.side==='short'?-1:1;
    const items=rows.filter(x=>String(x.price).trim()||String(x.share).trim()).map(x=>({p:number(x.price),w:number(x.share)}));
    if(!items.length)return{error:'Добавь цену и долю хотя бы одного выхода.'};
    if(items.some(x=>!(x.p>0&&x.w>0&&x.w<=100)||(x.p-e)*d<=0))return{error:'Каждая цель должна быть в сторону прибыли, доля — от 0 до 100%.'};
    const share=items.reduce((a,x)=>a+x.w,0);
    if(share>100+1e-8)return{error:'Сумма долей не должна превышать 100%.'};
    const result={share,average:items.reduce((a,x)=>a+x.p*(x.w/share),0),pnl:items.reduce((a,x)=>a+quantity*(x.w/100)*((x.p-e)*d-f*(e+x.p)),0)};
    return Number.isFinite(result.average)&&Number.isFinite(result.pnl)?result:{error:'Слишком большие значения для расчёта частичных выходов.'};
  }
  function screen(rows,{query='',filter='all',sort='volume',favorites=[],minVolume=0}={}){
    const q=String(query).toUpperCase().replace(/[\s/_-]/g,'');
    const out=rows.filter(t=>Number.isFinite(t.price)&&t.price>0&&Number.isFinite(t.chg)&&Number.isFinite(t.vol)&&t.symbol.replace(/-/g,'').includes(q)&&t.vol>=minVolume&&(filter==='all'||filter==='gain'&&t.chg>0||filter==='lose'&&t.chg<0||filter==='favorites'&&favorites.includes(t.symbol)));
    const order={volume:(a,b)=>b.vol-a.vol,gain:(a,b)=>b.chg-a.chg,lose:(a,b)=>a.chg-b.chg,move:(a,b)=>Math.abs(b.chg)-Math.abs(a.chg),name:(a,b)=>a.symbol.localeCompare(b.symbol)}[sort]||((a,b)=>b.vol-a.vol);
    return out.sort((a,b)=>order(a,b)||a.symbol.localeCompare(b.symbol));
  }
  function journalRows(rows,{query='',filter='all',period='all',now=Date.now()}={}){
    const q=String(query).trim().toUpperCase().replace(/[\s/_-]/g,'');
    const since=period==='all'?-Infinity:now-Number(period)*86400000;
    return rows.filter(t=>new Date(t.ts).getTime()>=since&&t.symbol.replace(/-/g,'').includes(q)&&(filter==='all'||filter==='win'&&t.pnl>0||filter==='lose'&&t.pnl<0||filter==='review'&&!(t.thesis?.trim().length>=20&&t.lesson?.trim().length>=20))).sort((a,b)=>new Date(b.ts)-new Date(a.ts)||Number(b.id)-Number(a.id));
  }
  function stats(rows){
    const sorted=[...rows].sort((a,b)=>new Date(a.ts)-new Date(b.ts)||Number(a.id)-Number(b.id));
    const wins=rows.filter(t=>t.pnl>0),losses=rows.filter(t=>t.pnl<0),sum=a=>a.reduce((v,t)=>v+t.pnl,0),grossProfit=sum(wins),grossLoss=-sum(losses),total=sum(rows);
    let cumulative=0;const equity=[0,...sorted.map(t=>(cumulative+=t.pnl))];
    return{count:rows.length,total,wins:wins.length,losses:losses.length,flat:rows.length-wins.length-losses.length,winRate:rows.length?wins.length/rows.length*100:null,average:rows.length?total/rows.length:null,profitFactor:grossLoss>0?grossProfit/grossLoss:null,equity,reviewed:rows.filter(t=>t.thesis?.trim().length>=20&&t.lesson?.trim().length>=20).length};
  }
  function csv(rows){
    const cell=(value,text=false)=>{let s=String(value??'');if(text&&/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';};
    const header=['Дата записи UTC','Монета','Сторона','Вход','Выход','Количество','PnL без комиссий','Эмоция','Заметка','Причина входа','Вывод'];
    return '\uFEFF'+header.map(x=>cell(x)).join(';')+'\r\n'+rows.map(t=>[cell(t.ts,true),cell(t.symbol,true),cell(t.side,true),cell(t.entry),cell(t.exit),cell(t.size),cell(t.pnl),cell(t.emotion,true),cell(t.note,true),cell(t.thesis,true),cell(t.lesson,true)].join(';')).join('\r\n');
  }
  return{number,symbol,plan,liquidation,funding,ladder,screen,journalRows,stats,csv};
});
