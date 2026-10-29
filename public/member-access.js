/* Membership is enforced by the server. This screen only explains access state. */
(function (global) {
  'use strict';
  const nativeFetch = global.fetch.bind(global);
  // Local copies can preview the interface; server API permissions are unchanged.
  const localPreview = global.location.protocol === 'file:';
  const initData = () => global.Telegram?.WebApp?.initData || '';
  global.appFetch = async function (url, options = {}) {
    const target = new URL(url, global.location.href);
    const appApi = target.origin === global.location.origin && target.pathname.startsWith('/api/');
    const headers = new Headers(options.headers || {});
    if (appApi && initData()) headers.set('x-telegram-init-data', initData());
    const response = await nativeFetch(url, { ...options, headers });
    if (appApi && [401, 403, 503].includes(response.status)) {
      const error = await response.clone().json().catch(() => null);
      if (error && ['auth', 'not_member', 'membership_unavailable', 'channel_not_configured'].includes(error.reason)) {
        global.dispatchEvent(new CustomEvent('app-access-denied', { detail: error }));
      }
    }
    return response;
  };
  global.createMemberGate = function (React) {
    const h = React.createElement, { useState, useEffect, useRef } = React;
    const MemoryBoundary = global.createMemoryBindings(React).Boundary;
    return function MemberGate({ App }) {
      const [access, setAccess] = useState({ ok: false, reason: 'checking' });
      const [busy, setBusy] = useState(false), retry = useRef(null);
      useEffect(() => {
        if (localPreview) {
          let disposed = false;
          const snapshot = global.document.createElement('script');
          // Outside public/ and omitted from the deployment package.
          snapshot.src = new URL('../local-preview/pump-dump-data.js', global.location.href).href;
          const ready = () => { if (!disposed) setAccess({ ok: true }); };
          snapshot.onload = ready; snapshot.onerror = ready;
          global.document.head.appendChild(snapshot);
          return () => { disposed = true; snapshot.onload = null; snapshot.onerror = null; snapshot.remove(); };
        }
        let disposed = false, inFlight = false, controller, revision = 0;
        const check = async () => {
          if (disposed || inFlight) return;
          if (!initData()) { setAccess({ ok: false, reason: 'auth' }); return; }
          inFlight = true; setBusy(true);
          controller = new AbortController();
          const checkRevision = revision, timeout = setTimeout(() => controller.abort(), 9000);
          try {
            const response = await global.appFetch('/api/access', { method: 'POST', cache: 'no-store', signal: controller.signal });
            const result = await response.json();
            if (!disposed && (checkRevision === revision || !result.ok)) {
              if(response.ok && result.ok === true && Number.isSafeInteger(result.userId)) setAccess({ok:true,userId:result.userId});
              else if(result.reason==='membership_unavailable')setAccess(current=>current.ok?{...current,offline:true}:{...result,ok:false});
              else setAccess({...result,ok:false});
            }
          } catch (_) {
            if (!disposed) setAccess(current => current.ok ? {...current,offline:true} : {ok:false,reason:'membership_unavailable'});
          } finally { clearTimeout(timeout); inFlight = false; if (!disposed) setBusy(false); }
        };
        const deny = event => { revision++; if(event.detail?.reason==='membership_unavailable')setAccess(current=>current.ok?{...current,offline:true}:{...event.detail,ok:false});else setAccess({ ...event.detail, ok: false }); };
        const visible = () => { if (global.document.visibilityState === 'visible') check(); };
        retry.current = check;
        global.addEventListener('app-access-denied', deny);
        global.document.addEventListener('visibilitychange', visible);
        global.addEventListener('online', visible);
        global.Telegram?.WebApp?.onEvent?.('activated', visible);
        check();
        const timer = setInterval(visible, 60000);
        return () => { disposed = true; retry.current = null; controller?.abort(); clearInterval(timer); global.removeEventListener('app-access-denied', deny); global.document.removeEventListener('visibilitychange', visible); global.removeEventListener('online', visible); global.Telegram?.WebApp?.offEvent?.('activated', visible); };
      }, []);
      if (access.ok) return localPreview
        ? h('div', { className: 'member-preview' }, h('div', { className: 'member-preview-note' }, global.PUMP_DUMP_DATA?.events?.length ? 'Локальный просмотр · сохранённые сигналы' : 'Локальный просмотр'), h(MemoryBoundary,{App,preview:true,key:'preview'}))
        : h('div',{className:'member-offline-wrap'},access.offline&&h('div',{className:'member-offline-note',role:'status'},'Нет связи · доступ проверится после подключения'),h(MemoryBoundary,{App,userId:access.userId,key:String(access.userId)}));
      const reasons = {
        checking: ['Проверяем подписку', 'Это займёт несколько секунд.'],
        auth: ['Откройте в Telegram', 'Запустите приложение из бота, чтобы подтвердить участие в канале.'],
        not_member: ['Для участников канала', 'Вступите в канал и вернитесь сюда — доступ проверится автоматически. Если экран не обновился, нажмите «Проверить подписку».'],
        channel_not_configured: ['Скоро откроемся', 'Доступ для участников канала ещё настраивается.'],
        membership_unavailable: ['Не удалось проверить подписку', 'Повторите попытку немного позже.'],
      };
      const [title, detail] = reasons[access.reason] || reasons.membership_unavailable;
      const joinUrl = /^https:\/\/t\.me\/[a-zA-Z0-9_+\/-]+$/.test(access.channelUrl || '') ? access.channelUrl : '';
      const openChannel = () => { if (global.Telegram?.WebApp?.openTelegramLink) global.Telegram.WebApp.openTelegramLink(joinUrl); else global.open(joinUrl, '_blank', 'noopener,noreferrer'); };
      return h('main', { className: 'member-gate' }, h('section', { className: 'member-card', 'aria-label': 'Вход для участников канала' },
        h('div', { className: 'member-brand' }, 'ЧТО ПО РЫНКУ'),
        h('h1', null, title), h('p', { role: 'status' }, access.reason === 'checking' && h('span', { className: 'motion-loader', 'aria-hidden': true }), detail),
        joinUrl && h('button', { type: 'button', className: 'member-primary', onClick: openChannel }, 'Подписаться на канал'),
        access.reason !== 'checking' && h('button', { type: 'button', className: 'member-retry', disabled: busy, 'aria-busy': busy, onClick: () => retry.current?.() }, busy ? 'Проверяем…' : 'Проверить подписку')));
    };
  };
})(window);
