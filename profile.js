'use strict';
const {progress,weekKey}=require('./public/profile-model');
function createCommunityCounter({botToken='',channelId='',fetchImpl=global.fetch,clock=Date.now}={}){
  let value=null,updatedAt=null,lastAttempt=null,pending=null;
  return {async get(){
    if(!botToken||!channelId)return{members:null,updatedAt:null,stale:false};
    if(pending)return pending;
    if(lastAttempt!==null&&clock()-lastAttempt<(updatedAt===lastAttempt?300000:60000))return{members:value,updatedAt,stale:updatedAt!==lastAttempt};
    pending=(async()=>{lastAttempt=clock();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);try{
      const r=await fetchImpl('https://api.telegram.org/bot'+botToken+'/getChatMemberCount',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:channelId}),signal:controller.signal});
      if(!r.ok)throw Error('unavailable');const d=await r.json();if(!d.ok||!Number.isSafeInteger(d.result)||d.result<0)throw Error('invalid_count');
      value=d.result;updatedAt=lastAttempt;return{members:value,updatedAt,stale:false};
    }catch(_){return{members:value,updatedAt,stale:true};}finally{clearTimeout(timer);}})();
    try{return await pending;}finally{pending=null;}
  }};
}
function createProfileService({pool,ensureUser,counter,channelUrl='',adminIds=[],clock=Date.now}={}){
  async function get(tg){
    const community=await counter.get(),base={schema_version:1,ok:true,isAdmin:adminIds.includes(tg.id),community:{...community,active7Days:null,channelUrl},member:{name:tg.first_name||'участник',username:tg.username||'',since:null,referrals:null},progress:null,personal:null,reflection:null};
    if(!pool)return{...base,status:'no_db'};
    const user=await ensureUser(tg),week=weekKey(clock());
    const [stats,weeks,awards,active,current,summary]=await Promise.all([
      pool.query(`SELECT count(*)::int AS trade_count, COALESCE(sum(CASE WHEN side='short' THEN (entry-exit)*size ELSE (exit-entry)*size END),0) AS pnl,
        count(*) FILTER (WHERE (CASE WHEN side='short' THEN (entry-exit)*size ELSE (exit-entry)*size END)>0)::int AS wins,
        count(DISTINCT (ts AT TIME ZONE 'Europe/Moscow')::date) FILTER (WHERE length(trim(COALESCE(thesis,'')))>=20 AND length(trim(COALESCE(lesson,'')))>=20 AND ts<=now())::int AS review_days
        FROM journal WHERE user_id=$1`,[tg.id]),
      pool.query('SELECT count(*)::int AS total FROM member_reflections WHERE user_id=$1',[tg.id]),
      pool.query('SELECT kind FROM member_awards WHERE user_id=$1',[tg.id]),
      pool.query("SELECT count(*)::int AS total FROM users WHERE last_seen_at >= now()-interval '7 days'"),
      pool.query('SELECT body FROM member_reflections WHERE user_id=$1 AND week_start=$2',[tg.id,week]),
      pool.query('SELECT body FROM member_summaries WHERE user_id=$1',[tg.id])
    ]);
    const s=stats.rows[0],kinds=new Set(awards.rows.map(r=>r.kind)),hasSummary=summary.rows.length>0;
    const p=progress({reviewDays:s.review_days,reviewWeeks:weeks.rows[0].total,summaryDone:hasSummary,mentor:kinds.has('mentor'),helper:kinds.has('helper'),referrals:user.referrals});
    return{...base,status:'ready',member:{...base.member,name:user.name,since:user.since,referrals:user.referrals,inviteLink:user.refLink||''},community:{...base.community,active7Days:Number(active.rows[0].total)},progress:p,personal:{tradeCount:Number(s.trade_count),pnl:Number(s.pnl),winRate:Number(s.trade_count)?Number(s.wins)/Number(s.trade_count)*100:null},reflection:{week,body:current.rows[0]?.body||'',summaryBody:summary.rows[0]?.body||'',summaryAvailable:p.counts.reviewWeeks>=8}};
  }
  async function saveReflection(tg,input){
    if(!pool)return{ok:false,reason:'no_db'};
    const kind=input?.kind,body=typeof input?.body==='string'?input.body.trim():'';
    if(!['weekly','summary'].includes(kind))return{ok:false,reason:'bad_kind'};
    if(body.length<40||body.length>2000)return{ok:false,reason:'reflection_length'};
    const week=weekKey(clock());
    if(kind==='weekly'&&input?.week!==week)return{ok:false,reason:'week_changed'};
    if(typeof input?.baseBody!=='string'||input.baseBody.length>2000)return{ok:false,reason:'reflection_version_required'};
    const baseBody=input.baseBody;
    await ensureUser(tg);
    let result;
    if(kind==='summary'){
      const {rows}=await pool.query('SELECT count(*)::int AS total FROM member_reflections WHERE user_id=$1',[tg.id]);
      if(Number(rows[0].total)<8)return{ok:false,reason:'summary_not_ready'};
      result=await pool.query(`INSERT INTO member_summaries (user_id,body) SELECT $1,$2 WHERE $3=''
        ON CONFLICT (user_id) DO UPDATE SET body=EXCLUDED.body, updated_at=now()
        WHERE member_summaries.body=$3 OR member_summaries.body=EXCLUDED.body RETURNING body`,[tg.id,body,baseBody]);
      if(!result.rows.length&&baseBody!=='')result=await pool.query('UPDATE member_summaries SET body=$2,updated_at=now() WHERE user_id=$1 AND (body=$3 OR body=$2) RETURNING body',[tg.id,body,baseBody]);
    }else{
      result=await pool.query(`INSERT INTO member_reflections (user_id,week_start,body) SELECT $1,$2,$3 WHERE $4=''
        ON CONFLICT (user_id,week_start) DO UPDATE SET body=EXCLUDED.body, updated_at=now()
        WHERE member_reflections.body=$4 OR member_reflections.body=EXCLUDED.body RETURNING body`,[tg.id,week,body,baseBody]);
      if(!result.rows.length&&baseBody!=='')result=await pool.query('UPDATE member_reflections SET body=$3,updated_at=now() WHERE user_id=$1 AND week_start=$2 AND (body=$4 OR body=$3) RETURNING body',[tg.id,week,body,baseBody]);
    }
    if(!result.rows.length){const current=await pool.query(kind==='weekly'?'SELECT body FROM member_reflections WHERE user_id=$1 AND week_start=$2':'SELECT body FROM member_summaries WHERE user_id=$1',kind==='weekly'?[tg.id,week]:[tg.id]);return{ok:false,reason:'reflection_conflict',body:current.rows[0]?.body||''};}
    return{ok:true};
  }
  async function award(admin,input){
    if(!pool)return{ok:false,reason:'no_db'};
    const userId=Number(input?.userId),kind=input?.kind;
    if(!Number.isSafeInteger(userId)||userId<=0||!['helper','mentor'].includes(kind)||typeof input?.enabled!=='boolean')return{ok:false,reason:'invalid_award'};
    const exists=await pool.query('SELECT id FROM users WHERE id=$1',[userId]);if(!exists.rows.length)return{ok:false,reason:'user_not_found'};
    if(input.enabled)await pool.query('INSERT INTO member_awards (user_id,kind,granted_by) VALUES ($1,$2,$3) ON CONFLICT (user_id,kind) DO NOTHING',[userId,kind,admin.id]);
    else await pool.query('DELETE FROM member_awards WHERE user_id=$1 AND kind=$2',[userId,kind]);
    return{ok:true};
  }
  return{get,saveReflection,award};
}
module.exports={createCommunityCounter,createProfileService};
