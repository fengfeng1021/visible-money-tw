/* 動效語彙。
   規則：每一個動作都必須能用一句話說明它讓使用者理解了什麼。
   說不出來的就不做。全部尊重 prefers-reduced-motion，降級為即時到位。 */

const gsap = window.gsap;
if (window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);
if (window.CustomEase) {
  gsap.registerPlugin(window.CustomEase);
  // 紙落定的感覺：快速起步、長尾收束
  window.CustomEase.create('paper', 'M0,0 C0.12,0.86 0.2,1 1,1');
}

export const EASE = window.CustomEase ? 'paper' : 'power3.out';

const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
export const reduced = () => mqReduce.matches;
/** 動畫該不該播：使用者要求降低動效，或分頁在背景（rAF 不跑，動畫會卡在起始值）。 */
export const still = () => mqReduce.matches || document.visibilityState !== 'visible';

gsap.defaults({ duration: 0.42, ease: EASE });

export { gsap };

/* --------------------------------------------------------------------------
   1. 逐行推出（line feed）
   說明：結果一列一列被推出來，建立閱讀順序，也讓人感覺數字是被算出來的。
   -------------------------------------------------------------------------- */
export function printRows(targets, { stagger = 0.045, delay = 0 } = {}) {
  const els = gsap.utils.toArray(targets);
  if (!els.length) return null;
  if (still()) {
    gsap.set(els, { clearProps: 'all', opacity: 1, x: 0 });
    return null;
  }
  return gsap.fromTo(els,
    { opacity: 0, x: -8, clipPath: 'inset(0 100% 0 0)' },
    {
      opacity: 1, x: 0, clipPath: 'inset(0 0% 0 0)',
      duration: 0.36, stagger, delay, ease: EASE,
      clearProps: 'clipPath,transform',
    });
}

/* --------------------------------------------------------------------------
   2. 複寫壓力傳遞（carbon transfer）
   說明：我改了上面的欄位，下面哪些數字跟著變 —— 因果關係被看見。
   -------------------------------------------------------------------------- */
export function carbonTransfer(targets, { stagger = 0.03 } = {}) {
  const els = gsap.utils.toArray(targets);
  if (!els.length || still()) return null;
  return gsap.fromTo(els,
    { opacity: 0.35, y: -2 },
    { opacity: 1, y: 0, duration: 0.28, stagger, ease: EASE, overwrite: 'auto' });
}

/* --------------------------------------------------------------------------
   3. 蓋章（stamp）
   說明：結論落定。一次狀態轉換的終結感，一頁只用在真正的結論上。
   -------------------------------------------------------------------------- */
export function stampIn(target, { rotate = -3 } = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return null;
  if (still()) { gsap.set(el, { opacity: 1, scale: 1, rotate }); return null; }
  return gsap.fromTo(el,
    { opacity: 0, scale: 1.5, rotate: rotate - 9, filter: 'blur(3px)' },
    { opacity: 1, scale: 1, rotate, filter: 'blur(0px)', duration: 0.34, ease: 'back.out(2.2)' });
}

/* --------------------------------------------------------------------------
   4. 數字滾動（count）
   說明：讓變化的「幅度」被感覺到，而不只是被讀到。高頻更新請用 makeCounter。
   -------------------------------------------------------------------------- */
export function countTo(el, to, format, { duration = 0.5, from } = {}) {
  if (!el) return null;
  const start = Number.isFinite(from) ? from : (Number(el.dataset.v) || 0);
  el.dataset.v = String(to);
  if (still() || !Number.isFinite(to)) {
    el.textContent = format(to);
    return null;
  }
  const o = { v: start };
  return gsap.to(o, {
    v: to, duration, ease: EASE, overwrite: 'auto',
    onUpdate() { el.textContent = format(o.v); },
    onComplete() { el.textContent = format(to); },
  });
}

/** 拖曳滑桿這種每幀更新的場景，用 quickTo 重複利用同一個 tween。
    分頁在背景時 requestAnimationFrame 不會跑，動畫會卡在起始值，
    所以隱藏時直接寫入最終值 —— 數字正確永遠比動畫重要。 */
export function makeCounter(el, format, { duration = 0.28, html = false } = {}) {
  if (!el) return () => {};
  const write = (v) => { if (html) el.innerHTML = format(v); else el.textContent = format(v); };
  const o = { v: Number(el.dataset.v) || 0 };
  const snap = (to) => { o.v = to; el.dataset.v = String(to); write(to); };
  if (still()) return (to) => { if (Number.isFinite(to)) snap(to); };

  const q = gsap.quickTo(o, 'v', {
    duration, ease: 'power2.out',
    onUpdate() { write(o.v); },
    onComplete() { write(Number(el.dataset.v)); },
  });
  return (to) => {
    if (!Number.isFinite(to)) return;
    el.dataset.v = String(to);
    if (document.visibilityState !== 'visible') { snap(to); return; }
    q(to);
  };
}

/* --------------------------------------------------------------------------
   5. 撕開騎縫線（tear off）
   說明：複製一份情境出來比較 —— 分岔這件事變成一個實體動作。
   -------------------------------------------------------------------------- */
export function tearOff(el) {
  if (!el || still()) return null;
  return gsap.fromTo(el,
    { xPercent: -4, opacity: 0, skewX: 3 },
    { xPercent: 0, opacity: 1, skewX: 0, duration: 0.4, ease: 'back.out(1.6)' });
}

/* --------------------------------------------------------------------------
   6. 進入視窗時揭露
   說明：長頁面上，讓使用者知道「這一段是新的」。只做一次，不來回。
   -------------------------------------------------------------------------- */
export function revealOnScroll(selector, { start = 'top 88%' } = {}) {
  const ST = window.ScrollTrigger;
  const els = gsap.utils.toArray(selector);
  if (!els.length) return;
  if (still() || !ST) { gsap.set(els, { opacity: 1, y: 0 }); return; }
  gsap.set(els, { opacity: 0, y: 14 });
  ST.batch(els, {
    start,
    once: true,
    onEnter: (batch) => gsap.to(batch, {
      opacity: 1, y: 0, duration: 0.5, stagger: 0.07, ease: EASE, overwrite: true,
    }),
  });
}

/* --------------------------------------------------------------------------
   7. 警示脈動：只用在使用者剛剛越過一條有意義的線時，且只播一次。
   -------------------------------------------------------------------------- */
export function flagCross(el) {
  if (!el) return null;
  if (still()) return null;
  return gsap.fromTo(el,
    { backgroundColor: 'var(--warn-wash)' },
    { backgroundColor: 'transparent', duration: 0.9, ease: 'power2.out' });
}

/** 清掉一個容器內所有 ScrollTrigger（單頁切換情境時避免殘留） */
export function killTriggers(root) {
  const ST = window.ScrollTrigger;
  if (!ST) return;
  ST.getAll().forEach((t) => {
    if (!root || (t.trigger && root.contains(t.trigger))) t.kill();
  });
}
