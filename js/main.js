/**
 * App wiring: BPM UI, smarter auto-chart, optional Web Audio detect, YT clock.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const urlInput = $("#url-input");
  const bpmInput = $("#bpm-input");
  const offsetInput = $("#offset-input");
  const subdivSelect = $("#subdiv-select");
  const densitySelect = $("#density-select");
  const beatHint = $("#beat-hint");
  const btnLoad = $("#btn-load");
  const btnSample = $("#btn-sample");
  const btnPlay = $("#btn-play");
  const btnShare = $("#btn-share");
  const btnRegen = $("#btn-regen");
  const btnRetry = $("#btn-retry");
  const btnHome = $("#btn-home");
  const audioFile = $("#audio-file");
  const lifeFill = $("#life-fill");
  const scoreEl = $("#score-val");
  const comboEl = $("#combo-val");
  const judgeEl = $("#judgment-flash");
  const breakPanel = $("#break-panel");
  const breakText = $("#break-text");
  const resultScreen = $("#result-screen");
  const readyScreen = $("#ready-screen");
  const resultTitle = $("#result-title");
  const toast = $("#toast");
  const canvas = $("#playfield");

  let chart = null;
  let raf = 0;
  let breakTimer = 0;
  let lastVideoId = null;
  let lastDurationHint = 45;
  let audioDetectMeta = null; // {bpm,offset,duration,source}

  const game = GameEngine.createGame(canvas, {
    getTime: () => YTBridge.getTime(),
    onHud: (s) => {
      lifeFill.style.width = s.life + "%";
      lifeFill.classList.remove("warn", "danger");
      if (s.life < 40) lifeFill.classList.add("danger");
      else if (s.life < 70) lifeFill.classList.add("warn");
      scoreEl.textContent = String(s.score);
      comboEl.textContent = String(s.combo);
    },
    onJudgment: (grade) => {
      const labels = { 300: "PERFECT", 100: "GREAT", 50: "GOOD", 0: "MISS" };
      const colors = { 300: "#06d6a0", 100: "#4cc9f0", 50: "#ffd166", 0: "#ef476f" };
      judgeEl.textContent = labels[grade] || String(grade);
      judgeEl.style.color = colors[grade] || "#fff";
      judgeEl.classList.remove("show");
      void judgeEl.offsetWidth;
      judgeEl.classList.add("show");
    },
    onBreak: (kind) => {
      breakPanel.className = "break-panel active " + kind;
      if (kind === "o") breakText.textContent = "O！応援成功";
      else if (kind === "x") breakText.textContent = "X…危險！";
      else breakText.textContent = "加油…繼續應援！";
      clearTimeout(breakTimer);
      breakTimer = setTimeout(() => breakPanel.classList.remove("active"), 1400);
    },
    onFail: (s) => {
      cancelAnimationFrame(raf);
      YTBridge.pause();
      showResult(false, s);
    },
    onClear: (s) => {
      cancelAnimationFrame(raf);
      YTBridge.pause();
      showResult(true, s);
    },
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function readGenOpts(extra) {
    const bpm = parseFloat(bpmInput.value) || 120;
    const offset = parseFloat(offsetInput.value) || 0;
    const subdivision = parseInt(subdivSelect.value, 10) || 1;
    const density = densitySelect.value || "normal";
    return Object.assign(
      {
        bpm,
        offset,
        subdivision,
        density,
        durationHint: lastDurationHint,
        approachSec: 1.2,
      },
      extra || {}
    );
  }

  function syncUiFromChart(c) {
    if (!c) return;
    if (c.bpm != null) bpmInput.value = String(c.bpm);
    if (c.offset != null) offsetInput.value = String(c.offset);
    if (c.subdivision) subdivSelect.value = String(c.subdivision);
    if (c.density) densitySelect.value = c.density;
    if (c.durationHint) lastDurationHint = c.durationHint;
  }

  function showResult(cleared, s) {
    resultScreen.classList.add("active");
    readyScreen.classList.remove("active");
    resultTitle.textContent = cleared ? "CLEAR！" : "FAILED…";
    resultTitle.style.color = cleared ? "#06d6a0" : "#ef476f";
    $("#stat-300").textContent = s.counts[300];
    $("#stat-100").textContent = s.counts[100];
    $("#stat-50").textContent = s.counts[50];
    $("#stat-0").textContent = s.counts[0];
    $("#stat-score").textContent = s.score;
    $("#stat-combo").textContent = s.maxCombo;
  }

  function hideOverlays() {
    resultScreen.classList.remove("active");
    readyScreen.classList.remove("active");
  }

  function loop() {
    if (!game.isRunning()) return;
    game.tick(YTBridge.getTime());
    raf = requestAnimationFrame(loop);
  }

  function waitDuration(maxMs) {
    maxMs = maxMs || 4000;
    return new Promise((resolve) => {
      const t0 = performance.now();
      (function poll() {
        const d = YTBridge.getDuration();
        if (d && d > 0 && isFinite(d)) {
          resolve(d);
          return;
        }
        if (performance.now() - t0 > maxMs) {
          resolve(0);
          return;
        }
        setTimeout(poll, 150);
      })();
    });
  }

  async function ensurePlayer(videoId) {
    await YTBridge.create("yt-player", videoId, {
      onReady: () => {
        btnPlay.disabled = false;
      },
      onError: () => {
        showToast("此影片可能無法嵌入，請換另一個 videoId");
      },
      onStateChange: () => {},
    });
  }

  async function loadChart(c, opts) {
    chart = ChartUtil.normalizeChart(c);
    if (!chart) {
      showToast("譜面無效");
      return;
    }
    if (!chart.videoId) {
      showToast("譜面缺少 videoId — 請先貼 YouTube URL 再 Regen／Play");
      syncUiFromChart(chart);
      game.resetRuntime(chart);
      game.resize();
      game.draw(0);
      readyScreen.classList.add("active");
      $("#ready-title").textContent = chart.title || "（未設 YT）";
      $("#ready-meta").textContent =
        "標記 " + chart.markers.length + "　BPM " + chart.bpm + "　請補上 YT 連結";
      btnPlay.disabled = true;
      return;
    }
    lastVideoId = chart.videoId;
    if (chart.durationHint) lastDurationHint = chart.durationHint;
    syncUiFromChart(chart);
    urlInput.value = "https://www.youtube.com/watch?v=" + chart.videoId;
    game.resetRuntime(chart);
    game.resize();
    game.draw(0);
    hideOverlays();
    readyScreen.classList.add("active");
    const src = chart.chartSource ? "　[" + chart.chartSource + "]" : "";
    $("#ready-title").textContent = chart.title || chart.videoId;
    $("#ready-meta").textContent =
      "標記 " +
      chart.markers.length +
      "　BPM " +
      chart.bpm +
      "　Off " +
      chart.offset +
      "　÷" +
      (chart.subdivision || 1) +
      src;
    btnPlay.disabled = true;
    await ensurePlayer(chart.videoId);
    const dur = await waitDuration(3500);
    if (dur > 0) {
      lastDurationHint = dur;
      beatHint.textContent =
        "YT 時長 ≈ " +
        dur.toFixed(1) +
        "s　| 時鐘：getCurrentTime（不下載音訊）　| 改 BPM 後按 Regen";
    }
    btnPlay.disabled = false;
    if (opts && opts.autoplay) startPlay();
  }

  async function loadFromUrlInput() {
    const id = ChartUtil.parseVideoId(urlInput.value);
    if (!id) {
      showToast("請貼上有效的 YouTube URL 或 videoId（偵測音訊請用「上傳音訊」）");
      return;
    }
    lastVideoId = id;
    showToast("載入 YT 並依 BPM 產譜…");
    btnPlay.disabled = true;
    await ensurePlayer(id);
    const dur = await waitDuration(4500);
    lastDurationHint = dur > 0 ? dur : 45;
    const opts = readGenOpts({
      durationHint: lastDurationHint,
      chartSource: audioDetectMeta ? "procedural+audioBPM" : "procedural",
      title: "Auto — " + id,
    });
    // If user previously ran audio detect, keep those bpm/offset already in inputs
    const c = ChartUtil.autoGenerateChart(id, opts);
    await loadChart(c);
    showToast(
      "自動譜完成：BPM " +
        opts.bpm +
        "　時長 " +
        lastDurationHint.toFixed(1) +
        "s　標記 " +
        c.markers.length
    );
  }

  async function regenChart() {
    const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId || (chart && chart.videoId);
    if (!id) {
      showToast("請先 Load YouTube URL");
      return;
    }
    // Refresh duration if player ready
    const dur = YTBridge.getDuration();
    if (dur > 0) lastDurationHint = dur;
    const opts = readGenOpts({
      durationHint: lastDurationHint,
      chartSource: audioDetectMeta ? "procedural+audioBPM" : "procedural",
      title: "Auto — " + id + " @ " + (parseFloat(bpmInput.value) || 120) + "BPM",
    });
    const c = ChartUtil.autoGenerateChart(id, opts);
    await loadChart(c);
    showToast("已 Regen：BPM " + opts.bpm + " Offset " + opts.offset + " ÷" + opts.subdivision);
  }

  async function loadSample() {
    try {
      const res = await fetch("sample-chart.json");
      const json = await res.json();
      await loadChart(json);
      showToast("已載入手譜 sample");
    } catch (e) {
      showToast("無法載入 sample（請用 HTTP server）");
      const id = "jNQXAC9IVRw";
      await loadChart(ChartUtil.autoGenerateChart(id, readGenOpts({ durationHint: 40 })));
    }
  }

  async function onAudioSelected(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    showToast("分析音訊中（僅本地檔，唔經 YT）…");
    try {
      const meta = await BeatDetect.analyzeFile(file);
      audioDetectMeta = meta;
      bpmInput.value = String(meta.bpm);
      offsetInput.value = String(meta.offset);
      lastDurationHint = meta.duration;
      beatHint.textContent =
        "音訊偵測：BPM " +
        meta.bpm +
        "　offset " +
        meta.offset +
        "　時長 " +
        meta.duration.toFixed(1) +
        "s — 請確認 YT 係同一首歌，再 Regen／Load";
      const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId;
      if (id) {
        const c = ChartUtil.autoGenerateChart(
          id,
          readGenOpts({
            durationHint: Math.min(meta.duration, lastDurationHint || meta.duration),
            chartSource: "webaudio+procedural",
            title: "AudioBPM — " + file.name,
          })
        );
        await loadChart(c);
        showToast("已用上傳音訊 BPM 產譜；播放仍用 YT 嵌入");
      } else {
        showToast("已填入 BPM／Offset — 請貼同一首歌嘅 YT URL 再 Load");
      }
    } catch (err) {
      console.warn(err);
      showToast(String(err.message || err));
    }
  }

  function startPlay() {
    if (!chart || !chart.videoId) {
      showToast("需要 YouTube videoId 先可以 Play");
      return;
    }
    hideOverlays();
    game.resetRuntime(chart);
    game.resize();
    YTBridge.seek(0);
    YTBridge.play();
    game.start();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  async function copyShare() {
    if (!chart) {
      showToast("尚未載入譜面");
      return;
    }
    if (!chart.videoId) {
      showToast("分享需要 videoId");
      return;
    }
    const url = ChartUtil.buildShareUrl(chart);
    try {
      await navigator.clipboard.writeText(url);
      showToast("已複製分享連結（videoId + chart）");
    } catch (_) {
      window.prompt("複製分享連結：", url);
    }
  }

  btnLoad.addEventListener("click", loadFromUrlInput);
  btnSample.addEventListener("click", loadSample);
  btnPlay.addEventListener("click", startPlay);
  btnRegen.addEventListener("click", regenChart);
  $("#btn-ready-play").addEventListener("click", startPlay);
  btnShare.addEventListener("click", copyShare);
  $("#btn-result-share").addEventListener("click", copyShare);
  audioFile.addEventListener("change", onAudioSelected);
  btnRetry.addEventListener("click", () => {
    if (chart) startPlay();
  });
  btnHome.addEventListener("click", () => {
    game.stop();
    cancelAnimationFrame(raf);
    YTBridge.pause();
    resultScreen.classList.remove("active");
    readyScreen.classList.add("active");
  });

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadFromUrlInput();
  });

  window.addEventListener("resize", () => {
    game.resize();
    if (chart) game.draw(YTBridge.getTime());
  });

  // boot
  game.resize();
  const shared = ChartUtil.parseShareFromLocation();
  if (shared) {
    loadChart(shared).then(() => showToast("已從分享連結載入譜面"));
  } else {
    readyScreen.classList.add("active");
    $("#ready-title").textContent = "貼上 YouTube 連結開始應援";
    $("#ready-meta").textContent = "填 BPM → Load；或上傳 CC 音訊偵測後再對應 YT";
    btnPlay.disabled = true;
  }
})();
