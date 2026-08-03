# retire-fan 對共用層的需求

我沒有動 `assets/` 底下任何檔案。第 1 項已經隨 `assets/data/tw-returns.json`
進來而結案，留著紀錄；第 2、3 項仍未處理。

## 1.（已結案）bundled 年度報酬序列已進來，歷史區塊拔靴法已解除拒答

`assets/data/tw-returns.json` 補齊之後，這一頁已經改成：

- `rules.json` 增加 `series` 區段（只放描述、用途與出處；數字本身不從共用檔複製一份）
- worker 的 `simPath()` 增加 `boot` 分支，`blockBootstrap` 直接把 `core/fin.js`
  匯入的那一份 `toString()` 注入 worker blob，block = 3 年
- 抽樣池可切台股 22 年（2004–2025）或 S&P 500 98 年（1928–2025）；
  債券那一腳抽**同一組年度索引**的美國 10 年期公債模型化報酬，所以股債共動來自歷史，
  歷史模式不使用 ρ
- 通膨可切固定值或抽台灣 CPI 1996–2025（同樣 block = 3）
- 「退休前五年遇到大跌」在歷史模式改成套用該池實際最差的連續 5 年
  （台股 2004–2008 累計 −4.9%；S&P 500 1928–1932 累計 −49.3%），滑桿失效並標明；
  參數化模式維持原本的形狀假設
- 計畫終齡的對照提示改用分齡平均餘命（65 歲男 18.35／女 22.41），不再用 0 歲平均壽命

仍然缺、且已在 `rules.json` 的 `refusals` 與畫面上寫明的兩項：

- 台灣公債／投資等級債的長期年度報酬序列（現在只能用美債模型化序列替代）
- 全球股票（MSCI World）年度報酬序列（授權限制，刻意不提供）

## 2.（CSS）`.state` 的 `display:flex` 會蓋掉 `hidden` 屬性

`components.css` 的 `.state { display: flex; ... }` 特異性高於 `[hidden]`，
所以 `<div class="state state--refuse" hidden>` 在畫面上仍然是顯示的。
同樣問題也會出現在任何「預設收起、需要時才出現」的狀態面板上。

我在 `apps/retire-fan/app.css` 加了 `[hidden] { display: none !important; }` 擋住，
但這應該修在共用層，建議在 `components.css` 加：

```css
.state[hidden] { display: none; }
```

或全站一條 `[hidden] { display: none !important; }`。

## 3.（資料，不是我的 App，但會影響別人）0050 還原價序列沒有處理 2025 年的分割

`assets/data/market/0050.json` 的 `monthly[].adj` 在 2025-05 是 174.94、2025-06 是 47.07，
`anomalies` 欄位自己也記了 `2025-07-01 179.75 → 48.64（-72.9%）`。
這是 1 股拆 4 股，不是下跌，但還原價序列沒有把它除掉，所以由這份資料算出來的
年度報酬會是 2025 年 −65.8%、2026 年 +58.6%。

`etf-start-lottery-tw` 如果直接用這份 `adj` 算報酬會整組失真。建議在
`tools/build-market-data.mjs` 把分割也納入還原因子（TWSE 的除權除息表不含分割，
需要另外處理）。我沒有動這份資料，也沒有拿它來當我的抽樣池，就是因為這一點。
