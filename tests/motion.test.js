'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=process.env.MEMBER_APP_DIR||path.resolve(__dirname,'..');
const tick=()=>new Promise(setImmediate);

function environment(initialReduced=false){
  let change;const preference={matches:initialReduced,addEventListener(name,fn){assert.equal(name,'change');change=fn;}};
  const w={matchMedia:()=>preference,getComputedStyle:node=>({opacity:node.opacity||'1',paddingTop:'10px',paddingBottom:'10px',borderTopWidth:'1px',borderBottomWidth:'1px'})};
  vm.runInNewContext(fs.readFileSync(path.join(root,'public/app-motion.js'),'utf8'),{window:w,Set,Map,parseFloat});
  return{motion:w.AppMotion,setReduced(value){preference.matches=value;change();}};
}
function box(height=180){
  let active=null;const animations=[],node={scrollHeight:height,opacity:'1',getBoundingClientRect(){return{height:active?active.currentHeight:height};},animate(frames,options){
    let resolve,reject;const animation={frames,options,currentHeight:parseFloat(frames[0].height),cancelled:false,finished:new Promise((yes,no)=>{resolve=yes;reject=no;}),finish(){resolve();},cancel(){this.cancelled=true;if(active===this)active=null;reject(Error('cancelled'));}};
    active=animation;animations.push(animation);return animation;
  }};return{node,animations};
}
function revealHarness(motion,node){
  const slots=[],effects=[],cleanups=[];let cursor=0,dirty=false,lastTree,lastOpen;
  const React={createElement(type,props,...children){return{type,props,children};},useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{if(slots[i]!==value){slots[i]=value;dirty=true;}}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useEffect(fn,deps){const i=cursor++;if(!slots[i]||deps.some((d,j)=>!Object.is(d,slots[i][j]))){slots[i]=deps;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
  const Reveal=motion.createReveal(React);
  const render=open=>{lastOpen=open;let attempts=0;do{dirty=false;cursor=0;const previous=lastTree;lastTree=Reveal({open,children:'private form'});if(previous?.props.ref&&previous!==lastTree)previous.props.ref.current=null;if(lastTree)lastTree.props.ref.current=node;while(effects.length)effects.shift()();if(++attempts>8)throw Error('Render loop');}while(dirty);return lastTree;};
  return{render,flush:()=>render(lastOpen),unmount(){cleanups.forEach(fn=>fn?.());},get dirty(){return dirty;}};
}

test('Reveal opens, closes with inaccessible contents, and removes the closed form after completion',async()=>{
  const env=environment(),b=box(),h=revealHarness(env.motion,b.node);
  assert.equal(h.render(false),null);assert.equal(b.animations.length,0);
  assert.ok(h.render(true));assert.equal(b.animations.length,1);assert.equal(b.animations[0].frames[0].height,'0px');
  b.animations[0].finish();await tick();assert.equal(b.animations[0].cancelled,true);
  const closing=h.render(false);assert.equal(closing.props['aria-hidden'],true);assert.equal(closing.props.inert,'');
  b.animations[1].finish();await tick();assert.equal(h.flush(),null);h.unmount();
});

test('Rapid reversal cancels the previous close and keeps the reopened content mounted',async()=>{
  const env=environment(),b=box(),h=revealHarness(env.motion,b.node);
  h.render(true);b.animations[0].finish();await tick();h.render(false);
  const closing=b.animations[1];closing.currentHeight=70;
  h.render(true);assert.equal(closing.cancelled,true);assert.equal(b.animations[2].frames[0].height,'70px');
  closing.finish();await tick();assert.ok(h.flush());
  b.animations[2].finish();await tick();assert.equal(h.flush().props['aria-hidden'],undefined);h.unmount();
});

test('Reduced motion and a missing animation API preserve immediate opening and closing',()=>{
  for(const reduced of [true,false]){const env=environment(reduced),b=box();if(!reduced)delete b.node.animate;const h=revealHarness(env.motion,b.node);assert.equal(h.render(false),null);assert.ok(h.render(true));assert.equal(h.render(false),null);assert.equal(b.animations.length,0);h.unmount();}
});

test('Changing reduced-motion preference settles active animation and unmount cancels pending work',async()=>{
  const env=environment(),b=box(),h=revealHarness(env.motion,b.node);
  h.render(true);env.setReduced(true);assert.equal(b.animations[0].cancelled,true);assert.ok(h.flush());
  assert.equal(h.render(false),null);
  env.setReduced(false);h.render(true);const active=b.animations.at(-1);h.unmount();assert.equal(active.cancelled,true);active.finish();await tick();assert.equal(h.dirty,false);
});

function detailsHarness(env){
  const b=box(160),classes=new Set(),listeners=new Map();
  const details=Object.assign(b.node,{tagName:'DETAILS',open:false,classList:{add:x=>classes.add(x),remove:x=>classes.delete(x)}});
  const summary={parentElement:details,contains:n=>n===summary,getBoundingClientRect:()=>({height:24}),closest:selector=>selector==='summary'?summary:null};
  const root={contains:n=>n===details,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  const cleanup=env.motion.mount(root);
  return{...b,details,classes,listeners,cleanup,click(){let prevented=false;listeners.get('click')({target:summary,defaultPrevented:false,preventDefault(){prevented=true;}});if(!prevented)details.open=!details.open;return prevented;}};
}

test('Native details handle rapid toggles, return to natural height, and clean up the listener',async()=>{
  const env=environment(),h=detailsHarness(env);
  assert.equal(h.click(),true);assert.equal(h.details.open,true);assert.equal(h.classes.has('motion-details-active'),true);
  h.click();assert.equal(h.animations[0].cancelled,true);h.animations[1].finish();await tick();assert.equal(h.details.open,false);assert.equal(h.classes.size,0);
  h.click();h.animations[2].finish();await tick();assert.equal(h.details.open,true);assert.equal(h.classes.size,0);
  h.click();h.cleanup();assert.equal(h.details.open,false);assert.equal(h.animations[3].cancelled,true);assert.equal(h.listeners.size,0);
});

test('Native details remain native when motion is reduced and settle on preference change',()=>{
  const env=environment(true),h=detailsHarness(env);assert.equal(h.click(),false);assert.equal(h.details.open,true);assert.equal(h.animations.length,0);
  env.setReduced(false);h.click();env.setReduced(true);assert.equal(h.details.open,false);assert.equal(h.classes.size,0);h.cleanup();
});

test('Animation assets parse and CSS disables animation for all app and access descendants when requested',()=>{
  new vm.Script(fs.readFileSync(path.join(root,'public/app-motion.js'),'utf8'));
  const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8'),css=fs.readFileSync(path.join(root,'public/app-motion.css'),'utf8');
  assert.ok(html.includes('./app-motion.js?v=20261028-motion-1'));assert.ok(html.includes('./app-motion.css?v=20261028-motion-1'));
  assert.ok(css.includes('@media (prefers-reduced-motion:reduce)'));assert.ok(css.includes('animation: none !important; transition: none !important;'));
});
