# 借款模組對共用層的需求

這一頁沒有修改 `assets/` 底下任何檔案。以下是合併過程中發現、但必須由共用層處理的事。
按急迫度排序。

---

## 1. 交易成本與各縣市房價負擔能力還沒進共用資料層（唯一的硬阻塞）

硬規則要求「法規常數一律讀 `assets/data/*.json`」，但買房那一段需要的下列常數
在共用資料層裡不存在，目前只存在 `apps/afford-ceiling/rules.json`：

| 項目 | 目前來源 | 性質 |
|---|---|---|
| `deedTaxRate` 契稅 6% | afford-ceiling/rules.json | 已查證（契稅條例第 3 條） |
| `stampTaxRate` 印花稅 0.1% | 同上 | 已查證（印花稅法第 7 條） |
| `assessedValueRatioOfPrice` 評定現值占成交價比例 | 同上 | 未查證，本站粗估 |
| `publicContractRatioOfPrice` 公契金額占成交價比例 | 同上 | 未查證，本站粗估 |
| `agencyFeeBuyer` 買方仲介報酬 | 同上 | 市場慣例，非法規 |
| `scrivenerAndRegistryFee` 代書費與登記規費 | 同上 | 市場行情估計 |
| `settlingReserveRate` 交屋後週轉金 | 同上 | 建議值，非法規 |
| `ltvFirstHomeNoProperty` 名下無房成數 0.8 | 同上 | 未查證，非法規（央行未規範此類） |
| `dsrLevels` 33／40／60 三檔 | 同上 | 非法規，銀行實務參考帶 |
| `affordability.counties` 22 縣市房價所得比與負擔率 | 同上 | 已查證（內政部 114 年第 3 季分表） |
| `affordability.countyQuarter` / `countyMedianPriceNote` | 同上 | 同上 |

因此 `apps/borrow/app.js` 目前 fetch 三個檔案：

```
assets/data/tw-lending.json   ← 央行成數、DBR、房價負擔能力全國數（真相）
assets/data/tw-mortgage.json  ← 預設利率、警戒線、官方方案、一碼 = 0.25 個百分點（真相）
apps/afford-ceiling/rules.json ← 上表這些共用層還沒收錄的項目（暫時來源）
```

**兩者重疊的欄位一律以 `assets/data/` 為準**，程式在 `boot()` 裡明確覆蓋
（第 2 戶成數、第 3 戶成數、高價住宅成數、DBR 倍數與實務控管帶、一碼的百分點、
全國中位數住宅價格、統計季別、五大銀行新承做房貸利率）。
`rules.json` 只負責補上表那些共用層沒有的項目。

**要的東西**：把上表併進 `assets/data/tw-lending.json`
（建議放在 `transactionCosts`、`dsrLevels`、`market115q1.byCityFull` 三個節點下，
每一項保留 `status` / `legalBasis` / `sourceUrl`，因為「未查證」要顯示在畫面上）。
併完之後把 `apps/borrow/app.js` 的第三個 fetch 拿掉即可，計算邏輯不用動。

**現在的風險**：`apps/afford-ceiling/` 一旦被刪掉，這一頁的買房那一段會直接顯示拒答
（不會用寫死的預設值假裝算得出來，這是刻意的）。
在上面那件事完成之前，`apps/afford-ceiling/rules.json` 不可以刪。

---

## 2. `profile.js` 缺一個「這一格是我拖出來的假設，不是我的檔案」的概念

房貸那一段的寬限期滑桿同時是兩件事：
使用者檔案裡的 `mortgageGraceLeft`（事實），以及情境比較的軸（假設）。

目前的處理：**第一聯**的滑桿放開時寫回 `mortgageGraceLeft`，
第二、三聯只改本地情境。這個規則講得出來，但要靠一行提示文字說明。

如果之後其他模組也遇到同樣的情況（例如退休模組的退休年齡），
建議 `profile.js` 增加一個 `overlay(patch)` / `clearOverlay()`：
覆蓋層只活在記憶體，`get()` 會先看覆蓋層，但不寫進 localStorage。
這樣「拿檔案當起點做假設」就有一個全站一致的做法，不必每個模組自己發明。

---

## 3. `createPlies` 無法還原多聯狀態

`createPlies` 每次載入都從一聯開始，但情境是存在 localStorage 裡的。
`apps/mortgage-cliff` 存了三聯之後重新載入，分頁只剩一聯，圖上卻仍畫三條線，
圖例會退化成「情境 2」「情境 3」。

這一頁的做法是**載入時只保留使用中的那一聯**（`app.js` 開頭那一段），
把問題繞開。要真正修好，`createPlies` 需要一個 `initial: [{id, label}]` 參數
與一個 `setItems()`，讓呼叫端把保存的聯數還原回去。

---

## 4. `components.css` 缺「模組內分段」的樣式

這一頁用 `.segmented--block` 當兩段的切換器，並在 `app.css` 裡加了 `.app-tabs`
把它的高度與字級調大（46px、`--t-base`），因為它是頁面層級的導覽，
不是表單裡的一個選項。三個模組都會需要同一個東西。

建議把它收進 `components.css`，例如 `.segmented--nav`，
免得三個模組各自複製一份高度與字級。

同樣情況：`.demo-badge`（「範例數字」徽章）。
沒有檔案的人在任何模組首屏看到的都是範例，這個徽章應該是全站共用元件，
不是每個模組自己畫一顆。

---

## 5. 資料版本徽章的語意需要統一

這一頁顯示 `資料版本 2026-08．未查證 7 項`，其中版本號來自 `tw-lending.json`，
未查證項數卻是數 `afford-ceiling/rules.json` 裡 `status: "unverified"` 的欄位。
第 1 點做完之後這兩個數字就會來自同一個檔案，語意才會一致。
