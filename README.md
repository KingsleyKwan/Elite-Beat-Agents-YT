# Elite Beat Agents YT（應援團 YT）

手機橫向節奏遊戲：貼 YouTube 歌連結 → 依 BPM 產譜 → 點／劃／轉應援。靈感來自 NDS《押忍！闘え！応援団》／Elite Beat Agents。

## 線上玩

若已開啟 GitHub Pages，打開：

**https://kingsleykwan.github.io/Elite-Beat-Agents-YT/**

（Settings → Pages → Deploy from branch `main` / root。首次推送後可能要手動開一次。）

手機請**橫放**。流程：貼 YT URL → Load → 調 BPM／Offset → Regen → Play。可選上傳同一首歌嘅本地／CC 音訊估 BPM（播放仍用 YT 嵌入，唔下載 YT 音訊）。

## 本機

```bash
python3 -m http.server 8080
```

開 `http://localhost:8080/`（唔好用 `file://`）。

## 檔案

| 路徑 | 說明 |
|------|------|
| `index.html` | 遊戲 |
| `js/` `css/` | 邏輯與樣式 |
| `sample-chart.json` | 範例譜 |
| `SPEC.md` | 玩法／關卡格式規格 |

## 限制

純 YouTube 路徑唔會下載或分析音訊；BPM／Offset 要手填或用上傳音訊偵測。部分影片禁止嵌入。
