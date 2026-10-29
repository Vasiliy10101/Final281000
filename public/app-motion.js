(function (global) {
  'use strict';
  const preference = global.matchMedia?.('(prefers-reduced-motion: reduce)');
  const running = new Set();
  const easing = 'cubic-bezier(.22,1,.36,1)';
  const reduced = () => !!preference?.matches;

  // A cancelled animation never commits its old end state after a newer action.
  function play(node, frames, duration, finish) {
    if (reduced() || typeof node?.animate !== 'function') {
      finish?.();
      return null;
    }
    let animation;
    try { animation = node.animate(frames, { duration, easing, fill: 'both' }); }
    catch (_) { finish?.(); return null; }
    let active = true;
    const record = {
      cancel() {
        if (!active) return;
        active = false;
        running.delete(record);
        animation.cancel();
      },
      complete() {
        if (!active) return;
        active = false;
        running.delete(record);
        animation.cancel();
        finish?.();
      }
    };
    running.add(record);
    animation.finished.then(record.complete, () => {
      if (active) { active = false; running.delete(record); }
    });
    return record;
  }
  const preferenceChanged = () => {
    if (reduced()) [...running].forEach(record => record.complete());
  };
  preference?.addEventListener?.('change', preferenceChanged);

  function createReveal(React) {
    const { createElement: h, useState, useRef, useEffect } = React;
    return function MotionReveal({ open, children, className = '' }) {
      const [present, setPresent] = useState(!!open);
      const node = useRef(null), animation = useRef(null), revision = useRef(0);
      useEffect(() => {
        if (open && !present) { setPresent(true); return; }
        const element = node.current;
        if (!element) return;
        const version = ++revision.current;
        const interrupted = !!animation.current;
        const from = element.getBoundingClientRect().height;
        const opacity = interrupted ? global.getComputedStyle(element).opacity : (open ? '0' : '1');
        animation.current?.cancel();
        animation.current = null;
        const target = open ? element.scrollHeight : 0;
        animation.current = play(element, [
          { height: (open && !interrupted ? 0 : from) + 'px', opacity },
          { height: target + 'px', opacity: open ? 1 : 0 }
        ], open ? 260 : 190, () => {
          if (revision.current !== version) return;
          animation.current = null;
          if (!open) setPresent(false);
        });
      }, [open, present]);
      useEffect(() => () => {
        revision.current++;
        animation.current?.cancel();
        animation.current = null;
      }, []);
      return present ? h('div', {
        className: 'motion-reveal' + (className ? ' ' + className : ''), ref: node,
        'aria-hidden': open ? undefined : true, inert: open ? undefined : ''
      }, children) : null;
    };
  }

  // Native details keep their semantics and keyboard activation. Only geometry animates.
  function mount(root) {
    if (!root?.addEventListener) return () => {};
    const states = new Map();
    const click = event => {
      if (event.defaultPrevented) return;
      const summary = event.target?.closest?.('summary');
      const details = summary?.parentElement;
      if (!summary || details?.tagName !== 'DETAILS' || !root.contains(details)) return;
      const control = event.target.closest('a,button,input,textarea,select');
      if (control && summary.contains(control)) return;
      if (reduced() || typeof details.animate !== 'function') return;
      event.preventDefault();
      const previous = states.get(details);
      const open = !(previous ? previous.open : details.open);
      const from = details.getBoundingClientRect().height;
      previous?.animation?.cancel();
      details.open = true;
      const style = global.getComputedStyle(details);
      const edges = ['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth']
        .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
      const to = open ? details.getBoundingClientRect().height : summary.getBoundingClientRect().height + edges;
      const state = { open, animation: null };
      states.set(details, state);
      details.classList.add('motion-details-active');
      state.animation = play(details, [{ height: from + 'px' }, { height: to + 'px' }], open ? 260 : 190, () => {
        if (states.get(details) !== state) return;
        details.open = open;
        details.classList.remove('motion-details-active');
        states.delete(details);
      });
    };
    root.addEventListener('click', click);
    return () => {
      root.removeEventListener('click', click);
      for (const [details, state] of states) {
        state.animation?.cancel();
        details.open = state.open;
        details.classList.remove('motion-details-active');
      }
      states.clear();
    };
  }
  global.AppMotion = { createReveal, mount, reduced };
})(window);
