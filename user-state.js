'use strict';
const {valid,same}=require('./public/user-state-model');
function createUserState({pool,ensureUser}){
  const record=r=>r?{key:r.state_key,value:r.value,revision:Number(r.revision),updatedAt:r.updated_at,operationId:r.last_operation}:null;
  async function get(tg){if(!pool)return{ok:false,reason:'no_db'};await ensureUser(tg);const {rows}=await pool.query('SELECT state_key,value,revision,updated_at,last_operation FROM user_state WHERE user_id=$1',[tg.id]);return{ok:true,userId:tg.id,records:rows.map(record)};}
  async function put(tg,input){
    if(!pool)return{ok:false,reason:'no_db'};
    const {key,value,baseRevision,operationId}=input||{};
    if(!valid(key,value)||!Number.isSafeInteger(baseRevision)||baseRevision<0||baseRevision>2147483646||typeof operationId!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(operationId))return{ok:false,reason:'invalid_state'};
    await ensureUser(tg);
    const {rows}=await pool.query(`INSERT INTO user_state(user_id,state_key,value,revision,last_operation)
      SELECT $1,$2,$3::jsonb,1,$5 WHERE $4=0
      ON CONFLICT(user_id,state_key) DO UPDATE SET value=EXCLUDED.value,revision=user_state.revision+1,last_operation=EXCLUDED.last_operation,updated_at=now()
      WHERE user_state.revision=$4 RETURNING state_key,value,revision,updated_at,last_operation`,[tg.id,key,JSON.stringify(value),baseRevision,operationId]);
    // Existing records with a nonzero base use an atomic compare-and-swap update.
    if(rows.length)return{ok:true,userId:tg.id,record:record(rows[0])};
    if(baseRevision>0){const updated=await pool.query('UPDATE user_state SET value=$3::jsonb,revision=revision+1,last_operation=$5,updated_at=now() WHERE user_id=$1 AND state_key=$2 AND revision=$4 RETURNING state_key,value,revision,updated_at,last_operation',[tg.id,key,JSON.stringify(value),baseRevision,operationId]);if(updated.rows.length)return{ok:true,userId:tg.id,record:record(updated.rows[0])};}
    const current=await pool.query('SELECT state_key,value,revision,updated_at,last_operation FROM user_state WHERE user_id=$1 AND state_key=$2',[tg.id,key]);const r=current.rows[0];
    if(r?.last_operation===operationId&&same(r.value,value))return{ok:true,userId:tg.id,record:record(r),replayed:true};
    return{ok:false,reason:'state_conflict',userId:tg.id,record:record(r)};
  }
  return{get,put};
}
module.exports={createUserState};
