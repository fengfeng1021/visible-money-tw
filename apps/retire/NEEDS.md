# 退休模組需要共用層做的事

以下每一項都是在合併 pension-race 與 retire-fan 時真的撞到的，
不是「有的話比較好」。本模組沒有動 `assets/` 底下任何檔案，全部寫在這裡。

## 1. `assets/js/core/profile.js`：缺三個欄位

這一頁有三個數字屬於「使用者是誰／他決定了什麼」，應該全站共用，
但字典裡沒有，只好退回本模組自己的 `localStorage('vm:retire')`：

| 建議 key | 型別 | 為什麼該進共用檔案 |
|---|---|---|
| `pensionClaimAge` | int，歲 | 「幾歲開始領勞保」是一個人生決定，不是這一頁的旋鈕。首頁時間軸上「115 年 5 月起年金調高 6.46%」那類條目要算對你的影響，也需要它。 |
| `laborPensionMonthly` | money，元／月 | 勞退月退休金的**核定金額**。本模組可以由 `pensionAccount` 換算，但換算用的是內政部簡易生命表，不是勞保局的勞退年金生命表；使用者查得到核定數字時，那個數字比餘額更有價值，而且別的計算（例如所得替代率）也會要。 |
| `sexAtLifeTable` 或替 `sex` 補說明 | enum | 現有 `sex` 的 `ask` 寫的是「生命表的平均餘命男女不同」，在退休模組讀起來剛好，但它同時被別的計算拿去用時會顯得突兀。建議把 ask 改成中性描述。 |

## 2. 模型假設沒有常數檔可放

`μ`、`σ`、`ρ`、退休前五年大跌的形狀、動態護欄門檻這幾項不是法規，
所以不該進 `tw-labor-pension.json`；但它們也不該寫死在 App 裡，
因為 DESIGN 要求每一個假設都要能被攤開、被標示未查證、被覆寫。

目前它們寫在 `apps/retire/app.js` 的 `MODEL` 物件裡（全部在畫面上標未查證且可改）。
建議新增 **`assets/data/model-assumptions.json`**，欄位比照 `tw-*.json`
（`version` / `note` / 每項 `status: unverified` + `note`），
讓借款、退休、投資與稅三個模組共用同一份假設，改一次三邊同步。

## 3. `assets/data/tw-labor-pension.json` 少兩樣東西

1. **勞退月退休金的請領年齡**：條文是年滿 60 歲且年資滿 15 年。
   本模組把「不早於 60 歲」寫在程式裡當條件判斷，這是法規事實，應該外部化成
   `laborPensionMonthlyMinAge: 60` 與 `laborPensionMonthlyMinYears: 15`。
2. **勞退年金生命表**：現在只有利率 `laborPensionMonthlyAnnuityInterestRatePct`，
   沒有那張表，所以月退金額只能用內政部簡易生命表的平均餘命估。
   畫面上已經明講這是估計值，但如果拿得到勞保局的年金生命表，這一格就能從「估計」升級成「可核對」。

## 4. `assets/css/components.css`：沒有分頁元件

模組內部要切換「幾歲開始領／錢夠不夠」，共用元件庫裡只有 `.segmented`（勾選格）
與 `.plies`（並存情境），語意都不對。本模組用 `.segmented` 的外觀加 `role="tablist"`，
把 `[aria-selected="true"]` 的樣式寫在自己的 `app.css` 裡。
三個模組都會有同樣的需求，建議把它升上共用層（`.tabbar` / `.tabbar__sub`），
不然三份 CSS 會各自漂移。

## 5. `assets/js/core/profile-ui.js`：`askBox` 只問不改

`askBox(need)` 只渲染**缺的**欄位，填過的就完全消失，
使用者在模組裡沒有辦法改一個已經填過的數字（例如把投保薪資從 38,200 改成 45,800 再看一次）。
本模組自己包了一層 `askAndEdit()`：askBox 負責問，另一個 `<details class="filled">` 負責改。
這個模式三個模組都需要，建議直接做進 `profile-ui.js`，例如
`askBox(need, { editable: true })` 或新增 `fieldsFor(keys)`。

## 6. `assets/js/core/state.js` 的 handoff 可以退休了

`putHandoff` / `takeHandoff` 當初就是為了「勞保賽跑的月領金額傳進退休模擬」而存在的。
合併之後那個值是同一頁裡的同一個變數，這對 API 在本模組已經不再使用。
等三個模組都上線後可以確認是否還有人用，沒有就刪掉。
