# invest-tax 對共用層的需求

沒有修改 `assets/` 下的任何檔案，也沒有動原本的三個 app 資料夾。
以下是合併過程中在模組層繞過的共用層缺口。

## 1. 交易成本常數還沒有進 `assets/data`（阻礙，且牽涉一個尚未解決的事實衝突）

硬規則要求「法規常數一律讀 `assets/data/*.json`」，但手續費費率、單筆最低手續費與
證券交易稅目前只存在於 `apps/etf-lottery/rules.json` 與 `apps/ex-dividend/rules.json`。
本模組不複製一份到自己的資料夾，改成執行期直接讀那兩份既有檔案並比對，
比對結果渲染成頁面最下方的「交易成本」那一節。

**兩份檔案對同一件事的認定互相衝突，而且兩邊都自評 `verified`：**

| 爭點 | `etf-lottery/rules.json` | `ex-dividend/rules.json` |
|---|---|---|
| 1.425‰ 的地位 | `trading.feeRateMax`：「券商受託買賣手續費費率**上限**」，引臺灣證交所費率標準，`verified` | `market.brokerFeeRate`：「牌告**基準**費率」，並明言金管會 97 年金管證二字第 0970019212 號函開放後**已非法定上限**，`verified` |
| 單筆最低 20 元 | `trading.feeMin`：「**無法源**，券商普遍慣例」，`unverified` | `market.brokerFeeMin`：引證交所規章資料庫 FE064320，`verified` |

本模組的處理：**不選邊**。兩種說法原文並列在畫面上，狀態一律降級為「未查證」，
並說明兩邊對數值（0.1425%、20 元）其實一致，衝突的只是它的法律地位，
所以三聯的計算結果不受影響，受影響的是使用者能不能把它當成不可協商的下限。

**需要統籌者做的事**：把這三個常數收進 `assets/data/tw-trading.json`，
並在收進去之前先查證那份金管會函釋原文。查不到就把兩項都標 `unverified`
並保留 `conflictingClaims` 欄位，讓 UI 可以繼續並列呈現，而不是逼工具挑一邊。
在那之前，本模組會一直依賴 `apps/etf-lottery/` 與 `apps/ex-dividend/` 兩個資料夾存在。

## 2. `tw-tax.json` 缺 115 年度的基本生活費金額（已正確處理，僅記錄）

`years.115.basicLivingExpense` 是 `null`。本模組照 `traps` 的指示不沿用 114 年度的
213,000，直接不計入基本生活費差額，並在公式抽屜裡寫明「尚未查得公告值」。
公告之後把數字填進去即可，不需要改本模組的程式。

## 3. `assets/data/market/index.json` 的統計欄位與各檔實際內容不一致

`index.json` 的 `0050` 寫 `months: 200 / anomalies: 1`，但 `0050.json` 的
`anomalies` 是空陣列、`splitFixedAt: "2026-08-03"`（分割已在建置階段修正）。
本模組一律以各檔 JSON 為準，`index.json` 只用來取 id 清單與 `builtAt`／`dataFloor`。
建議 build script 收尾時重寫一次 `index.json`。

## 4. `Plot` 沒有 after-draw 掛勾（沿用 etf-lottery 已回報過的同一項）

招牌視覺需要在直方圖上方疊一排箱型圖、在成本瀑布的每根柱子上標金額。
本模組沿用實例層包裹的繞法：

```js
const base = Plot.prototype.render.bind(plot);
plot.render = () => { base(); drawOverlay(); };
```

建議在 `Plot.render()` 末端加一行 `this.onDraw?.(this.ctx)`。

## 5. `Plot` 與自繪畫布都只監聽 `prefers-color-scheme`，不監聽 `data-theme`

`ui.js` 的 `mountTheme()` 改的是 `document.documentElement.dataset.theme`。
本模組自己掛了一個 `MutationObserver` 重繪六張畫布。
建議由 `mountTheme()` 發一個 `vm:theme` 自訂事件，讓各畫布自行訂閱。

## 6. `profile.js` 缺兩格，本模組用既有欄位近似

- **利息與其他所得在夫妻間的歸屬**：`FIELDS` 沒有這一格，所以本模組固定歸「本人」，
  並在公式抽屜裡把這個模型約定寫出來。要精算「各類所得分開計稅」需要新增一格
  `spouseInterestShare` 之類的欄位。
- **列舉扣除額的其他項目**（保險費、醫藥費、捐贈）：`FIELDS` 只有
  `mortgageInterestPaid`，所以本模組的一般扣除額只在「標準」與「購屋借款利息」
  之間取大者。多數存股族用標準扣除額，這個近似不影響結論方向，但要做完整的
  列舉試算就需要補欄位。

## 7. `askBox` 的 `title: ''` 會留下一個空的 `<p>`

`profile-ui.js` 的 `askBox` 在 `title` 為空字串時仍然會塞一個 `.askbox__lead`。
本模組每個 askBox 都給了標題所以沒踩到，但 `home.js` 有一處傳 `title: ''`。
建議在 `askBox` 內加一行 `if (title)` 判斷。
