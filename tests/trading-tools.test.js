'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=process.env.MEMBER_APP_DIR||path.resolve(__dirname,'..'),M=require(path.join(root,'public/trading-model.js'));
const base={symbol:'BTC-USDT',side:'long',balance:'1000',risk:'1',entry:'100',stop:'98',target:'104',leverage:'10',fee:'0.05',quantity:''};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('Linear sizing includes both commissions; leverage only changes collateral',()=>{
 const a=M.plan(base),b=M.plan({...base,leverage:'2'});assert.equal(a.valid,true);near(a.quantity,10/(2+.0005*198));near(a.stopPnl,-10);near(a.targetPnl,a.quantity*(4-.0005*204));near(a.quantity,b.quantity);near(a.margin*5,b.margin);near(a.required,a.margin+a.entryFee);near(a.at(a.breakEven),0);
 const short=M.plan({...base,side:'short',stop:'102',target:'96'});near(short.stopPnl,-10);near(short.at(short.breakEven),0);assert.ok(short.targetPnl>0);
 const custom=M.plan({...base,quantity:'1000'});assert.equal(custom.overBudget,true);assert.equal(custom.insufficient,true);
});
test('Wrong-side stops/targets, blank and malformed numbers never create a plausible result',()=>{
 for(const [key,value] of [['stop','101'],['stop','100'],['target','99'],['entry','0'],['balance',''],['risk','101'],['leverage','0'],['fee','100'],['quantity','-1'],['entry','100x'],['entry','Infinity']])assert.equal(M.plan({...base,[key]:value}).valid,false,key+':'+value);
 assert.equal(M.plan({...base,side:'short',stop:'98'}).valid,false);
 assert.equal(M.plan({...base,balance:'1e300',quantity:'1e300',entry:'1e300',stop:'1',target:''}).valid,false);
 const optional=M.plan({...base,target:''});assert.equal(optional.valid,true);assert.equal(optional.targetPnl,null);assert.equal(optional.rr,null);
 near(M.number(' 1 234,50 '),1234.5);assert.ok(Number.isNaN(M.number('')));assert.equal(M.symbol('btc/usdt'),'BTC-USDT');assert.equal(M.symbol('<script>'),'');
});
test('Funding sign follows position and payment count; ladder excludes the open remainder',()=>{
 near(M.funding({side:'long',fundingRate:'0.01',periods:'3'},1000),-.3);near(M.funding({side:'short',fundingRate:'0.01',periods:'3'},1000),.3);near(M.funding({side:'long',fundingRate:'-0.01',periods:'3'},1000),.3);assert.equal(M.funding({fundingRate:'1',periods:'0.5'},1000),null);
 const l=M.ladder(base,1,[{price:'104',share:'50'},{price:'',share:''}]);assert.equal(l.share,50);near(l.pnl,.5*(4-.102));assert.ok(M.ladder(base,1,[{price:'104',share:'60'},{price:'108',share:'50'}]).error);assert.ok(M.ladder(base,1,[{price:'99',share:'20'}]).error);
 near(M.liquidation({...base,mmr:'.5'}),90/.995);assert.equal(M.liquidation({...base,mmr:'20'}),null);
});

test('Overflow in funding and partial exits does not become a valid numerical result',()=>{
 assert.equal(M.funding({side:'long',fundingRate:'1e308',periods:'10'},1000),null);
 assert.equal(M.funding({side:'long',fundingRate:'0.01',periods:'9007199254740992'},1000),null);
 assert.ok(M.ladder(base,1e308,[{price:'100000',share:'100'}]).error);
});
const ticks=[{symbol:'BTC-USDT',price:100,vol:2e6,chg:5},{symbol:'ETH-USDT',price:10,vol:3e6,chg:-10},{symbol:'SOL-USDT',price:1,vol:4e6,chg:0}];
test('Screener handles normalized search, watchlists, volume, losers first and all matching rows',()=>{
 assert.deepEqual(M.screen(ticks,{query:'btc/usdt'}).map(t=>t.symbol),['BTC-USDT']);assert.equal(M.screen(ticks,{filter:'favorites',favorites:['ETH-USDT']})[0].symbol,'ETH-USDT');assert.equal(M.screen(ticks,{filter:'gain'}).length,1);assert.equal(M.screen(ticks,{filter:'lose'})[0].chg,-10);assert.equal(M.screen(ticks,{sort:'move'})[0].symbol,'ETH-USDT');assert.equal(M.screen(ticks,{minVolume:3e6}).length,2);
 assert.equal(M.screen(Array.from({length:250},(_,i)=>({symbol:'COIN'+i+'-USDT',price:1,chg:1,vol:i}))).length,250);assert.equal(M.screen([...ticks,{symbol:'BAD-USDT',price:NaN,chg:1,vol:5}]).length,3);
});
const trades=[{id:1,symbol:'BTC-USDT',side:'long',entry:100,exit:102,size:1,pnl:2,ts:'2026-10-01T10:00:00Z',thesis:'x'.repeat(20),lesson:'y'.repeat(20)},{id:2,symbol:'ETH-USDT',side:'short',entry:10,exit:12,size:1,pnl:-2,ts:'2026-10-27T10:00:00Z'},{id:3,symbol:'SOL-USDT',side:'long',entry:1,exit:1,size:1,pnl:0,ts:'2026-10-28T10:00:00Z'}];
test('Journal filters and statistics share a subset; zero results and no losses are explicit',()=>{
 const now=Date.parse('2026-10-28T12:00:00Z');assert.deepEqual(M.journalRows(trades,{period:'7',now}).map(t=>t.id),[3,2]);assert.deepEqual(M.journalRows(trades,{filter:'review'}).map(t=>t.id),[3,2]);assert.equal(M.journalRows(trades,{query:'btc/usdt'})[0].id,1);const s=M.stats(trades);assert.equal(s.total,0);assert.equal(s.flat,1);assert.deepEqual(s.equity,[0,2,0,0]);near(s.winRate,100/3);assert.equal(s.profitFactor,1);assert.equal(M.stats([]).winRate,null);assert.equal(M.stats([trades[0]]).profitFactor,null);
});
test('CSV preserves full analysis, newlines and quotes and neutralizes text formulas',()=>{
 const result=M.csv([{...trades[1],note:'=HYPERLINK("test")',thesis:'две\nстроки; с точкой',lesson:'@SUM(1)'}]);assert.ok(result.startsWith('\uFEFF'));assert.ok(result.includes('"\'=HYPERLINK(""test"")"'));assert.ok(result.includes('"две\nстроки; с точкой"'));assert.ok(result.includes('"\'@SUM(1)"'));assert.ok(result.includes('"-2"'));
});
test('Database list contains latest 500 owned entries and a truthful truncation marker',async()=>{
 const journal=require(path.join(root,'journal.js'));let query;
 const rows=Array.from({length:501},(_,i)=>({id:501-i,symbol:'BTC-USDT',side:'long',entry:100,exit:101,size:1,ts:new Date(2026,0,1,0,i).toISOString()}));
 const r=await journal.listTrades({query:async(sql,args)=>{query={sql,args};return{rows};}},async()=>{},{id:42});assert.match(query.sql,/WHERE user_id = \$1 ORDER BY ts DESC, id DESC LIMIT 501/);assert.deepEqual(query.args,[42]);assert.equal(r.hasMore,true);assert.equal(r.trades.length,500);assert.equal(r.trades[0].id,2);assert.equal(r.trades[499].id,501);
});

function element(type,props,...children){return{type,props:props||{},children:children.flat(Infinity).filter(x=>x!==false&&x!==null&&x!==undefined)};}
function walk(n,p,out=[]){if(n&&typeof n==='object'){if(p(n))out.push(n);for(const c of n.children||[])walk(c,p,out);}return out;}
function harness(){let cursor=0;const slots=[],pending=[],cleanups=[];const R={Fragment:'fragment',createElement:element,useState(init){const i=cursor++;if(!(i in slots))slots[i]=typeof init==='function'?init():init;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef(init){const i=cursor++;if(!(i in slots))slots[i]={current:init};return slots[i];},useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((d,j)=>!Object.is(d,slots[i][j]))){slots[i]=deps;pending.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};return{R,render(fn){cursor=0;const tree=fn();while(pending.length)pending.shift()();return tree;},cleanup(){cleanups.forEach(f=>f?.());}};}
const tick=()=>new Promise(setImmediate);
function ui({protocol='file:',fetch,list,add,remove,storage=new Map()}={}){
 const hooks=harness(),events=[];
 const w={addEventListener(){},removeEventListener(){},TradingModel:M,location:{protocol},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)},navigator:{clipboard:{writeText:async()=>{}}},dispatchEvent:e=>events.push(e.type)};
 vm.runInNewContext(fs.readFileSync(path.join(root,'public/trading-tools.js'),'utf8'),{window:w,AbortController,setTimeout,clearTimeout,Date,Intl,CustomEvent:class{constructor(type){this.type=type;}}});
 const api={Reveal:function Reveal(){},bingxUrl:(path,sym)=>path+'?symbol='+sym,fetch:fetch||(async()=>{throw Error('unexpected quote')}),list:list||(async()=>({ok:true,trades:[]})),add:add||(async()=>{throw Error('unexpected save')}),remove:remove||(async()=>{throw Error('unexpected delete')})};
 return{...hooks,w,events,storage,components:w.createTradingTools(hooks.R,api)};
}
const button=(tree,text)=>walk(tree,n=>(n.type==='button'||n.type?.name==='Btn')&&n.children.includes(text))[0];
const field=(tree,label)=>walk(tree,n=>n.type?.name==='Field'&&n.props.label===label)[0];
test('Unified calculator has no mode slider, restores drafts and transfers only a plan',()=>{
 const x=ui();let transferred;const props={symbols:['BTC-USDT'],onJournal:v=>transferred=v};const render=()=>x.render(()=>x.components.CalculatorsModule(props));let t=render();button(t,'Заполнить учебный пример').props.onClick();t=render();assert.ok(walk(t,n=>n.type?.name==='Metric'&&n.props.value==='-10,00 USDT').length||walk(t,n=>n.type?.name==='Metric'&&n.props.label==='Результат на стопе').length);button(t,'В дневник →').props.onClick();assert.equal(transferred.symbol,'BTC-USDT');assert.equal(transferred.entry,'100');assert.ok(!('exit' in transferred));assert.ok(!('pnl' in transferred));assert.ok(!JSON.stringify(t).includes('Профи'));assert.ok(!walk(t,n=>n.type==='input'&&n.props.type==='range').length);
 const y=ui({storage:x.storage});const t2=y.render(()=>y.components.CalculatorsModule(props));assert.equal(field(t2,'Цена входа').props.value,'100');
});
test('Delayed quote responses cannot overwrite manual input or a changed instrument',async()=>{
 let resolve;const x=ui({protocol:'https:',fetch:()=>new Promise(r=>resolve=r)}),render=()=>x.render(()=>x.components.CalculatorsModule({symbols:[]}));let t=render();const request=button(t,'↻ Подставить цену BingX').props.onClick();t=render();field(t,'Цена входа').props.onChange('321');resolve({ok:true,json:async()=>({data:{price:'100'}})});await request;t=render();assert.equal(field(t,'Цена входа').props.value,'321');
});
test('Screener watchlist persists; stale or demo quotes never transfer as current prices',()=>{
 const x=ui(),calls=[],props={tickers:ticks,status:'mock',onCalculate:v=>calls.push(v)};let t=x.render(()=>x.components.ScreenerModule(props));walk(t,n=>n.props.className==='tt-star'&&n.props['aria-label'].endsWith('BTC-USDT'))[0].props.onClick();t=x.render(()=>x.components.ScreenerModule(props));assert.equal(walk(t,n=>n.props.className==='tt-star'&&n.props['aria-label'].endsWith('BTC-USDT'))[0].props['aria-pressed'],true);
 walk(t,n=>n.props.className==='tt-market-symbol')[0].props.onClick();t=x.render(()=>x.components.ScreenerModule(props));button(t,'Рассчитать сделку →').props.onClick();assert.equal(calls[0].price,null);assert.ok([...x.storage.values()].some(v=>v.includes('BTC-USDT')));
});
test('Journal preview never fetches or saves; incoming plans require application and have no exit',()=>{
 let calls=0;const x=ui({list:async()=>calls++,add:async()=>calls++});const props={request:{id:1,symbol:'ETH-USDT',side:'short',entry:'10',size:'2'}};let t=x.render(()=>x.components.JournalModule(props));button(t,'Заполнить черновик').props.onClick();t=x.render(()=>x.components.JournalModule(props));assert.equal(field(t,'Цена входа').props.value,'10');assert.equal(field(t,'Цена выхода').props.value,'');assert.equal(button(t,'Сохранить сделку').props.disabled,true);assert.equal(calls,0);
});
test('Journal save has a single-flight lock, preserves failed drafts and clears only on success',async()=>{
 let calls=0,resolve;const x=ui({protocol:'https:',add:()=>{calls++;return new Promise(r=>resolve=r);}}),render=()=>x.render(()=>x.components.JournalModule({}));let t=render();await tick();t=render();for(const [label,value] of [['Цена входа','100'],['Цена выхода','101'],['Количество монет','2']]){field(t,label).props.onChange(value);t=render();}
 const submit=walk(t,n=>n.type==='form')[0].props.onSubmit,p1=submit({preventDefault(){}}),p2=submit({preventDefault(){}});assert.equal(calls,1);resolve({ok:false});await Promise.all([p1,p2]);t=render();assert.equal(field(t,'Цена входа').props.value,'100');assert.ok(walk(t,n=>n.props.role==='alert').length);
 const p3=walk(t,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});resolve({ok:true,trade:{...trades[0],id:9}});await p3;t=render();assert.equal(field(t,'Цена входа').props.value,'');assert.deepEqual(x.events,['member-progress-changed']);
});
test('Delete is explicit, failed deletion retains the row, and errors are visible',async()=>{
 let calls=0;const x=ui({protocol:'https:',list:async()=>({ok:true,trades:[trades[0]]}),remove:async()=>{calls++;return{ok:false};}}),render=()=>x.render(()=>x.components.JournalModule({}));let t=render();await tick();t=render();button(t,'Удалить…').props.onClick();assert.equal(calls,0);t=render();await button(t,'Удалить запись').props.onClick();t=render();assert.equal(calls,1);assert.ok(walk(t,n=>n.props.className==='tt-trade').length);assert.ok(walk(t,n=>n.props.role==='alert').length);
});
test('UI modules and integration parse; failures no longer replace real market quotes with samples',()=>{
 for(const file of ['trading-model.js','trading-tools.js'])new vm.Script(fs.readFileSync(path.join(root,'public',file),'utf8'));
 const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');for(const [,s]of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(s.trim())new vm.Script(s);
 assert.ok(!html.includes('const MODES'));assert.ok(!html.includes('setTickers(MOCK_TICKERS)'));assert.ok(html.includes('onCalculate: openCalculator'));assert.ok(html.includes('onJournal: openJournal'));assert.ok(html.includes('document.removeEventListener("visibilitychange", refresh)'));
});
