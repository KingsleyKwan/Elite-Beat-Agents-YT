/**
 * App wiring: auto BPM (upload / localhost helper / heuristic), difficulty,
 * fullscreen YT underlay, A2HS gate. No in-browser YT download on Pages.
 */
(function () {
  const $ = (sel) => document.querySelector(sel);
  const urlInput = $("#url-input");
  const bpmInput = $("#bpm-input");
  const offsetInput = $("#offset-input");
  const subdivSelect = $("#subdiv-select");
  const difficultySelect = $("#difficulty-select");
  const latencyInput = $("#latency-input");
  const latencyVal = $("#latency-val");
  const beatHint = $("#beat-hint");
  const autoBpmLabel = $("#auto-bpm-label");
  const advancedPanel = $("#advanced-panel");
  const btnLoad = $("#btn-load");
  const btnSample = $("#btn-sample");
  const btnPlay = $("#btn-play");
  const btnShare = $("#btn-share");
  const btnRegen = $("#btn-regen");
  const btnRetry = $("#btn-retry");
  const btnHome = $("#btn-home");
  const btnCalibrate = $("#btn-calibrate");
  const btnAdvanced = $("#btn-advanced");
  const btnLocalHelper = $("#btn-local-helper");
  const btnBeatTap = $("#btn-beat-tap");
  const btnBeatTapReady = $("#btn-beat-tap-ready");
  const beatTapOverlay = $("#beat-tap-overlay");
  const beatTapMsg = $("#beat-tap-msg");
  const beatTapCount = $("#beat-tap-count");
  const btnTapPad = $("#btn-tap-pad");
  const btnBeatTapDone = $("#btn-beat-tap-done");
  const btnBeatTapCancel = $("#btn-beat-tap-cancel");
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
  const calibrateScreen = $("#calibrate-screen");
  const a2hsGate = $("#a2hs-gate");
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
  let autoMeta = { bpm: 120, offset: 0, source: "default", label: "自動" };
  let advancedOpen = false;

  const LATENCY_KEY = "ouendan-yt-latency-ms";
  const A2HS_SKIP_KEY = "ouendan-yt-a2hs-skip";
  const HELPER_URL = "http://127.0.0.1:8767"; // 進階／電腦 only；電話唔使
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
    const key = difficultySelect.value || "normal";
    const p = DIFF[key] || DIFF.normal;
    return { density: p.density, subdivision: p.subdivision, difficulty: key };
  }

  function setAutoBadge(meta) {
    autoMeta = meta || autoMeta;
    if (bpmInput) bpmInput.value = String(autoMeta.bpm);
    if (offsetInput) offsetInput.value = String(autoMeta.offset);
    autoBpmLabel.textContent =
      autoMeta.bpm + (autoMeta.label ? " · " + autoMeta.label : "");
  }

  function applyDifficultyToHidden() {
    const d = difficultyOpts();
    subdivSelect.value = String(d.subdivision);
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
        "<div>" +
        (labels[grade] || String(grade)) +
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
  applyDifficultyToHidden();
  setAutoBadge({ bpm: 120, offset: 0, source: "default", label: "自動" });

  function setPlayingUi(on) {
    appEl.classList.toggle("playing", !!on);
    requestAnimationFrame(() => {
      game.resize();
      YTBridge.applyCoverSize && YTBridge.applyCoverSize();
    });
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2800);
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
      autoBpmLabel.textContent = c.bpm + (c.chartSource ? " · " + c.chartSource : "");
    }
    if (c.offset != null) offsetInput.value = String(c.offset);
    if (c.subdivision) subdivSelect.value = String(c.subdivision);
    // map density back to difficulty select
    if (c.density === "sparse") difficultySelect.value = "easy";
    else if (c.density === "dense") difficultySelect.value = "hard";
    else difficultySelect.value = "normal";
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
        YTBridge.applyCoverSize && YTBridge.applyCoverSize();
      },
      onError: () => showToast("此影片可能無法嵌入，請換另一個 videoId"),
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

  /** Resolve BPM without downloading YT in the browser. */
  async function resolveAutoBeat(videoId, duration) {
    // Prefer last upload / helper result if for same session
    if (audioDetectMeta && audioDetectMeta.bpm) {
      return {
        bpm: audioDetectMeta.bpm,
        offset: audioDetectMeta.offset || 0,
        source: audioDetectMeta.source || "webaudio",
        label: audioDetectMeta.source === "localhost-ytdlp" ? "本機yt-dlp" : "音訊偵測",
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
    if (!chart) {
      showToast("譜面無效");
      return;
    }
    if (!chart.videoId) {
      showToast("譜面缺少 videoId");
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
      if (chart.markers.length < before) {
        showToast("已按片長夾短譜面（" + before + "→" + chart.markers.length + "）");
      }
    }
    if (!chart.markers.length) {
      showToast("片長過短或譜面全被夾掉");
      btnPlay.disabled = true;
      return;
    }
    game.resetRuntime(chart);
    game.resize();
    game.draw(0);
    hideOverlays();
    readyScreen.classList.add("active");
    const diffLabel = (DIFF[difficultySelect.value] || DIFF.normal).label;
    $("#ready-title").textContent = chart.title || chart.videoId;
    $("#ready-meta").textContent =
      "標記 " +
      chart.markers.length +
      "　難度 " +
      diffLabel +
      "　BPM " +
      chart.bpm +
      "（" +
      (autoMeta.label || "自動") +
      "）　延遲 " +
      game.getDeviceLatencyMs() +
      "ms";
    beatHint.textContent =
      "個人學習｜自動 BPM " +
      chart.bpm +
      "｜難度 " +
      diffLabel +
      "｜電話：上傳音訊或跟拍校准；唔使電腦";
    btnPlay.disabled = false;
  }

  async function buildAndLoad(videoId) {
    lastVideoId = videoId;
    showToast("載入中（自動估 BPM）…");
    btnPlay.disabled = true;
    await ensurePlayer(videoId);
    const dur = await waitDuration(4500);
    lastDurationHint = dur > 0 ? dur : 45;
    const guessed = await resolveAutoBeat(videoId, lastDurationHint);
    setAutoBadge(guessed);
    const opts = readGenOpts({
      durationHint: lastDurationHint,
      chartSource: guessed.source,
      title: "Auto — " + videoId,
    });
    let c = ChartUtil.autoGenerateChart(videoId, opts);
    if (dur > 0) c = ChartUtil.clampChartToDuration(c, dur, 0.4);
    await loadChart(c);
    showToast("已自動產譜 BPM " + opts.bpm + "（" + guessed.label + "）· 難度已套用");
  }

  async function loadFromUrlInput() {
    const id = ChartUtil.parseVideoId(urlInput.value);
    if (!id) {
      showToast("請貼上有效 YouTube URL");
      return;
    }
    await buildAndLoad(id);
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
      title: "Auto — " + id,
    });
    let c = ChartUtil.autoGenerateChart(id, opts);
    if (lastDurationHint > 0) c = ChartUtil.clampChartToDuration(c, lastDurationHint, 0.4);
    await loadChart(c);
    showToast("已 Regen（難度／自動 BPM）");
  }

  async function loadSample() {
    try {
      const res = await fetch("sample-chart.json");
      const json = await res.json();
      setAutoBadge({
        bpm: json.bpm || 100,
        offset: json.offset || 0,
        source: "sample",
        label: "Sample",
      });
      await loadChart(json);
      showToast("已載入 Sample");
    } catch (e) {
      await buildAndLoad("jNQXAC9IVRw");
    }
  }

  async function onAudioSelected(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    showToast("分析電話音訊檔（唔下載 YT）…");
    try {
      const meta = await BeatDetect.analyzeFile(file);
      audioDetectMeta = Object.assign({}, meta, { source: "webaudio" });
      setAutoBadge({
        bpm: meta.bpm,
        offset: meta.offset,
        source: "webaudio",
        label: "音訊偵測",
      });
      lastDurationHint = meta.duration || lastDurationHint;
      const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId;
      if (id) {
        await buildAndLoad(id);
        showToast("已用上傳音訊對拍；播放仍用 YT 畫面");
      } else {
        showToast("已得 BPM — 請貼同一首歌 YT 再 Load");
      }
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
    let off = times[0] % beat;
    if (off > beat / 2) off -= beat;
    // refine offset with all taps
    let phase = 0;
    for (const t of times) {
      let p = t % beat;
      if (p > beat / 2) p -= beat;
      phase += p;
    }
    off = phase / times.length;
    return {
      bpm: bpm,
      offset: Math.round(off * 1000) / 1000,
      source: "beat-tap",
      label: "跟拍",
    };
  }

  async function startBeatTap() {
    const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId || (chart && chart.videoId);
    if (!id) {
      showToast("請先貼 YouTube URL 並 Load");
      return;
    }
    if (!YTBridge.player) {
      await ensurePlayer(id);
      await waitDuration(3000);
    }
    beatTapTimes = [];
    beatTapActive = true;
    beatTapCount.textContent = "0 / " + BEAT_TAP_TARGET;
    beatTapMsg.textContent = "跟住音樂拍子撳大掣（建議 6–8 下）";
    btnBeatTapDone.disabled = true;
    beatTapOverlay.hidden = false;
    readyScreen.classList.remove("active");
    // Preview play for tapping (not full game)
    ytEnded = false;
    YTBridge.seek(Math.max(0, (YTBridge.getTime() || 0) < 1 ? 0 : YTBridge.getTime()));
    YTBridge.play();
    showToast("跟拍中：聽到拍就撳");
  }

  function onBeatTapPad() {
    if (!beatTapActive) return;
    const t = YTBridge.getTime();
    if (!(t >= 0)) return;
    // debounce double taps < 120ms
    if (beatTapTimes.length && t - beatTapTimes[beatTapTimes.length - 1] < 0.12) return;
    beatTapTimes.push(t);
    beatTapCount.textContent = beatTapTimes.length + " / " + BEAT_TAP_TARGET;
    beatTapMsg.textContent =
      beatTapTimes.length >= 4
        ? "夠用啦，可再撳或按「完成並產譜」"
        : "繼續跟拍…（至少 4 下）";
    if (beatTapTimes.length >= 4) btnBeatTapDone.disabled = false;
    if (beatTapTimes.length >= BEAT_TAP_TARGET) {
      finishBeatTap();
    }
  }

  async function finishBeatTap() {
    if (!beatTapActive) return;
    beatTapActive = false;
    const est = estimateBpmFromTaps(beatTapTimes);
    beatTapOverlay.hidden = true;
    YTBridge.pause();
    if (!est) {
      showToast("拍數唔夠或太亂，請再試跟拍校准");
      if (chart) readyScreen.classList.add("active");
      return;
    }
    audioDetectMeta = est;
    setAutoBadge(est);
    const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId || (chart && chart.videoId);
    if (id) {
      await buildAndLoad(id);
      showToast("跟拍完成 BPM " + est.bpm + " Offset " + est.offset);
    } else {
      showToast("跟拍得 BPM " + est.bpm + " — 請 Load URL");
      readyScreen.classList.add("active");
    }
  }

  function cancelBeatTap() {
    beatTapActive = false;
    beatTapTimes = [];
    beatTapOverlay.hidden = true;
    YTBridge.pause();
    if (chart) readyScreen.classList.add("active");
  }

  async function runLocalHelper() {
    const id = ChartUtil.parseVideoId(urlInput.value) || lastVideoId;
    if (!id) {
      showToast("請先貼 YouTube URL");
      return;
    }
    showToast("（進階）呼叫電腦 127.0.0.1 — 電話請改用上傳／跟拍…");
    try {
      const res = await fetch(HELPER_URL + "/analyze?v=" + encodeURIComponent(id), {
        mode: "cors",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "HTTP " + res.status);
      }
      const meta = await res.json();
      if (!meta.ok) throw new Error(meta.error || "helper failed");
      audioDetectMeta = meta;
      setAutoBadge({
        bpm: meta.bpm,
        offset: meta.offset,
        source: "localhost-ytdlp",
        label: "本機yt-dlp",
      });
      if (meta.duration) lastDurationHint = meta.duration;
      await buildAndLoad(id);
      showToast("本機 yt-dlp 對拍完成 BPM " + meta.bpm + "（個人學習）");
    } catch (err) {
      console.warn(err);
      showToast(
        "電話唔使電腦伺服器。請用「上傳音訊」或「跟拍校准」。（純網頁無法下載 YT）"
      );
    }
  }

  function startPlay() {
    if (!chart || !chart.videoId) {
      showToast("需要 YouTube videoId");
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
    if (!chart || !chart.videoId) {
      showToast("尚未載入譜面");
      return;
    }
    const url = ChartUtil.buildShareUrl(chart);
    try {
      await navigator.clipboard.writeText(url);
      showToast("已複製分享連結（注意：github.io 往往公開）");
    } catch (_) {
      window.prompt("複製：", url);
    }
  }

  // --- calibrate ---
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
    let expected = 0;
    let listening = false;
    function onTap() {
      if (!listening) return;
      deltas.push(performance.now() - expected);
      listening = false;
      flash.classList.remove("pulse");
      msg.textContent = "已記錄 " + deltas.length + "/4";
    }
    calibrateScreen.addEventListener("pointerdown", onTap);
    function beat() {
      if (i >= 4) {
        calibrateScreen.removeEventListener("pointerdown", onTap);
        calBusy = false;
        if (deltas.length >= 2) {
          const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
          const ms = Math.max(0, Math.min(200, Math.round(avg)));
          applyLatency(ms);
          showToast("校准完成：延遲 " + ms + "ms");
        }
        setTimeout(() => {
          calibrateScreen.classList.remove("active");
          if (chart) readyScreen.classList.add("active");
        }, 600);
        return;
      }
      i += 1;
      expected = performance.now();
      listening = true;
      flash.classList.add("pulse");
      msg.textContent = "撳！（" + i + "/4）";
      setTimeout(() => flash.classList.remove("pulse"), 120);
      setTimeout(beat, 700);
    }
    setTimeout(beat, 400);
  }

  // --- A2HS ---
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = $("#btn-a2hs-install");
    if (btn) btn.hidden = false;
  });

  function setupA2hsGate() {
    if (isStandalone() || localStorage.getItem(A2HS_SKIP_KEY) === "1") {
      a2hsGate.hidden = true;
      return;
    }
    const ua = navigator.userAgent || "";
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
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
    if (!deferredPrompt) {
      showToast("請用瀏覽器選單「加到主畫面／安裝」");
      return;
    }
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    a2hsGate.hidden = true;
    a2hsGate.classList.remove("active");
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  btnLoad.addEventListener("click", loadFromUrlInput);
  btnSample.addEventListener("click", loadSample);
  btnPlay.addEventListener("click", startPlay);
  btnRegen.addEventListener("click", regenChart);
  $("#btn-ready-play").addEventListener("click", startPlay);
  btnShare.addEventListener("click", copyShare);
  $("#btn-result-share").addEventListener("click", copyShare);
  audioFile.addEventListener("change", onAudioSelected);
  if (audioFileReady) audioFileReady.addEventListener("change", onAudioSelected);
  if (btnLocalHelper) btnLocalHelper.addEventListener("click", runLocalHelper);
  if (btnBeatTap) btnBeatTap.addEventListener("click", startBeatTap);
  if (btnBeatTapReady) btnBeatTapReady.addEventListener("click", startBeatTap);
  if (btnTapPad) btnTapPad.addEventListener("pointerdown", (e) => { e.preventDefault(); onBeatTapPad(); });
  if (btnBeatTapDone) btnBeatTapDone.addEventListener("click", finishBeatTap);
  if (btnBeatTapCancel) btnBeatTapCancel.addEventListener("click", cancelBeatTap);
  if (latencyInput) latencyInput.addEventListener("input", () => applyLatency(latencyInput.value));
  if (btnCalibrate) btnCalibrate.addEventListener("click", openCalibrate);
  $("#btn-cal-start").addEventListener("click", runCalibrate);
  $("#btn-cal-cancel").addEventListener("click", () => {
    calibrateScreen.classList.remove("active");
    if (chart) readyScreen.classList.add("active");
  });
  btnAdvanced.addEventListener("click", () => {
    advancedOpen = !advancedOpen;
    advancedPanel.hidden = !advancedOpen;
    btnAdvanced.textContent = advancedOpen ? "收起進階" : "進階";
  });
  difficultySelect.addEventListener("change", () => {
    applyDifficultyToHidden();
    if (lastVideoId || (chart && chart.videoId)) regenChart();
  });
  btnRetry.addEventListener("click", () => chart && startPlay());
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
    YTBridge.applyCoverSize && YTBridge.applyCoverSize();
  });

  // boot
  game.resize();
  setupA2hsGate();
  const shared = ChartUtil.parseShareFromLocation();
  if (shared) {
    loadChart(shared).then(() => showToast("已從分享連結載入"));
  } else {
    readyScreen.classList.add("active");
    $("#ready-title").textContent = "貼上 YouTube → Load → Play";
    $("#ready-meta").textContent = "電話專用｜揀難度即可｜上傳音訊或跟拍校准";
    btnPlay.disabled = true;
  }
})();
