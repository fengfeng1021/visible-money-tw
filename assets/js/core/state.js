/* 狀態：可訂閱的小型 store + localStorage 保存 + URL 情境編碼。
   沒有後端，所以「把情境傳給另一個人」＝ 把狀態塞進網址。 */

const enc = (obj) => {
  try {
    const json = JSON.stringify(obj);
    return btoa(String.fromCharCode(...new TextEncoder().encode(json)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch { return ''; }
};

const dec = (s) => {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
};

/**
 * @param {string} key  localStorage 鍵名，同時是網址參數名
 * @param {object} defaults
 */
export function createStore(key, defaults) {
  const subs = new Set();
  let state = { ...defaults };
  let saveTimer = 0;

  // 優先序：網址 > localStorage > 預設值。網址代表「別人傳給我的情境」。
  const url = new URLSearchParams(location.search).get('s');
  const fromUrl = url ? dec(url) : null;
  if (fromUrl && typeof fromUrl === 'object') {
    state = { ...state, ...fromUrl };
  } else {
    try {
      const raw = localStorage.getItem(key);
      if (raw) state = { ...state, ...JSON.parse(raw) };
    } catch { /* 隱私模式或配額用盡：靜默使用預設值 */ }
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* noop */ }
    }, 250);
  }

  const store = {
    get() { return state; },
    /** 取單一欄位 */
    at(k) { return state[k]; },
    /** 合併更新並通知。相同值不觸發。 */
    set(patch, { silent = false } = {}) {
      let changed = false;
      for (const [k, v] of Object.entries(patch)) {
        if (!Object.is(state[k], v)) { state[k] = v; changed = true; }
      }
      if (!changed) return state;
      persist();
      if (!silent) subs.forEach((fn) => fn(state));
      return state;
    },
    replace(next) {
      state = { ...defaults, ...next };
      persist();
      subs.forEach((fn) => fn(state));
      return state;
    },
    reset() { return store.replace({ ...defaults }); },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** 目前情境的分享網址 */
    shareUrl() {
      const u = new URL(location.href);
      u.search = '';
      u.searchParams.set('s', enc(state));
      return u.toString();
    },
    /** 網址列同步（不新增歷史紀錄） */
    syncUrl() {
      const u = new URL(location.href);
      u.searchParams.set('s', enc(state));
      history.replaceState(null, '', u);
    },
    cameFromLink: Boolean(fromUrl),
  };
  return store;
}

/** 跨 App 傳遞：例如勞保年金試算結果帶進退休模擬 */
const HANDOFF = 'vm:handoff';
export function putHandoff(payload) {
  try { sessionStorage.setItem(HANDOFF, JSON.stringify({ ...payload, at: Date.now() })); }
  catch { /* noop */ }
}
export function takeHandoff(maxAgeMs = 30 * 60 * 1000) {
  try {
    const raw = sessionStorage.getItem(HANDOFF);
    if (!raw) return null;
    const v = JSON.parse(raw);
    sessionStorage.removeItem(HANDOFF);
    if (!v || Date.now() - (v.at || 0) > maxAgeMs) return null;
    return v;
  } catch { return null; }
}
