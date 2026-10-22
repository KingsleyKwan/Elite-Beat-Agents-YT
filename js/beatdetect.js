/**
 * Client-side Web Audio beat / BPM estimation for uploaded or CORS-open audio.
 * NEVER used on YouTube streams — YT audio must not be downloaded.
 */
(function (global) {
  const MIN_BPM = 70;
  const MAX_BPM = 180;

  function downsampleMono(audioBuffer, targetRate) {
    const srcRate = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    let mono = ch0;
    if (audioBuffer.numberOfChannels > 1) {
      const ch1 = audioBuffer.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    }
    if (Math.abs(srcRate - targetRate) < 1) return { data: mono, rate: srcRate };
    const ratio = srcRate / targetRate;
    const outLen = Math.floor(mono.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio;
      const i0 = Math.floor(x);
      const f = x - i0;
      const a = mono[i0] || 0;
      const b = mono[i0 + 1] || a;
      out[i] = a + (b - a) * f;
    }
    return { data: out, rate: targetRate };
  }

  /** Spectral-flux-ish onset envelope via short-frame energy diff. */
  function onsetStrength(samples, rate) {
    const hop = Math.floor(rate * 0.01); // 10ms
    const win = Math.floor(rate * 0.04); // 40ms
    const n = Math.floor((samples.length - win) / hop);
    const env = new Float32Array(Math.max(0, n));
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const start = i * hop;
      let e = 0;
      for (let j = 0; j < win; j++) {
        const v = samples[start + j];
        e += v * v;
      }
      e = Math.sqrt(e / win);
      const flux = Math.max(0, e - prev);
      env[i] = flux;
      prev = e * 0.85 + prev * 0.15;
    }
    // normalize
    let max = 0;
    for (let i = 0; i < env.length; i++) if (env[i] > max) max = env[i];
    if (max > 0) for (let i = 0; i < env.length; i++) env[i] /= max;
    return { env, hop, rate };
  }

  function estimateBpm(env, hop, rate) {
    const fps = rate / hop;
    const minLag = Math.floor((60 / MAX_BPM) * fps);
    const maxLag = Math.floor((60 / MIN_BPM) * fps);
    let bestLag = minLag;
    let bestScore = -Infinity;
    const scores = [];
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      const lim = env.length - lag;
      for (let i = 0; i < lim; i++) s += env[i] * env[i + lag];
      s /= lim || 1;
      scores.push({ lag, s });
      if (s > bestScore) {
        bestScore = s;
        bestLag = lag;
      }
    }
    // Prefer tempo whose double/half isn't much stronger — pick peak in common range
    let bpm = 60 / (bestLag / fps);
    // Snap toward 80–160 by doubling/halving
    while (bpm < 80 && bpm * 2 <= MAX_BPM) bpm *= 2;
    while (bpm > 160 && bpm / 2 >= MIN_BPM) bpm /= 2;
    return { bpm: Math.round(bpm * 10) / 10, fps, bestLag };
  }

  function estimateOffset(env, hop, rate, bpm) {
    const fps = rate / hop;
    const beat = (60 / bpm) * fps;
    // Find first strong peak after 0.3s
    const start = Math.floor(0.3 * fps);
    let bestI = start;
    let bestV = -1;
    const searchEnd = Math.min(env.length, Math.floor(8 * fps));
    for (let i = start; i < searchEnd; i++) {
      if (env[i] > bestV) {
        bestV = env[i];
        bestI = i;
      }
    }
    // Align to beat grid relative to 0: offset so that bestI is near a beat
    const phase = bestI % beat;
    // offset in seconds: time of first beat = bestI/fps - k*beatSec, choose k so offset in [-beat/2, beat/2] near start
    const beatSec = 60 / bpm;
    let offset = bestI / fps;
    // wrap into [0, beatSec)
    offset = offset % beatSec;
    if (offset > beatSec / 2) offset -= beatSec;
    // Prefer small positive intro skip: first downbeat time
    const firstBeat = bestI / fps;
    return { offset: Math.round(offset * 1000) / 1000, firstBeat: Math.round(firstBeat * 1000) / 1000 };
  }

  /**
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<{bpm:number, offset:number, duration:number, firstBeat:number, source:'webaudio'}>}
   */
  async function analyzeArrayBuffer(arrayBuffer) {
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) throw new Error("Web Audio API 不可用");
    const ctx = new AC();
    let audioBuffer;
    try {
      audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      try {
        await ctx.close();
      } catch (_) {}
    }
    const { data, rate } = downsampleMono(audioBuffer, 22050);
    // Cap analysis to first 90s for speed on mobile
    const maxSamples = Math.min(data.length, rate * 90);
    const slice = data.subarray(0, maxSamples);
    const { env, hop } = onsetStrength(slice, rate);
    const { bpm } = estimateBpm(env, hop, rate);
    const { offset, firstBeat } = estimateOffset(env, hop, rate, bpm);
    return {
      bpm,
      offset,
      duration: audioBuffer.duration,
      firstBeat,
      source: "webaudio",
    };
  }

  async function analyzeFile(file) {
    const buf = await file.arrayBuffer();
    return analyzeArrayBuffer(buf);
  }

  /** Fetch only if CORS allows — never point this at YouTube watch/embed URLs. */
  async function analyzeUrl(url) {
    const lower = String(url).toLowerCase();
    if (lower.includes("youtube.com") || lower.includes("youtu.be") || lower.includes("googlevideo.com")) {
      throw new Error("不可對 YouTube 下載／分析音訊（政策限制）");
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error("無法取得音訊：" + res.status);
    const buf = await res.arrayBuffer();
    return analyzeArrayBuffer(buf);
  }

  global.BeatDetect = {
    analyzeFile,
    analyzeUrl,
    analyzeArrayBuffer,
    MIN_BPM,
    MAX_BPM,
  };
})(window);
