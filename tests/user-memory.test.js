'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=process.env.MEMBER_APP_DIR||path.resolve(__dirname,'..'),M=require(path.join(root,'public/user-state-model'));
function storage(){const data=new Map();return{data,getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};}
function cloud(){const rows=new Map();let writes=0;return{rows,get writes(){return writes;},fetch(user){return async(_url,options={})=>{const key=String(user),map=rows.get(key)||{};rows.set(key,map);if(options.method!=='PUT')return{ok:true,json:async()=>({ok:true,userId:user,records:Object.values(map)})};const p=JSON.parse(options.body),old=map[p.key];if((old?.revision||0)!==p.baseRevision)return{ok:false,json:async()=>({ok:false,reason:'state_conflict',userId:user,record:old})};writes++;map[p.key]={key:p.key,value:p.value,revision:(old?.revision||0)+1,updatedAt:'2026-10-28T00:00:00Z'};return{ok:true,json:async()=>({ok:true,userId:user,record:map[p.key]})};};}};}
function client(t,userId,fetchImpl,local=storage(),preview=false){const events=new Map(),w={localStorage:local,document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},addEventListener:(k,v)=>events.set(k,v),removeEventListener:k=>events.delete(k)};vm.runInNewContext(['user-state-model.js','user-memory.js'].map(f=>fs.readFileSync(path.join(root,'public',f),'utf8')).join('\n'),{window:w,console,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});const memory=w.createUserMemory({userId,fetchImpl,storage:local,preview,debounce:100000});t.after(()=>memory.stop());return{memory,local,events};}
const plain=v=>JSON.parse(JSON.stringify(v));
test('State schema accepts only the agreed personal fields, bounded text and contract lists',()=>{
 assert.equal(M.valid('favorites',['BTC-USDT']),true);for(const [k,v]of [['userId',42],['isAdmin',true],['favorites',['<script>']],['favorites',Array(501).fill('BTC-USDT')],['profile-drafts',{'weekly:2026-10-26':{body:'x'.repeat(2001)}}],['calculator',{balance:3}]])assert.equal(M.valid(k,v),false);
 assert.equal(M.same({a:1,b:2},{b:2,a:1}),true);
});
test('Two devices restore all agreed personal settings from the same verified account',async t=>{
 const c=cloud(),a=client(t,42,c.fetch(42)).memory,b=client(t,42,c.fetch(42)).memory;
 const values={favorites:['BTC-USDT','SOL-USDT'],'screen-filters':{query:'SOL',filter:'favorites',sort:'volume',minVolume:'0'},'journal-filters':{query:'BTC',filter:'all',period:'30'},'profile-drafts':{'weekly:2026-10-26':{body:'Мой личный черновик'}},'pump-direction':'dump','calculator-exits':[{price:'103',share:'50'},{price:'105',share:'50'},{price:'',share:''}]};
 for(const key of ['calculator','journal-draft'])values[key]=Object.fromEntries(M.fields[key].map(k=>[k,k==='symbol'?'BTC-USDT':k==='side'?'long':k==='clientId'?'draft_memory_test_12345':'']));
 for(const [k,v]of Object.entries(values))a.set(k,v);await a.sync();await b.sync();for(const [k,v]of Object.entries(values))assert.deepEqual(plain(b.read(k)),v);assert.equal(a.snapshot().pending,0);assert.equal(c.writes,8);
});
test('A shared device and local preview do not mix identities or import another user draft',async t=>{
 const c=cloud(),local=storage();local.setItem('trader-v2:preview:favorites',JSON.stringify(['BTC-USDT']));local.setItem('trader-v2:1:favorites',JSON.stringify(['ETH-USDT']));
 const a=client(t,1,c.fetch(1),local).memory;a.start();await a.sync();assert.deepEqual(plain(a.read('favorites')),['ETH-USDT']);
 const b=client(t,2,c.fetch(2),local).memory;b.start();await b.sync();assert.equal(b.read('favorites'),undefined);b.set('favorites',['SOL-USDT']);await b.sync();await a.sync();assert.deepEqual(plain(a.read('favorites')),['ETH-USDT']);
 const p=client(t,undefined,()=>{throw Error('Preview must not request API');},local,true).memory;p.start();assert.deepEqual(plain(p.read('favorites')),['BTC-USDT']);p.set('favorites',[]);await p.sync();assert.equal(c.writes,2);
});
test('Offline edits survive reload and upload only when a connection is restored',async t=>{
 const c=cloud(),local=storage();let online=false;const fetch=async(...args)=>{if(!online)throw Error('offline');return c.fetch(4)(...args);};
 const a=client(t,4,fetch,local).memory;a.set('favorites',['BTC-USDT']);await a.sync();assert.equal(a.snapshot().status,'offline');a.stop();
 const b=client(t,4,fetch,local).memory;assert.deepEqual(plain(b.read('favorites')),['BTC-USDT']);await b.sync();assert.equal(c.writes,0);online=true;await b.sync();assert.equal(b.snapshot().status,'synced');assert.equal(c.writes,1);
});
test('Concurrent device edits retain both versions; choosing local or remote is explicit',async t=>{
 const c=cloud(),a=client(t,5,c.fetch(5)).memory,b=client(t,5,c.fetch(5)).memory;
 a.set('favorites',['BTC-USDT']);await a.sync();await b.sync();a.set('favorites',['SOL-USDT']);b.set('favorites',['ETH-USDT']);await a.sync();await b.sync();assert.equal(b.snapshot().status,'conflict');assert.deepEqual(plain(b.read('favorites')),['ETH-USDT']);assert.deepEqual(plain(b.snapshot().conflicts[0].remote),['SOL-USDT']);assert.equal(c.writes,2);
 b.resolve('favorites','local');await b.sync();await a.sync();assert.deepEqual(plain(a.read('favorites')),['ETH-USDT']);
 a.set('favorites',['BTC-USDT']);b.set('favorites',[]);await b.sync();await a.sync();a.resolve('favorites','remote');await a.sync();assert.deepEqual(plain(a.read('favorites')),[]);assert.equal(a.snapshot().pending,0);
});
test('Lost acknowledgement retries safely without applying the same mutation twice',async t=>{
 const c=cloud();let lose=true;const fetch=async(...args)=>{const result=await c.fetch(6)(...args);if(args[1]?.method==='PUT'&&lose){lose=false;throw Error('connection lost');}return result;};
 const a=client(t,6,fetch).memory;a.set('favorites',['BTC-USDT']);await a.sync();assert.equal(a.snapshot().pending,1);await a.sync();assert.equal(a.snapshot().pending,0);assert.equal(c.writes,1);
});
test('Editing while a save is in flight keeps the newer local change pending',async t=>{
 const c=cloud();let unblock,entered;const ready=new Promise(r=>entered=r);const fetch=async(...args)=>{if(args[1]?.method==='PUT'&&!unblock){await new Promise(r=>{unblock=r;entered();});}return c.fetch(7)(...args);};
 const a=client(t,7,fetch).memory;a.set('favorites',['BTC-USDT']);const sending=a.sync();await ready;a.set('favorites',['SOL-USDT']);unblock();await sending;assert.deepEqual(plain(a.read('favorites')),['SOL-USDT']);assert.equal(a.snapshot().pending,1);await a.sync();assert.equal(a.snapshot().status,'synced');assert.equal(c.writes,2);
});
test('A response for a different identity never enters the current user cache',async t=>{
 const a=client(t,8,async()=>({ok:true,json:async()=>({ok:true,userId:9,records:[{key:'favorites',value:['BTC-USDT'],revision:1}]})})).memory;await a.sync();assert.equal(a.snapshot().status,'locked');assert.equal(a.read('favorites'),undefined);
});
test('Unavailable local storage is visible, while server saving can still succeed',async t=>{
 const c=cloud(),a=client(t,10,c.fetch(10),{getItem(){throw Error('blocked');},setItem(){throw Error('quota');}}).memory;a.set('favorites',['BTC-USDT']);assert.equal(a.snapshot().localError,true);await a.sync();assert.equal(c.writes,1);assert.equal(a.snapshot().localError,true);
});
test('New accounts never upload untouched defaults, and drafts never create closed trades',async t=>{
 const c=cloud(),urls=[],a=client(t,11,(url,o)=>{urls.push(url);return c.fetch(11)(url,o);}).memory;await a.sync();assert.equal(c.writes,0);a.read('favorites',[]);await a.sync();assert.equal(c.writes,0);a.set('profile-drafts',{'weekly:2026-10-26':{body:'Незавершённый текст'}});await a.sync();assert.ok(urls.every(u=>u==='/api/user-state'));
});

test('A lost save acknowledgement followed by a new edit does not conflict with its own write',async t=>{
 const c=cloud(),local=storage();let lose=true;const fetch=async(...args)=>{const r=await c.fetch(12)(...args);if(args[1]?.method==='PUT'){const p=JSON.parse(args[1].body);c.rows.get('12')[p.key].operationId=p.operationId;if(lose){lose=false;throw Error('lost acknowledgement');}}return r;};
 const a=client(t,12,fetch,local).memory;a.set('favorites',['BTC-USDT']);await a.sync();a.set('favorites',['SOL-USDT']);a.stop();
 const b=client(t,12,fetch,local).memory;await b.sync();assert.equal(b.snapshot().status,'synced');assert.deepEqual(plain(c.rows.get('12').favorites.value),['SOL-USDT']);assert.equal(c.writes,2);
});

test('Two offline tabs preserve independent fields when writing the same account cache',async t=>{
 const local=storage(),fetch=async()=>{throw Error('offline');};const a=client(t,13,fetch,local).memory,b=client(t,13,fetch,local).memory;
 a.set('favorites',['BTC-USDT']);b.set('pump-direction','dump');a.set('screen-filters',{query:'ETH',filter:'all',sort:'volume',minVolume:'0'});
 const restored=client(t,13,fetch,local).memory;assert.deepEqual(plain(restored.read('favorites')),['BTC-USDT']);assert.equal(restored.read('pump-direction'),'dump');assert.equal(restored.read('screen-filters').query,'ETH');
});

test('Two offline tabs changing the same field retain both versions until an explicit choice',async t=>{
 const local=storage(),c=cloud(),a=client(t,14,c.fetch(14),local).memory,b=client(t,14,c.fetch(14),local).memory;
 a.set('favorites',['BTC-USDT']);b.set('favorites',['SOL-USDT']);const restored=client(t,14,c.fetch(14),local).memory;
 assert.deepEqual(plain(restored.read('favorites')),['SOL-USDT']);assert.deepEqual(plain(restored.snapshot().conflicts[0]?.remote),['BTC-USDT']);await restored.sync();assert.equal(c.writes,0);
 restored.resolve('favorites','remote');await restored.sync();assert.deepEqual(plain(c.rows.get('14').favorites.value),['BTC-USDT']);assert.equal(restored.snapshot().status,'synced');
});

test('Repeated local edits in one offline tab never manufacture a second version',async t=>{
 const a=client(t,15,async()=>{throw Error('offline');}).memory;for(const symbol of ['BTC-USDT','ETH-USDT','SOL-USDT'])a.set('favorites',[symbol]);assert.equal(a.snapshot().conflicts.length,0);assert.deepEqual(plain(a.read('favorites')),['SOL-USDT']);
});
