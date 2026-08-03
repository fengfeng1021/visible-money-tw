/* 版面探針：在真正的裝置模擬下量元素寬度，找出被壓縮或溢出的節點。
   用法：node tools/probe.mjs <url> [width] [expr] */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const PORT = Number(process.env.CDP_PORT || 9334);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const url = process.argv[2];
const width = Number(process.argv[3] || 390);
const expr = process.argv[4] || `JSON.stringify({
  w: innerWidth,
  scrollW: document.documentElement.scrollWidth,
  narrow: [...document.querySelectorAll('.field,.slider,.segmented,.row,.sheet,.sheet__body,.workbench,.workbench__inputs,.readout')]
    .map(e => ({ c: (e.className||'').toString().slice(0,34), w: Math.round(e.getBoundingClientRect().width) }))
    .filter(x => x.w < innerWidth * 0.6).slice(0,20),
  overflow: [...document.querySelectorAll('body *')]
    .filter(e => e.getBoundingClientRect().right > innerWidth + 1)
    .map(e => (e.tagName + '.' + (e.className||'').toString().split(' ')[0]).slice(0,40)).slice(0,10)
})`;

const profile = path.join(os.tmpdir(), 'vm-probe-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'], { stdio: 'ignore' });

try {
  let ver;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch {}
    await sleep(250);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: width < 700 }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(2200);
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
  console.log(r.result.value);
} finally {
  chrome.kill(); await sleep(200);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
