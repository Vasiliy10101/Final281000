(function(w){
  'use strict';
  w.createTradingTools=function(React,api){
    const h=React.createElement,{useState,useEffect,useRef}=React,M=w.TradingModel;
    const preview=w.location.protocol==='file:';
    const useSaved=w.createMemoryBindings?.(React).useStoredState||((_key,initial)=>useState(initial));
    const userKey=String(w.Telegram?.WebApp?.initDataUnsafe?.user?.id||'preview');
    const money=n=>Number.isFinite(n)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2,minimumFractionDigits:2}).format(n)+' USDT':'—';
    const price=n=>Number.isFinite(n)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:n>=100?2:n>=1?4:10}).format(n):'—';
    const signed=n=>Number.isFinite(n)?(n>0?'+':'')+money(n):'—';
    const pct=n=>Number.isFinite(n)?new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(n)+'%':'—';
    const compact=n=>new Intl.NumberFormat('ru-RU',{notation:'compact',maximumFractionDigits:1}).format(n);
    const time=t=>t?new Date(t).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'';
    function read(key,fallback){if(w.AppMemory)return w.AppMemory.read(key,fallback);try{const value=JSON.parse(w.localStorage.getItem('trader-v2:'+userKey+':'+key));return value??fallback;}catch(_){return fallback;}}
    function write(key,value){try{w.localStorage.setItem('trader-v2:'+userKey+':'+key,JSON.stringify(value));return true;}catch(_){return false;}}
    function storedFields(key,defaults){const data=read(key,{});return Object.fromEntries(Object.entries(defaults).map(([k,v])=>[k,typeof data?.[k]==='string'?data[k].slice(0,2000):v]));}
    function Btn({children,onClick,primary,danger,quiet,...rest}){return h('button',{type:'button',className:'tt-btn'+(primary?' tt-btn-primary':'')+(danger?' tt-btn-danger':'')+(quiet?' tt-btn-quiet':''),onClick,...rest},children);}
    function Field({label,value,onChange,unit,error,hint,text=false,placeholder='',inputRef,...rest}){return h('label',{className:'tt-field'},h('span',null,label),h('span',{className:'tt-field-control'},h('input',{value,onChange:e=>onChange(e.target.value),inputMode:text?'text':'decimal',autoComplete:'off',spellCheck:false,placeholder,ref:inputRef,'aria-invalid':!!error,...rest}),unit&&h('span',{className:'tt-field-unit'},unit)),error?h('span',{className:'tt-error'},error):hint&&h('small',null,hint));}
    function Note({children,warning=false}){return h('div',{className:'tt-note'+(warning?' tt-note-warning':''),role:'status'},children);}
    function Chips({items,value,onChange,label}){return h('div',{className:'tt-chips',role:'group','aria-label':label},items.map(([id,name])=>h('button',{type:'button',className:'tt-chip',key:id,'aria-pressed':value===id,onClick:()=>onChange(id)},name)));}
    function Side({value,onChange}){return h('div',{className:'tt-side',role:'group','aria-label':'Направление сделки'},[['long','↗ Лонг'],['short','↘ Шорт']].map(([id,name])=>h('button',{key:id,type:'button','aria-pressed':value===id,className:value===id?'is-'+id:'',onClick:()=>onChange(id)},name)));}
    function Pair({label,value,tone}){return h('div',{className:'tt-pair'},h('span',null,label),h('strong',{className:tone?'tt-'+tone:undefined},value));}
    function Details({title,children,...props}){return h('details',{className:'tt-disclosure',...props},h('summary',null,title),h('div',{className:'tt-disclosure-body'},children));}
    function Header({title,subtitle,onBack,children}){return h('div',{className:'tt-heading'},onBack&&h('button',{className:'tt-back',type:'button',onClick:onBack},'← На главную'),h('div',{className:'tt-header'},h('h1',null,title),children),h('p',{className:'tt-muted'},subtitle));}
    function Empty({title,children}){return h('div',{className:'tt-empty'},h('strong',null,title),children);}
    function Search({value,onChange,label}){return h('div',{className:'tt-search'},h('span',{'aria-hidden':true},'⌕'),h('input',{value,onChange:e=>onChange(e.target.value),placeholder:label,'aria-label':label}),value&&h('button',{type:'button',className:'tt-clear','aria-label':'Очистить поиск',onClick:()=>onChange('')},'×'));}
    function Metric({label,value,tone}){return h('div',{className:'tt-metric'},h('small',null,label),h('strong',{className:tone?'tt-'+tone:undefined},value));}
    const initialPlan={symbol:'BTC-USDT',side:'long',balance:'',risk:'1',entry:'',stop:'',target:'',leverage:'10',fee:'0.05',quantity:'',mmr:'0.5',fundingRate:'0.01',periods:'1'};
    function CalculatorsModule({symbols=[],onBack,onJournal,request}){
      const [form,setForm]=useSaved('calculator',()=>storedFields('calculator',initialPlan));
      const [touched,setTouched]=useState({}),[notice,setNotice]=useState(''),[quote,setQuote]=useState({state:'idle'}),[copyText,setCopyText]=useState(''),[ignored,setIgnored]=useState(null);
      const [tps,setTps]=useSaved('calculator-exits',[{price:'',share:''},{price:'',share:''},{price:'',share:''}]);
      const generation=useRef(0),abort=useRef(null);
      const result=M.plan(form),sym=M.symbol(form.symbol),coin=sym.replace('-USDT','')||'монет';
      useEffect(()=>{if(!w.AppMemory&&!write('calculator',form))setNotice('Не удалось сохранить черновик на устройстве. Расчёт продолжает работать.');},[form]);
      useEffect(()=>()=>{generation.current++;abort.current?.abort();},[]);
      const invalidateQuote=()=>{generation.current++;abort.current?.abort();setQuote({state:'idle'});};
      function change(key,value){if(key==='symbol'||key==='entry')invalidateQuote();setForm(p=>({...p,[key]:value}));setTouched(p=>({...p,[key]:true,...(key==='side'?{stop:true,target:true}:{})}));setNotice('');setCopyText('');}
      const field=(key,label,options={})=>h(Field,{label,value:form[key],onChange:v=>change(key,v),error:touched[key]?result.errors[key]:undefined,...options});
      async function loadPrice(){
        if(!sym||preview)return;
        abort.current?.abort();const controller=new AbortController();abort.current=controller;const version=++generation.current;
        setQuote({state:'loading'});const timer=setTimeout(()=>controller.abort(),8000);
        try{const response=await api.fetch(api.bingxUrl('/openApi/swap/v2/quote/price',sym),{signal:controller.signal});const data=await response.json();const p=M.number(data?.data?.price??data?.data?.[0]?.price);if(!response.ok||!(p>0))throw Error('price');
          if(version!==generation.current)return;setForm(v=>({...v,entry:String(p)}));setTouched(v=>({...v,entry:true}));setQuote({state:'ready',at:Date.now()});setNotice('Цена входа обновлена. Проверь стоп и цель.');
        }catch(_){if(version===generation.current)setQuote({state:'error'});}finally{clearTimeout(timer);}
      }
      function applyRequest(){invalidateQuote();setForm(p=>({...p,symbol:request.symbol,entry:request.price>0?String(request.price):'',stop:'',target:'',quantity:''}));setTps([{price:'',share:''},{price:'',share:''},{price:'',share:''}]);setTouched({});setIgnored(request.id);setNotice(request.price?'Цена перенесена из скринера. Укажи стоп и цель.':'Монета выбрана. Введи цену входа или обнови её.');setCopyText('');}
      function example(){invalidateQuote();setForm({...initialPlan,balance:'1000',entry:'100',stop:'98',target:'104'});setTouched({});setTps([{price:'',share:''},{price:'',share:''},{price:'',share:''}]);setNotice('Учебный пример: цены условные, это не текущая котировка BTC.');setCopyText('');}
      const liq=result.valid?M.liquidation(form):null,stop=M.number(form.stop),entry=M.number(form.entry),dir=form.side==='short'?-1:1;
      const beforeStop=liq!==null&&(form.side==='short'?liq<=stop:liq>=stop);
      const fund=result.valid?M.funding(form,result.notional):null;
      const ladder=result.valid?M.ladder(form,result.quantity,tps):null;
      async function copy(){if(!result.valid)return;const text=[`${sym} · ${form.side==='long'?'Лонг':'Шорт'}`,`Вход ${form.entry} · Стоп ${form.stop} · Цель ${form.target||'не задана'}`,`Количество ${result.quantity.toPrecision(10)} ${coin}`,`Позиция ${money(result.notional)} · Плечо ${form.leverage}×`,`Результат на стопе ${signed(result.stopPnl)} · На цели ${signed(result.targetPnl)}`,`Комиссия ${form.fee}% на каждую сторону; без фандинга и проскальзывания.`].join('\n');try{await w.navigator.clipboard.writeText(text);setNotice('Расчёт скопирован.');setCopyText('');}catch(_){setCopyText(text);setNotice('Выдели и скопируй расчёт ниже.');}}
      return h('section',{className:'tt','aria-label':'Калькулятор сделки'},
        h(Header,{title:'Калькулятор',subtitle:'От риска к размеру позиции · USDT-фьючерсы',onBack}),
        request&&request.id!==ignored&&h(Note,null,h('p',null,`Открыть расчёт ${request.symbol.replace('-USDT','')} из скринера? Вход, стоп и цель текущего расчёта будут заменены.`),h('div',{className:'tt-actions'},h(Btn,{primary:true,onClick:applyRequest},'Применить'),h(Btn,{onClick:()=>setIgnored(request.id)},'Оставить текущий'))),
        h('div',{className:'tt-card'},h('div',{className:'tt-section-title'},h('span',{className:'tt-step'},'01'),h('h2',null,'План сделки')),
          field('symbol','Монета',{text:true,unit:'/ USDT',list:'tt-symbols',placeholder:'BTC',maxLength:20}),h('datalist',{id:'tt-symbols'},symbols.map(s=>h('option',{key:s,value:s}))),
          h(Side,{value:form.side,onChange:v=>change('side',v)}),
          h('div',{className:'tt-grid'},field('balance','Доступный депозит',{unit:'USDT',placeholder:'1 000'}),field('risk','Риск на сделку',{unit:'%',hint:'Часть депозита на случай стопа'})),
          h(Chips,{items:[['0.5','Риск 0,5%'],['1','1%'],['2','2%']],value:form.risk,onChange:v=>change('risk',v),label:'Быстрый выбор риска'}),
          h('div',{className:'tt-grid'},field('entry','Цена входа',{unit:'USDT',placeholder:'0,00'}),field('stop','Стоп-лосс',{unit:'USDT',placeholder:form.side==='long'?'Ниже входа':'Выше входа'})),
          h(Btn,{quiet:true,onClick:loadPrice,disabled:preview||!sym||quote.state==='loading','aria-busy':quote.state==='loading'},quote.state==='loading'?'Получаю цену…':'↻ Подставить цену BingX'),
          preview&&h('small',null,'В локальном просмотре цену вводим вручную. В Telegram доступна котировка BingX.'),
          quote.state==='ready'&&h('small',null,'Котировка получена в '+time(quote.at)+'. Автоматически не меняется.'),
          quote.state==='error'&&h(Note,{warning:true},'Котировка недоступна. Введённая цена сохранена; попробуй ещё раз или введи её вручную.'),
          field('target','Тейк-профит',{unit:'USDT',placeholder:'Необязательно'}),
          h('div',{className:'tt-chips',role:'group','aria-label':'Цель по расстоянию до стопа'},[1,2,3].map(r=>h('button',{key:r,type:'button',className:'tt-chip',disabled:!(entry>0&&stop>0&&(entry-stop)*dir>0&&entry+dir*Math.abs(entry-stop)*r>0),onClick:()=>change('target',String(Number((entry+dir*Math.abs(entry-stop)*r).toPrecision(12))))},'Цель 1:'+r))),
          h('small',null,'Быстрые цели рассчитаны по расстоянию цены, без комиссий.'),
          h('div',{className:'tt-grid'},field('leverage','Плечо',{unit:'×'}),field('fee','Комиссия за сторону',{unit:'%'})),h('small',null,'0,05% — пример комиссии. Укажи свой тариф. Плечо меняет маржу, размер позиции определяется риском.')),
        h('div',{className:'tt-card tt-result'},h('div',{className:'tt-section-title'},h('span',{className:'tt-step'},'02'),h('h2',null,'Твой расчёт')),
          result.valid?h(React.Fragment,null,h('small',null,'Размер позиции'),h('div',{className:'tt-result-amount'},money(result.notional).replace(' USDT',''),h('small',null,'USDT')),h('small',null,price(result.quantity)+' '+coin+' · '+(form.quantity?'заданный объём':'объём рассчитан по риску')),
            h('div',{className:'tt-grid'},h(Metric,{label:'Результат на стопе',value:signed(result.stopPnl),tone:'bad'}),h(Metric,{label:'Результат на цели',value:signed(result.targetPnl),tone:result.targetPnl!==null?(result.targetPnl>=0?'good':'bad'):undefined})),
            h(Pair,{label:'Начальная маржа',value:money(result.margin)}),h(Pair,{label:'Маржа + комиссия входа',value:money(result.required)}),h(Pair,{label:'Риск : прибыль с комиссиями',value:result.rr!==null?'1 : '+price(result.rr):'Укажи цель'}),
            h('small',null,'Результаты учитывают указанную комиссию входа и выхода. Без фандинга, проскальзывания и округления под шаг биржи.'),
            result.insufficient&&h(Note,{warning:true},'Для такого объёма недостаточно указанного депозита: требуется '+money(result.required)+'.'),
            result.overBudget&&h(Note,{warning:true},'Заданный объём превышает бюджет риска '+money(result.budget)+'.'),
            result.targetPnl!==null&&result.targetPnl<=0&&h(Note,{warning:true},'Движение до цели не покрывает указанные комиссии.'),
            h('div',{className:'tt-actions'},h(Btn,{primary:true,onClick:()=>onJournal?.({symbol:sym,side:form.side,entry:form.entry,size:String(Number(result.quantity.toPrecision(12)))})},'В дневник →'),h(Btn,{onClick:copy},'Копировать')),h('small',null,'В дневник попадёт черновик. Цену выхода заполни после закрытия сделки.')):
            h(Empty,{title:'Сначала заполни план'},h('p',null,'Нужны депозит, риск, цена входа и стоп. Результат появится автоматически.'),h(Btn,{quiet:true,onClick:example},'Заполнить учебный пример'))),
        notice&&h(Note,null,notice),copyText&&h('textarea',{className:'tt-copy',value:copyText,readOnly:true,rows:7,'aria-label':'Текст расчёта для копирования',onFocus:e=>e.target.select()}),
        h(Details,{title:'Свой объём и безубыток'},field('quantity','Количество монет',{unit:coin,placeholder:'Автоматически по риску',hint:'Оставь пустым, чтобы рассчитывать размер из риска.'}),h(Pair,{label:'Безубыток с комиссиями',value:result.valid?price(result.breakEven)+' USDT':'—'}),h(Pair,{label:'Доля депозита: маржа и вход',value:result.valid?pct(result.depositShare):'—'})),
        h(Details,{title:'Ликвидация · приблизительная оценка'},field('mmr','Поддерживающая маржа',{unit:'%'}),h(Pair,{label:'Расчётная цена ликвидации',value:liq!==null?price(liq)+' USDT':'—',tone:'bad'}),
          liq!==null&&h(Note,{warning:beforeStop},beforeStop?'В этой модели ликвидация наступает до уровня стопа.':'В этой модели уровень стопа ближе к входу. Это не гарантия его исполнения.'),
          h('small',null,'Упрощённая изолированная маржа: поддерживающая маржа от текущей стоимости позиции. Без комиссий, дополнительных средств и ступеней риска. Для кросс-маржи не подходит. Точное значение смотри на бирже; ликвидацию определяет mark price.'),
          result.valid&&liq===null&&h('small',null,'Для оценки поддерживающая маржа должна быть меньше 100 / плечо. При лонге 1× положительная цена может отсутствовать.')),
        h(Details,{title:'Частичные выходы'},h('small',null,'Доли от первоначальной позиции. Для незакрытого остатка результат не считается.'),tps.map((tp,i)=>h('div',{className:'tt-grid',key:i},h(Field,{label:'Цель '+(i+1),unit:'USDT',value:tp.price,onChange:v=>setTps(p=>p.map((x,j)=>j===i?{...x,price:v}:x))}),h(Field,{label:'Доля '+(i+1),unit:'%',value:tp.share,onChange:v=>setTps(p=>p.map((x,j)=>j===i?{...x,share:v}:x))}))),
          ladder?.error?h('small',null,ladder.error):ladder&&h(React.Fragment,null,h(Pair,{label:'Закрываемая доля',value:pct(ladder.share)}),h(Pair,{label:'Средняя цена этих выходов',value:price(ladder.average)}),h(Pair,{label:'Результат закрытой части с комиссией',value:signed(ladder.pnl),tone:ladder.pnl>=0?'good':'bad'}))),
        h(Details,{title:'Фандинг за время удержания'},h('div',{className:'tt-grid'},field('fundingRate','Ставка за выплату',{unit:'%'}),field('periods','Количество выплат',{unit:'раз'})),h(Pair,{label:fund!==null&&fund>0?'Ожидаемое получение':'Ожидаемая выплата',value:fund!==null?money(Math.abs(fund)):'—',tone:fund>0?'good':'bad'}),h('small',null,'Оценка при неизменной ставке и стоимости позиции по цене входа. Положительная ставка: лонг платит, шорт получает. В фактическом расчёте используется mark price на момент выплаты. Не включено в результат выше.')),
        h('small',null,'Расчёт сохраняется автоматически. Состояние синхронизации — вверху экрана.'));
    }

    function ScreenerModule({tickers=[],status,reload,updatedAt,onBack,onCalculate}){
      const [filters,setFilters]=useSaved('screen-filters',{query:'',filter:'all',sort:'volume',minVolume:'0'});
      const {query,filter,sort,minVolume}=filters,setQuery=v=>setFilters(p=>({...p,query:v})),setFilter=v=>setFilters(p=>({...p,filter:v})),setSort=v=>setFilters(p=>({...p,sort:v})),setMinVolume=v=>setFilters(p=>({...p,minVolume:v}));
      const [limit,setLimit]=useState(30),[expanded,setExpanded]=useState(null),[storageError,setStorageError]=useState(false);
      const [favorites,setFavorites]=useSaved('favorites',()=>{const x=read('favorites',[]);return Array.isArray(x)?x.filter(s=>typeof s==='string'&&M.symbol(s)===s).slice(0,500):[];});
      useEffect(()=>setLimit(30),[query,filter,sort,minVolume]);
      const rows=M.screen(tickers,{query,filter,sort,favorites,minVolume:Number(minVolume)}),demo=status==='mock'||preview;
      const selectFilter=v=>{setFilter(v);if(v==='gain')setSort('gain');if(v==='lose')setSort('lose');};
      const favorite=s=>setFavorites(p=>{const next=p.includes(s)?p.filter(v=>v!==s):[...p,s];if(!w.AppMemory)setStorageError(!write('favorites',next));return next;});
      const clear=()=>{setQuery('');setFilter('all');setSort('volume');setMinVolume('0');};
      return h('section',{className:'tt','aria-label':'Скринер рынка'},
        h(Header,{title:'Скринер',subtitle:'BingX · USDT-фьючерсы · изменение за 24 часа',onBack},h(Btn,{onClick:reload,disabled:status==='loading'||preview,'aria-busy':status==='loading','aria-label':'Обновить котировки'},'↻')),
        demo?h(Note,{warning:true},'Демонстрационные котировки для просмотра интерфейса. Это не текущий рынок.'):
          status==='error'||status==='stale'?h(Note,{warning:true},updatedAt?'Связь потеряна. Показаны последние котировки от '+time(updatedAt)+'.':'Котировки пока недоступны. Попробуй обновить.'):
          h('small',{role:'status'},status==='loading'?'Обновляю котировки…':updatedAt?'Обновлено '+time(updatedAt)+' · автообновление каждые 30 секунд':'Ожидаю котировки…'),
        h(Search,{value:query,onChange:setQuery,label:'Найти монету: BTC, SOL…'}),
        h(Chips,{items:[['all','Все'],['favorites','★ Избранное'],['gain','Рост'],['lose','Падение']],value:filter,onChange:selectFilter,label:'Фильтр монет'}),
        h('div',{className:'tt-grid'},h('label',{className:'tt-field'},'Сортировать',h('select',{className:'tt-select',value:sort,onChange:e=>setSort(e.target.value)},[['volume','По объёму ↓'],['move','Сильные движения'],['gain','Рост за 24 ч ↓'],['lose','Падение за 24 ч ↓'],['name','По названию А–Я']].map(([v,l])=>h('option',{key:v,value:v},l)))),
          h('label',{className:'tt-field'},'Объём за 24 часа',h('select',{className:'tt-select',value:minVolume,onChange:e=>setMinVolume(e.target.value)},[['0','Любой'],['1000000','От 1 млн USDT'],['10000000','От 10 млн USDT'],['100000000','От 100 млн USDT']].map(([v,l])=>h('option',{key:v,value:v},l))))),
        storageError&&h(Note,{warning:true},'Избранное работает в этой сессии, но сохранить его на устройстве не удалось.'),
        h('div',{className:'tt-table-note'},h('span',null,'Найдено '+rows.length+' · показано '+Math.min(limit,rows.length)),h('span',null,'Нажми на монету для деталей')),
        h('div',{className:'tt-list'},h('div',{className:'tt-market-head'},h('span',null,'Монета / объём 24 ч'),h('span',null,'Цена / изменение 24 ч')),
          !rows.length?h(Empty,{title:filter==='favorites'&&!favorites.length?'Твой список наблюдения':status==='loading'?'Загружаю рынок…':'Монеты не найдены'},h('p',null,filter==='favorites'&&!favorites.length?'Добавь монету звёздочкой — она появится здесь.':'Попробуй другой тикер или убери фильтры.'),h(Btn,{quiet:true,onClick:clear},'Показать все монеты')):
          rows.slice(0,limit).map(t=>h(React.Fragment,{key:t.symbol},h('div',{className:'tt-market-row'},
            h('button',{type:'button',className:'tt-star','aria-label':(favorites.includes(t.symbol)?'Убрать из избранного ':'В избранное ')+t.symbol,'aria-pressed':favorites.includes(t.symbol),onClick:()=>favorite(t.symbol)},h('svg',{width:18,height:18,viewBox:'0 0 24 24',fill:favorites.includes(t.symbol)?'currentColor':'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true},h('path',{d:'m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z'}))),
            h('button',{type:'button',className:'tt-market-symbol','aria-expanded':expanded===t.symbol,onClick:()=>setExpanded(expanded===t.symbol?null:t.symbol)},h('strong',null,t.symbol.replace('-USDT',''),h('small',null,' /USDT')),h('small',null,compact(t.vol)+' USDT · '+(expanded===t.symbol?'свернуть':'подробнее ›'))),
            h('div',{className:'tt-market-price'},h('strong',null,price(t.price)),h('span',{className:'tt-change '+(t.chg>0?'tt-good':t.chg<0?'tt-bad':'tt-muted')},(t.chg>0?'+':'')+pct(t.chg)))),
            expanded===t.symbol&&h('div',{className:'tt-market-detail motion-panel'},h('div',{className:'tt-table-note'},h('span',null,'Мин. 24 ч: '+(t.low>0?price(t.low):'—')),h('span',null,'Макс. 24 ч: '+(t.high>0?price(t.high):'—'))),
              t.high>t.low&&t.low>0&&h('div',{className:'tt-market-range','aria-label':'Положение цены в диапазоне 24 часа'},h('i',{style:{left:Math.min(100,Math.max(0,(t.price-t.low)/(t.high-t.low)*100))+'%'}})),
              h(Btn,{primary:true,onClick:()=>onCalculate?.({symbol:t.symbol,price:status==='live'&&!demo&&updatedAt&&Date.now()-updatedAt<60000?t.price:null})},'Рассчитать сделку →'),h('small',null,'Изменение за сутки описывает рынок, а не сигнал PUMP DUMP за 1–5 минут.'))))),
        rows.length>limit&&h(Btn,{onClick:()=>setLimit(n=>n+30)},'Показать ещё '+Math.min(30,rows.length-limit)),h('small',null,'Избранное привязано к твоему аккаунту. В локальном просмотре — только к этому устройству.'));
    }

    const initialJournal={symbol:'BTC',side:'long',entry:'',exit:'',size:'',emotion:'',note:'',thesis:'',lesson:'',clientId:''};
    const newId=()=>w.crypto?.randomUUID?.()||('trade_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+'_'+Math.random().toString(36).slice(2));
    const newJournal=()=>({...initialJournal,clientId:newId()});
    const emotions=[['calm','😌','Спокоен'],['fear','😨','Страх'],['greed','🤑','Жадность'],['tilt','😤','Тильт']];
    function JournalModule({onBack,request,active=true}){
      const [trades,setTrades]=useState([]),[loading,setLoading]=useState(!preview),[loaded,setLoaded]=useState(preview),[loadError,setLoadError]=useState(''),[hasMore,setHasMore]=useState(false);
      const [form,setForm]=useSaved('journal-draft',()=>{const f=storedFields('journal-draft',initialJournal);return{...f,clientId:/^[a-zA-Z0-9_-]{16,80}$/.test(f.clientId)?f.clientId:newId()};}),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[err,setErr]=useState(''),[notice,setNotice]=useState(''),[ignored,setIgnored]=useState(null);
      const [filters,setFilters]=useSaved('journal-filters',{query:'',filter:'all',period:'all'});
      const {query,filter,period}=filters,setQuery=v=>setFilters(p=>({...p,query:v})),setFilter=v=>setFilters(p=>({...p,filter:v})),setPeriod=v=>setFilters(p=>({...p,period:v}));
      const [limit,setLimit]=useState(20),[confirm,setConfirm]=useState(null),[deleting,setDeleting]=useState(null),[resetConfirm,setResetConfirm]=useState(false);
      const requestLock=useRef(false),formRef=useRef(null),alive=useRef(true),listRevision=useRef(0);
      useEffect(()=>{if(!/^[a-zA-Z0-9_-]{16,80}$/.test(form.clientId))setForm(current=>({...current,clientId:newId()}));},[form.clientId]);
      useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
      useEffect(()=>{if(!w.AppMemory&&!write('journal-draft',form))setNotice('Черновик останется только до закрытия этой страницы: сохранение на устройстве недоступно.');},[form]);
      useEffect(()=>{setLimit(20);setConfirm(null);},[query,filter,period]);
      const errorMessage=r=>r?.reason==='no_db'?'Хранилище дневника ещё не подключено.':r?.reason==='auth'?'Открой приложение в Telegram, чтобы работать с дневником.':'Не удалось связаться с дневником. Попробуй ещё раз.';
      async function load(){if(preview||requestLock.current)return;const revision=++listRevision.current;setLoading(true);setLoadError('');try{const r=await api.list();if(!alive.current||revision!==listRevision.current)return;if(r?.ok&&Array.isArray(r.trades)){setTrades(r.trades);setLoaded(true);setHasMore(!!r.hasMore);}else setLoadError(errorMessage(r));}catch(_){if(alive.current&&revision===listRevision.current)setLoadError(errorMessage());}finally{if(alive.current&&revision===listRevision.current)setLoading(false);}}
      useEffect(()=>{load();},[]);
      useEffect(()=>{if(preview||!active)return;const refresh=()=>{if(w.document?.visibilityState!=='hidden')load();};w.addEventListener('online',refresh);w.document?.addEventListener('visibilitychange',refresh);return()=>{w.removeEventListener('online',refresh);w.document?.removeEventListener('visibilitychange',refresh);};},[active]);
      useEffect(()=>{if(open)formRef.current?.focus({preventScroll:true});},[open]);
      const change=(k,v)=>{setForm(p=>({...p,[k]:v,clientId:newId()}));setErr('');};
      const sym=M.symbol(form.symbol),entry=M.number(form.entry),exit=M.number(form.exit),size=M.number(form.size),gross=(exit-entry)*size*(form.side==='short'?-1:1);
      const valid=!!sym&&entry>0&&exit>0&&size>0&&Number.isFinite(gross);
      const rows=M.journalRows(trades,{query,filter,period}),stats=M.stats(rows);
      async function save(e){e.preventDefault();if(requestLock.current||preview||loading)return;if(w.AppMemory?.snapshot().conflicts.some(c=>c.key==='journal-draft')){setErr('Сначала выбери версию черновика вверху экрана.');return;}if(!valid){setErr('Проверь тикер, цены входа и выхода и количество монет. Числа должны быть больше нуля.');return;}requestLock.current=true;setBusy(true);setErr('');
        try{const r=await api.add({...form,symbol:sym,entry,exit,size,emotion:form.emotion||null});if(!alive.current)return;if(r?.ok&&r.trade){if(trades.length>=500)setHasMore(true);setTrades(p=>[...p.filter(t=>String(t.id)!==String(r.trade.id)),r.trade].slice(-500));setLoaded(true);setLoadError('');setForm(current=>Object.keys(form).every(k=>current[k]===form[k])?{...newJournal(),symbol:form.symbol,side:form.side}:current);setNotice('Отправленная сделка сохранена.');setQuery('');setFilter('all');setPeriod('all');w.dispatchEvent(new CustomEvent('member-progress-changed'));}else setErr(r?.reason==='network'||!r?.reason?'Не удалось подтвердить сохранение. Обнови историю перед повторной отправкой; черновик сохранён.':r.reason==='review_too_long'?'Причина и вывод должны быть не длиннее 1000 символов.':r.reason==='idempotency_conflict'?'Эта версия черновика уже была сохранена с другими данными. Обнови историю и измени нужное поле перед новой записью.':errorMessage(r));}catch(_){if(alive.current)setErr('Не удалось подтвердить сохранение. Обнови историю перед повторной отправкой; черновик сохранён.');}finally{requestLock.current=false;if(alive.current)setBusy(false);}}
      async function remove(id){if(requestLock.current||preview)return;requestLock.current=true;listRevision.current++;setLoading(false);setDeleting(id);setErr('');try{const r=await api.remove(id);if(!alive.current)return;if(r?.ok){setTrades(p=>p.filter(t=>String(t.id)!==String(id)));setConfirm(null);setNotice('Запись удалена.');w.dispatchEvent(new CustomEvent('member-progress-changed'));}else setErr('Не удалось удалить запись. Она остаётся в дневнике.');}catch(_){if(alive.current)setErr('Не удалось удалить запись. Попробуй ещё раз.');}finally{requestLock.current=false;if(alive.current)setDeleting(null);}}
      function applyRequest(){setForm({...newJournal(),symbol:request.symbol,side:request.side,entry:request.entry,size:request.size});setOpen(true);setIgnored(request.id);setNotice('Черновик из калькулятора. Укажи фактическую цену выхода после закрытия.');setErr('');}
      function exportCsv(){try{const blob=new Blob([M.csv(rows)],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='journal-'+new Date().toISOString().slice(0,10)+'.csv';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('CSV подготовлен: '+rows.length+' записей с текущими фильтрами. Если файл не скачался, открой приложение в браузере.');}catch(_){setErr('Не удалось скачать CSV в этом браузере.');}}
      const field=(key,label,options={})=>h(Field,{label,value:form[key],onChange:v=>change(key,v),disabled:busy,...options});
      const max=Math.max(...stats.equity),min=Math.min(...stats.equity),span=max-min||1;
      const points=stats.equity.map((v,i)=>(5+i/(stats.equity.length-1||1)*290)+','+(85-(v-min)/span*75)).join(' ');
      const fullDate=ts=>new Date(ts).toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'});
      return h('section',{className:'tt','aria-label':'Дневник сделок'},
        h(Header,{title:'Дневник',subtitle:'Сохраняй сделки. Замечай закономерности.',onBack},h(Btn,{primary:!open,onClick:()=>setOpen(v=>!v),'aria-expanded':open,disabled:busy},open?'Свернуть':'+ Сделка')),
        preview&&h(Note,null,'Локальный просмотр: можно заполнить черновик. История и сохранение сделок доступны в Telegram.'),
        request&&request.id!==ignored&&h(Note,null,h('p',null,'Перенести '+request.symbol+' из калькулятора? Это заменит поля текущего черновика.'),h('div',{className:'tt-actions'},h(Btn,{primary:true,disabled:busy,onClick:applyRequest},'Заполнить черновик'),h(Btn,{onClick:()=>setIgnored(request.id)},'Оставить текущий'))),
        h(api.Reveal,{open},h('form',{className:'tt-card',onSubmit:save},h('h2',null,'Закрытая сделка'),h('small',null,'Запиши фактические цены и объём после закрытия. Дата записи проставляется при сохранении.'),
          h('div',{className:'tt-grid'},field('symbol','Монета',{text:true,placeholder:'BTC',maxLength:20,inputRef:formRef}),field('size','Количество монет',{unit:sym.replace('-USDT','')||'монет',placeholder:'Например, 0,01'})),
          h(Side,{value:form.side,onChange:v=>{if(!busy)change('side',v);}}),h('div',{className:'tt-grid'},field('entry','Цена входа',{unit:'USDT',placeholder:'0,00'}),field('exit','Цена выхода',{unit:'USDT',placeholder:'0,00'})),
          h(Pair,{label:'Результат без комиссий и фандинга',value:valid?signed(gross):'—',tone:valid?(gross>=0?'good':'bad'):undefined}),
          h(Details,{title:'Разбор и эмоции · необязательно'},h('small',null,'Добавь контекст, чтобы позже понимать причины результата.'),h('div',{className:'tt-emotions',role:'group','aria-label':'Эмоция во время сделки'},emotions.map(([id,emoji,label])=>h('button',{key:id,type:'button',disabled:busy,'aria-pressed':form.emotion===id,onClick:()=>change('emotion',form.emotion===id?'':id)},h('span',{'aria-hidden':true},emoji),label))),
            h('label',{className:'tt-field'},'Причина входа',h('textarea',{value:form.thesis,onChange:e=>change('thesis',e.target.value),maxLength:1000,disabled:busy,rows:3,placeholder:'Какую ситуацию увидел и почему вошёл?'})),
            h('label',{className:'tt-field'},'Вывод по сделке',h('textarea',{value:form.lesson,onChange:e=>change('lesson',e.target.value),maxLength:1000,disabled:busy,rows:3,placeholder:'Что получилось и что изменишь в следующий раз?'})),
            h('small',null,'Для прогресса в профиле — от 20 символов в причине и выводе. Сейчас: '+form.thesis.trim().length+' / '+form.lesson.trim().length+'.'),
            h('label',{className:'tt-field'},'Короткая заметка',h('textarea',{value:form.note,onChange:e=>change('note',e.target.value),maxLength:280,rows:2,disabled:busy,placeholder:'Что ещё хочется запомнить?'}))),
          h('div',{className:'tt-actions'},h(Btn,{type:'submit',primary:true,disabled:busy||preview||loading||deleting!==null,'aria-busy':busy},busy?'Сохраняю…':'Сохранить сделку'),h(Btn,{disabled:busy,onClick:()=>setResetConfirm(true)},'Очистить')),
          resetConfirm&&h('div',{className:'tt-confirm'},'Очистить поля черновика?',h('div',{className:'tt-actions'},h(Btn,{danger:true,disabled:busy,onClick:()=>{setForm(newJournal());setResetConfirm(false);setErr('');}},'Очистить'),h(Btn,{onClick:()=>setResetConfirm(false)},'Оставить'))),h('small',null,'Черновик сохраняется на этом устройстве, даже если свернуть форму.'))),
        err&&h('div',{className:'tt-error',role:'alert'},err,!preview&&h(Btn,{quiet:true,onClick:load,disabled:busy||loading||deleting!==null},'Обновить историю')),notice&&h(Note,null,notice),
        loadError&&h(Note,{warning:true},h('p',null,loadError+(loaded?' Ранее загруженные записи сохранены на экране.':'')),h(Btn,{quiet:true,onClick:load,disabled:loading},'Повторить загрузку')),
        loading&&h('div',{className:'tt-loading',role:'status'},h('span',{className:'motion-loader','aria-hidden':true}),'Загружаю дневник…'),
        h(Chips,{items:[['all','Всё время'],['7','7 дней'],['30','30 дней']],value:period,onChange:setPeriod,label:'Период по дате записи'}),
        h('div',{className:'tt-card tt-result'},h('small',null,'Результат по текущим фильтрам · без комиссий'),h('div',{className:'tt-result-amount '+(loaded&&stats.count?(stats.total>=0?'tt-good':'tt-bad'):'')},loaded&&stats.count?signed(stats.total):'—'),h('div',{className:'tt-grid'},h(Metric,{label:'Сделок',value:loaded?stats.count:'—'}),h(Metric,{label:'Прибыльных',value:loaded&&stats.count?pct(stats.winRate):'—'})),h('small',null,'Фильтр периода использует дату добавления записи.')),
        h(Search,{value:query,onChange:setQuery,label:'Поиск по монете'}),h(Chips,{items:[['all','Все'],['win','В плюс'],['lose','В минус'],['review','Без разбора']],value:filter,onChange:setFilter,label:'Фильтр дневника'}),
        hasMore&&h(Note,null,'Загружены последние 500 записей. Фильтры, аналитика и экспорт относятся к ним.'),
        h('div',{className:'tt-list'},!loaded&&!loading?h(Empty,{title:'История недоступна'},h('p',null,'Повтори загрузку, чтобы увидеть свои записи.')):!rows.length?h(Empty,{title:trades.length?'Нет сделок по этим фильтрам':'Здесь будет история твоих решений'},h('p',null,trades.length?'Измени период или очисти поиск.':'Начни с одной закрытой сделки. Можно добавить причину входа, эмоцию и вывод.'),h(Btn,{quiet:true,onClick:()=>{if(trades.length){setQuery('');setFilter('all');setPeriod('all');}else setOpen(true);}},trades.length?'Сбросить фильтры':'Добавить первую сделку')):
          rows.slice(0,limit).map((t,i)=>h(React.Fragment,{key:t.id},(i===0||fullDate(rows[i-1].ts)!==fullDate(t.ts))&&h('div',{className:'tt-date'},fullDate(t.ts)),
            h('details',{className:'tt-trade'},h('summary',null,h('div',null,h('div',{className:'tt-trade-top'},h('strong',null,t.symbol.replace('-USDT','')),h('span',{className:'tt-side-badge '+(t.side==='long'?'tt-good':'tt-bad')},t.side==='long'?'Лонг':'Шорт')),h('small',null,price(t.entry)+' → '+price(t.exit))),h('div',{style:{textAlign:'right'}},h('strong',{className:t.pnl>0?'tt-good':t.pnl<0?'tt-bad':'tt-muted'},signed(t.pnl)),h('div',null,h('small',null,t.thesis?.trim().length>=20&&t.lesson?.trim().length>=20?'✓ Разбор':'Подробнее ›')))),
              h('div',{className:'tt-trade-detail'},h(Pair,{label:'Количество',value:price(t.size)+' '+t.symbol.replace('-USDT','')}),h(Pair,{label:'Записано',value:time(t.ts)}),t.emotion&&h('small',null,'Эмоция: '+(emotions.find(e=>e[0]===t.emotion)?.[2]||t.emotion)),
                t.thesis&&h('p',null,h('strong',null,'Причина входа: '),t.thesis),t.lesson&&h('p',null,h('strong',null,'Вывод: '),t.lesson),t.note&&h('p',null,h('strong',null,'Заметка: '),t.note),
                confirm===t.id?h('div',{className:'tt-confirm'},'Удалить эту запись? Она исчезнет из статистики и прогресса профиля.',h('div',{className:'tt-actions'},h(Btn,{danger:true,disabled:deleting!==null||busy,'aria-busy':deleting===t.id,onClick:()=>remove(t.id)},'Удалить запись'),h(Btn,{disabled:deleting!==null,onClick:()=>setConfirm(null)},'Отмена'))):h(Btn,{quiet:true,onClick:()=>setConfirm(t.id),disabled:busy||deleting!==null},'Удалить…')))))),
        rows.length>limit&&h(Btn,{onClick:()=>setLimit(v=>v+20)},'Ещё '+Math.min(20,rows.length-limit)+' записей'),
        h(Details,{title:'Аналитика дневника'},h('small',null,'Те же фильтры, что у списка сделок. Это статистика записей, а не оценка будущей доходности.'),h('div',{className:'tt-analysis-grid'},h(Metric,{label:'Средний результат',value:money(stats.average)}),h(Metric,{label:'Отношение прибылей к убыткам',value:stats.profitFactor!==null?price(stats.profitFactor):stats.wins?'Нет убыточных сделок':'—'}),h(Metric,{label:'Плюс / минус / ноль',value:stats.wins+' / '+stats.losses+' / '+stats.flat}),h(Metric,{label:'Сделок с разбором',value:stats.reviewed+' из '+stats.count})),
          h('h3',null,'Накопленный результат'),stats.count?h('svg',{className:'tt-chart',viewBox:'0 0 300 90',role:'img','aria-label':'Накопленный результат от нуля по порядку записей'},h('line',{x1:5,x2:295,y1:85-(0-min)/span*75,y2:85-(0-min)/span*75,stroke:'#ffffff20',strokeDasharray:'3 3'}),h('polyline',{points,fill:'none',stroke:stats.total>=0?'#67dfa0':'#ff8992',strokeWidth:2,strokeLinejoin:'round'})):h('small',null,'График появится после первой записи.'),
          ['long','short'].map(side=>{const list=rows.filter(t=>t.side===side);return h(Pair,{key:side,label:(side==='long'?'Лонги':'Шорты')+' · '+list.length+' сделок',value:list.length?signed(M.stats(list).total):'—'});}),
          emotions.filter(([id])=>rows.some(t=>t.emotion===id)).map(([id,emoji,label])=>{const list=rows.filter(t=>t.emotion===id);return h(Pair,{key:id,label:emoji+' '+label+' · среднее по '+list.length,value:money(M.stats(list).average)});}),
          h(Btn,{onClick:exportCsv,disabled:!loaded||!rows.length},'Скачать эти записи · CSV')));
    }
    return{CalculatorsModule,ScreenerModule,JournalModule};
  };
})(window);
