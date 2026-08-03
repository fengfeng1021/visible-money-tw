/* 財務檔案的介面。

   核心互動：**缺什麼才問什麼**。
   時間軸上一條變動需要三格才算得出金額，就只問那三格，就地填、就地算。
   使用者永遠不會面對一張 30 欄的表單，而每填一格就多解鎖一條答案。
*/

import { FIELDS, GROUPS, get, getOr, has, set, missing, completeness, display } from './profile.js';
import { el, $, $$, iconHTML, toast } from './ui.js';
import { carbonTransfer, printRows } from './motion.js';
import { int, parseNum } from './format.js';

/* ==========================================================================
   單一欄位的控制項
   ========================================================================== */
export function fieldControl(key, { onChange, compact = false } = {}) {
  const f = FIELDS[key];
  if (!f) return el('span');

  const wrap = el('label', { class: 'field' + (compact ? ' field--compact' : ''), 'data-key': key });
  wrap.appendChild(el('span', { class: 'field__label', text: f.label }));

  const control = el('span', { class: 'field__control' });

  if (f.type === 'bool') {
    const sw = el('label', { class: 'switch' }, [
      el('input', {
        type: 'checkbox',
        checked: Boolean(getOr(key, false)),
        onchange: (e) => { set({ [key]: e.target.checked }); onChange?.(e.target.checked); },
      }),
      el('span', { class: 'switch__box' }),
      el('span', { text: f.label }),
    ]);
    wrap.replaceChildren(sw);
    return wrap;
  }

  if (f.type === 'enum') {
    const sel = el('select', {
      onchange: (e) => { set({ [key]: e.target.value }); onChange?.(e.target.value); },
    }, f.options.map(([v, label]) => el('option', { value: v, text: label, selected: getOr(key) === v })));
    control.appendChild(sel);
  } else {
    const raw = get(key);
    const shown = raw === undefined ? '' : (f.type === 'money' ? int(raw) : String(raw));
    const input = el('input', {
      type: 'text',
      inputmode: f.type === 'rate' ? 'decimal' : 'numeric',
      value: shown,
      placeholder: f.default !== undefined && f.default !== 0 ? String(f.default) : '',
      onfocus: (e) => { const v = parseNum(e.target.value, NaN); if (Number.isFinite(v)) e.target.value = String(v); },
      onblur: (e) => {
        const v = e.target.value.trim();
        set({ [key]: v === '' ? undefined : v });
        const now = get(key);
        e.target.value = now === undefined ? '' : (f.type === 'money' ? int(now) : String(now));
        onChange?.(now);
      },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
    });
    control.appendChild(input);
    if (f.unit) control.appendChild(el('span', { class: 'field__unit', text: f.unit }));
  }

  wrap.appendChild(control);
  if (f.ask && !compact) wrap.appendChild(el('span', { class: 'field__hint', text: f.ask }));
  return wrap;
}

/* ==========================================================================
   問缺的那幾格。
   need 是這個計算需要的欄位；已經填過的不會再問。
   ========================================================================== */
export function askBox(need, { onReady, title = '再告訴我這幾件事就能算', compact = true } = {}) {
  const host = el('div', { class: 'askbox' });

  function render() {
    const gaps = missing(need);
    host.replaceChildren();

    if (!gaps.length) {
      host.hidden = true;
      onReady?.();
      return;
    }
    host.hidden = false;
    host.appendChild(el('p', { class: 'askbox__lead', text: title }));
    const grid = el('div', { class: 'askbox__grid' });
    for (const k of gaps) {
      grid.appendChild(fieldControl(k, { compact, onChange: () => render() }));
    }
    host.appendChild(grid);
    host.appendChild(el('p', {
      class: 'askbox__note',
      text: '填過的東西會記在這台裝置上，其他工具不會再問你一次。',
    }));
    printRows($$('.field', grid), { stagger: 0.04 });
  }

  render();
  return { el: host, refresh: render };
}

/* ==========================================================================
   完整的檔案編輯器（我的檔案頁）
   ========================================================================== */
export function profileEditor(host, { onChange } = {}) {
  function render() {
    host.replaceChildren();
    const c = completeness();

    host.appendChild(el('div', { class: 'prog' }, [
      el('div', { class: 'prog__bar' }, [
        el('span', { class: 'prog__fill', style: `width:${Math.round(c.ratio * 100)}%` }),
      ]),
      el('p', {
        class: 'prog__text',
        text: `已經填了 ${c.filled} 格，共 ${c.total} 格。不用一次填完，用到哪一格才會問你。`,
      }),
    ]));

    for (const g of GROUPS) {
      const keys = Object.keys(FIELDS).filter((k) => FIELDS[k].group === g);
      if (!keys.length) continue;
      const filled = keys.filter(has).length;
      const det = el('details', { class: 'formula', open: filled > 0 });
      det.appendChild(el('summary', { text: `${g}（${filled} / ${keys.length}）` }));
      const body = el('div', { class: 'formula__body askbox__grid' });
      for (const k of keys) body.appendChild(fieldControl(k, { onChange: () => { onChange?.(); } }));
      det.appendChild(body);
      host.appendChild(det);
    }
  }
  render();
  return { refresh: render };
}

/* ==========================================================================
   帶著走：匯出 / 匯入 / 分享
   沒有帳號，所以換裝置這條路必須是明確的按鈕，不能只靠 localStorage。
   ========================================================================== */
export function portabilityBar(host, profile) {
  const bar = el('div', { class: 'btnrow' });

  bar.appendChild(el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    html: iconHTML('copy') + '<span>匯出檔案</span>',
    onclick: () => {
      const blob = new Blob([profile.exportJSON()], { type: 'application/json' });
      const a = el('a', {
        href: URL.createObjectURL(blob),
        download: `看得見的錢-我的檔案-${new Date().toISOString().slice(0, 10)}.json`,
      });
      document.body.appendChild(a); a.click(); a.remove();
      toast('檔案已下載，換裝置時匯入它就好');
    },
  }));

  const file = el('input', {
    type: 'file', accept: 'application/json,.json', style: 'display:none',
    onchange: async (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const r = profile.importJSON(await f.text());
      toast(r.ok ? `匯入成功，讀到 ${r.count} 格` : r.error);
      e.target.value = '';
    },
  });
  bar.appendChild(file);
  bar.appendChild(el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button',
    html: iconHTML('down') + '<span>匯入檔案</span>',
    onclick: () => file.click(),
  }));

  bar.appendChild(el('button', {
    class: 'btn btn--quiet btn--sm', type: 'button',
    text: '全部清除',
    onclick: () => {
      if (!confirm('這會刪掉這台裝置上的整份財務檔案，確定嗎？')) return;
      profile.clear();
      toast('已清除');
    },
  }));

  host.appendChild(bar);
  return bar;
}

/** 相依數字更新時讓它們一起浮出來 */
export function pulse(scope) { carbonTransfer($$('[data-live]', scope)); }
