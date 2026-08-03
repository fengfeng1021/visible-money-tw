/* 由 tw-changes.json 產生 JSON Feed。
   沒有帳號、沒有推播，但 feed 是一條完全靜態、使用者自己掌握的訂閱路徑。
   用法：node tools/build-feed.mjs */

import { readFile, writeFile } from 'node:fs/promises';

const SITE = 'https://fengfeng1021.github.io/visible-money-tw';

const src = JSON.parse(await readFile('assets/data/tw-changes.json', 'utf8'));
const STATUS = { 'in-force': '已生效', scheduled: '將生效', shelved: '已暫緩', repealed: '已廢止' };
const CAT = { tax: '稅', lending: '房貸', pension: '勞保勞退', nhi: '健保', market: '市場' };

const items = [...src.changes]
  .sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)))
  .map((c) => ({
    id: `${SITE}/#c-${c.id}`,
    url: `${SITE}/#c-${c.id}`,
    title: `${c.title}（${STATUS[c.status] || c.status}）`,
    content_text: [
      `${CAT[c.category] || c.category}｜生效日 ${c.effectiveDate}`,
      c.before && c.before !== 'null' ? `${c.before}${c.unit || ''} → ${c.after}${c.unit || ''}` : '',
      '',
      c.whoIsAffected,
      '',
      `法源：${c.legalBasis}`,
      c.note ? `註記：${c.note}` : '',
      c.confidence !== 'verified' ? `查證狀態：${c.confidence === 'probable' ? '高度可能，但無正式公告文號' : '未查證'}` : '',
    ].filter(Boolean).join('\n'),
    date_published: new Date(c.effectiveDate + 'T00:00:00+08:00').toISOString(),
    tags: [CAT[c.category] || c.category, STATUS[c.status] || c.status],
  }));

const feed = {
  version: 'https://jsonfeed.org/version/1.1',
  title: '看得見的錢．法規變動',
  home_page_url: SITE + '/',
  feed_url: SITE + '/feed.json',
  description: '台灣理財相關法規變動時間軸。每一條都附生效日、變動前後值、影響對象與法源。',
  language: 'zh-Hant-TW',
  items,
};

await writeFile('feed.json', JSON.stringify(feed, null, 1));
console.log(`feed.json 已產生，${items.length} 條，最新一條 ${items[0]?.date_published?.slice(0, 10)}`);
