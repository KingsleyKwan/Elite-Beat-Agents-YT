/**
 * App wiring: BPM UI, clamp-to-duration, latency, playing HUD, softlock-safe end.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const urlInput = $("#url-input");
  const bpmInput = $("#bpm-input");
  const offsetInput = $("#offset-input");
  const subdivSelect = $("#subdiv-select");
  const densitySelect = $("#density-select");
  const latencyInput = $("#latency-input");
  const latencyVal = $("#latency-val");
  const beatHint = $("#beat-hint");
  const btnLoad = $("#btn-load");
  const btnSample = $("#btn-sample");
  const btnPlay = $("#btn-play");
  const btnShare = $("#btn-share");
  const btnRegen = $("#btn-regen");
  const btnRetry = $("#btn-retry");
  const btnHome = $("#btn-home");
  const btnCalibrate = $("#btn-calibrate");
  const audioFile = $("#audio-file");
  const lifeFill = $("#life-fill");
  const scoreEl = $("#score-val");
  const comboEl = $("#combo-val");
  const judgeEl = $("#judgment-flash");
  const breakPanel = $("#break-panel");
  const breakText = $("#break-text");
  const resultScreen = $("#result-screen");
  const readyScreen = $("#ready-screen");
  const calibrateScreen = $("#calibrate-screen");
  const resultTitle = $("#result-title");
  const toast = $("#toast");
  const canvas = $("#playfield");
  const appEl = $("#app");

  let chart = null;
  let raf = 0;
  let breakTimer = 0;
  let lastVideoId = null;
  let lastDurationHint = 45;
  let audioDetectMeta = null;
  let ytEnded = false;

  const LATENCY_KEY = "ouendan-yt-latency-ms";

  function loadStoredLatency() {
    const v = parseInt(localStorage.getItem(LATENCY_KEY) || "40", 10);
    const ms = Number.isFinite(v) ? Math.max(0, Math.min(200, v)) : 40;
    latencyInput.value = String(ms);
    latencyVal.textContent = String(ms);
    return ms;
  }

  function applyLatency(ms) {
    ms = Math.max(0, Math.min(200, Number(ms) || 0));
    latencyInput.value = String(ms);
    latencyVal.textContent = String(ms);
    localStorage.setItem(LATENCY_KEY, String(ms));
    game.setDeviceLatencyMs(ms);
  }

  const game = GameEngine.createGame(canvas, {
    getTime: () => YTBridge.getTime(),
    getState: () => YTBridge.getState(),
    onHud: (s) => {
      lifeFill.style.width = s.life + "%";
      lifeFill.classList.remove("warn", "danger");
      if (s.life < 40) lifeFill.classList.add("danger");
      else if (s.life < 70) lifeFill.classList.add("warn");
      scoreEl.textContent = String(s.score);
      comboEl.textContent = String(s.combo);
    },
    onJudgment: (grade, combo, info) => {
      const labels = { 300: "PERFECT", 100: "GREAT", 50: "GOOD", 0: "MISS" };
      const colors = { 300: "#06d6a0", 100: "#4cc9f0", 50: "#ffd166", 0: "#ef476f" };
      const el = (info && info.earlyLate) || "";
      const elColor =
        el === "EARLY" ? "#4cc9f0" : el === "LATE" ? "#ff8fab" : el === "OK" ? "#94a3b8" : "";
      judgeEl.innerHTML =
        '<div>' +
        (labels[grade] || String(grade)) +
        "</div>" +
        (el && el !== "MISS" && el !== "OK"
          ? '<div class="el-tag" style="color:' + elColor + '">' + el + "</div>"
          : el === "OK"
            ? ""
            : "");
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
      setPlayingUi(false);
      showResult(false, s);
    },
    onClear: (s) => {
      cancelAnimationFrame(raf);
      YTBridge.pause();
      setPlayingUi(false);
      showResult(true, s);
    },
  });

  applyLatency(loadStoredLatency());

  function setPlayingUi(on) {
    appEl.classList.toggle("playing", !!on);
    if (on) {
      // recover canvas height after beatbar collapse
      requestAnimationFrame(() => game.resize());
    } else {
      requestAnimationFrame(() => game.resize());
    }
  }

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
    calibrateScreen.classList.remove("active");
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
    calibrateScreen.classList.remove("active");
  }

  function loop() {
    if (!game.isRunning()) return;
    const dur = YTBridge.getDuration() || lastDurationHint || 0;
    game.tick(YTBridge.getTime(), {
      videoDuration: dur,
      ended: ytEnded || YTBridge.getState() === 0,
    });
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
    ytEnded = false;
    await YTBridge.create("yt-player", videoId, {
      onReady: () => {
        btnPlay.disabled = false;
      },
      onError: () => {
        showToast("此影片可能無法嵌入，請換另一個 videoId");
      },
      onStateChange: (e) => {
        // 0 = ENDED
        if (e.data === 0) {
          ytEnded = true;
          if (game.isRunning()) {
            game.forceResolveEnd("yt-ended");
          }
        }
      },
    });
  }

  function applyDurationClamp(c, dur) {
    if (!(dur > 0)) return c;
    const clamped = ChartUtil.clampChartToDuration(c, dur, 0.4);
    game.setVideoDuration(dur);
    lastDurationHint = dur;
    return clamped;
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
    btnPlay.disabled = true;
    await ensurePlayer(chart.videoId);
    const dur = await waitDuration(4500);
    if (dur > 0) {
      const before = chart.markers.length;
      chart = applyDurationClamp(chart, dur);
      beatHint.textContent =
        "YT 時長 ≈ " +
        dur.toFixed(1) +
        "s　| 標記 " +
        chart.markers.length +
        (chart.markers.length < before ? "（已夾掉超時標記）" : "") +
        "　| 改 BPM 後 Regen　| 延遲 " +
        game.getDeviceLatencyMs() +
        "ms";
      if (chart.markers.length < before) {
        showToast("已按片長夾短譜面（" + before + "→" + chart.markers.length + "）");
      }
    }
    if (!chart.markers.length) {
      showToast("片長過短或譜面全被夾掉 — 請換片／Regen");
      btnPlay.disabled = true;
      return;
    }
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
      "　延遲 " +
      game.getDeviceLatencyMs() +
      "ms" +
      src;
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
    let c = ChartUtil.autoGenerateChart(id, opts);
    if (dur > 0) c = ChartUtil.clampChartToDuration(c, dur, 0.4);
    await loadChart(c);
    showToast(
      "自動譜完成：BPM " +
        opts.bpm +
        "　時長 " +
        lastDurationHint.toFixed(1) +
        "s　標記 " +
        (chart && chart.markers.length)
    );
  }

  async function regenChart() {
    const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId || (chart && chart.videoId);
    if (!id) {
      showToast("請先 Load YouTube URL");
      return;
    }
    const dur = YTBridge.getDuration();
    if (dur > 0) lastDurationHint = dur;
    const opts = readGenOpts({
      durationHint: lastDurationHint,
      chartSource: audioDetectMeta ? "procedural+audioBPM" : "procedural",
      title: "Auto — " + id + " @ " + (parseFloat(bpmInput.value) || 120) + "BPM",
    });
    let c = ChartUtil.autoGenerateChart(id, opts);
    if (lastDurationHint > 0) c = ChartUtil.clampChartToDuration(c, lastDurationHint, 0.4);
    await loadChart(c);
    showToast("已 Regen：BPM " + opts.bpm + " Offset " + opts.offset + " ÷" + opts.subdivision);
  }

  async function loadSample() {
    try {
      const res = await fetch("sample-chart.json");
      const json = await res.json();
      await loadChart(json);
      showToast("已載入 Sample（譜面已對齊短片）");
    } catch (e) {
      showToast("無法載入 sample（請用 HTTP server）");
      const id = "jNQXAC9IVRw";
      await loadChart(
        ChartUtil.autoGenerateChart(id, readGenOpts({ durationHint: 18.5, density: "sparse" }))
      );
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
        let c = ChartUtil.autoGenerateChart(
          id,
          readGenOpts({
            durationHint: meta.duration,
            chartSource: "webaudio+procedural",
            title: "AudioBPM — " + file.name,
          })
        );
        const ytDur = YTBridge.getDuration();
        if (ytDur > 0) c = ChartUtil.clampChartToDuration(c, ytDur, 0.4);
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
    ytEnded = false;
    hideOverlays();
    setPlayingUi(true);
    game.resetRuntime(chart);
    const dur = YTBridge.getDuration();
    if (dur > 0) {
      chart = applyDurationClamp(chart, dur);
      game.resetRuntime(chart);
      game.setVideoDuration(dur);
    }
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

  // --- latency calibrate (4 visual flashes) ---
  let calBusy = false;
  function openCalibrate() {
    calibrateScreen.classList.add("active");
    readyScreen.classList.remove("active");
    $("#calibrate-msg").textContent = "跟住圓圈閃光撳畫面（共 4 次）";
    $("#calibrate-flash").classList.remove("pulse");
  }

  function runCalibrate() {
    if (calBusy) return;
    calBusy = true;
    const flash = $("#calibrate-flash");
    const msg = $("#calibrate-msg");
    const deltas = [];
    let i = 0;
    const interval = 700;
    let expected = 0;
    let listening = false;

    function onTap() {
      if (!listening) return;
      const dt = performance.now() - expected;
      deltas.push(dt);
      listening = false;
      flash.classList.remove("pulse");
      msg.textContent = "已記錄 " + deltas.length + "/4（Δ " + Math.round(dt) + "ms）";
    }

    calibrateScreen.addEventListener("pointerdown", onTap);
    msg.textContent = "準備…";

    function beat() {
      if (i >= 4) {
        calibrateScreen.removeEventListener("pointerdown", onTap);
        calBusy = false;
        if (deltas.length >= 2) {
          const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
          // positive avg => user tapped after flash => need latency compensation
          const ms = Math.max(0, Math.min(200, Math.round(avg)));
          applyLatency(ms);
          showToast("校准完成：延遲 " + ms + "ms");
          $("#calibrate-msg").textContent = "完成！延遲設為 " + ms + "ms";
        } else {
          showToast("校准次數不足");
        }
        setTimeout(() => {
          calibrateScreen.classList.remove("active");
          if (chart) readyScreen.classList.add("active");
        }, 700);
        return;
      }
      i += 1;
      expected = performance.now();
      listening = true;
      flash.classList.add("pulse");
      msg.textContent = "撳！（" + i + "/4）";
      setTimeout(() => flash.classList.remove("pulse"), 120);
      setTimeout(beat, interval);
    }
    setTimeout(beat, 500);
  }

  btnLoad.addEventListener("click", loadFromUrlInput);
  btnSample.addEventListener("click", loadSample);
  btnPlay.addEventListener("click", startPlay);
  btnRegen.addEventListener("click", regenChart);
  $("#btn-ready-play").addEventListener("click", startPlay);
  btnShare.addEventListener("click", copyShare);
  $("#btn-result-share").addEventListener("click", copyShare);
  audioFile.addEventListener("change", onAudioSelected);
  latencyInput.addEventListener("input", () => applyLatency(latencyInput.value));
  btnCalibrate.addEventListener("click", openCalibrate);
  $("#btn-cal-start").addEventListener("click", runCalibrate);
  $("#btn-cal-cancel").addEventListener("click", () => {
    calibrateScreen.classList.remove("active");
    if (chart) readyScreen.classList.add("active");
  });
  btnRetry.addEventListener("click", () => {
    if (chart) startPlay();
  });
  btnHome.addEventListener("click", () => {
    game.stop();
    cancelAnimationFrame(raf);
    YTBridge.pause();
    setPlayingUi(false);
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
    $("#ready-meta").textContent = "填 BPM → Load；Sample 已夾短片長；可校准延遲";
    btnPlay.disabled = true;
  }
})();
