/* 揭露頁。

   這一頁刻意不寫死任何一句「本站目前沒有分潤」——那種句子會在某天變成謊話，
   而且沒有人會記得回來改。所以整頁都是從 partners.json 讀出來的現況：
   總開關關著就說關著，有連結就一條一條列，過期就標過期。
   設定檔改了，這一頁自己會跟著改。
*/

import { $, el, mountTopbar, mountTheme } from './core/ui.js';
import { loadPartners, allLinks } from './core/partners.js';
import { printRows, revealOnScroll, still } from './core/motion.js';

const STATE = {
  live: { s: 'live', label: '分潤連結' },
  plain: { s: 'plain', label: '官網連結' },
  expired: { s: 'expired', label: '活動已結束' },
};

function stateOf(r) {
  if (r.live) return STATE.live;
  if (r.expired) return STATE.expired;
  return STATE.plain;
}

function renderState(c, rows) {
  const host = $('#stateHost');
  const liveN = rows.filter((r) => r.live).length;

  if (!c || c.enabled !== true) {
    host.appendChild(el('div', { class: 'note' }, [
      el('p', { class: 'disclose__lead', html:
        '<b>目前站上沒有任何分潤連結生效。</b>　'
        + '設定檔裡的總開關是關的，所以即使某一筆已經填好追蹤網址，'
        + '送出去的也一律是該機構的官網原始網址，不加任何追蹤參數。' }),
      el('p', { class: 'disclose__law', text:
        '這個開關是為了「先把連結配置完成、再一次打開」而存在，'
        + '而不是為了在你看這一頁的時候暫時關掉。它就是站上實際的執行狀態。' }),
    ]));
    return;
  }

  host.appendChild(el('div', { class: liveN ? 'note note--warn' : 'note' }, [
    el('p', { class: 'disclose__lead', html: liveN
      ? `<b>目前有 ${liveN} 個分潤連結生效中。</b>　${c.disclosure?.short || ''}`
      : '<b>總開關是開的，但目前沒有任何一筆連結處於生效狀態。</b>　'
        + '可能是還沒設定追蹤網址，也可能是活動都已經過期。' }),
  ]));
}

function renderList(rows) {
  const list = $('#plist');
  list.replaceChildren();

  if (!rows.length) {
    list.appendChild(el('li', {}, [
      el('p', { class: 'plist__empty', text:
        '設定檔裡目前沒有任何離站連結。這一頁會隨著設定檔長出內容，不需要改程式碼。' }),
    ]));
    return;
  }

  for (const r of rows) {
    const st = stateOf(r);
    list.appendChild(el('li', { class: 'plist__row' }, [
      el('span', { class: 'plist__name', text: r.label }),
      el('span', { class: 'plist__state', dataset: { s: st.s }, text: st.label }),
      r.href
        ? el('a', { class: 'btn btn--ghost btn--sm', href: r.href, target: '_blank',
                    rel: r.live ? 'sponsored nofollow noopener' : 'noopener', text: '前往' })
        : null,
      r.note ? el('p', { class: 'plist__note', text: r.note }) : null,
    ]));
  }
}

function renderRules(c) {
  const d = c?.disclosure || {};
  const ul = $('#longList');
  ul.replaceChildren();
  for (const line of d.long || []) ul.appendChild(el('li', { text: line }));
  $('#lawNote').textContent = d.lawNote || '';

  const excl = $('#exclHost');
  const kinds = c?.rules?.excludedKinds || [];
  const note = c?.rules?.excludedKindsNote;
  if (kinds.length && note) {
    excl.appendChild(el('div', { class: 'note note--stop' }, [
      el('p', { class: 'disclose__lead', text: note }),
    ]));
  } else {
    excl.appendChild(el('p', { class: 'plist__empty', text: '設定檔沒有標示排除的類別。' }));
  }

  $('#expireNote').textContent = c?.rules?.expirePolicy || '';
}

async function boot() {
  mountTopbar({ base: './' });
  mountTheme($('.topbar'));

  const c = await loadPartners('./assets/data/partners.json');
  const rows = allLinks();

  $('#dataver').textContent = `資料版本 ${c?.version || '—'}`;
  renderState(c, rows);
  renderList(rows);
  renderRules(c);

  if (!still()) {
    printRows(['.sheet', '#state'], { stagger: 0.07, delay: 0.04 });
    revealOnScroll(['#list', '#rules', '#excluded', '#expire']);
  }
}

boot();
