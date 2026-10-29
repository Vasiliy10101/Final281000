(function(root,factory){const model=factory();if(typeof module==='object'&&module.exports)module.exports=model;else root.MemberProfileModel=model;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const RANKS=[
    {id:'member',name:'Участник',level:1,mark:'I',color:'#a89dbf',rule:'Первый вход в приложение'},
    {id:'explorer',name:'Исследователь',level:2,mark:'II',color:'#b58aff',rule:'Разборы сделок в 5 разных днях'},
    {id:'practitioner',name:'Практик',level:3,mark:'III',color:'#58d5bd',rule:'5 дней с разборами и итоги 4 разных недель'},
    {id:'strategist',name:'Стратег',level:4,mark:'IV',color:'#e0b96d',rule:'5 дней с разборами, 8 недель итогов и итоговый разбор'},
    {id:'mentor',name:'Наставник',level:5,mark:'V',color:'#d5b4ff',rule:'Назначается основателем за помощь сообществу'}
  ];
  const nonnegative=n=>Number.isFinite(Number(n))?Math.max(0,Math.floor(Number(n))):0;
  function progress(values={}){
    const days=nonnegative(values.reviewDays),weeks=nonnegative(values.reviewWeeks),summary=values.summaryDone===true,mentor=values.mentor===true;
    const index=mentor?4:days>=5&&weeks>=8&&summary?3:days>=5&&weeks>=4?2:days>=5?1:0;
    const next=RANKS[index+1]||null;
    const requirement=(label,current,target,action)=>({label,current:Math.min(current,target),target,action,done:current>=target});
    const requirements=index===0?[requirement('Дни с полным разбором',days,5,'journal')]:index===1?[requirement('Недели с итогами',weeks,4,'weekly')]:index===2?[requirement('Недели с итогами',weeks,8,'weekly'),requirement('Итоговый разбор',summary?1:0,1,'summary')]:[];
    const fraction=requirements.length?requirements.reduce((sum,r)=>sum+r.current/r.target,0)/requirements.length:null;
    const achievement=(id,title,detail,current,target,action)=>({id,title,detail,current:Math.min(current,target),target,done:current>=target,action});
    return {rank:RANKS[index],next,requirements,fraction,counts:{reviewDays:days,reviewWeeks:weeks,summaryDone:summary},achievements:[
      achievement('first_review','Первый разбор','Запиши причину входа и вывод по сделке',days,1,'journal'),
      achievement('weekly_system','Системный подход','Подведи итоги в 4 разных неделях',weeks,4,'weekly'),
      achievement('community_help','Вклад в сообщество','Помощь участникам, подтверждённая основателем',values.helper?1:0,1,'manual'),
      achievement('five_days','Осознанная практика','Разборы сделок в 5 разных днях',days,5,'journal'),
      achievement('eight_weeks','Дистанция','Подведи итоги в 8 разных неделях',weeks,8,'weekly'),
      achievement('first_friend','Вместе сильнее','Пригласи первого участника в приложение',nonnegative(values.referrals),1,'invite')
    ]};
  }
  function weekKey(ms){
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));
    const get=key=>parts.find(p=>p.type===key).value;
    const date=new Date(get('year')+'-'+get('month')+'-'+get('day')+'T00:00:00Z');
    date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7));return date.toISOString().slice(0,10);
  }
  return {RANKS,progress,weekKey};
});
