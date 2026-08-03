# 共用層需求（dividend-tax-map）

兩件都已在本 App 內就地繞過，不影響交付；但七個 App 都會踩到，建議由統籌者收進 assets/。

## 1. `hidden` 屬性被元件的 display 蓋掉

`components.css` 的 `.state { display: flex }` 與 `.ledger-wrap { overflow: auto }` 這類元件，
一旦用 `hidden` 屬性切換顯示就失效（`display:flex` 優先於 UA 的 `[hidden]{display:none}`）。
本 App 有 6 個條件區塊靠 `hidden` 切換，只好在 `app.css` 自己補：

```css
[hidden] { display: none !important; }
```

建議加進 `base.css`，緊接在 `.sr-only` 那一段。

## 2. 手動切換日間／夜間時，canvas 不重畫

`plot.js` 只監聽 `matchMedia('(prefers-color-scheme: dark)')`，
但 `ui.js` 的 `mountTheme()` 是寫 `document.documentElement.dataset.theme`，不會觸發那個 media query。
所以使用者按下夜間鈕之後，圖表會留著上一個主題的墨色與格線色，直到下一次 resize 或重新計算。

本 App 自己補了一個 MutationObserver 監看 `data-theme`。
建議直接做進 `Plot` 的 constructor（並在 `destroy()` 裡 disconnect），
或由 `mountTheme()` 發一個 `vm:theme` 的 CustomEvent，讓所有 canvas 訂閱。

## 3.（僅供參考，不急）`niceTicks` 對負數域

`plot.js` 的 `niceTicks` 在 min 為負、max 為正時運作正常，本 App 未遇到問題。
但地圖需要「0 以下也要有刻度」的情境（其他所得淨額為負），本 App 自行寫了一份 `ticks()`。
若之後有第二個 App 需要負值座標軸，可以把它抽回共用層。
