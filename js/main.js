/**
 * Phone-minimal UI: big URL + Paste + Go; tools in ⋯ sheet.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const appEl = $("#app");
  const homeUrl = $("#home-url");
  const urlInput = $("#url-input");
  const bpmInput = $("#bpm-input");
  const offsetInput = $("#offset-input");
  const subdivSelect = $("#subdiv-select");
  const difficultySelect = $("#difficulty-select");
  const difficultyLobby = $("#difficulty-select-lobby");
  const latencyInput = $("#latency-input");
  const latencyVal = $("#latency-val");
  const autoBpmLabel = $("#auto-bpm-label");
  const beatHint = $("#beat-hint");
  const btnGo = $("#btn-go");
  const btnPaste = $("#btn-paste");
  const btnLoad = $("#btn-load");
  const btnSample = $("#btn-sample");
  const btnPlay = $("#btn-play");
  const btnShare = $("#btn-share");
  const btnRegen = $("#btn-regen");
  const btnRetry = $("#btn-retry");
  const btnHome = $("#btn-home");
  const btnHomeMini = $("#btn-home-mini");
  const btnMore = $("#btn-more");
  const btnCalibrate = $("#btn-calibrate");
  const btnLocalHelper = $("#btn-local-helper");
  const btnBeatTap = $("#btn-beat-tap");
  const btnBeatTapReady = $("#btn-beat-tap-ready");
  const audioFile = $("#audio-file");
  const audioFileReady = $("#audio-file-ready");
  const lifeFill = $("#life-fill");
  const scoreEl = $("#score-val");
  const comboEl = $("#combo-val");
  const judgeEl = $("#judgment-flash");
  const breakPanel = $("#break-panel");
  const breakText = $("#break-text");
  const resultScreen = $("#result-screen");
  const readyScreen = $("#ready-screen");
  const lobbyScreen = $("#lobby-screen");
  const calibrateScreen = $("#calibrate-screen");
  const a2hsGate = $("#a2hs-gate");
  const disclaimerGate = $("#disclaimer-gate");
  const moreSheet = $("#more-sheet");
  const topbar = $("#topbar");
  const gameHud = $("#game-hud");
  const resultTitle = $("#result-title");
  const toast = $("#toast");
  const canvas = $("#playfield");
  const beatTapOverlay = $("#beat-tap-overlay");
  const beatTapMsg = $("#beat-tap-msg");
  const beatTapCount = $("#beat-tap-count");
  const btnTapPad = $("#btn-tap-pad");
  const btnBeatTapDone = $("#btn-beat-tap-done");
  const btnBeatTapCancel = $("#btn-beat-tap-cancel");

  let chart = null;
  let raf = 0;
  let breakTimer = 0;
  let lastVideoId = null;
  let lastDurationHint = 45;
  let audioDetectMeta = null;
  let ytEnded = false;
  let autoMeta = { bpm: 120, offset: 0, source: "default", label: "自動" };
  const LATENCY_KEY = "ouendan-yt-latency-ms";
  const A2HS_SKIP_KEY = "ouendan-yt-a2hs-skip";
  const DISCLAIMER_KEY = "ouendan-yt-disclaimer-ok";
  const HELPER_URL = "http://127.0.0.1:8767";
  const BEAT_TAP_TARGET = 8;
  let beatTapTimes = [];
  let beatTapActive = false;
  const DIFF = ChartUtil.DIFFICULTY_PRESETS;

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function setMode(mode) {
    appEl.classList.remove("mode-home", "mode-lobby", "mode-play");
    appEl.classList.add("mode-" + mode);
    if (mode === "home") {
      topbar.hidden = true;
      gameHud.hidden = true;
      readyScreen.classList.add("active");
      lobbyScreen.classList.remove("active");
      resultScreen.classList.remove("active");
    } else if (mode === "lobby") {
      topbar.hidden = false;
      gameHud.hidden = true;
      readyScreen.classList.remove("active");
      lobbyScreen.classList.add("active");
      resultScreen.classList.remove("active");
      btnPlay.disabled = !chart;
    } else if (mode === "play") {
      topbar.hidden = false;
      gameHud.hidden = false;
      readyScreen.classList.remove("active");
      lobbyScreen.classList.remove("active");
      resultScreen.classList.remove("active");
    }
  }

  function syncUrlFromHome() {
    if (homeUrl && urlInput) urlInput.value = homeUrl.value.trim();
  }
  function syncHomeFromUrl() {
    if (homeUrl && urlInput) homeUrl.value = urlInput.value;
  }

  function syncDifficulty(from) {
    const v = from.value;
    if (difficultySelect) difficultySelect.value = v;
    if (difficultyLobby) difficultyLobby.value = v;
    applyDifficultyToHidden();
  }

  function loadStoredLatency() {
    const v = parseInt(localStorage.getItem(LATENCY_KEY) || "40", 10);
    const ms = Number.isFinite(v) ? Math.max(0, Math.min(200, v)) : 40;
    if (latencyInput) latencyInput.value = String(ms);
    if (latencyVal) latencyVal.textContent = String(ms);
    return ms;
  }
  function applyLatency(ms) {
    ms = Math.max(0, Math.min(200, Number(ms) || 0));
    if (latencyInput) latencyInput.value = String(ms);
    if (latencyVal) latencyVal.textContent = String(ms);
    localStorage.setItem(LATENCY_KEY, String(ms));
    game.setDeviceLatencyMs(ms);
  }

  function difficultyOpts() {
    const key = (difficultySelect && difficultySelect.value) || "normal";
    const p = DIFF[key] || DIFF.normal;
    return { density: p.density, subdivision: p.subdivision, difficulty: key };
  }
  function applyDifficultyToHidden() {
    const d = difficultyOpts();
    if (subdivSelect) subdivSelect.value = String(d.subdivision);
  }
  function setAutoBadge(meta) {
    autoMeta = meta || autoMeta;
    if (bpmInput) bpmInput.value = String(autoMeta.bpm);
    if (offsetInput) offsetInput.value = String(autoMeta.offset);
    if (autoBpmLabel)
      autoBpmLabel.textContent =
        autoMeta.bpm + (autoMeta.label ? " · " + autoMeta.label : "");
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
      const elColor = el === "EARLY" ? "#4cc9f0" : el === "LATE" ? "#ff8fab" : "";
      judgeEl.innerHTML =
        "<div>" +
        (labels[grade] || "") +
        "</div>" +
        (el && el !== "MISS" && el !== "OK"
          ? '<div class="el-tag" style="color:' + elColor + '">' + el + "</div>"
          : "");
      judgeEl.style.color = colors[grade] || "#fff";
      judgeEl.classList.remove("show");
      void judgeEl.offsetWidth;
      judgeEl.classList.add("show");
    },
    onBreak: (kind) => {
      breakPanel.className = "break-panel active " + kind;
      breakText.textContent = kind === "o" ? "O！" : kind === "x" ? "X…" : "加油！";
      clearTimeout(breakTimer);
      breakTimer = setTimeout(() => breakPanel.classList.remove("active"), 1200);
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
  applyDifficultyToHidden();
  setAutoBadge(autoMeta);

  function setPlayingUi(on) {
    appEl.classList.toggle("playing", !!on);
    if (on) setMode("play");
    requestAnimationFrame(() => {
      game.resize();
      YTBridge.applyCoverSize && YTBridge.applyCoverSize();
    });
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function readGenOpts(extra) {
    applyDifficultyToHidden();
    const d = difficultyOpts();
    const bpm = parseFloat(bpmInput.value) || autoMeta.bpm || 120;
    const offset = parseFloat(offsetInput.value);
    const off = Number.isFinite(offset) ? offset : autoMeta.offset || 0;
    return Object.assign(
      {
        bpm,
        offset: off,
        subdivision: d.subdivision,
        density: d.density,
        durationHint: lastDurationHint,
        approachSec: 1.2,
        chartSource: autoMeta.source || "auto",
      },
      extra || {}
    );
  }

  function syncUiFromChart(c) {
    if (!c) return;
    if (c.bpm != null) {
      bpmInput.value = String(c.bpm);
      if (autoBpmLabel) autoBpmLabel.textContent = String(c.bpm);
    }
    if (c.offset != null) offsetInput.value = String(c.offset);
    if (c.subdivision) subdivSelect.value = String(c.subdivision);
    const diff =
      c.density === "sparse" ? "easy" : c.density === "dense" ? "hard" : "normal";
    if (difficultySelect) difficultySelect.value = diff;
    if (difficultyLobby) difficultyLobby.value = diff;
    if (c.durationHint) lastDurationHint = c.durationHint;
  }

  function showResult(cleared, s) {
    setPlayingUi(false);
    topbar.hidden = false;
    gameHud.hidden = true;
    readyScreen.classList.remove("active");
    lobbyScreen.classList.remove("active");
    resultScreen.classList.add("active");
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
    lobbyScreen.classList.remove("active");
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
        if (d && d > 0 && isFinite(d)) return resolve(d);
        if (performance.now() - t0 > maxMs) return resolve(0);
        setTimeout(poll, 150);
      })();
    });
  }

  async function ensurePlayer(videoId) {
    ytEnded = false;
    await YTBridge.create("yt-player", videoId, {
      onReady: () => {
        btnPlay.disabled = false;
        YTBridge.applyCoverSize && YTBridge.applyCoverSize();
      },
      onError: () => showToast("影片無法播放，換一條連結"),
      onStateChange: (e) => {
        if (e.data === 0) {
          ytEnded = true;
          if (game.isRunning()) game.forceResolveEnd("yt-ended");
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

  async function resolveAutoBeat(videoId, duration) {
    if (audioDetectMeta && audioDetectMeta.bpm) {
      return {
        bpm: audioDetectMeta.bpm,
        offset: audioDetectMeta.offset || 0,
        source: audioDetectMeta.source || "webaudio",
        label: audioDetectMeta.label || "偵測",
      };
    }
    let title = "";
    const vd = YTBridge.getVideoData && YTBridge.getVideoData();
    if (vd && vd.title) title = vd.title;
    if (!title) {
      try {
        const meta = await ChartUtil.fetchVideoMeta(videoId);
        title = (meta && meta.title) || "";
      } catch (_) {}
    }
    return ChartUtil.guessBpmFromMeta({ title: title, duration: duration });
  }

  async function loadChart(c) {
    chart = ChartUtil.normalizeChart(c);
    if (!chart || !chart.videoId) {
      showToast("載入失敗");
      return;
    }
    lastVideoId = chart.videoId;
    if (chart.durationHint) lastDurationHint = chart.durationHint;
    syncUiFromChart(chart);
    urlInput.value = "https://www.youtube.com/watch?v=" + chart.videoId;
    syncHomeFromUrl();
    btnPlay.disabled = true;
    await ensurePlayer(chart.videoId);
    const dur = await waitDuration(4500);
    if (dur > 0) {
      const before = chart.markers.length;
      chart = applyDurationClamp(chart, dur);
      if (chart.markers.length < before) showToast("已按片長調整");
    }
    if (!chart.markers.length) {
      showToast("譜面太短");
      return;
    }
    game.resetRuntime(chart);
    game.resize();
    game.draw(0);
    const diffLabel = (DIFF[difficultySelect.value] || DIFF.normal).label;
    $("#ready-title").textContent = chart.title || "準備好";
    $("#ready-meta").textContent = diffLabel + " · " + chart.markers.length + " 標記";
    setMode("lobby");
    btnPlay.disabled = false;
  }

  async function buildAndLoad(videoId) {
    lastVideoId = videoId;
    showToast("載入中…");
    btnPlay.disabled = true;
    await ensurePlayer(videoId);
    const dur = await waitDuration(4500);
    lastDurationHint = dur > 0 ? dur : 45;
    const guessed = await resolveAutoBeat(videoId, lastDurationHint);
    setAutoBadge(guessed);
    const opts = readGenOpts({
      durationHint: lastDurationHint,
      chartSource: guessed.source,
      title: videoId,
    });
    let c = ChartUtil.autoGenerateChart(videoId, opts);
    if (dur > 0) c = ChartUtil.clampChartToDuration(c, dur, 0.4);
    await loadChart(c);
  }

  async function goFromHome() {
    syncUrlFromHome();
    const id = ChartUtil.parseVideoId(urlInput.value || homeUrl.value);
    if (!id) {
      showToast("請貼上 YouTube 連結");
      homeUrl && homeUrl.focus();
      return;
    }
    await buildAndLoad(id);
  }

  async function pasteUrl() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        showToast("請長按輸入框貼上");
        homeUrl && homeUrl.focus();
        return;
      }
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) {
        showToast("剪貼簿係空");
        return;
      }
      homeUrl.value = text;
      urlInput.value = text;
      showToast("已貼上");
      // auto-go if looks like YT
      if (ChartUtil.parseVideoId(text)) {
        await goFromHome();
      }
    } catch (err) {
      console.warn(err);
      showToast("無法讀取剪貼簿，請長按輸入框貼上");
      homeUrl && homeUrl.focus();
    }
  }

  async function regenChart() {
    const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId || (chart && chart.videoId);
    if (!id) return showToast("未有影片");
    const dur = YTBridge.getDuration();
    if (dur > 0) lastDurationHint = dur;
    let c = ChartUtil.autoGenerateChart(id, readGenOpts({ durationHint: lastDurationHint }));
    if (lastDurationHint > 0) c = ChartUtil.clampChartToDuration(c, lastDurationHint, 0.4);
    await loadChart(c);
  }

  async function loadSample() {
    closeMore();
    try {
      const res = await fetch("sample-chart.json");
      const json = await res.json();
      setAutoBadge({ bpm: json.bpm || 100, offset: json.offset || 0, source: "sample", label: "Sample" });
      await loadChart(json);
    } catch (_) {
      await buildAndLoad("jNQXAC9IVRw");
    }
  }

  async function onAudioSelected(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    closeMore();
    showToast("分析音訊…");
    try {
      const meta = await BeatDetect.analyzeFile(file);
      audioDetectMeta = Object.assign({}, meta, { source: "webaudio", label: "音訊" });
      setAutoBadge({ bpm: meta.bpm, offset: meta.offset, source: "webaudio", label: "音訊" });
      lastDurationHint = meta.duration || lastDurationHint;
      const id = ChartUtil.parseVideoId(urlInput.value || homeUrl.value) || lastVideoId;
      if (id) await buildAndLoad(id);
      else showToast("請先貼 YouTube 連結");
    } catch (err) {
      showToast(String(err.message || err));
    }
  }

  function estimateBpmFromTaps(times) {
    if (!times || times.length < 4) return null;
    const intervals = [];
    for (let i = 1; i < times.length; i++) {
      const d = times[i] - times[i - 1];
      if (d > 0.15 && d < 2.5) intervals.push(d);
    }
    if (intervals.length < 3) return null;
    intervals.sort((a, b) => a - b);
    const med = intervals[Math.floor(intervals.length / 2)];
    const filtered = intervals.filter((x) => x > med * 0.72 && x < med * 1.28);
    const use = filtered.length >= 2 ? filtered : intervals;
    const avg = use.reduce((a, b) => a + b, 0) / use.length;
    let bpm = 60 / avg;
    while (bpm < 75 && bpm * 2 <= 180) bpm *= 2;
    while (bpm > 175 && bpm / 2 >= 70) bpm /= 2;
    bpm = Math.round(bpm * 10) / 10;
    const beat = 60 / bpm;
    let phase = 0;
    for (const t of times) {
      let p = t % beat;
      if (p > beat / 2) p -= beat;
      phase += p;
    }
    return {
      bpm: bpm,
      offset: Math.round((phase / times.length) * 1000) / 1000,
      source: "beat-tap",
      label: "跟拍",
    };
  }

  async function startBeatTap() {
    closeMore();
    const id = ChartUtil.parseVideoId(urlInput.value || homeUrl.value) || lastVideoId || (chart && chart.videoId);
    if (!id) return showToast("請先貼連結並開始");
    if (!YTBridge.player) {
      await ensurePlayer(id);
      await waitDuration(3000);
    }
    beatTapTimes = [];
    beatTapActive = true;
    beatTapCount.textContent = "0 / " + BEAT_TAP_TARGET;
    beatTapMsg.textContent = "跟拍子撳大掣";
    btnBeatTapDone.disabled = true;
    beatTapOverlay.hidden = false;
    lobbyScreen.classList.remove("active");
    YTBridge.play();
  }
  function onBeatTapPad() {
    if (!beatTapActive) return;
    const t = YTBridge.getTime();
    if (!(t >= 0)) return;
    if (beatTapTimes.length && t - beatTapTimes[beatTapTimes.length - 1] < 0.12) return;
    beatTapTimes.push(t);
    beatTapCount.textContent = beatTapTimes.length + " / " + BEAT_TAP_TARGET;
    if (beatTapTimes.length >= 4) btnBeatTapDone.disabled = false;
    if (beatTapTimes.length >= BEAT_TAP_TARGET) finishBeatTap();
  }
  async function finishBeatTap() {
    if (!beatTapActive) return;
    beatTapActive = false;
    const est = estimateBpmFromTaps(beatTapTimes);
    beatTapOverlay.hidden = true;
    YTBridge.pause();
    if (!est) {
      showToast("再試多次跟拍");
      setMode("lobby");
      return;
    }
    audioDetectMeta = est;
    setAutoBadge(est);
    const id = lastVideoId || (chart && chart.videoId);
    if (id) {
      await buildAndLoad(id);
      showToast("BPM " + est.bpm);
    }
  }
  function cancelBeatTap() {
    beatTapActive = false;
    beatTapOverlay.hidden = true;
    YTBridge.pause();
    if (chart) setMode("lobby");
  }

  async function runLocalHelper() {
    const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId;
    if (!id) return;
    try {
      const res = await fetch(HELPER_URL + "/analyze?v=" + encodeURIComponent(id));
      const meta = await res.json();
      if (!meta.ok) throw new Error(meta.error || "fail");
      audioDetectMeta = meta;
      setAutoBadge({ bpm: meta.bpm, offset: meta.offset, source: "localhost-ytdlp", label: "PC" });
      await buildAndLoad(id);
    } catch (_) {
      showToast("請用上傳或跟拍");
    }
  }

  function startPlay() {
    if (!chart || !chart.videoId) return showToast("請先開始");
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
    closeMore();
    if (!chart || !chart.videoId) return showToast("未有譜");
    const url = ChartUtil.buildShareUrl(chart);
    try {
      await navigator.clipboard.writeText(url);
      showToast("已複製");
    } catch (_) {
      window.prompt("複製", url);
    }
  }

  function goHome() {
    game.stop();
    cancelAnimationFrame(raf);
    YTBridge.pause();
    appEl.classList.remove("playing");
    setMode("home");
    homeUrl && homeUrl.focus();
  }

  function openMore() {
    moreSheet.hidden = false;
  }
  function closeMore() {
    moreSheet.hidden = true;
  }

  // latency flash calibrate
  let calBusy = false;
  function openCalibrate() {
    closeMore();
    calibrateScreen.classList.add("active");
    lobbyScreen.classList.remove("active");
    $("#calibrate-msg").textContent = "跟閃光撳 4 次";
  }
  function runCalibrate() {
    if (calBusy) return;
    calBusy = true;
    const flash = $("#calibrate-flash");
    const msg = $("#calibrate-msg");
    const deltas = [];
    let i = 0;
    let expected = 0;
    let listening = false;
    function onTap() {
      if (!listening) return;
      deltas.push(performance.now() - expected);
      listening = false;
      flash.classList.remove("pulse");
    }
    calibrateScreen.addEventListener("pointerdown", onTap);
    function beat() {
      if (i >= 4) {
        calibrateScreen.removeEventListener("pointerdown", onTap);
        calBusy = false;
        if (deltas.length >= 2) {
          const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
          applyLatency(Math.max(0, Math.min(200, Math.round(avg))));
          showToast("完成");
        }
        calibrateScreen.classList.remove("active");
        if (chart) setMode("lobby");
        return;
      }
      i++;
      expected = performance.now();
      listening = true;
      flash.classList.add("pulse");
      msg.textContent = i + "/4";
      setTimeout(() => flash.classList.remove("pulse"), 120);
      setTimeout(beat, 700);
    }
    setTimeout(beat, 400);
  }

  // A2HS
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = $("#btn-a2hs-install");
    if (btn) btn.hidden = false;
  });

  function shouldSkipDisclaimer() {
    // Fresh browser loads always show; only skip if installed (standalone) and agreed once
    if (!isStandalone()) return false;
    return localStorage.getItem(DISCLAIMER_KEY) === "1";
  }

  function showDisclaimerThenContinue(next) {
    if (shouldSkipDisclaimer()) {
      next();
      return;
    }
    disclaimerGate.hidden = false;
    disclaimerGate.classList.add("active");
    // hide home until accepted
    readyScreen.classList.remove("active");
    const btn = $("#btn-disclaimer-ok");
    function onOk() {
      localStorage.setItem(DISCLAIMER_KEY, "1");
      disclaimerGate.hidden = true;
      disclaimerGate.classList.remove("active");
      btn.removeEventListener("click", onOk);
      next();
    }
    btn.addEventListener("click", onOk);
  }

  function setupA2hsGate() {
    if (isStandalone() || localStorage.getItem(A2HS_SKIP_KEY) === "1") {
      a2hsGate.hidden = true;
      return;
    }
    const ua = navigator.userAgent || "";
    const isIOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    $("#a2hs-ios").hidden = !isIOS;
    $("#a2hs-android").hidden = !isAndroid;
    $("#a2hs-other").hidden = isIOS || isAndroid;
    a2hsGate.hidden = false;
    a2hsGate.classList.add("active");
  }
  $("#btn-a2hs-continue").addEventListener("click", () => {
    localStorage.setItem(A2HS_SKIP_KEY, "1");
    a2hsGate.hidden = true;
    a2hsGate.classList.remove("active");
  });
  $("#btn-a2hs-install").addEventListener("click", async () => {
    if (!deferredPrompt) return showToast("用瀏覽器選單加入");
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    a2hsGate.hidden = true;
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  // Events
  btnPaste.addEventListener("click", pasteUrl);
  btnGo.addEventListener("click", goFromHome);
  homeUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goFromHome();
  });
  // Best-effort: some browsers fire paste event
  homeUrl.addEventListener("paste", () => {
    setTimeout(() => {
      syncUrlFromHome();
      if (ChartUtil.parseVideoId(homeUrl.value)) {
        /* user can tap 開始; don't auto to avoid surprise */
      }
    }, 0);
  });

  btnPlay.addEventListener("click", startPlay);
  $("#btn-ready-play").addEventListener("click", startPlay);
  btnRetry.addEventListener("click", () => chart && startPlay());
  btnHome.addEventListener("click", goHome);
  btnHomeMini.addEventListener("click", goHome);
  btnMore.addEventListener("click", openMore);
  $("#more-close").addEventListener("click", closeMore);
  $("#more-backdrop").addEventListener("click", closeMore);
  $("#btn-more-sample").addEventListener("click", loadSample);
  $("#btn-more-share").addEventListener("click", copyShare);
  $("#btn-more-regen").addEventListener("click", () => {
    closeMore();
    regenChart();
  });
  $("#btn-more-latency").addEventListener("click", openCalibrate);
  $("#btn-result-share").addEventListener("click", copyShare);

  if (audioFile) audioFile.addEventListener("change", onAudioSelected);
  if (audioFileReady) audioFileReady.addEventListener("change", onAudioSelected);
  if (btnBeatTapReady) btnBeatTapReady.addEventListener("click", startBeatTap);
  if (btnBeatTap) btnBeatTap.addEventListener("click", startBeatTap);
  if (btnTapPad)
    btnTapPad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      onBeatTapPad();
    });
  if (btnBeatTapDone) btnBeatTapDone.addEventListener("click", finishBeatTap);
  if (btnBeatTapCancel) btnBeatTapCancel.addEventListener("click", cancelBeatTap);
  if (btnLocalHelper) btnLocalHelper.addEventListener("click", runLocalHelper);
  if (btnCalibrate) btnCalibrate.addEventListener("click", openCalibrate);
  $("#btn-cal-start").addEventListener("click", runCalibrate);
  $("#btn-cal-cancel").addEventListener("click", () => {
    calibrateScreen.classList.remove("active");
    if (chart) setMode("lobby");
  });

  if (difficultySelect)
    difficultySelect.addEventListener("change", () => {
      syncDifficulty(difficultySelect);
      if (chart) regenChart();
    });
  if (difficultyLobby)
    difficultyLobby.addEventListener("change", () => {
      syncDifficulty(difficultyLobby);
      if (chart) regenChart();
    });

  // legacy hidden aliases
  if (btnLoad) btnLoad.addEventListener("click", goFromHome);
  if (btnSample) btnSample.addEventListener("click", loadSample);
  if (btnShare) btnShare.addEventListener("click", copyShare);
  if (btnRegen) btnRegen.addEventListener("click", regenChart);

  window.addEventListener("resize", () => {
    game.resize();
    YTBridge.applyCoverSize && YTBridge.applyCoverSize();
  });

  game.resize();
  function afterDisclaimer() {
    setupA2hsGate();
    const shared = ChartUtil.parseShareFromLocation();
    if (shared) {
      loadChart(shared);
    } else {
      setMode("home");
      setTimeout(() => homeUrl && homeUrl.focus(), 300);
    }
  }
  showDisclaimerThenContinue(afterDisclaimer);
})();

/* longpress-guard */
(function () {
  const block = (e) => {
    const app = document.getElementById("app");
    if (app && app.classList.contains("playing")) e.preventDefault();
  };
  document.addEventListener("contextmenu", block, { capture: true });
  document.addEventListener("selectstart", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    const app = document.getElementById("app");
    if (app && app.classList.contains("playing")) e.preventDefault();
  }, { capture: true });
})();
