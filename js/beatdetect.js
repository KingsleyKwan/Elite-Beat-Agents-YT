/**
 * Client-side Web Audio beat / BPM estimation for uploaded or CORS-open audio.
 * Also estimates a melody-note stream (主旋律) from the same buffer.
 * NEVER used on YouTube streams — YT audio must not be downloaded.
 */
(function (global) {
  const MIN_BPM = 70;
  const MAX_BPM = 180;
  const SNAP_SEC = 0.04;

  function downsampleMono(audioBuffer, targetRate) {
    const srcRate = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    let mono = ch0;
    if (audioBuffer.numberOfChannels > 1) {
      const ch1 = audioBuffer.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    }
    return resampleLinear(mono, srcRate, targetRate);
  }

  function resampleLinear(samples, srcRate, targetRate) {
    if (Math.abs(srcRate - targetRate) < 1) return { data: samples, rate: srcRate };
    const ratio = srcRate / targetRate;
    const outLen = Math.floor(samples.length / ratio);
    const out = new Float32Array(outLen);
    const last = samples.length - 1;
    for (let i = 0; i < outLen; i++) {
      const x = i * ratio;
      const i0 = Math.floor(x);
      const f = x - i0;
      const a = samples[i0] || 0;
      const b = samples[i0 < last ? i0 + 1 : last] || a;
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
    const beatSec = 60 / bpm;
    let offset = bestI / fps;
    // wrap into [0, beatSec)
    offset = offset % beatSec;
    if (offset > beatSec / 2) offset -= beatSec;
    // Prefer small positive intro skip: first downbeat time
    const firstBeat = bestI / fps;
    return { offset: Math.round(offset * 1000) / 1000, firstBeat: Math.round(firstBeat * 1000) / 1000 };
  }

  function hzToMidi(hz) {
    if (!(hz > 0)) return 0;
    return 69 + 12 * Math.log(hz / 440) / Math.LN2;
  }

  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  function round2(x) {
    return Math.round(x * 100) / 100;
  }

  /** RBJ biquad. type: highpass | lowpass. */
  function biquadCoeffs(type, freq, rate, q) {
    const w0 = (2 * Math.PI * freq) / rate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = sin / (2 * q);
    let b0;
    let b1;
    let b2;
    if (type === "highpass") {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
    } else {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
    }
    const a0 = 1 + alpha;
    return {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: (-2 * cos) / a0,
      a2: (1 - alpha) / a0,
    };
  }

  function applyBiquad(samples, c) {
    const out = new Float32Array(samples.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    const b0 = c.b0;
    const b1 = c.b1;
    const b2 = c.b2;
    const a1 = c.a1;
    const a2 = c.a2;
    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return out;
  }

  function decimateEven(samples) {
    const n = Math.floor(samples.length / 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = samples[i * 2];
    return out;
  }

  /**
   * Snap t to the beat/16th grid only when it already lies within ~40ms.
   * Farther notes keep their expressive timing.
   */
  function quantizeOnset(t, bpm, offset) {
    if (!(bpm > 0) || !(t >= 0)) return t;
    const beat = 60 / bpm;
    const subdiv = beat / 4;
    const origin = Number(offset) || 0;
    const k = Math.round((t - origin) / subdiv);
    const gridT = origin + k * subdiv;
    if (gridT < -0.02) return t;
    if (Math.abs(gridT - t) <= SNAP_SEC) return gridT;
    return t;
  }

  function medianOf(arr) {
    if (!arr.length) return 0;
    const a = arr.slice().sort(function (x, y) {
      return x - y;
    });
    const m = Math.floor(a.length / 2);
    if (a.length % 2) return a[m];
    return 0.5 * (a[m - 1] + a[m]);
  }

  /**
   * Dominant pitch in the melody band via normalized autocorrelation.
   * Ignores weak / noisy frames (low correlation).
   */
  function estimateFramePitch(samples, start, win, buf, hann, corrs, lagMin, lagMax, rate) {
    let mean = 0;
    for (let i = 0; i < win; i++) {
      const v = samples[start + i] * hann[i];
      buf[i] = v;
      mean += v;
    }
    mean /= win;
    let r0 = 0;
    for (let i = 0; i < win; i++) {
      buf[i] -= mean;
      r0 += buf[i] * buf[i];
    }
    if (r0 < 1e-8) return { hz: 0, conf: 0 };

    let bestLag = -1;
    let bestC = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const lim = win - lag;
      let r = 0;
      let e0 = 0;
      let e1 = 0;
      for (let i = 0; i < lim; i++) {
        const a = buf[i];
        const b = buf[i + lag];
        r += a * b;
        e0 += a * a;
        e1 += b * b;
      }
      const c = e0 > 0 && e1 > 0 ? r / Math.sqrt(e0 * e1) : 0;
      corrs[lag] = c;
      if (c > bestC) {
        bestC = c;
        bestLag = lag;
      }
    }

    let peakLag = -1;
    let peakC = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const c = corrs[lag];
      const left = lag > lagMin ? corrs[lag - 1] : c - 1;
      const right = lag < lagMax ? corrs[lag + 1] : c - 1;
      if (c >= 0.42 && c >= left && c >= right && c > peakC) {
        peakLag = lag;
        peakC = c;
      }
    }
    if (peakLag < 0) {
      if (bestC < 0.55 || bestLag < 0) return { hz: 0, conf: bestC };
      peakLag = bestLag;
      peakC = bestC;
    }
    if (peakC < 0.5) return { hz: 0, conf: peakC };

    const a = peakLag > lagMin ? corrs[peakLag - 1] : peakC;
    const b = corrs[peakLag];
    const c = peakLag < lagMax ? corrs[peakLag + 1] : peakC;
    const denom = a - 2 * b + c;
    let delta = 0;
    if (Math.abs(denom) > 1e-6) delta = (0.5 * (a - c)) / denom;
    if (delta > 0.5) delta = 0.5;
    else if (delta < -0.5) delta = -0.5;
    const hz = rate / (peakLag + delta);
    if (hz < 240 || hz > 2600) return { hz: 0, conf: peakC };
    return { hz: hz, conf: peakC };
  }

  function foldOctaveBlips(frames) {
    for (let i = 1; i < frames.length - 1; i++) {
      const hz = frames[i].pitchHz;
      if (!(hz > 0)) continue;
      const left = frames[i - 1].pitchHz;
      const right = frames[i + 1].pitchHz;
      if (!(left > 0 && right > 0)) continue;
      const ref = Math.sqrt(left * right);
      const ratio = hz / ref;
      if (ratio > 1.88 && ratio < 2.18) frames[i].pitchHz = hz * 0.5;
      else if (ratio > 0.46 && ratio < 0.535) frames[i].pitchHz = hz * 2;
    }
  }

  /**
   * Melody-band frames: highpass ~200 Hz + lowpass ~2600 Hz, then pitch + flux.
   * Onsets come from band-limited energy rises (not the full mix / kick).
   */
  function trackMelodyFrames(samples, rate) {
    const hp = biquadCoeffs("highpass", 200, rate, 0.7071);
    const lp = biquadCoeffs("lowpass", 2600, rate, 0.7071);
    let band = applyBiquad(samples, hp);
    band = applyBiquad(band, lp);
    let mRate = rate;
    if (rate >= 16000) {
      band = decimateEven(band);
      mRate = rate / 2;
    }

    const hop = Math.max(80, Math.round(mRate * 0.02));
    const win = Math.max(hop + 8, Math.round(mRate * 0.046));
    const lagMin = Math.max(2, Math.floor(mRate / 2200));
    const lagMax = Math.min(win - 3, Math.ceil(mRate / 250));
    const nFrames = Math.max(0, Math.floor((band.length - win) / hop));
    if (!nFrames || lagMax <= lagMin + 2) return { frames: [], hopSec: hop / mRate, rmsThresh: 1 };

    const hann = new Float32Array(win);
    for (let i = 0; i < win; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (win - 1)));
    const buf = new Float32Array(win);
    const corrs = new Float32Array(lagMax + 2);
    const rmsArr = new Float32Array(nFrames);
    let maxRms = 0;
    for (let fi = 0; fi < nFrames; fi++) {
      const start = fi * hop;
      let e = 0;
      for (let i = 0; i < win; i++) {
        const v = band[start + i];
        e += v * v;
      }
      const rms = Math.sqrt(e / win);
      rmsArr[fi] = rms;
      if (rms > maxRms) maxRms = rms;
    }

    const sorted = new Float32Array(rmsArr);
    sorted.sort();
    const p50 = sorted[Math.floor(nFrames * 0.5)] || 0;
    const rmsThresh = Math.max(maxRms * 0.05, p50 * 0.4);
    const pitchGate = rmsThresh * 0.7;

    const frames = new Array(nFrames);
    for (let fi = 0; fi < nFrames; fi++) {
      const start = fi * hop;
      const t = (start + win * 0.5) / mRate;
      const rms = rmsArr[fi];
      const prevRms = fi > 0 ? rmsArr[fi - 1] : 0;
      const flux = Math.max(0, rms - prevRms);
      let pitchHz = 0;
      let conf = 0;
      if (rms >= pitchGate && t >= 0.05 && maxRms > 1e-5) {
        const est = estimateFramePitch(band, start, win, buf, hann, corrs, lagMin, lagMax, mRate);
        pitchHz = est.hz;
        conf = est.conf;
      }
      frames[fi] = { t: t, rms: rms, flux: flux, pitchHz: pitchHz, conf: conf, onset: false };
    }

    foldOctaveBlips(frames);

    let maxFlux = 0;
    const fluxes = [];
    for (let i = 0; i < nFrames; i++) {
      const f = frames[i].flux;
      if (f > maxFlux) maxFlux = f;
      if (f > 0) fluxes.push(f);
    }
    fluxes.sort(function (a, b) {
      return a - b;
    });
    const p75 = fluxes.length ? fluxes[Math.floor(fluxes.length * 0.75)] : 0;
    const onsetThresh = Math.max(p75 * 0.62, maxFlux * 0.1, maxRms * 0.015);
    for (let i = 1; i < nFrames - 1; i++) {
      const f = frames[i];
      f.onset =
        f.pitchHz > 0 &&
        f.flux >= onsetThresh &&
        f.flux >= frames[i - 1].flux &&
        f.flux >= frames[i + 1].flux;
    }
    return { frames: frames, hopSec: hop / mRate, rmsThresh: rmsThresh, onsetThresh: onsetThresh };
  }

  function segmentMelody(tracked, bpm, offset) {
    const frames = tracked.frames || [];
    const empty = { melodyNotes: [], hasMelody: false };
    if (!frames.length) return empty;
    const rmsThresh = tracked.rmsThresh || 0;
    const hopSec = tracked.hopSec || 0.02;
    const notes = [];
    let cur = null;

    function closeAt(endT) {
      if (!cur) return;
      const dur = endT - cur.t;
      const pitches = cur.pitches;
      if (dur >= 0.07 && pitches.length >= 2) {
        const hz = medianOf(pitches);
        const midi = hzToMidi(hz);
        let varSum = 0;
        for (let i = 0; i < pitches.length; i++) {
          const d = hzToMidi(pitches[i]) - midi;
          varSum += d * d;
        }
        const spread = Math.sqrt(varSum / pitches.length);
        const conf = cur.confSum / pitches.length;
        if (hz >= 240 && hz <= 2600 && spread <= 1.6 && conf >= 0.48) {
          notes.push({
            t: cur.t,
            duration: dur,
            pitchHz: hz,
            midi: midi,
            strength: conf,
          });
        }
      }
      cur = null;
    }

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const voiced = f.pitchHz > 0 && f.conf >= 0.5 && f.rms >= rmsThresh * 0.85;
      if (!voiced) {
        if (cur) {
          cur.gap += 1;
          if (cur.gap >= 2) closeAt(f.t);
        }
        continue;
      }
      const midi = hzToMidi(f.pitchHz);
      let jump = false;
      if (cur && cur.pitches.length) {
        const med = hzToMidi(medianOf(cur.pitches));
        jump = Math.abs(midi - med) >= 0.9;
      }
      const reattack = !!(cur && f.onset && f.t - cur.t > 0.1);
      if (!cur || jump || reattack) {
        if (cur) closeAt(f.t);
        cur = { t: f.t, pitches: [f.pitchHz], confSum: f.conf, gap: 0 };
      } else {
        cur.gap = 0;
        cur.pitches.push(f.pitchHz);
        cur.confSum += f.conf;
      }
    }
    if (cur) {
      const last = frames[frames.length - 1];
      closeAt(last.t + hopSec);
    }

    if (!notes.length) return empty;

    // Merge tiny same-pitch gaps left by a single dropped frame.
    const merged = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (prev && Math.abs(n.midi - prev.midi) < 0.65 && n.t - (prev.t + prev.duration) < 0.045) {
        const end = Math.max(prev.t + prev.duration, n.t + n.duration);
        prev.duration = end - prev.t;
        prev.strength = Math.max(prev.strength, n.strength);
        prev.pitchHz = (prev.pitchHz + n.pitchHz) * 0.5;
        prev.midi = hzToMidi(prev.pitchHz);
      } else {
        merged.push({
          t: n.t,
          duration: n.duration,
          pitchHz: n.pitchHz,
          midi: n.midi,
          strength: n.strength,
        });
      }
    }

    let prevT = -1;
    let confSum = 0;
    for (let i = 0; i < merged.length; i++) {
      const n = merged[i];
      const end = n.t + n.duration;
      let t = quantizeOnset(n.t, bpm, offset);
      if (t <= prevT + 0.02) t = Math.max(n.t, prevT + 0.02);
      n.t = round3(Math.max(0, t));
      n.duration = round3(Math.max(0.05, end - n.t));
      n.pitchHz = round2(n.pitchHz);
      n.midi = round2(n.midi);
      confSum += n.strength;
      prevT = n.t;
    }

    const meanConf = confSum / merged.length;
    let maxS = 0;
    for (let i = 0; i < merged.length; i++) if (merged[i].strength > maxS) maxS = merged[i].strength;
    if (maxS > 0) {
      for (let i = 0; i < merged.length; i++) merged[i].strength = round3(merged[i].strength / maxS);
    }

    const span = merged[merged.length - 1].t - merged[0].t;
    const hasMelody = (merged.length >= 8 && meanConf >= 0.5) || (merged.length >= 5 && span >= 3 && meanConf >= 0.55);
    if (!hasMelody) return empty;
    return { melodyNotes: merged, hasMelody: true };
  }

  /**
   * Melody notes from a mono PCM buffer already near 22050 Hz.
   * Each note: { t, duration, pitchHz, midi, strength }.
   * When the take is too noisy / too thin, melodyNotes is [] and hasMelody is false
   * so chart generation can keep the beat-grid fallback.
   */
  function extractMelody(samples, rate, bpm, offset) {
    try {
      if (!samples || samples.length < rate * 0.4) return { melodyNotes: [], hasMelody: false };
      const tracked = trackMelodyFrames(samples, rate);
      return segmentMelody(tracked, bpm, offset);
    } catch (_) {
      return { melodyNotes: [], hasMelody: false };
    }
  }

  /**
   * BPM + offset + melody from mono PCM. Caps analysis at 90s.
   * durationSec is the full source length (may be longer than the analyzed slice).
   */
  function analyzePrepared(samples, rate, durationSec) {
    const maxSamples = Math.min(samples.length, Math.floor(rate * 90));
    const slice = samples.subarray(0, maxSamples);
    const { env, hop } = onsetStrength(slice, rate);
    const { bpm } = estimateBpm(env, hop, rate);
    const { offset, firstBeat } = estimateOffset(env, hop, rate, bpm);
    const melody = extractMelody(slice, rate, bpm, offset);
    return {
      bpm: bpm,
      offset: offset,
      duration: durationSec,
      firstBeat: firstBeat,
      source: "webaudio",
      melodyNotes: melody.melodyNotes,
      hasMelody: melody.hasMelody,
    };
  }

  /**
   * @param {Float32Array|Array<number>} samples
   * @param {number} sampleRate
   * @param {number} [durationSec]
   */
  function analyzePcm(samples, sampleRate, durationSec) {
    const mono = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    const resampled = resampleLinear(mono, sampleRate, 22050);
    const duration = durationSec == null ? mono.length / sampleRate : durationSec;
    return analyzePrepared(resampled.data, resampled.rate, duration);
  }

  /**
   * @param {ArrayBuffer} arrayBuffer
   * @returns {Promise<{bpm:number, offset:number, duration:number, firstBeat:number, source:string, melodyNotes:Array, hasMelody:boolean}>}
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
    return analyzePrepared(data, rate, audioBuffer.duration);
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
    analyzePcm,
    extractMelody,
    hzToMidi,
    quantizeOnset,
    MIN_BPM,
    MAX_BPM,
  };
})(window);
