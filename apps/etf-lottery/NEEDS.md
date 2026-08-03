# etf-lottery 對共用層的需求

沒有修改 `assets/` 下的任何檔案。以下三項是實作過程中在 App 層繞過的共用層缺口，
若統籌者要動共用層，這三項會讓其他 App 也受益。

## 1. `Plot` 沒有自訂繪製的掛勾（本 App 影響最大）

招牌視覺需要在直方圖上方疊一排箱型圖，成本瀑布需要在每根柱子上標金額。
`Plot.render()` 沒有留任何 after-draw 掛勾，也沒有可擴充的 series type，
所以本 App 用「實例層包裹」的方式繞過：

```js
const base = Plot.prototype.render.bind(plot);
plot.render = () => { base(); drawOverlay(); };
```

這樣可行，而且 `_morph` 內部的 `this.render()` 也會走到包裹版本，動畫同步沒問題，
但它依賴 `Plot` 內部不改用箭頭函式綁定 render。

建議：在 `render()` 末端加一行 `this.onDraw?.(this.ctx)`，一行就夠。

## 2. `Plot` 只監聽 `prefers-color-scheme`，不監聽 `data-theme`

`core/ui.js` 的 `mountTheme()` 是改 `document.documentElement.dataset.theme`，
但 `Plot` 建構子只在 `matchMedia('(prefers-color-scheme: dark)')` 上掛 change。
使用者按夜間鈕時，DOM 會換色，畫布上的線與柱子仍是舊色。

本 App 自己掛了一個 `MutationObserver` 在 `data-theme` 上重算重繪。
建議在 `Plot` 建構子裡一併觀察 `data-theme`，或由 `mountTheme()` 發一個
`vm:theme` 自訂事件讓各 Plot 自行重繪。

## 3. `[hidden]` 被元件的 `display` 蓋掉

`.state`、`.field`、`.btn`、`.legend` 都設了 `display`，比 UA 的 `[hidden]` 規則強，
所以 `el.hidden = true` 對它們無效。本 App 在 `app.css` 自己補了

```css
.state[hidden], .field[hidden], .btn[hidden], .legend[hidden] { display: none; }
```

建議在 `base.css` 加一條全域的 `[hidden] { display: none !important; }`，
七個 App 都會用到隱藏欄位與拒答面板。

## 4. （非阻礙，僅記錄）市場資料的分割修正

`assets/data/market/0050.json` 在本 App 開發期間被重新建置過：最初的還原序列
未處理 2025-06-18 的 1 拆 4，`2025-05 → 2025-06` 有一道 −73% 的假崩盤；
後來的版本已修正（`2010-01` 的 adj 由 31.708 變成 7.927），`anomalies` 也清空了。

本 App 不假設哪一版：`rules.json` 宣告分割事件，載入時比對分割日前後的還原價比值，
只有在「確實還沒被處理」時才補除以倍數，不會重複修正。另外逐月掃描還原價，
任何月對月 −40% 以上的跳空一律停用該檔並在畫面上說明。

如果之後 build script 再改，這一段仍然會自己判斷，不需要跟著改。
但 `assets/data/market/index.json` 的 `months`、`anomalies` 欄位目前與各檔實際內容
不一致（0050 寫 `months: 179 / anomalies: 1`，實際 200 個月、0 個異常），
本 App 一律以各檔 JSON 為準，index.json 只用來取 id 清單與 `builtAt`。
建議 build script 收尾時重寫一次 index.json。
