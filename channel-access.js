'use strict';
const crypto = require('node:crypto');

function createChannelAccess({ botToken = '', channelId = '', channelUrl = '', fetchImpl = global.fetch, clock = Date.now } = {}) {
  channelId = String(channelId).trim();
  const numericId = Number(channelId);
  const configured = /^@[a-zA-Z0-9_]{5,}$/.test(channelId) || (/^-\d+$/.test(channelId) && Number.isSafeInteger(numericId) && numericId <= -1000000000001 && numericId >= -1997852516352);
  const joinUrl = /^https:\/\/t\.me\/[a-zA-Z0-9_+\/-]+$/.test(channelUrl) ? channelUrl : (channelId.startsWith('@') && configured ? 'https://t.me/' + channelId.slice(1) : '');
  // Only simultaneous requests share a check. A completed permission is never reused.
  const pending = new Map();
  function verify(initData) {
    if (!botToken || typeof initData !== 'string' || !initData || initData.length > 16384) return null;
    try {
      const params = new URLSearchParams(initData), hash = params.get('hash');
      if (!/^[a-fA-F0-9]{64}$/.test(hash || '')) return null;
      const keys = [...params.keys()];
      if (new Set(keys).size !== keys.length) return null;
      params.delete('hash');
      const dataCheck = [...params].map(([k,v]) => k + '=' + v).sort().join('\n');
      const secret = crypto.createHmac('sha256','WebAppData').update(botToken).digest();
      const expected = crypto.createHmac('sha256',secret).update(dataCheck).digest();
      if (!crypto.timingSafeEqual(expected,Buffer.from(hash,'hex'))) return null;
      const authDate = Number(params.get('auth_date')), now = clock()/1000;
      if (!Number.isFinite(authDate) || authDate <= 0 || now-authDate > 86400 || authDate-now > 30) return null;
      const u = JSON.parse(params.get('user') || 'null');
      if (!u || !Number.isSafeInteger(u.id) || u.id <= 0) return null;
      return { id:u.id, first_name:u.first_name || '', username:u.username || null, startParam:params.get('start_param') || null };
    } catch (_) { return null; }
  }
  async function check(userId) {
    if (!configured || !botToken) return { ok:false, reason:'channel_not_configured' };
    if (pending.has(userId)) return pending.get(userId);
    const request=(async()=>{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),7000);
      try {
        const response=await fetchImpl('https://api.telegram.org/bot'+botToken+'/getChatMember',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:channelId,user_id:userId}),signal:controller.signal});
        if (!response.ok) return {ok:false,reason:'membership_unavailable'};
        const body=await response.json(),member=body.result;
        if (!body.ok || !member || Number(member.user?.id)!==userId) return {ok:false,reason:'membership_unavailable'};
        const allowed=['creator','administrator','member'].includes(member.status) || (member.status==='restricted' && member.is_member===true);
        if (!allowed) return {ok:false,reason:'not_member'};
        return {ok:true};
      } catch (_) { return {ok:false,reason:'membership_unavailable'}; }
      finally {clearTimeout(timeout);}
    })();
    pending.set(userId,request);
    try { return await request; } finally { pending.delete(userId); }
  }
  async function requireMember(req,res,next) {
    // These two bot endpoints retain their own secret checks in server.js.
    if (req.path==='/tg/webhook' || req.path==='/tg/setup') return next();
    res.set('Cache-Control','no-store');
    const user=verify(req.get('x-telegram-init-data') || req.body?.initData);
    if (!user) return res.status(401).json({ok:false,reason:'auth',channelUrl:joinUrl});
    const result=await check(user.id);
    if (!result.ok) return res.status(result.reason==='not_member'?403:503).json({...result,channelUrl:joinUrl});
    req.tgUser=user;
    return next();
  }
  return { verify, check, requireMember, joinUrl };
}
module.exports={createChannelAccess};
