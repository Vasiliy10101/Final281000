'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=process.env.MEMBER_APP_DIR || path.resolve(__dirname,'..');
const {createChannelAccess}=require(path.join(root,'channel-access.js'));
const token='test-token-not-real',now=Date.now();
function signed(id=42,extra={}){const params=new URLSearchParams({auth_date:String(Math.floor(now/1000)),user:JSON.stringify({id,first_name:'Member',username:'member'}),...extra});const secret=crypto.createHmac('sha256','WebAppData').update(token).digest();params.set('hash',crypto.createHmac('sha256',secret).update([...params].map(([k,v])=>k+'='+v).sort().join('\n')).digest('hex'));return params.toString();}
function response(){return {statusCode:200,headers:{},body:null,set(k,v){this.headers[k]=v;return this;},status(n){this.statusCode=n;return this;},json(x){this.body=x;return this;},sendStatus(n){this.statusCode=n;return this;}};}
function request(p,init=signed()){return{path:p,body:{initData:init},query:{},get(name){return name==='x-telegram-init-data'?init:undefined;}};}

test('Signed identity is required; altered, old, missing-date and future initData fail',()=>{
 const access=createChannelAccess({botToken:token,channelId:'@channel_test',clock:()=>now});
 assert.equal(access.verify(signed()).id,42);
 for(const invalid of ['',signed().replace('Member','Intruder'),signed(42,{auth_date:'1'}),signed(42,{auth_date:''}),signed(42,{auth_date:String(now/1000+3600)}),signed(0),signed()+'&auth_date=1'])assert.equal(access.verify(invalid),null);
});

test('Only channel members pass; no admin-account bypass and failed checks deny access',async()=>{
 for(const [status,isMember,allowed] of [['creator',false,true],['administrator',false,true],['member',false,true],['restricted',true,true],['restricted',false,false],['left',false,false],['kicked',false,false],['unexpected',false,false]]){
  const access=createChannelAccess({botToken:token,channelId:'@channel_test',fetchImpl:async(url,options)=>{assert.ok(url.endsWith('/getChatMember'));assert.deepEqual(JSON.parse(options.body),{chat_id:'@channel_test',user_id:42});return{ok:true,json:async()=>({ok:true,result:{user:{id:42},status,is_member:isMember}})};}});
  const result=await access.check(42);assert.equal(result.ok,allowed,status);
 }
 for(const fetchImpl of [async()=>{throw Error('offline');},async()=>({ok:false}),async()=>({ok:true,json:async()=>({ok:false,description:'not admin'})}),async()=>({ok:true,json:async()=>({ok:true,result:{user:{id:99},status:'member'}})})]){
  const access=createChannelAccess({botToken:token,channelId:'@channel_test',fetchImpl});assert.equal((await access.check(42)).reason,'membership_unavailable');
 }
 assert.equal((await createChannelAccess({botToken:token}).check(42)).reason,'channel_not_configured');
});

test('Completed permissions are not cached; simultaneous checks share a call and membership changes apply immediately',async()=>{
 let clock=now,calls=0,status='member';
 const access=createChannelAccess({botToken:token,channelId:'@channel_test',clock:()=>clock,fetchImpl:async()=>{calls++;return{ok:true,json:async()=>({ok:true,result:{user:{id:42},status}})};}});
 await Promise.all([access.check(42),access.check(42)]);assert.equal(calls,1);
 status='left';assert.equal((await access.check(42)).reason,'not_member');assert.equal(calls,2);
 status='member';assert.equal((await access.check(42)).ok,true);assert.equal(calls,3);
});

function serverHarness(status='member',adminIds=''){
 const routes=new Map(),middleware=[];let scans=0,botStarts=0,radarOptions;
 const app={use(...args){if(args[0]==='/api')middleware.push(args[1]);},post(p,handler){routes.set('POST '+p,handler);},put(p,handler){routes.set('PUT '+p,handler);},get(p,handler){routes.set('GET '+p,handler);},listen(){}};
 const express=()=>app;express.json=()=>()=>{};express.static=()=>()=>{};
 const feed={schema_version:1,run:{stage:'stopped'},events:[{id:'private-event'}]};
 const fetchImpl=async()=>({ok:true,json:async()=>({ok:true,result:{user:{id:42},status}})});
 const mocks={express,'./channel-access':{createChannelAccess:options=>createChannelAccess({...options,fetchImpl})},'./channel-config.json':{channel_id:'@channel_test',channel_url:''},'./radar':{createRadar(options){radarOptions=options;return{start(){scans++;},getRadar(){return{items:[]};}};}},'./profile':{createCommunityCounter:()=>({get:async()=>({members:null,updatedAt:null,stale:false})}),createProfileService:require(path.join(root,'profile.js')).createProfileService},'./news':{createNews:()=>({})},'./pump-dump-feed':{createPumpDumpFeed:()=>({get:()=>feed})},'./bot':{makeBot:()=>({secret:'test-secret',startPolling(){botStarts++;},fetchUsername:async()=>'',handleUpdate:async()=>{}})}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'server.js'),'utf8'),{require(name){return mocks[name] || require(name.startsWith('./')?path.join(root,name):name);},process:{env:{BOT_TOKEN:token,CHANNEL_ID:'@channel_test',ADMIN_IDS:adminIds}},console,URLSearchParams,Buffer,__dirname:root,fetch:async()=>{throw Error('Unexpected external fetch');}});
 return{radarOptions,scans,botStarts,async call(method,p,init=signed()){const req=request(p.replace(/^\/api/,''),init),res=response();const handler=routes.get(method+' '+p);assert.ok(handler,p);await middleware[0](req,res,()=>handler(req,res));return res;}};
}

test('Every data API rejects nonmembers and unsigned requests; bot endpoints still check their own secrets',async()=>{
 const endpoints=[['GET','/api/user-state'],['PUT','/api/user-state'],['GET','/api/pump-dump'],['GET','/api/radar'],['GET','/api/bingx'],['POST','/api/me'],['POST','/api/access'],['POST','/api/journal/list'],['POST','/api/journal/add'],['POST','/api/journal/delete'],['POST','/api/spin'],['POST','/api/quest'],['POST','/api/profile'],['POST','/api/profile/reflection'],['POST','/api/profile/award']];
 const server=serverHarness('left');
 for(const [method,p]of endpoints){const denied=await server.call(method,p);assert.equal(denied.statusCode,403,p);assert.equal(denied.body.reason,'not_member');const unsigned=await server.call(method,p,'');assert.equal(unsigned.statusCode,401,p);}
 assert.equal((await server.call('POST','/api/tg/webhook','')).statusCode,401);
 assert.equal((await server.call('GET','/api/tg/setup','')).statusCode,401);
 assert.equal(server.scans,0);assert.equal(server.botStarts,0);assert.deepEqual(Object.keys(server.radarOptions),['news']);
});

test('A regular channel member can retrieve signals and profile with no VIP flag',async()=>{
 const server=serverHarness('member');const feed=await server.call('GET','/api/pump-dump');assert.equal(feed.statusCode,200);assert.equal(feed.body.events[0].id,'private-event');
 const me=await server.call('POST','/api/me');assert.equal(me.body.ok,true);assert.equal(me.body.user.name,'Member');assert.equal('isVip' in me.body.user,false);
});

test('VIP bot commands do nothing; stats and requested bot replies remain without broadcast capability',async()=>{
 const queries=[],messages=[];const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'bot.js'),'utf8'),{module,require(name){return name==='./referral'?{parseRef:()=>null}:require(name);},process:{env:{}},console,setTimeout,clearTimeout,AbortController,fetch:async(url,options)=>{messages.push({url,body:JSON.parse(options.body)});return{json:async()=>({ok:true})};}});
 const pool={async query(sql){queries.push(sql);return{rows:[{total:3,inserted:false}],rowCount:1};}};
 const bot=module.exports.makeBot({pool,botToken:token,adminIds:[42],publicUrl:'https://example.test'});
 assert.equal(bot.send,undefined);assert.equal(messages.length,0);
 for(const text of ['/vip 99','/unvip @member'])await bot.handleUpdate({message:{text,from:{id:42},chat:{id:42}}});
 assert.equal(queries.length,0);assert.equal(messages.length,0);
 await bot.handleUpdate({message:{text:'/stats',from:{id:42},chat:{id:42}}});
 assert.equal(queries.length,1);assert.ok(!/vip/i.test(queries[0]));assert.match(messages[0].body.text,/3/);
 await bot.handleUpdate({message:{text:'/myid',from:{id:77},chat:{id:77}}});assert.match(messages[1].body.text,/77/);
});

test('Journal ownership is preserved for list and delete',async()=>{
 const journal=require(path.join(root,'journal.js'));let queries=[];
 const pool={async query(sql,args){queries.push({sql,args});return{rows:[],rowCount:0};}},ensure=async()=>{};
 await journal.listTrades(pool,ensure,{id:42});assert.ok(queries[0].sql.includes('WHERE user_id = $1'));assert.deepEqual(queries[0].args,[42]);
 const removed=await journal.deleteTrade(pool,ensure,{id:42},123);assert.ok(queries[1].sql.includes('AND user_id = $2'));assert.deepEqual(queries[1].args,[123,42]);assert.equal(removed.ok,false);
});

test('Public snapshot contains no signals, UI has no VIP gates, and every changed script parses',()=>{
 for(const file of ['server.js','profile.js','journal.js','public/profile-model.js','public/community-profile.js','bot.js','radar.js','referral.js','channel-access.js','public/member-access.js','public/pump-dump.js','public/pump-dump-data.js'])new vm.Script(fs.readFileSync(path.join(root,file),'utf8'));
 const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 for(const [,s]of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(s.trim())new vm.Script(s);
 assert.ok(!/vip|LockedRadar|openDM|const role =/i.test(html));assert.ok(html.includes('React.createElement(JournalModule, { onBack:'));assert.ok(html.includes('React.createElement(MemberGate, { App })'));
 const w={};vm.runInNewContext(fs.readFileSync(path.join(root,'public/pump-dump-data.js'),'utf8'),{window:w});assert.equal(w.PUMP_DUMP_DATA,null);assert.ok(!html.includes('src="./pump-dump-data.js'));
 for(const f of ['server.js','bot.js','radar.js','referral.js'])assert.ok(!/onAlert|dispatchAlert|is_vip|pending_vip|grantVip|creditVip|RADAR_ALERT_STARS/.test(fs.readFileSync(path.join(root,f),'utf8')),f);
});
function walk(node,predicate,out=[]){if(node&&typeof node==='object'){if(predicate(node))out.push(node);for(const child of node.children||[])walk(child,predicate,out);}return out;}
function element(type,props,...children){return{type,props:props||{},children:children.flat(Infinity).filter(x=>x!==null&&x!==false&&x!==undefined)};}
function browserAccess(fetchImpl,withIdentity=true,options={}){
 const listeners=new Map();
 const w={location:{href:'https://app.example.test/',origin:'https://app.example.test',protocol:'https:'},fetch:fetchImpl,Telegram:{WebApp:{initData:withIdentity?'signed-client-data':''}},document:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},addEventListener(name,fn){listeners.set(name,fn);},removeEventListener(name){listeners.delete(name);},dispatchEvent(event){listeners.get(event.type)?.(event);}};
 if(options.location)w.location=options.location;
 if(options.document)w.document=options.document;
 const context={window:w,URL,Headers,AbortController,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){}};
 vm.runInNewContext(['public/user-state-model.js','public/user-memory.js','public/member-access.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n'),context);return w;
}
function gateHarness(w){let cursor=0,mounted=false;const states=[],effects=[];const React={createElement:element,useState(initial){const i=cursor++;if(!(i in states))states[i]=initial;return[states[i],v=>states[i]=typeof v==='function'?v(states[i]):v];},useEffect(effect){if(!mounted)effects.push(effect);},useRef(initial){const i=cursor++;if(!(i in states))states[i]={current:initial};return states[i];}};const Gate=w.createMemberGate(React),App=()=>{};return{App,effects,render(){cursor=0;const tree=Gate({App});mounted=true;return tree;}};}

test('Browser adds identity only to its own API; third-party market requests never receive it',async()=>{
 const calls=[];const w=browserAccess(async(url,options)=>{calls.push({url,options});return new Response('{}',{status:200});});
 await w.appFetch('/api/pump-dump');await w.appFetch('https://open-api.bingx.com/openApi/swap/v2/quote/price');
 assert.equal(calls[0].options.headers.get('x-telegram-init-data'),'signed-client-data');assert.equal(calls[1].options.headers.has('x-telegram-init-data'),false);
});

test('Membership screen opens only after confirmation, closes on denied API, and supports joining then retrying',async()=>{
 let allowed=true;const w=browserAccess(async()=>new Response(JSON.stringify(allowed?{ok:true,userId:42}:{ok:false,reason:'not_member',channelUrl:'https://t.me/channel_test'}),{status:allowed?200:403}));
 const gate=gateHarness(w);assert.notEqual(gate.render().type,gate.App);const cleanup=gate.effects[0]();await new Promise(setImmediate);
 assert.equal(walk(gate.render(),n=>n.props.App===gate.App).length,1);
 allowed=false;await w.appFetch('/api/pump-dump');const denied=gate.render();assert.notEqual(denied.type,gate.App);assert.equal(walk(denied,n=>n.props.className==='member-primary').length,1);
 allowed=true;walk(denied,n=>n.props.className==='member-retry')[0].props.onClick();await new Promise(setImmediate);assert.equal(walk(gate.render(),n=>n.props.App===gate.App).length,1);cleanup();
});

test('Unsigned browser never mounts the application or requests private data',async()=>{
 let calls=0;const w=browserAccess(async()=>{calls++;throw Error('Must not fetch');},false),gate=gateHarness(w);
 gate.render();const cleanup=gate.effects[0]();await new Promise(setImmediate);const tree=gate.render();assert.notEqual(tree.type,gate.App);assert.equal(calls,0);assert.ok(walk(tree,n=>n.type==='h1').some(n=>n.children.includes('Откройте в Telegram')));cleanup();
});

test('Ordinary member UI renders radar and journal analytics without upsells or missing definitions',()=>{
 const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 let main=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('function __start()'));
 main=main.replace('const root = ReactDOM.createRoot','window.testComponents = { App, HomeScreen, JournalModule, MemberProfileScreen };\nconst root = ReactDOM.createRoot');
 const React={createElement:element,Fragment:'fragment',useState(initial){return[typeof initial==='function'?initial():initial,()=>{}];},useEffect(){},useMemo(fn){return fn();},useCallback(fn){return fn;},useRef(initial){return{current:initial};}};
 const w={location:{href:'https://app.example.test/',origin:'https://app.example.test',protocol:'https:',hostname:'app.example.test',hash:'#radar'},appFetch:()=>{throw Error('Unexpected request');},createMemberGate:()=>()=>{},PUMP_DUMP_DATA:null};
 const context={window:w,React,ReactDOM:{createRoot:()=>({render(){}})},document:{getElementById:()=>({})},console,Date,Map,Set,setTimeout,clearTimeout};
 vm.runInNewContext(['public/user-state-model.js','public/user-memory.js','public/app-motion.js','public/profile-model.js','public/community-profile.js','public/pump-dump.js','public/trading-model.js','public/trading-tools.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n')+'\n'+main+'\n__start();',context);
 const tree=w.testComponents.App();assert.equal(walk(tree,n=>n.type?.name==='RadarModule').length,1);assert.equal(walk(tree,n=>n.type?.name==='JournalModule').length,1);
 const journal=w.testComponents.JournalModule({});assert.ok(walk(journal,n=>n.props.title==='Аналитика дневника').length===1);
 const profile=w.testComponents.MemberProfileScreen({resource:{data:null,loading:false,error:'',refresh(){}},name:'Member',onBack(){},onNavigate(){}});assert.ok(!JSON.stringify(profile).includes('VIP'));assert.equal(profile.props['aria-label'],'Профиль участника');
});
test('Configured private channel ID and invite are valid; malformed channel IDs keep access closed',async()=>{
 const config=JSON.parse(fs.readFileSync(path.join(root,'channel-config.json'),'utf8'));
 assert.equal(config.channel_id,'-1004301984596');assert.equal(config.channel_url,'https://t.me/+7FVHqvlTO3w2Njdi');
 const access=createChannelAccess({botToken:token,channelId:config.channel_id,channelUrl:config.channel_url,fetchImpl:async(_url,options)=>{assert.equal(JSON.parse(options.body).chat_id,config.channel_id);return{ok:true,json:async()=>({ok:true,result:{user:{id:42},status:'member'}})};}});
 assert.equal((await access.check(42)).ok,true);assert.equal(access.joinUrl,config.channel_url);
 assert.equal((await createChannelAccess({botToken:token,channelId:'-1001'}).check(42)).reason,'channel_not_configured');
});


test('Local file preview opens without Telegram and uses only the private saved snapshot',()=>{
 let calls=0,script,removed=false;
 const location={href:'file:///C:/Users/Admin/Desktop/Final2306/public/index.html',origin:'null',protocol:'file:'};
 const document={createElement(type){assert.equal(type,'script');return{remove(){removed=true;}};},head:{appendChild(node){script=node;}}};
 const w=browserAccess(async()=>{calls++;throw Error('No membership request expected');},false,{location,document});
 const gate=gateHarness(w);assert.notEqual(gate.render().type,gate.App);const cleanup=gate.effects[0]();
 assert.equal(script.src,'file:///C:/Users/Admin/Desktop/Final2306/local-preview/pump-dump-data.js');
 w.PUMP_DUMP_DATA={schema_version:1,run:{stage:'stopped'},events:[{id:'saved-preview-signal'}]};script.onload();
 const tree=gate.render();assert.equal(walk(tree,n=>n.props.App===gate.App).length,1);assert.ok(walk(tree,n=>n.props.className==='member-preview-note').some(n=>n.children.includes('Локальный просмотр · сохранённые сигналы')));
 assert.equal(w.PUMP_DUMP_DATA.events.length,1);assert.equal(w.PUMP_DUMP_DATA.run.stage,'stopped');assert.equal(calls,0);cleanup();assert.equal(removed,true);
});

test('Missing optional preview archive never blocks local interface',()=>{
 let script;
 const w=browserAccess(async()=>{throw Error('No network expected');},false,{location:{href:'file:///C:/project/public/index.html',origin:'null',protocol:'file:'},document:{createElement(){return{remove(){}};},head:{appendChild(node){script=node;}}}});
 const gate=gateHarness(w);gate.render();const cleanup=gate.effects[0]();script.onerror();
 const tree=gate.render();assert.equal(walk(tree,n=>n.props.App===gate.App).length,1);assert.equal(w.PUMP_DUMP_DATA,undefined);cleanup();
});

test('Preview parameters and localhost do not bypass membership on HTTP or HTTPS',async()=>{
 for(const href of ['https://app.example.test/?preview=true#local','http://127.0.0.1:3000/?preview=1','http://localhost:3000/']){
  const parsed=new URL(href);let calls=0;
  const w=browserAccess(async()=>{calls++;throw Error('Unsigned page must not request API');},false,{location:{href,origin:parsed.origin,protocol:parsed.protocol}});
  const gate=gateHarness(w);gate.render();const cleanup=gate.effects[0]();await new Promise(setImmediate);
  const tree=gate.render();assert.equal(walk(tree,n=>n.props.App===gate.App).length,0,href);assert.equal(calls,0);cleanup();
 }
});


test('Profile APIs retain membership protection and only configured admins can grant awards',async()=>{
 const member=serverHarness('member');const own=await member.call('POST','/api/profile');assert.equal(own.body.status,'no_db');assert.equal(own.body.progress,null);assert.equal(own.body.community.members,null);assert.equal(own.body.isAdmin,false);
 const denied=await member.call('POST','/api/profile/award');assert.equal(denied.statusCode,403);assert.equal(denied.body.reason,'admin_required');
 const admin=serverHarness('member','42');assert.equal((await admin.call('POST','/api/profile')).body.isAdmin,true);assert.equal((await admin.call('POST','/api/profile/award')).body.reason,'no_db');
 const left=serverHarness('left','42');assert.equal((await left.call('POST','/api/profile/award')).body.reason,'not_member');
});


test('Joining the community grants access without an existing account or manual allowlist; leaving denies the next API request',async()=>{
 let status='left',calls=0,next=0;
 const access=createChannelAccess({botToken:token,channelId:'@channel_test',fetchImpl:async()=>{calls++;return{ok:true,json:async()=>({ok:true,result:{user:{id:42},status}})};}});
 const run=async()=>{const res=response();await access.requireMember(request('/journal/list'),res,()=>{next++;res.json({ok:true});});return res;};
 assert.equal((await run()).statusCode,403);assert.equal(next,0);
 status='member';assert.equal((await run()).statusCode,200);assert.equal(next,1);
 status='left';assert.equal((await run()).statusCode,403);assert.equal(next,1);
 status='member';assert.equal((await run()).statusCode,200);assert.equal(next,2);assert.equal(calls,4);
});

test('Telegram failures after a successful membership check never reuse permission for a new API request',async()=>{
 let online=true,next=0;const access=createChannelAccess({botToken:token,channelId:'@channel_test',fetchImpl:async()=>{if(!online)throw Error('offline');return{ok:true,json:async()=>({ok:true,result:{user:{id:42},status:'member'}})};}});
 const first=response();await access.requireMember(request('/access'),first,()=>next++);assert.equal(next,1);
 online=false;const second=response();await access.requireMember(request('/user-state'),second,()=>next++);assert.equal(second.statusCode,503);assert.equal(next,1);
});

test('Returning from the channel automatically rechecks subscription and cleans up the Telegram event',async()=>{
 let allowed=false,calls=0,activated,removed;
 const w=browserAccess(async()=>{calls++;return new Response(JSON.stringify(allowed?{ok:true,userId:42}:{ok:false,reason:'not_member',channelUrl:'https://t.me/channel_test'}),{status:allowed?200:403});});
 w.Telegram.WebApp.onEvent=(name,fn)=>{assert.equal(name,'activated');activated=fn;};w.Telegram.WebApp.offEvent=(name,fn)=>{removed=fn;};
 const gate=gateHarness(w);gate.render();const cleanup=gate.effects[0]();await new Promise(setImmediate);assert.equal(walk(gate.render(),n=>n.props.App===gate.App).length,0);
 allowed=true;activated();await new Promise(setImmediate);assert.equal(walk(gate.render(),n=>n.props.App===gate.App).length,1);assert.equal(calls,2);cleanup();assert.equal(removed,activated);
});
