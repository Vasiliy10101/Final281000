'use strict';
const {progress,RANKS}=require('./public/profile-model');
async function communitySummary(pool){
 if(!pool)return{ok:false,reason:'no_db'};
 const {rows}=await pool.query(`SELECT u.id, (u.last_seen_at>=now()-interval '7 days') AS active7, (u.last_seen_at>=now()-interval '30 days') AS active30,
   COALESCE(j.days,0) AS days, COALESCE(w.weeks,0) AS weeks, (s.user_id IS NOT NULL) AS summary,
   COALESCE(a.mentor,false) AS mentor,COALESCE(a.helper,false) AS helper,COALESCE(r.refs,0) AS refs
 FROM users u
 LEFT JOIN (SELECT user_id,count(DISTINCT (ts AT TIME ZONE 'Europe/Moscow')::date) FILTER (WHERE length(trim(COALESCE(thesis,'')))>=20 AND length(trim(COALESCE(lesson,'')))>=20 AND ts<=now()) AS days FROM journal GROUP BY user_id) j ON j.user_id=u.id
 LEFT JOIN (SELECT user_id,count(*) AS weeks FROM member_reflections GROUP BY user_id) w ON w.user_id=u.id
 LEFT JOIN member_summaries s ON s.user_id=u.id
 LEFT JOIN (SELECT user_id,bool_or(kind='mentor') AS mentor,bool_or(kind='helper') AS helper FROM member_awards GROUP BY user_id) a ON a.user_id=u.id
 LEFT JOIN (SELECT referred_by,count(*) AS refs FROM users WHERE referred_by IS NOT NULL GROUP BY referred_by) r ON r.referred_by=u.id
 WHERE u.app_first_seen_at IS NOT NULL`);
 const ranks=RANKS.map(r=>({id:r.id,title:r.name,count:0})),achievements=progress().achievements.map(a=>({id:a.id,title:a.title,count:0}));
 for(const r of rows){const p=progress({reviewDays:r.days,reviewWeeks:r.weeks,summaryDone:r.summary,mentor:r.mentor,helper:r.helper,referrals:r.refs});ranks.find(x=>x.id===p.rank.id).count++;for(const a of p.achievements)if(a.done)achievements.find(x=>x.id===a.id).count++;}
 return{ok:true,members:rows.length,active7:rows.filter(r=>r.active7).length,active30:rows.filter(r=>r.active30).length,ranks,achievements};
}
module.exports={communitySummary};
