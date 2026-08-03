/* 截圖工具（CDP 版）。
   為什麼不用 chrome --screenshot：Windows 上瀏覽器視窗有最小寬度（約 500px），
   所以 --window-size=390 拍出來的其實是 500px 版面被裁掉右邊，
   手機版的驗收會整組失真。改用 Emulation.setDeviceMetricsOverride 做真正的裝置模擬，
   並用 captureBeyondViewport 取得完整長頁。

   用法：node tools/shot.mjs <outDir> <url1> [url2 ...]
        node tools/shot.mjs .shots --only mobile http://...
*/
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const PORT = Number(process.env.CDP_PORT || 9333);
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, dsf: 1, mobile: false },
  mobile: { width: 390, height: 844, dsf: 2, mobile: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* 還沒起來 */ }
    await sleep(250);
  }
  throw new Error('DevTools 沒有在時限內起來');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        (this.handlers.get(msg.method) || []).forEach((fn) => fn(msg.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(new CDP(ws)));
    ws.addEventListener('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const outDir = args[0] || '.shots';
  let which = ['desktop', 'mobile'];
  const onlyIdx = args.indexOf('--only');
  if (onlyIdx >= 0) which = [args[onlyIdx + 1]];
  const urls = args.filter((a, i) => a.startsWith('http') && i > 0);
  if (!urls.length) { console.error('沒有給網址'); process.exit(1); }
  if (!CHROME) { console.error('找不到 Chrome / Edge'); process.exit(1); }

  await mkdir(outDir, { recursive: true });
  const profile = path.join(os.tmpdir(), 'vm-shot-' + Date.now());

  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-prefers-reduced-motion',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const ver = await waitForDevtools();
    const browser = await connect(ver.webSocketDebuggerUrl);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

    // 用 flatten session：把 sessionId 帶在每個訊息上
    const page = {
      send: (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++browser.id;
        browser.pending.set(id, { resolve, reject });
        browser.ws.send(JSON.stringify({ id, sessionId, method, params }));
        setTimeout(() => { if (browser.pending.has(id)) { browser.pending.delete(id); reject(new Error('timeout ' + method)); } }, 30000);
      }),
    };

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const errors = [];
    browser.on('Runtime.exceptionThrown', () => {});

    for (const url of urls) {
      const slug = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '').replace(/[^\w.-]+/g, '_') || 'index';
      for (const key of which) {
        const v = VIEWPORTS[key];
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: v.width, height: v.height,
          deviceScaleFactor: v.dsf, mobile: v.mobile,
          screenWidth: v.width, screenHeight: v.height,
        });
        await page.send('Page.navigate', { url });
        await sleep(2200);

        // 收集 console error，讓截圖同時是一次健檢
        const res = await page.send('Runtime.evaluate', {
          expression: `JSON.stringify({ w: innerWidth, scrollW: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, title: document.title })`,
          returnByValue: true,
        });
        const info = JSON.parse(res.result.value || '{}');
        if (info.scrollW > info.w + 1) {
          console.log(`  ⚠ ${slug} ${key}：橫向溢出 ${info.scrollW} > ${info.w}`);
        }

        const shot = await page.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: v.width, height: Math.min(info.h || v.height, 6000), scale: 1 },
        });
        const file = path.join(outDir, `${slug}.${key}.png`);
        await writeFile(file, Buffer.from(shot.data, 'base64'));
        console.log(`  ✓ ${file}  ${v.width}×${Math.min(info.h, 6000)}`);
      }
    }
    await browser.send('Target.closeTarget', { targetId });
  } finally {
    chrome.kill();
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
