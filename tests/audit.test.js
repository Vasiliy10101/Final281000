'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.MEMBER_APP_DIR||path.resolve(__dirname,'..');
const {createMarketProxy}=require(path.join(root,'market-proxy'));
test('Quote proxy only exposes exact endpoints; concurrent requests share cached results',async()=>{
 let clock=1000,calls=0,release;const m=createMarketProxy({clock:()=>clock,fetchImpl:async()=>{calls++;await new Promise(r=>release=r);return{ok:true,json:async()=>({code:0,data:{price:'100'}})};}});
 const p='/openApi/swap/v2/quote/price';assert.equal((await m.get(p+'/../../trade/order')).status,400);assert.equal((await m.get(p,'BTC-USDT&x=1')).status,400);assert.equal(calls,0);
 const a=m.get(p,'BTC-USDT'),b=m.get(p,'BTC-USDT');assert.equal(calls,1);release();assert.equal((await a).status,200);await b;await m.get(p,'BTC-USDT');assert.equal(calls,1);clock+=2001;const c=m.get(p,'BTC-USDT');assert.equal(calls,2);release();await c;
});
test('Upstream errors and timeouts remain errors instead of successful quote responses',async()=>{
 for(const fetchImpl of [async()=>({ok:false,json:async()=>({code:0,data:{price:'100'}})}),async()=>({ok:true,json:async()=>({code:100500,msg:'error'})}),async()=>{throw Error('offline');}])assert.equal((await createMarketProxy({fetchImpl}).get()).status,502);
 const slow=createMarketProxy({timeoutMs:5,fetchImpl:(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted'))))});assert.equal((await slow.get()).status,504);
});
test('Journal rejects invalid server-side input and noninteger deletion IDs without SQL writes',async()=>{
 const j=require(path.join(root,'journal'));let writes=0;const pool={query:async()=>{writes++;throw Error('should not write');}},ensure=async()=>{},base={symbol:'BTC-USDT',side:'long',entry:100,exit:101,size:1};
 for(const input of [{...base,entry:true},{...base,exit:Infinity},{...base,size:1e308,exit:1e308},{...base,symbol:'BTC-USDT<script>'},{...base,clientId:'short'}])assert.equal((await j.addTrade(pool,ensure,{id:1},input)).ok,false);
 for(const id of [0,-1,1.5,Infinity,'nope',true,[],[1],{}])assert.equal((await j.deleteTrade(pool,ensure,{id:1},id)).reason,'bad_id');assert.equal(writes,0);
 assert.ok(Number.isFinite(j.pnlOf({side:'long',entry:1,exit:1e100,size:1e100})));
});
test('Profile does not silently attribute an old weekly draft to a new week',async()=>{
 let writes=0;const p=require(path.join(root,'profile')).createProfileService({pool:{query:async()=>writes++},ensureUser:async()=>{},clock:()=>Date.parse('2026-10-28T12:00:00Z')});const r=await p.saveReflection({id:1},{kind:'weekly',week:'2026-10-19',body:'Достаточно длинный осмысленный разбор недели. '.repeat(2)});assert.equal(r.reason,'week_changed');assert.equal(writes,0);
});
test('Corrupt feed entries and invalid timestamps cannot break signal rendering or claim live status',()=>{
 const w={};vm.runInNewContext(fs.readFileSync(path.join(root,'public/pump-dump.js'),'utf8'),{window:w});const snapshot=JSON.parse(fs.readFileSync(path.join(root,'data/pump-dump-feed.json'),'utf8'));assert.equal(w.PumpDumpHelpers.ordered(snapshot.events).length,116);
 const invalid=[null,{}, {id:'bad',first:{}},{...snapshot.events[0],id:'bad-date',first:{...snapshot.events[0].first,detection_ms:1e99}}];assert.equal(w.PumpDumpHelpers.ordered([...invalid,...snapshot.events]).length,116);assert.equal(w.PumpDumpHelpers.ordered({}).length,0);
 assert.equal(w.PumpDumpHelpers.feedState({run:{stage:'unavailable'},updated_at_ms:Date.now()},false).live,false);assert.equal(w.PumpDumpHelpers.feedState({run:{stage:'running'},updated_at_ms:Date.now()+60000},false).live,false);
});
test('Startup waits for migrations and database failure never opens a listener or starts services',async()=>{
 let listening=0,scans=0;const app={use(){},post(){},put(){},get(){},listen(){listening++;}},express=()=>app;express.json=()=>()=>{};express.static=()=>()=>{};
 const mocks={express,pg:{Pool:function(){return{on(){},query:async()=>{throw Error('database unavailable');}};}},'./channel-access':{createChannelAccess:()=>({requireMember(){}})},'./bot':{makeBot:()=>({fetchUsername:async()=>'',startPolling:async()=>scans++})},'./radar':{createRadar:()=>({start:()=>scans++})},'./news':{createNews:()=>({})},'./pump-dump-feed':{createPumpDumpFeed:()=>({})},'./profile':{createCommunityCounter:()=>({}),createProfileService:()=>({})}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'server.js'),'utf8'),{module,require:n=>mocks[n]||require(n.startsWith('./')?path.join(root,n):n),__dirname:root,process:{env:{DATABASE_URL:'test'}},console,fetch:async()=>{throw Error('No requests expected');}});
 await assert.rejects(module.exports.start(),/database unavailable/);assert.equal(listening,0);assert.equal(scans,0);
});
test('Bot start offers a Web App button only in private chats with configured HTTPS URL',async()=>{
 const out=[],module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'bot.js'),'utf8'),{module,require:n=>n==='./referral'?{parseRef:()=>null}:require(n),process:{env:{}},console,AbortController,setTimeout,clearTimeout,fetch:async(_u,o)=>{out.push(JSON.parse(o.body));return{json:async()=>({ok:true})};}});
 const bot=module.exports.makeBot({pool:null,botToken:'fake',adminIds:[],publicUrl:'https://app.example'});await bot.handleUpdate({message:{text:'/start',from:{id:1},chat:{id:1,type:'private'}}});assert.equal(out[0].reply_markup.inline_keyboard[0][0].web_app.url,'https://app.example');await bot.handleUpdate({message:{text:'/start',from:{id:1},chat:{id:-1,type:'group'}}});assert.equal(out[1].reply_markup,undefined);
 const empty=()=>module.exports.makeBot({pool:null,botToken:'',adminIds:[],publicUrl:''});assert.notEqual(empty().secret,empty().secret);assert.notEqual(empty().secret,'nosecret');
});
