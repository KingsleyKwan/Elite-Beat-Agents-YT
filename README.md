# Elite Beat Agents YT（應援團 YT）

**個人學習／唔對外分享。**

> ⚠️ **GitHub Pages（github.io）通常係公開網址。** 任何人有連結都睇到。  
> 呢個靜態站**唔會**、亦**唔應該**提供 YouTube 下載 API。若要 yt-dlp 自動對拍，只可喺你部電腦跑 `tools/server`（唔係 Pages）。

## 線上

**https://kingsleykwan.github.io/Elite-Beat-Agents-YT/**

手機橫放；建議「加到主畫面」全螢幕。流程：貼 YT → Load → 難度 易／正常／難 → Play。  
自動 BPM：啟發式；或上傳同一首歌音訊。播放永遠用嵌入 IFrame（時鐘 `getCurrentTime`）。

## 本機

```bash
python3 -m http.server 8080
```

可選對拍伺服器（私人）：repo 內 `tools/server`（綁 127.0.0.1）。

## 檔案

`index.html` · `css/` · `js/` · `sample-chart.json` · `SPEC.md` · `manifest.webmanifest` · `sw.js` · `icons/`
