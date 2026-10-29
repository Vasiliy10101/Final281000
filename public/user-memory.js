(function(w){
  'use strict';
  const M=w.UserStateModel,clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
  const id=()=>w.crypto?.randomUUID?.()||'mem_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+'_'+Math.random().toString(36).slice(2);
  w.createUserMemory=function({userId,preview=false,fetchImpl=w.appFetch,storage,debounce=700}){
    if(!preview&&(!Number.isSafeInteger(userId)||userId<=0))throw Error('verified_identity_required');
    if(!storage)try{storage=w.localStorage;}catch(_){storage=null;}
    const identity=preview?'preview':String(userId),storageKey='trader-memory:v1:'+identity,listeners=new Set();
    let records={},status=preview?'preview':'loading',localError=false,closed=false,busy=null,timer=null,interval=null,controller=null,active=false;
    const operationValid=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{16,100}$/.test(v);
    function normalize(values){const out={};for(const [k,v]of Object.entries(values||{}))if(v&&M.valid(k,v.value)&&Number.isSafeInteger(v.revision)&&v.revision>=0)out[k]={...v,operationId:operationValid(v.operationId)?v.operationId:undefined,dirty:v.dirty===true,conflict:v.conflict&&M.valid(k,v.conflict.value)&&Number.isSafeInteger(v.conflict.revision)&&v.conflict.revision>=(v.conflict.source==='tab'?0:1)?v.conflict:null,sent:v.sent&&operationValid(v.sent.operationId)&&M.valid(k,v.sent.value)&&Number.isSafeInteger(v.sent.revision)&&v.sent.revision>=0?v.sent:null};return out;}
    function diskRecords(){const saved=JSON.parse(storage.getItem(storageKey));return saved?.userId===identity?normalize(saved.records):{};}
    try{records=diskRecords();}catch(_){}
    let observed=clone(records);
    // Merge changed records from another tab before replacing the shared cache.
    // Competing edits to one field require a choice; independent fields are retained.
    function persist(){try{
      records=normalize(records);const disk=diskRecords();
      for(const [key,incoming]of Object.entries(disk)){
        if(M.same(incoming,observed[key]))continue;
        const ours=records[key];
        if(!ours||M.same(ours,observed[key]))records[key]=incoming;
        else if(M.same(ours.value,incoming.value)){if(incoming.revision>ours.revision)records[key]=incoming;else if(incoming.conflict&&!ours.conflict)ours.conflict=incoming.conflict;}
        else records[key]={...ours,conflict:{key,value:clone(incoming.value),revision:incoming.revision,source:'tab'}};
      }
      if(!M.same(disk,records))storage.setItem(storageKey,JSON.stringify({version:1,userId:identity,records}));
      observed=clone(records);localError=false;
    }catch(_){localError=true;}}
    function emit(){for(const f of listeners)f();}
    function snapshot(){return{status,localError,pending:Object.values(records).filter(r=>r.dirty).length,conflicts:Object.entries(records).filter(([,r])=>r.conflict).map(([key,r])=>({key,local:clone(r.value),remote:clone(r.conflict.value),label:M.labels[key]}))};}
    function read(key,fallback){return clone(records[key]?.value??fallback);}
    function set(key,value){if(closed||!M.valid(key,value))return false;const old=records[key];if(old&&M.same(old.value,value))return true;records[key]={...old,value:clone(value),revision:old?.revision||0,dirty:!preview,operationId:id(),conflict:old?.conflict||null};persist();if(!preview)status=status==='offline'?'offline':'pending';emit();schedule();return !localError;}
    function importLocal(){
      for(const key of ['calculator','favorites','journal-draft'])if(!records[key])try{const v=JSON.parse(storage.getItem('trader-v2:'+identity+':'+key));if(M.valid(key,v))records[key]={value:v,revision:0,dirty:!preview,operationId:id()};}catch(_){}
      if(!records['profile-drafts'])try{const v=JSON.parse(storage.getItem('trader-profile-drafts:'+identity));if(M.valid('profile-drafts',v))records['profile-drafts']={value:v,revision:0,dirty:!preview,operationId:id()};}catch(_){}
      persist();
    }
    function schedule(){if(preview||closed||!active)return;clearTimeout(timer);timer=setTimeout(sync,debounce);}
    async function request(url,options={}){
      controller=new AbortController();const t=setTimeout(()=>controller.abort(),10000);
      try{const r=await fetchImpl(url,{...options,signal:controller.signal,cache:'no-store'});const data=await r.json();if(data.userId!==undefined&&data.userId!==userId)throw Error('identity_mismatch');if(!r.ok||!data.ok){const e=Error(data.reason||'network');e.data=data;throw e;}if(data.userId!==userId)throw Error('identity_mismatch');return data;}finally{clearTimeout(t);}
    }
    function merge(remote){
      if(!remote||!M.valid(remote.key,remote.value)||!Number.isSafeInteger(remote.revision)||remote.revision<1)return;
      const r=records[remote.key];
      if(r?.conflict?.source==='tab')return;
      if(r?.sent&&remote.operationId===r.sent.operationId&&M.same(remote.value,r.sent.value)&&remote.revision>r.sent.revision){r.revision=remote.revision;r.sent=null;r.conflict=null;}
      if(!r||!r.dirty){records[remote.key]={value:clone(remote.value),revision:remote.revision,dirty:false,updatedAt:remote.updatedAt};return;}
      if(M.same(r.value,remote.value)){records[remote.key]={value:clone(remote.value),revision:remote.revision,dirty:false,updatedAt:remote.updatedAt};return;}
      if(remote.revision!==r.revision)r.conflict=clone(remote);
    }
    async function sync(){
      if(preview||closed)return;if(busy)return busy;
      status='syncing';emit();
      busy=(async()=>{try{
        const response=await request('/api/user-state');if(closed)return;
        if(!Array.isArray(response.records)||!response.records.every(r=>r&&M.valid(r.key,r.value)&&Number.isSafeInteger(r.revision)&&r.revision>0)||new Set(response.records.map(r=>r.key)).size!==response.records.length)throw Error('invalid_state');response.records.forEach(merge);persist();emit();
        for(const key of Object.keys(records)){
          if(closed)return;const r=records[key];if(!r.dirty||r.conflict)continue;
          if(!operationValid(r.operationId))r.operationId=id();
          const sent=clone(r);r.sent={operationId:sent.operationId,value:clone(sent.value),revision:sent.revision};persist();
          if(records[key].conflict)continue;
          try{const ack=await request('/api/user-state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,value:sent.value,baseRevision:sent.revision,operationId:sent.operationId})});if(closed)return;const current=records[key];if(!ack.record||ack.record.key!==key||!M.valid(key,ack.record.value)||!M.same(ack.record.value,sent.value)||!Number.isSafeInteger(ack.record.revision)||ack.record.revision<=sent.revision)throw Error('invalid_state');
            if(current.operationId===sent.operationId&&!current.conflict)records[key]={value:clone(ack.record.value),revision:ack.record.revision,dirty:false,updatedAt:ack.record.updatedAt};else if(!current.conflict){current.revision=ack.record.revision;current.sent=null;}
          }catch(e){if(e.message==='state_conflict'&&e.data?.record){merge({...e.data.record,key});}else throw e;}
          persist();emit();
        }
        if(!closed){status=snapshot().conflicts.length?'conflict':snapshot().pending?'pending':'synced';persist();emit();if(status==='pending')schedule();}
      }catch(e){if(!closed){status=e.message==='no_db'?'no_db':['auth','not_member','identity_mismatch'].includes(e.message)?'locked':'offline';persist();emit();}}
      finally{busy=null;}})();return busy;
    }
    function resolve(key,choice){const r=records[key];if(!r?.conflict)return;const remote=r.conflict;if(!['local','remote'].includes(choice))return;if(remote.source==='tab')records[key]={value:clone(choice==='remote'?remote.value:r.value),revision:choice==='remote'?remote.revision:r.revision,dirty:!preview,operationId:id()};else if(choice==='remote')records[key]={value:clone(remote.value),revision:remote.revision,dirty:false,updatedAt:remote.updatedAt};else records[key]={value:r.value,revision:remote.revision,dirty:true,operationId:id()};persist();status=preview?'preview':'pending';emit();schedule();}
    const storageChanged=e=>{if(closed||e.key!==storageKey)return;persist();status=snapshot().conflicts.length?'conflict':preview?'preview':snapshot().pending?'pending':status;emit();schedule();};
    const resume=()=>{if(!w.document||w.document.visibilityState!=='hidden')sync();};
    function start(){if(active)return;active=true;importLocal();w.addEventListener('storage',storageChanged);emit();if(preview)return;w.addEventListener('online',resume);w.document?.addEventListener('visibilitychange',resume);interval=setInterval(resume,30000);sync();}
    function stop(){closed=true;clearTimeout(timer);clearInterval(interval);controller?.abort();w.removeEventListener('storage',storageChanged);w.removeEventListener('online',resume);w.document?.removeEventListener('visibilitychange',resume);listeners.clear();}
    return{read,set,sync,resolve,start,stop,snapshot,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f);},identity};
  };
  w.createMemoryBindings=function(React){
    const h=React.createElement,{useState,useEffect}=React;
    function useStoredState(key,initial){const memory=w.AppMemory;const [value,update]=useState(()=>memory?memory.read(key,typeof initial==='function'?initial():initial):typeof initial==='function'?initial():initial);
      useEffect(()=>memory?.subscribe(()=>update(previous=>{const next=memory.read(key,previous);return M.same(previous,next)?previous:next;})),[memory,key]);
      const set=next=>{if(memory){const old=memory.read(key,value),v=typeof next==='function'?next(old):next;memory.set(key,v);update(memory.read(key,old));}else update(next);};return[value,set];
    }
    function describe(key,value){
      if(key==='favorites')return value.join(', ')||'Нет избранных монет';
      if(key==='pump-direction')return value==='pump'?'Pump':'Dump';
      if(key==='calculator-exits')return value.map((v,i)=>'Цель '+(i+1)+': '+(v.price||'—')+' · доля '+(v.share||'—')+'%').join('\n');
      if(key==='profile-drafts')return Object.entries(value).map(([k,v])=>(k==='summary'?'Итоговый разбор':'Неделя с '+k.slice(7))+'\n'+v.body).join('\n\n')||'Нет черновиков';
      const labels={symbol:'Монета',side:'Направление',balance:'Депозит',risk:'Риск, %',entry:'Вход',stop:'Стоп',target:'Цель',leverage:'Плечо',fee:'Комиссия, %',quantity:'Количество',mmr:'Поддерживающая маржа',fundingRate:'Фандинг',periods:'Выплат',exit:'Выход',size:'Количество',emotion:'Эмоция',note:'Заметка',thesis:'Причина входа',lesson:'Вывод',query:'Поиск',filter:'Фильтр',sort:'Сортировка',minVolume:'Минимальный объём',period:'Период'};
      const names={long:'Лонг',short:'Шорт',calm:'Спокойствие',fear:'Страх',greed:'Жадность',tilt:'Тильт',all:'Все',favorites:'Избранное',gain:'Рост',lose:'Падение',volume:'Объём',move:'Сила движения',name:'По названию',wins:'Прибыльные',losses:'Убыточные',review:'Без полного разбора'};
      return Object.entries(value).filter(([k])=>k!=='clientId').map(([k,v])=>(labels[k]||k)+': '+(names[v]||v||'—')).join('\n');
    }
    function Status(){const memory=w.AppMemory;const [state,setState]=useState(()=>memory?.snapshot());useEffect(()=>memory?.subscribe(()=>setState(memory.snapshot())),[memory]);if(!state)return null;
      const text=state.localError?'Не удалось сохранить на устройстве. Не закрывай страницу.':({preview:'Локальный просмотр · данные только на этом устройстве',loading:'Загружаем твои данные…',syncing:'Синхронизируем…',synced:'Данные синхронизированы',pending:'Изменения сохранены на устройстве',offline:'Нет связи · изменения сохранены на устройстве',no_db:'Серверное хранилище ещё не подключено',locked:'Войди снова, чтобы синхронизировать',conflict:'Есть изменения в другом окне или на другом устройстве'})[state.status];
      return h('div',{className:'um-status','data-status':state.status},h('div',{className:'um-status-row',role:'status'},h('span',null,text),!['preview','syncing','loading'].includes(state.status)&&h('button',{type:'button',onClick:()=>memory.sync()},'Обновить')),state.status==='offline'&&h('small',null,'Можно продолжать черновик. Синхронизация повторится после восстановления связи.'),state.conflicts.map(c=>h('details',{key:c.key,className:'um-conflict',open:true},h('summary',null,c.label+' · две версии'),h('p',null,'Выбери, какую версию использовать. До выбора обе сохранены на этом устройстве.'),h('div',{className:'um-versions'},h('label',null,'На этом устройстве',h('textarea',{readOnly:true,value:describe(c.key,c.local),rows:5})),h('label',null,'В другом окне / устройстве',h('textarea',{readOnly:true,value:describe(c.key,c.remote),rows:5}))),h('div',{className:'um-actions'},h('button',{type:'button',onClick:()=>memory.resolve(c.key,'local')},'Оставить эту'),h('button',{type:'button',onClick:()=>memory.resolve(c.key,'remote')},'Взять другую версию')))));
    }
    function Boundary({App,userId,preview=false}){const [memory]=useState(()=>w.createUserMemory({userId,preview}));const[state,setState]=useState(memory.snapshot());w.AppMemory=memory;
      useEffect(()=>{const off=memory.subscribe(()=>setState(memory.snapshot()));memory.start();return()=>{off();memory.stop();if(w.AppMemory===memory)w.AppMemory=null;};},[memory]);
      if(state.status==='loading'||(state.status==='syncing'&&!memory.booted)){if(state.status!=='loading')memory.booted=true;return h('div',{className:'um-loading',role:'status'},'Восстанавливаем твои данные…');}
      memory.booted=true;return h(App);
    }
    return{useStoredState,Status,Boundary};
  };
})(window);
