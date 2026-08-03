/* 元件行為。每個元件的互動邏輯集中在這裡，七個 App 共用同一套手感。 */

import { gsap, still, carbonTransfer, tearOff } from './motion.js';
import { parseNum, clamp } from './format.js';

/* ---------- DOM 小工具 ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

/* ---------- 圖示：自繪，單一線寬 1.75，方端點 ---------- */
const ICONS = {
  sheet: '<path d="M4 2h10l6 6v14H4z"/><path d="M14 2v6h6"/>',
  slider: '<path d="M3 8h18M3 16h18"/><rect x="7" y="4" width="4" height="8"/><rect x="14" y="12" width="4" height="8"/>',
  tear: '<path d="M6 3v18"/><path d="M10 3l0 3 0 3 0 3 0 3 0 3 0 3"/><path d="M14 3h6v18h-6"/>',
  stamp: '<path d="M6 20h12"/><path d="M8 17h8V13a4 4 0 0 0-1-2.6C14 9 14 8 14.4 6.6A2.6 2.6 0 0 0 12 3a2.6 2.6 0 0 0-2.4 3.6C10 8 10 9 9 10.4A4 4 0 0 0 8 13z"/>',
  share: '<path d="M4 12v8h16v-8"/><path d="M12 3v13"/><path d="M8 7l4-4 4 4"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  moon: '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M5 5l14 14M19 5L5 19"/>',
  back: '<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>',
  go: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  warn: '<path d="M12 3L2 21h20z"/><path d="M12 10v5M12 18v.5"/>',
  copy: '<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-5M12 16V7M16 16v-8"/>',
  down: '<path d="M12 4v14"/><path d="M6 13l6 6 6-6"/>',
};

export function icon(name, cls = '') {
  const svg = `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
  const t = document.createElement('template');
  t.innerHTML = svg;
  return t.content.firstElementChild;
}
export function iconHTML(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}

/* ==========================================================================
   滑桿：本套件最重要的輸入。拖動 = 論證。
   每個滑桿都有等效的數字輸入（鍵盤與精確值的路徑）。
   ========================================================================== */
export function bindSlider(root, { onInput, format = (v) => String(v), live = true } = {}) {
  const range = $('input[type="range"]', root);
  const twin = $('.slider__twin input', root);
  const valueEl = $('.slider__value', root);
  if (!range) return { set() {}, value: () => NaN };

  const paint = () => {
    const min = Number(range.min || 0), max = Number(range.max || 100);
    const pctv = max === min ? 0 : ((Number(range.value) - min) / (max - min)) * 100;
    range.style.setProperty('--fill', pctv + '%');
  };

  // 顯示值是給眼睛看的（「不變」「升 2 碼」「400 萬」），原始 value 常常是
  // 一個沒有意義的數（-2、4000000）。讀螢幕的人必須聽到跟看到的同一件事，
  // 所以每次重畫都把格式化後的純文字寫回 aria-valuetext。
  const plain = (html) => String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const show = (v) => {
    const shown = format(v);
    if (valueEl) valueEl.innerHTML = shown;
    const text = plain(shown);
    if (text) range.setAttribute('aria-valuetext', text);
    if (twin && document.activeElement !== twin) twin.value = String(v);
  };

  const emit = (v, source) => { paint(); show(v); onInput?.(v, source); };

  range.addEventListener('input', () => emit(Number(range.value), 'drag'));
  range.addEventListener('change', () => emit(Number(range.value), 'commit'));

  if (twin) {
    const commitTwin = () => {
      const v = clamp(parseNum(twin.value, Number(range.value)), Number(range.min), Number(range.max));
      const step = Number(range.step || 1);
      const snapped = Math.round(v / step) * step;
      range.value = String(snapped);
      emit(Number(range.value), 'type');
    };
    twin.addEventListener('change', commitTwin);
    twin.addEventListener('blur', commitTwin);
    twin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitTwin(); twin.blur(); } });
  }

  paint(); show(Number(range.value));

  return {
    set(v, { silent = false } = {}) {
      range.value = String(v);
      paint(); show(Number(range.value));
      if (!silent) onInput?.(Number(range.value), 'set');
    },
    value: () => Number(range.value),
    el: range,
  };
}

/* ==========================================================================
   填寫格：驗證即時、錯誤在下方、不用 placeholder 當標籤
   ========================================================================== */
export function bindField(root, { onChange, validate, parse = parseNum, pretty } = {}) {
  const input = $('input, select, textarea', root);
  const errEl = $('.field__error', root);
  if (!input) return { set() {}, value: () => undefined };

  const run = (source) => {
    const raw = input.value;
    const v = input.tagName === 'SELECT' ? raw : parse(raw);
    const err = validate ? validate(v, raw) : null;
    if (err) {
      root.dataset.state = 'error';
      if (errEl) errEl.textContent = err;
      input.setAttribute('aria-invalid', 'true');
    } else {
      delete root.dataset.state;
      input.removeAttribute('aria-invalid');
    }
    onChange?.(v, { valid: !err, source, raw });
  };

  input.addEventListener('input', () => run('type'));
  input.addEventListener('change', () => run('commit'));
  // 離開欄位時補上千分位，因為六位數以上不分節根本讀不出來；
  // 回到欄位時還原成純數字，才好編輯。
  input.addEventListener('focus', () => {
    if (!pretty) return;
    const v = parse(input.value);
    if (Number.isFinite(v)) input.value = String(v);
  });
  input.addEventListener('blur', () => {
    if (input.tagName === 'SELECT') return;
    const v = parse(input.value);
    if (Number.isFinite(v)) input.value = pretty ? pretty(v) : String(v);
    run('commit');
  });

  return {
    set(v, { silent = false } = {}) {
      const num = typeof v === 'number' ? v : parse(v);
      input.value = v === '' || v == null ? ''
        : (pretty && Number.isFinite(num) ? pretty(num) : String(v));
      if (!silent) run('set');
    },
    value: () => (input.tagName === 'SELECT' ? input.value : parse(input.value)),
    el: input,
  };
}

/* ==========================================================================
   勾選格
   ========================================================================== */
export function bindSegmented(root, { onChange } = {}) {
  const opts = $$('.segmented__opt', root);
  const select = (val, emit = true) => {
    opts.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(val))));
    if (emit) onChange?.(val);
  };
  opts.forEach((b) => b.addEventListener('click', () => select(b.dataset.value)));
  const cur = opts.find((b) => b.getAttribute('aria-pressed') === 'true');
  return { set: (v) => select(v, false), value: () => (opts.find((b) => b.getAttribute('aria-pressed') === 'true') || {}).dataset?.value, current: cur?.dataset.value };
}

/* ==========================================================================
   四聯情境
   ========================================================================== */
export function createPlies(host, { max = 4, onSwitch, onAdd, onRemove, labels = [] } = {}) {
  let items = [{ id: 1, label: labels[0] || '第一聯' }];
  let active = 1;
  let nextId = 2;

  function render() {
    host.innerHTML = '';
    host.setAttribute('role', 'tablist');
    items.forEach((it, i) => {
      const b = el('button', {
        class: 'ply',
        type: 'button',
        role: 'tab',
        'data-ply': String(i + 1),
        'aria-selected': String(it.id === active),
        onclick: () => { if (it.id !== active) { active = it.id; render(); onSwitch?.(it.id); } },
      }, [
        el('span', { class: 'ply__swatch' }),
        el('span', { text: it.label }),
      ]);
      if (items.length > 1) {
        b.appendChild(el('span', {
          class: 'ply__close',
          role: 'button',
          tabindex: '0',
          'aria-label': `刪除${it.label}`,
          html: iconHTML('close'),
          onclick: (e) => {
            e.stopPropagation();
            const removed = it.id;
            items = items.filter((x) => x.id !== removed);
            if (active === removed) active = items[0].id;
            render();
            onRemove?.(removed, active);
          },
        }));
      }
      host.appendChild(b);
    });
    if (items.length < max) {
      const add = el('button', {
        class: 'ply ply--add',
        type: 'button',
        'aria-label': '複寫一份新情境來比較',
        html: iconHTML('plus') + '<span>另存情境</span>',
        onclick: () => {
          const id = nextId++;
          const label = labels[items.length] || `第${'一二三四'[items.length] || items.length + 1}聯`;
          items.push({ id, label });
          active = id;
          render();
          const btn = host.querySelector('[aria-selected="true"]');
          tearOff(btn);
          onAdd?.(id);
        },
      });
      host.appendChild(add);
    }
  }
  render();
  return {
    active: () => active,
    items: () => items.slice(),
    rename(id, label) { const it = items.find((x) => x.id === id); if (it) { it.label = label; render(); } },
  };
}

/* ==========================================================================
   提示訊息
   ========================================================================== */
let toastHost;
export function toast(msg, ms = 2400) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = el('div', { class: 'toast', text: msg });
  toastHost.appendChild(t);
  if (still()) {
    setTimeout(() => t.remove(), ms);
  } else {
    gsap.fromTo(t, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.24 });
    gsap.to(t, { y: 8, opacity: 0, duration: 0.24, delay: ms / 1000, onComplete: () => t.remove() });
  }
}

/* ==========================================================================
   主題切換
   ========================================================================== */
export function mountTheme(host) {
  const KEY = 'vm:theme';
  const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  if (saved === 'dark' || saved === 'light') document.documentElement.dataset.theme = saved;

  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    if (t) return t === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const btn = el('button', {
    class: 'btn btn--quiet btn--sm',
    type: 'button',
    'aria-label': '切換日間／夜間',
    title: '切換日間／夜間',
  });
  const paint = () => { btn.innerHTML = iconHTML(isDark() ? 'sun' : 'moon'); };
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* noop */ }
    paint();
  });
  paint();
  host.appendChild(btn);
  return btn;
}

/* ==========================================================================
   分享情境（沒有後端，網址就是儲存體）
   ========================================================================== */
export function mountShare(host, store, label = '複製情境連結') {
  const btn = el('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    html: iconHTML('share') + `<span>${label}</span>`,
  });
  btn.addEventListener('click', async () => {
    const url = store.shareUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast('連結已複製，貼給誰都能看到同一組數字');
    } catch {
      // 剪貼簿被擋時，退回可手動複製的路徑
      const box = el('input', { class: 'num', value: url, style: 'position:fixed;left:-9999px' });
      document.body.appendChild(box); box.select();
      try { document.execCommand('copy'); toast('連結已複製'); }
      catch { prompt('複製這段網址：', url); }
      box.remove();
    }
  });
  host.appendChild(btn);
  return btn;
}

/* ==========================================================================
   頂欄
   ========================================================================== */
export function mountTopbar({ title, base = '../../' } = {}) {
  const bar = el('header', { class: 'topbar' }, [
    el('a', { class: 'topbar__mark', href: base + 'index.html' }, [
      icon('back'),
      el('span', { text: '看得見的錢' }),
    ]),
    el('span', { class: 'topbar__spacer' }),
  ]);
  document.body.insertBefore(bar, document.body.firstChild);
  if (title) document.title = `${title}｜看得見的錢`;
  return bar;
}

/* ==========================================================================
   長表格的虛擬捲動：480 期攤還表在手機上不能一次塞進 DOM
   ========================================================================== */
export function virtualTable(wrap, { rowHeight = 36, render, total = 0, buffer = 8 }) {
  const tbody = $('tbody', wrap);
  const spacerTop = el('tr', { style: 'height:0' , 'aria-hidden': 'true'});
  const spacerBot = el('tr', { style: 'height:0', 'aria-hidden': 'true' });
  let count = total;

  function paint() {
    const scrollTop = wrap.scrollTop;
    const view = wrap.clientHeight || 320;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - buffer);
    const visible = Math.ceil(view / rowHeight) + buffer * 2;
    const last = Math.min(count, first + visible);

    tbody.replaceChildren();
    spacerTop.style.height = first * rowHeight + 'px';
    spacerBot.style.height = Math.max(0, (count - last) * rowHeight) + 'px';
    tbody.appendChild(spacerTop);
    for (let i = first; i < last; i++) {
      const tr = render(i);
      if (tr) tbody.appendChild(tr);
    }
    tbody.appendChild(spacerBot);
  }

  let ticking = false;
  wrap.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { paint(); ticking = false; });
  }, { passive: true });

  return {
    setTotal(n) { count = n; wrap.scrollTop = 0; paint(); },
    refresh: paint,
    scrollToRow(i) { wrap.scrollTop = Math.max(0, i * rowHeight - wrap.clientHeight / 2); paint(); },
  };
}

/* ==========================================================================
   圖表提示氣泡
   ========================================================================== */
export function createTip(host) {
  const tip = el('div', { class: 'tip', role: 'status', 'aria-live': 'off' });
  host.appendChild(tip);
  let visible = false;
  return {
    show(html, x, y) {
      tip.innerHTML = html;
      const hb = host.getBoundingClientRect();
      const tb = tip.getBoundingClientRect();
      let left = x + 12;
      if (left + tb.width > hb.width - 4) left = x - tb.width - 12;
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = Math.max(4, Math.min(hb.height - tb.height - 4, y - tb.height - 10)) + 'px';
      if (!visible) { visible = true; gsap.to(tip, { opacity: 1, duration: still() ? 0 : 0.12 }); }
    },
    hide() {
      if (!visible) return;
      visible = false;
      gsap.to(tip, { opacity: 0, duration: still() ? 0 : 0.12 });
    },
    el: tip,
  };
}

/* ==========================================================================
   公式抽屜：每個數字都能攤開看代入值與法源
   ========================================================================== */
export function formulaBlock(title, lines, source) {
  return el('details', { class: 'formula' }, [
    el('summary', { text: title }),
    el('div', { class: 'formula__body' }, [
      ...lines.map((l) => el('div', { class: 'formula__line', html: l })),
      source ? el('p', { class: 'formula__src', html: source }) : null,
    ]),
  ]);
}

/** 依賴的數字更新時，讓它們一起浮出來，使用者看得到「因為我改了 X」 */
export function markUpdated(scope) {
  carbonTransfer($$('[data-live]', scope));
}
