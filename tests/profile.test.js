'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.MEMBER_APP_DIR||path.resolve(__dirname,'..');
const {progress,weekKey}=require(path.join(root,'public/profile-model'));
const {createCommunityCounter,createProfileService}=require(path.join(root,'profile'));
const journal=require(path.join(root,'journal'));

test('Ranks require distinct review days and weeks; profit, points and trade volume give no rank',()=>{
 assert.equal(progress({pnl:1e9,points:99999,tradeCount:500}).rank.id,'member');
 assert.equal(progress({reviewDays:4,reviewWeeks:100,summaryDone:true}).rank.id,'member');
 assert.equal(progress({reviewDays:5,reviewWeeks:3}).rank.id,'explorer');
 assert.equal(progress({reviewDays:5,reviewWeeks:4}).rank.id,'practitioner');
 assert.equal(progress({reviewDays:5,reviewWeeks:8}).rank.id,'practitioner');
 assert.equal(progress({reviewDays:5,reviewWeeks:8,summaryDone:true}).rank.id,'strategist');
 assert.equal(progress({reviewDays:999,reviewWeeks:999,summaryDone:true}).next.id,'mentor');
 assert.equal(progress({mentor:true}).rank.id,'mentor');
 assert.equal(progress({mentor:true}).next,null);
 assert.equal(progress({reviewDays:-5}).fraction,0);
 assert.equal(progress({reviewDays:5,reviewWeeks:999}).fraction,.5);
});

test('Week attribution uses Monday in Moscow, including Sunday UTC and year boundaries',()=>{
 assert.equal(weekKey(Date.parse('2026-10-25T20:59:59Z')),'2026-10-19');
 assert.equal(weekKey(Date.parse('2026-10-25T21:00:00Z')),'2026-10-26');
 assert.equal(weekKey(Date.parse('2027-01-01T10:00:00Z')),'2026-12-28');
});

test('A save that crosses midnight keeps the week validated at the start of the request',async()=>{
 let now=Date.parse('2026-10-25T20:59:59.999Z'),stored;
 const service=createProfileService({clock:()=>now,ensureUser:async()=>{now+=2;},pool:{query:async(sql,args)=>{stored=args;return{rows:[{body:args[2]}]};}}});
 const result=await service.saveReflection({id:42},{kind:'weekly',week:'2026-10-19',body:'a'.repeat(50),baseBody:''});assert.equal(result.ok,true);assert.equal(stored[1],'2026-10-19');
});

test('Community count requests are shared and cached; failures retain a marked stale value',async()=>{
 let clock=1000,calls=0,release,fail=false;
 const counter=createCommunityCounter({botToken:'test-token',channelId:'-1004301984596',clock:()=>clock,fetchImpl:async(url,options)=>{calls++;assert.ok(url.endsWith('/getChatMemberCount'));assert.equal(JSON.parse(options.body).chat_id,'-1004301984596');if(calls===1)await new Promise(resolve=>release=resolve);if(fail)throw Error('offline');return{ok:true,json:async()=>({ok:true,result:245})};}});
 const a=counter.get(),b=counter.get();assert.equal(calls,1);release();
 assert.deepEqual(await a,{members:245,updatedAt:1000,stale:false});assert.deepEqual(await b,await a);
 clock+=299999;assert.equal((await counter.get()).members,245);assert.equal(calls,1);
 clock++;fail=true;assert.deepEqual(await counter.get(),{members:245,updatedAt:1000,stale:true});assert.equal(calls,2);
 clock+=59000;await counter.get();assert.equal(calls,2);
 clock+=1000;fail=false;assert.equal((await counter.get()).stale,false);assert.equal(calls,3);
});

test('Missing configuration and invalid Telegram counts stay unknown, never zero or fabricated',async()=>{
 let calls=0;assert.equal((await createCommunityCounter({fetchImpl:async()=>calls++}).get()).members,null);assert.equal(calls,0);
 for(const result of ['42',-1,1.5,NaN,null]){const c=createCommunityCounter({botToken:'test',channelId:'@channel',fetchImpl:async()=>({ok:true,json:async()=>({ok:true,result})})});const r=await c.get();assert.equal(r.members,null);assert.equal(r.stale,true);}
 const zero=createCommunityCounter({botToken:'test',channelId:'@channel',fetchImpl:async()=>({ok:true,json:async()=>({ok:true,result:0})})});assert.equal((await zero.get()).members,0);
});

function profileFixture({weeks=4,summary='',awards=[],db=true}={}){
 const queries=[],ensured=[],clock=()=>Date.parse('2026-10-27T12:00:00Z');
 const pool={async query(sql,args){queries.push({sql,args});
  if(sql.includes('AS review_days'))return{rows:[{trade_count:10,pnl:-120,wins:3,review_days:5}]};
  if(sql.includes('count(*)::int AS total FROM member_reflections'))return{rows:[{total:weeks}]};
  if(sql.includes('SELECT kind'))return{rows:awards.map(kind=>({kind}))};
  if(sql.includes('last_seen_at'))return{rows:[{total:31}]};
  if(sql.includes('SELECT body FROM member_reflections'))return{rows:[{body:'Сохранённые итоги этой недели: '+'.'.repeat(40)}]};
  if(sql.includes('SELECT body FROM member_summaries'))return{rows:summary?[{body:summary}]:[]};
  if(sql.includes('SELECT id FROM users'))return{rows:args[0]===77?[{id:77}]:[]};
  if(sql.startsWith('INSERT INTO member_reflections')||sql.startsWith('INSERT INTO member_summaries')||sql.startsWith('UPDATE member_'))return{rows:[{body:args[args.length-2]}],rowCount:1};
  return{rows:[],rowCount:1};
 }};
 const service=createProfileService({pool:db?pool:null,ensureUser:async user=>{ensured.push(user.id);return{name:'Трейдер',since:'2026-10-01',referrals:2,refLink:'https://t.me/example_bot?start=ref42'};},counter:{get:async()=>({members:245,updatedAt:clock(),stale:false})},channelUrl:'https://t.me/+7FVHqvlTO3w2Njdi',adminIds:[99],clock});
 return{service,queries,ensured};
}

test('Profile computes private stats and rank from owned records; only active count is aggregate',async()=>{
 const f=profileFixture();const r=await f.service.get({id:42,first_name:'Участник',username:'member'});
 assert.equal(r.status,'ready');assert.equal(r.progress.rank.id,'practitioner');assert.equal(r.personal.pnl,-120);assert.equal(r.personal.winRate,30);
 assert.equal(r.community.members,245);assert.equal(r.community.active7Days,31);assert.equal(r.member.inviteLink,'https://t.me/example_bot?start=ref42');assert.equal(r.isAdmin,false);assert.deepEqual(f.ensured,[42]);
 for(const q of f.queries)if(!q.sql.includes('last_seen_at'))assert.equal(q.args[0],42);
 const reviews=f.queries.find(q=>q.sql.includes('AS review_days')).sql;
 assert.match(reviews,/count\(DISTINCT \(ts AT TIME ZONE 'Europe\/Moscow'\)::date\)/);assert.match(reviews,/thesis/);assert.match(reviews,/lesson/);assert.match(reviews,/ts<=now\(\)/);
 assert.ok(!('users' in r.community));
});

test('Without a database the profile reports unavailable personal data, not new-member statistics',async()=>{
 const f=profileFixture({db:false});const r=await f.service.get({id:42});assert.equal(r.status,'no_db');assert.equal(r.progress,null);assert.equal(r.personal,null);assert.equal(r.community.active7Days,null);assert.equal(r.community.members,245);assert.equal(f.queries.length,0);
 assert.equal((await f.service.saveReflection({id:42},{kind:'weekly',baseBody:'',body:'x'.repeat(60)})).reason,'no_db');
});

test('Weekly edits upsert one server-dated record, ignore forged owner and reject stale weeks',async()=>{
 const f=profileFixture();
 for(let i=0;i<2;i++)assert.equal((await f.service.saveReflection({id:42},{kind:'weekly',baseBody:'',body:'  '+('Осмысленные итоги недели. '.repeat(4))+'  ',userId:99,week:'2026-10-26'})).ok,true);
 const inserts=f.queries.filter(q=>q.sql.startsWith('INSERT'));assert.equal(inserts.length,2);
 for(const q of inserts){assert.match(q.sql,/ON CONFLICT \(user_id,week_start\) DO UPDATE/);assert.equal(q.args[0],42);assert.equal(q.args[1],'2026-10-26');assert.equal(q.args[2],q.args[2].trim());}
 assert.equal((await f.service.saveReflection({id:42},{kind:'weekly',baseBody:'',body:'    '})).reason,'reflection_length');
 assert.equal((await f.service.saveReflection({id:42},{kind:'weekly',baseBody:'',body:'a'.repeat(2001)})).reason,'reflection_length');
 assert.equal((await f.service.saveReflection({id:42},{kind:'mentor',body:'a'.repeat(50)})).reason,'bad_kind');
 assert.equal(f.queries.length,2);
});

test('Summary is locked before 8 weeks; awards require a real account and explicit allowed kind',async()=>{
 const early=profileFixture({weeks:7});assert.equal((await early.service.saveReflection({id:42},{kind:'summary',baseBody:'',body:'a'.repeat(50)})).reason,'summary_not_ready');assert.ok(!early.queries.some(q=>q.sql.startsWith('INSERT')));
 const f=profileFixture({weeks:8,summary:'a'.repeat(50)});assert.equal((await f.service.saveReflection({id:42},{kind:'summary',baseBody:'',body:'b'.repeat(50)})).ok,true);assert.equal((await f.service.get({id:42})).progress.rank.id,'strategist');
 assert.equal((await f.service.award({id:99},{userId:77,kind:'mentor',enabled:true})).ok,true);
 const grant=f.queries.find(q=>q.sql.startsWith('INSERT INTO member_awards'));assert.deepEqual(grant.args,[77,'mentor',99]);
 assert.equal((await f.service.award({id:99},{userId:77,kind:'mentor',enabled:false})).ok,true);
 assert.equal((await f.service.award({id:99},{userId:123,kind:'helper',enabled:true})).reason,'user_not_found');
 assert.equal((await f.service.award({id:99},{userId:77,kind:'admin',enabled:true})).reason,'invalid_award');
 assert.equal((await f.service.award({id:99},{userId:77,kind:'helper',enabled:'true'})).reason,'invalid_award');
});

test('Journal accepts optional analysis, returns it, and never accepts forged timestamps or owners',async()=>{
 const queries=[],pool={async query(sql,args){queries.push({sql,args});return{rows:[{id:1,symbol:args[1],side:args[2],entry:args[3],exit:args[4],size:args[5],thesis:args[8],lesson:args[9],ts:'2026-10-27'}]};}};
 const input={symbol:'btc-usdt',side:'long',entry:100,exit:90,size:1,user_id:77,ts:'2020-01-01',thesis:'  Причина входа в эту сделку.  ',lesson:'Соблюдать заранее определённый план.'};
 const result=await journal.addTrade(pool,async()=>{}, {id:42},input);assert.equal(result.ok,true);assert.equal(result.trade.thesis,input.thesis.trim());assert.equal(result.trade.pnl,-10);assert.equal(queries[0].args[0],42);assert.ok(!queries[0].args.includes(input.ts));assert.ok(!queries[0].sql.includes(' ts)'));
 const basic=await journal.addTrade(pool,async()=>{}, {id:42},{...input,thesis:undefined,lesson:undefined});assert.equal(basic.ok,true);assert.equal(basic.trade.thesis,'');
 assert.equal((await journal.addTrade(pool,async()=>{},{id:42},{...input,lesson:'a'.repeat(1001)})).reason,'review_too_long');assert.equal(queries.length,2);
});

function element(type,props,...children){return{type,props:props||{},children:children.flat(Infinity).filter(x=>x!==null&&x!==undefined&&x!==false)};}
function walk(node,pred,out=[]){if(node&&typeof node==='object'){if(pred(node))out.push(node);for(const c of node.children||[])walk(c,pred,out);}return out;}
function reactHarness(){const slots=[],pending=[],cleanups=[];let cursor=0;const React={Fragment:'fragment',createElement:element,useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],v=>slots[i]=typeof v==='function'?v(slots[i]):v];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useCallback(fn,deps){const i=cursor++;if(!slots[i]||deps.some((d,j)=>!Object.is(d,slots[i].deps[j])))slots[i]={fn,deps};return slots[i].fn;},useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((d,j)=>!Object.is(d,slots[i][j]))){slots[i]=deps;pending.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};return{React,render(fn){cursor=0;const r=fn();while(pending.length)pending.shift()();return r;},cleanup(){cleanups.forEach(f=>f?.());}};}
function browser(protocol='https:',fetchImpl=async()=>{throw Error('Unexpected API');}){
 const listeners={},intervals=new Map();let timer=0;
 const w={location:{protocol},document:{visibilityState:'visible',addEventListener(n,fn){listeners[n]=fn;},removeEventListener(n){delete listeners[n];}},addEventListener(n,fn){listeners[n]=fn;},removeEventListener(n){delete listeners[n];},appFetch:fetchImpl,navigator:{clipboard:{writeText:async()=>{}}}};
 const context={window:w,Date,Intl,AbortController,setTimeout,clearTimeout,setInterval(fn){intervals.set(++timer,fn);return timer;},clearInterval(id){intervals.delete(id);}};
 vm.runInNewContext(['public/app-motion.js','public/profile-model.js','public/community-profile.js'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n'),context);
 return{w,listeners,intervals};
}
const tick=()=>new Promise(setImmediate);

test('Local profile opens without Telegram requests, unknown totals and disabled saving',()=>{
 let calls=0;const b=browser('file:',async()=>calls++),hooks=reactHarness(),ui=b.w.createCommunityProfile(hooks.React);
 const resource=hooks.render(()=>ui.useProfile());assert.equal(resource.data.status,'preview');assert.equal(resource.data.community.members,null);assert.equal(resource.data.personal,null);assert.equal(calls,0);
 const screenHooks=reactHarness(),view=b.w.createCommunityProfile(screenHooks.React);let tree=screenHooks.render(()=>view.ProfileScreen({resource,name:'трейдер',onBack(){},onNavigate(){}}));
 assert.equal(walk(tree,n=>n.props.className==='mp-metric'&&n.children[0].children[0]==='—').length,5);
 walk(tree,n=>n.props.className==='mp-review-toggle')[0].props.onClick();tree=screenHooks.render(()=>view.ProfileScreen({resource,name:'трейдер',onBack(){},onNavigate(){}}));
 assert.equal(walk(tree,n=>n.type==='textarea')[0].props.disabled,false);assert.equal(walk(tree,n=>n.type==='button'&&n.props.type==='submit')[0].props.disabled,true);assert.equal(calls,0);hooks.cleanup();
});

test('Profile refresh retains valid data on error, responds to diary changes and cleans up polling',async()=>{
 let calls=0,fail=false;const payload=await profileFixture().service.get({id:42});
 const b=browser('https:',async()=>{calls++;if(fail)throw Error('offline');return{ok:true,json:async()=>payload};}),hooks=reactHarness(),ui=b.w.createCommunityProfile(hooks.React);
 let state=hooks.render(()=>ui.useProfile());assert.equal(state.data,null);await tick();state=hooks.render(()=>ui.useProfile());assert.equal(state.data.member.name,'Трейдер');assert.equal(calls,1);assert.equal(b.intervals.size,1);
 fail=true;await state.refresh();state=hooks.render(()=>ui.useProfile());assert.equal(state.data.personal.pnl,-120);assert.ok(state.error);
 fail=false;b.listeners['member-progress-changed']();await tick();state=hooks.render(()=>ui.useProfile());assert.equal(state.error,'');
 hooks.cleanup();assert.equal(b.intervals.size,0);assert.equal(b.listeners['member-progress-changed'],undefined);
});

test('Profile entry is an explicit button; back, diary CTA and reflection saving work',async()=>{
 const payload=await profileFixture({weeks:0}).service.get({id:42});payload.progress=progress({reviewDays:0});let opened=0,back=0,navigated='',saved,refreshed=0;
 const b=browser('https:',async(url,options)=>{assert.equal(url,'/api/profile/reflection');saved=JSON.parse(options.body);return{ok:true,json:async()=>({ok:true})};}),hooks=reactHarness(),ui=b.w.createCommunityProfile(hooks.React);
 const resource={data:payload,error:'',loading:false,refresh:async()=>{refreshed++;}};
 const entry=hooks.render(()=>ui.EntryCard({resource,name:'Трейдер',onOpen:()=>opened++}));assert.equal(entry.type,'button');assert.equal(entry.props['aria-label'],'Открыть мой профиль');entry.props.onClick();assert.equal(opened,1);
 const h2=reactHarness(),v=b.w.createCommunityProfile(h2.React),props={resource,name:'Трейдер',onBack:()=>back++,onNavigate:id=>navigated=id};
 let tree=h2.render(()=>v.ProfileScreen(props));walk(tree,n=>n.props.className==='mp-back')[0].props.onClick();assert.equal(back,1);walk(tree,n=>n.type==='button'&&n.children.includes('Сделать разбор сделки'))[0].props.onClick();assert.equal(navigated,'journal');
 walk(tree,n=>n.props.className==='mp-review-toggle')[0].props.onClick();tree=h2.render(()=>v.ProfileScreen(props));
 const draft='Проверил соблюдение плана и записал причины своих ошибок за эту неделю.';walk(tree,n=>n.type==='textarea')[0].props.onChange({target:{value:draft}});tree=h2.render(()=>v.ProfileScreen(props));
 await walk(tree,n=>n.type==='form')[0].props.onSubmit({preventDefault(){}});assert.deepEqual(saved,{kind:'weekly',baseBody:payload.reflection.body,body:draft,week:payload.reflection.week});assert.equal(refreshed,1);
 tree=h2.render(()=>v.ProfileScreen({...props,resource:{...resource,data:{...payload,reflection:{...payload.reflection,body:'Older saved text'}}}}));assert.equal(walk(tree,n=>n.type==='textarea')[0].props.value,draft);
});
