# 本機對拍伺服器（個人學習）

**用途**：喺你部電腦用 `yt-dlp` 拉 YouTube **音訊** → 估 BPM／Offset → 俾遊戲頁自動產譜。  
**唔係**公開 API。`github.io` 靜態站**唔會**、亦**唔應該**部署呢個服務。

## 警告

- YouTube ToS／版權：只供個人學習；Kingsley 表明唔對外分享 Pages 時仍請注意 **github.io 預設公開**。
- 只綁 `127.0.0.1`；CORS 只准 localhost／區網 origin。
- 勿將此資料夾放到可被外人呼叫嘅雲端／Pages Functions。

## 啟動

```bash
cd /workspace/ouendan-yt/tools/server
python3 -m venv .venv
.venv/bin/pip install yt-dlp numpy
.venv/bin/python server.py
```

遊戲頁（本機 `python -m http.server` 或區網）撳「本機自動對拍」。

## 同靜態 Pages 嘅關係

| 環境 | 自動 BPM |
|------|----------|
| 純 github.io | **唔可以**下載 YT；只能上傳本地／CC 音訊，或手填進階 |
| 本機 + helper | `yt-dlp` 對拍（此工具） |
| 上傳音訊 | 瀏覽器 Web Audio（唔經 YT 下載） |
