# 押忍！YouTube 応援団 — 可玩產品規格（MVP）

> 語言：香港繁體為主；程式識別字／技術術語用英文。  
> 靈感：NDS《押忍！闘え！応援団》／Elite Beat Agents — **只有三種標記**。

---

## 1. 核心循環（Core Loop）

1. 使用者貼上 YouTube URL → **Load** 解析 `videoId`，自動產生簡易譜面（或載入分享連結／sample）。
2. **Play**：嵌入式 YT IFrame 開始播放；畫面下方／側邊為遊玩區（playfield）。
3. 以 `player.getCurrentTime()` 為唯一時鐘，標記依 `t`（秒）出現：接近環縮小 → 玩家點擊／滑動／轉圈。
4. 判定影響 **裝置延遲（Device latency）**
- 與拍子 **Offset** 分開：Offset 對齊音樂節拍；Latency（ms）補償手機觸控／顯示延遲。
- 判定時鐘：`getCurrentTime() + offset - latencySec`。
- UI：0–200ms slider +「校准」（跟閃光撳 4 次估平均延遲）；存 localStorage。

**片長夾緊／結束（防 softlock）**
- 載入後若知悉 YT `getDuration()`，`clampChartToDuration` 刪除／縮短超出片長的標記；`endTime` 唔超過片長。
- Auto-chart／Regen 以 `duration - margin` 為上限，唔會擺標記喺片尾之後。
- YT `ENDED` 或 `currentTime >= duration` → `forceResolveEnd`：剩餘標記當 Miss，然後 Clear 或因 Life 歸零 Fail — **禁止**卡死。

**遊玩 HUD**
- Play 期間收合 beatbar 以騰出 playfield。
- 即將出現嘅 Hit 之間畫編號導引線（Ouendan-like trails）。
- YT `controls=0`，避免拖動進度造成譜面不同步。
- 判定可顯示 EARLY／LATE。

**Life 條** 與分數；Life 歸零 → Fail；曲終且 Life > 0 → Clear。
5. 結果畫面顯示分數／判定統計；**Share** 複製含 `videoId` + chart JSON 的 permalink（**不**分享音訊）。

---

## 2. 標記類型（僅三種）

### 2.1 Hit Marker（點擊）
- 欄位：`type:"hit"`, `t`（完美時機秒）, `x`,`y`（正規化 0–1，相對 playfield）, `n`（顯示編號，可選）。
- 視覺：數字圓 + **approach ring**（自外向內縮，於 `t` 重合）。
- 操作：在目標圓內 pointer down／tap。
- 出現：約 `t - approachSec`（預設 1.2s）開始顯示。

### 2.2 Phrase Marker（跟球路徑）
- 欄位：`type:"phrase"`, `t`（開始）, `duration`, `path`: `[[x,y],...]`（≥2 點）。
- 視覺：路徑線 + 跟隨球；玩家需沿路徑拖曳（pointer move），進度填滿才算完成。
- 判定：在時間窗內完成路徑進度 ≥ 閾值（MVP：≥85% → 300；≥60% → 100；≥40% → 50；否則 miss）。

### 2.3 Spin Marker（轉圈）
- 欄位：`type:"spin"`, `t`, `duration`, `x`,`y`, `revs`（需轉圈數，預設 1）。
- 視覺：圓環進度條；玩家繞中心做圓形手勢累積角度。
- 判定：時間內累積角度 ≥ `revs * 2π * 0.85` → 高分，類推。

---

## 3. 時間窗與判定（Scoring）

| 判定 | Hit（|Δt|） | 分數 |
|------|-------------|------|
| Perfect (300) | ≤ 50ms | 300 |
| Great (100) | ≤ 100ms | 100 |
| Good (50) | ≤ 150ms | 50 |
| Miss (0) | > 150ms 或超時未點 | 0 |

- Phrase／Spin：依完成度映射到 300／100／50／0（見上）。
- Combo：連續非 Miss 遞增；Miss 中斷。
- 總分 = Σ 各標記得分（MVP 不乘 combo 倍率；可顯示 combo 作回饋）。

**Life 條**
- 初始：100%。
- Hit 300：+2%；100：+1%；50：0%；Miss：−8%。
- Phrase／Spin 成功（≥50）：+3%；Miss：−10%。
- 夾限 0–100%；**≤0 → Fail**（暫停影片、顯示 Fail）。
- Mid-song **O／X 場景（stub）**：依當前 Life 色帶觸發簡易面板  
  - Life ≥ 70% → 「O！応援成功」暖色 stub  
  - 40–70% → 「加油…」中性  
  - < 40% → 「X…危險」冷色／警告  
  - 在譜面 `breaks[]` 時間點觸發（自動譜會插 1–2 個）。

---

## 4. Chart JSON Schema（versioned）

```json
{
  "version": 1,
  "videoId": "dQw4w9WgXcQ",
  "title": "Demo Chart",
  "bpm": 120,
  "offset": 0.0,
  "approachSec": 1.2,
  "durationHint": 60,
  "markers": [
    { "type": "hit", "t": 3.0, "x": 0.25, "y": 0.45, "n": 1 },
    { "type": "hit", "t": 3.5, "x": 0.55, "y": 0.55, "n": 2 },
    {
      "type": "phrase",
      "t": 8.0,
      "duration": 2.0,
      "path": [[0.15, 0.6], [0.4, 0.35], [0.7, 0.5], [0.85, 0.4]]
    },
    {
      "type": "spin",
      "t": 14.0,
      "duration": 1.8,
      "x": 0.5,
      "y": 0.5,
      "revs": 1
    }
  ],
  "breaks": [
    { "t": 20.0, "kind": "meter" }
  ]
}
```

### 欄位說明
| 欄位 | 必填 | 說明 |
|------|------|------|
| `version` | ✓ | 整數；MVP = 1 |
| `videoId` | ✓ | YouTube video id（11 字元典型） |
| `title` | | 顯示用 |
| `bpm` | | 自動譜參考；手譜可省略 |
| `offset` | | 全譜時間偏移（秒） |
| `approachSec` | | approach ring 時長 |
| `durationHint` | | 自動譜估計長度（秒） |
| `markers[]` | ✓ | 依 `t` 排序 |
| `breaks[]` | | 中場 O/X stub 時間點 |

**座標**：`x`,`y` ∈ [0,1]，相對 playfield 客戶區（非整個視窗）。

---

## 5. YouTube 嵌入規則（產品層）

1. **只用**官方 IFrame Player API；以 `getCurrentTime()`／`getPlayerState()` 驅動遊戲時鐘。
2. **禁止**下載、快取、分離或重新編碼 YT 音訊／影片。
3. 播放器必須**始終可見**（不可 0×0 或完全遮蓋）；建議佔畫面約 28–36% 寬／高，其餘為 playfield。
4. `playsinline`／行動裝置允許行內播放；使用者手勢觸發首次 Play（符合 autoplay 政策）。
5. 分享內容 = `videoId` + chart 資料；接收端仍透過官方嵌入播放同一支影片。
6. 請遵守 YouTube ToS／嵌入政策；本 MVP 為個人原型，非上架產品。

**Share URL 格式（MVP）**
```
https://<host>/index.html#v=<videoId>&c=<base64url(JSON chart without bulky fields)>
```
- Hash 編碼避免把大 JSON 打進瀏覽紀錄 query（仍可用 `?` 後備）。
- 解碼失敗 → 回退為該 `videoId` 的自動譜。

---

## 6. 自動譜（Auto-chart）策略

**硬限制**：純 YouTube 路徑**禁止**下載／快取／分離 YT 音訊；播放時鐘永遠係 IFrame `getCurrentTime()`。

### 6.1 純 YT URL（預設）
1. 解析 `videoId` → 嵌入播放器；就緒後讀 `getDuration()` 作 `durationHint`。
2. 使用者可填 **BPM、Offset（秒）、拍子細分（1/1·1/2·1/4）、密度（疏／中／密）**，按 **Regen** 重產。
3. 程式化譜（procedural）：
   - 以 `offset` 為拍子網格原點；Hit 落在 beat／subdivision 上，**downbeat 加重**。
   - 位置用応援団式 pattern（Z 字、弧、交叉、瀑布、V）輪換，避免同秒堆疊。
   - 每 N 小節（預設 8）喺小節線插入 **Phrase** 與 **Spin**（交替），並 reserved 時段唔再疊 Hit。
   - `breaks[]` 落喺中段／後段小節線（避開 specials）。
4. 無音訊分析 → **唔會**自動估歌嘅真實 BPM；要準就手填或用 6.2。

### 6.2 可選：上傳 CC／本地音訊（Web Audio）
1. 使用者上傳自己有權使用嘅音訊（或 CORS 開放嘅**非 YT** 直鏈）。
2. 瀏覽器內 `decodeAudioData` → onset／autocorr 估 **BPM + offset + duration**。
3. 用估出嚟嘅參數走同一套 procedural 產譜；**播放仍用對應 YT 嵌入**（假設同一首歌）。
4. **禁止**對 youtube.com／googlevideo 做 fetch／yt-dlp。

### 6.3 分享／手譜
- 分享格式不變：`#v=&c=`（videoId + chart JSON）。
- 手譜範例：`web/sample-chart.json`。

---

## 7. UI／平台約束

- **僅橫向（landscape）**：CSS `min-aspect-ratio`／orientation；直向顯示「請旋轉手機」遮罩。
- Touch-first：`pointer` events；Hit 目標直徑建議 ≥ 56px。
- 流程畫面：`Input` → `Ready` → `Playing` → `Result`（Fail／Clear）。

---

## 8. MVP vs Later

| MVP（本原型） | Later |
|---------------|-------|
| 三種標記 + 自動譜 | 編輯器、社群譜、難度 |
| Life + 簡易 O/X stub | 完整劇情／角色動畫 |
| 300/100/50/0、無倍率 | Combo 倍率、等級、排行 |
| Hash 分享 | 短碼伺服器、譜倉庫 |
| 單頁靜態 | PWA、帳號、多語言 |
| BPM／Offset／細分 UI + procedural 譜 | 編輯器、延遲補償、社群譜庫 |

---

## 9. 已知限制（寫入 README 同步）

- 純 YT 路徑唔分析音訊；BPM 靠手填或「上傳同源 CC 音訊」偵測；拍子靠 Offset，觸控手感靠 Latency。
- Web Audio 偵測係粗略 onset／autocorr；只分析最長約 90 秒。
- 上傳音訊 BPM 同 YT 片若唔係同一首歌／有前奏差，仍會錯位。
- `getCurrentTime()` 有取樣誤差；長時間可能 drift；唔好靠拖動影片進度（controls 已關）。
- Sample 用短片時譜面必須 ≤ 片長（載入時會再 clamp）。
- `file://` 下 YT API 可能受限 → 請用本機 HTTP server。
- 部分影片禁止嵌入 → 需換 `videoId`。

## 10. UX（自動 BPM／全螢幕／A2HS／個人學習）

- **個人學習／唔對外分享** 標籤；注意 github.io 往往係公開站。
- **正常流程**：貼 URL → Load → Play。BPM／Offset／細分唔使手打。
  - 優先：上傳同一首歌 CC／本地音訊 → Web Audio 偵測。
  - 或：本機 `tools/server`（127.0.0.1 + yt-dlp）→ 回傳 BPM／Offset（**唔**部署到 Pages）。
  - 純靜態／無上傳：oEmbed 標題／時長啟發式 → 標示「自動」；進階面板可手改。
- **難度**：易＝sparse÷1；正常＝normal÷2；難＝dense÷4。
- **畫面**：YT iframe 全螢幕 cover 墊底；標記／HUD 透明疊加。
- **A2HS**：manifest + SW；非 standalone 顯示「加到主畫面」引導。
- **阻斷（誠實）**：純 github.io **無法**喺瀏覽器合法／技術上可靠地下載 YT 音訊（CORS／ToS）；要 yt-dlp 必須本機 companion。

