/**
 * Chart schema helpers: parse YT URL, auto-gen, share encode/decode.
 * Schema version: 1
 */
(function (global) {
  const SCHEMA_VERSION = 1;

  function parseVideoId(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.hostname.includes("youtu.be")) {
        const id = u.pathname.replace(/^\//, "").slice(0, 11);
        return /^[\w-]{11}$/.test(id) ? id : null;
      }
      if (u.hostname.includes("youtube.com") || u.hostname.includes("youtube-nocookie.com")) {
        const v = u.searchParams.get("v");
        if (v && /^[\w-]{11}$/.test(v)) return v;
        const parts = u.pathname.split("/");
        const embedIdx = parts.indexOf("embed");
        const shortsIdx = parts.indexOf("shorts");
        const liveIdx = parts.indexOf("live");
        for (const idx of [embedIdx, shortsIdx, liveIdx]) {
          if (idx >= 0 && parts[idx + 1] && /^[\w-]{11}$/.test(parts[idx + 1].slice(0, 11))) {
            return parts[idx + 1].slice(0, 11);
          }
        }
      }
    } catch (_) {
      /* not a URL */
    }
    const m = s.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  const DIFFICULTY_PRESETS = {
    easy: { density: "sparse", subdivision: 1, label: "易" },
    normal: { density: "normal", subdivision: 2, label: "正常" },
    hard: { density: "dense", subdivision: 4, label: "難" },
  };

  /** Best-effort BPM without YT audio — title parse + duration heuristic. */
  function guessBpmFromMeta(meta) {
    meta = meta || {};
    const title = String(meta.title || "");
    const m = title.match(/(\d{2,3})\s*[_\-]?\s*bpm\b/i) || title.match(/bpm\s*[_\-:＝=]?\s*(\d{2,3})/i);
    if (m) {
      const bpm = Math.max(70, Math.min(200, parseInt(m[1], 10)));
      return { bpm: bpm, offset: 0, source: "title", label: "自動(標題)" };
    }
    const dur = Number(meta.duration) || 0;
    // Mild heuristic only — not real beat detection
    let bpm = 120;
    if (dur > 0 && dur < 45) bpm = 100;
    else if (dur >= 45 && dur < 150) bpm = 120;
    else if (dur >= 150) bpm = 128;
    return { bpm: bpm, offset: 0, source: "heuristic", label: "自動" };
  }

  async function fetchVideoMeta(videoId) {
    // oEmbed is metadata-only (title/author) — NEVER fetches media/audio
    const watch = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
    const endpoints = [
      "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(watch),
      "https://noembed.com/embed?url=" + encodeURIComponent(watch),
    ];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, { mode: "cors" });
        if (!res.ok) continue;
        const j = await res.json();
        if (j && (j.title || j.author_name)) {
          return { title: j.title || "", author: j.author_name || "", source: "oembed" };
        }
      } catch (_) {}
    }
    return { title: "", author: "", source: "none" };
  }



  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  function melodyTitle(opts, videoId) {
    const base = (opts && opts.title) || (videoId ? "Auto Chart — " + videoId : "Auto Chart (audio)");
    if (String(base).indexOf("主旋律") >= 0) return base;
    return base + " · 主旋律";
  }

  function percentile(values, p) {
    if (!values.length) return 0;
    const s = values.slice().sort(function (a, b) {
      return a - b;
    });
    const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
    return s[i];
  }

  /**
   * Chart whose hits follow detected melody notes (pitch → Y, time → onsets).
   * Falls back to the beat grid when melodyNotes is missing.
   * Marker times are absolute audio times. Chart offset stays 0 so the game
   * clock (ytTime + offset) does not shift them a second time.
   */
  function melodyGridFallback(videoId, opts) {
    const rest = Object.assign({}, opts);
    rest.melodyNotes = null;
    if (rest.chartSource === "melody") rest.chartSource = "procedural";
    return autoGenerateChart(videoId, rest);
  }

  function autoGenerateMelodyChart(videoId, opts) {
    opts = opts || {};
    const raw = opts.melodyNotes;
    if (!raw || !raw.length) return melodyGridFallback(videoId, opts);

    const bpm = Math.max(60, Math.min(220, Number(opts.bpm) || 120));
    const beat = 60 / bpm;
    const bar = beat * 4;
    const rawDur = Number(opts.durationHint);
    const duration = Math.max(5, rawDur > 0 ? rawDur : 45);
    const margin = 0.45;
    const approachSec = Number(opts.approachSec) > 0 ? Number(opts.approachSec) : 1.2;
    const subdiv = [1, 2, 4].indexOf(Number(opts.subdivision)) >= 0 ? Number(opts.subdivision) : 1;
    const density = opts.density === "sparse" || opts.density === "dense" ? opts.density : "normal";
    const reservePad = Math.min(0.22, Math.max(0.06, approachSec * 0.1));

    let tEnd = duration - margin;
    const tail = Math.min(2.5, bar);
    if (duration - tail > 2) tEnd = Math.min(tEnd, duration - tail);
    const tMin = 1.15;
    if (!(tEnd > tMin + beat)) tEnd = Math.max(tMin + beat, duration - margin);

    const notes = [];
    for (let i = 0; i < raw.length; i++) {
      const n = raw[i] || {};
      const pitchHz = Number(n.pitchHz) || 0;
      let midi = Number(n.midi);
      if (!(midi > 0) && pitchHz > 0) midi = 69 + (12 * Math.log(pitchHz / 440)) / Math.LN2;
      const t = Number(n.t);
      if (!(t >= tMin - 0.02 && t <= tEnd && midi > 0 && pitchHz > 0)) continue;
      let dur = Number(n.duration);
      if (!(dur > 0)) dur = 0.12;
      notes.push({
        t: t,
        duration: dur,
        pitchHz: pitchHz,
        midi: midi,
        strength: Number.isFinite(Number(n.strength)) ? Number(n.strength) : 0.5,
      });
    }
    notes.sort(function (a, b) {
      return a.t - b.t;
    });
    if (!notes.length) return melodyGridFallback(videoId, opts);

    const minGap = density === "sparse" ? beat * 1.05 : density === "dense" ? Math.max(0.1, beat * 0.28) : beat * 0.42;
    const thinned = thinMelodyNotes(notes, minGap);
    const playable = thinned.length ? thinned : notes;

    let midiLo = Infinity;
    let midiHi = -Infinity;
    for (let i = 0; i < playable.length; i++) {
      if (playable[i].midi < midiLo) midiLo = playable[i].midi;
      if (playable[i].midi > midiHi) midiHi = playable[i].midi;
    }

    function yFor(midi) {
      if (!(midiHi > midiLo + 0.4)) return 0.5;
      const norm = (midi - midiLo) / (midiHi - midiLo);
      const y = 0.75 - norm * 0.5;
      if (y < 0.25) return 0.25;
      if (y > 0.75) return 0.75;
      return y;
    }

    assignMelodyX(playable, beat, yFor);

    const taken = new Set();
    const maxSpin = density === "sparse" ? 2 : density === "dense" ? 5 : 3;
    const strengths = playable.map(function (n) {
      return n.strength;
    });
    const p70 = percentile(strengths, 0.7);
    const spins = [];
    let lastSpinT = -99;
    for (let i = 0; i < playable.length; i++) {
      if (spins.length >= maxSpin) break;
      const n = playable[i];
      const sustained = n.duration >= beat * 1.5;
      let climax = false;
      if (!sustained && midiHi - midiLo >= 3 && n.strength >= p70 && n.midi >= midiHi - 2.5 && n.duration >= beat * 0.7) {
        const prevM = i > 0 ? playable[i - 1].midi : n.midi - 2;
        const nextM = i < playable.length - 1 ? playable[i + 1].midi : n.midi - 2;
        climax = n.midi >= prevM + 1.2 && n.midi >= nextM + 1.2;
      }
      if (!sustained && !climax) continue;
      if (n.t - lastSpinT < beat * 4) continue;
      let spinDur = Math.max(beat * 1.1, Math.min(n.duration, beat * 2.6));
      const nxt = playable[i + 1];
      if (nxt && n.t + spinDur > nxt.t - reservePad) spinDur = nxt.t - reservePad - n.t;
      if (n.t + spinDur > tEnd) spinDur = tEnd - n.t;
      if (spinDur < Math.max(0.45, beat * 0.9)) continue;
      spins.push({ note: n, duration: spinDur });
      taken.add(n);
      lastSpinT = n.t;
    }

    const maxPhrase = density === "sparse" ? 2 : density === "dense" ? 5 : 3;
    const phraseGap = bar * (density === "sparse" ? 8 : density === "dense" ? 4 : 6);
    const phrases = [];
    let lastPhraseT = -99;
    let iNote = 0;
    while (iNote < playable.length && phrases.length < maxPhrase) {
      if (taken.has(playable[iNote])) {
        iNote++;
        continue;
      }
      let best = null;
      const maxLen = Math.min(7, playable.length - iNote);
      for (let len = maxLen; len >= 4; len--) {
        const run = playable.slice(iNote, iNote + len);
        if (run.some(function (n) { return taken.has(n); })) continue;
        let close = true;
        for (let k = 1; k < run.length; k++) {
          if (run[k].t - run[k - 1].t > beat * 1.25) {
            close = false;
            break;
          }
        }
        if (!close) continue;
        const kind = melodyContour(run);
        if (!kind) continue;
        const span = run[run.length - 1].t - run[0].t;
        if (span < Math.max(0.65, beat * 1.15) || span > beat * 6) continue;
        best = run;
        break;
      }
      if (!best) {
        iNote++;
        continue;
      }
      if (best[0].t - lastPhraseT < phraseGap) {
        iNote++;
        continue;
      }
      let dur = best[best.length - 1].t + Math.min(best[best.length - 1].duration, beat * 0.8) - best[0].t;
      dur = Math.max(beat * 1.2, Math.min(dur, beat * 4));
      const after = playable[iNote + best.length];
      if (after && best[0].t + dur > after.t - reservePad) dur = after.t - reservePad - best[0].t;
      if (best[0].t + dur > tEnd) dur = tEnd - best[0].t;
      if (dur >= Math.max(0.55, beat)) {
        phrases.push({ run: best, duration: dur });
        for (let k = 0; k < best.length; k++) taken.add(best[k]);
        lastPhraseT = best[0].t;
        iNote += best.length;
      } else {
        iNote++;
      }
    }

    const reserved = [];
    function overlapsReserved(t, pad) {
      const p = pad == null ? reservePad : pad;
      for (let i = 0; i < reserved.length; i++) {
        const r = reserved[i];
        if (t + p >= r.t0 && t - p <= r.t1) return true;
      }
      return false;
    }
    function reserve(t0, t1) {
      reserved.push({ t0: t0, t1: t1 });
    }

    const markers = [];
    for (let i = 0; i < phrases.length; i++) {
      const ph = phrases[i];
      const path = sampleContour(ph.run);
      if (path.length < 2) continue;
      const t = ph.run[0].t;
      reserve(t - reservePad, t + ph.duration + reservePad * 0.5);
      markers.push({
        type: "phrase",
        t: round3(t),
        duration: round3(ph.duration),
        path: path,
      });
    }
    for (let i = 0; i < spins.length; i++) {
      const sp = spins[i];
      const n = sp.note;
      reserve(n.t - reservePad, n.t + sp.duration + reservePad * 0.5);
      markers.push({
        type: "spin",
        t: round3(n.t),
        duration: round3(sp.duration),
        x: round3(clamp01(n.x)),
        y: round3(clamp01(n.y)),
        revs: 1,
      });
    }

    const hitGap = density === "sparse" ? beat * 0.9 : density === "dense" ? Math.max(0.1, beat * 0.25) : Math.max(0.12, beat * 0.38);
    let lastHitT = -99;
    for (let i = 0; i < playable.length; i++) {
      const n = playable[i];
      if (taken.has(n)) continue;
      if (n.t > tEnd) continue;
      if (overlapsReserved(n.t, reservePad)) continue;
      if (n.t - lastHitT < hitGap - 1e-6) continue;
      markers.push({
        type: "hit",
        t: round3(n.t),
        x: round3(clamp01(n.x)),
        y: round3(clamp01(n.y)),
      });
      lastHitT = n.t;
    }

    markers.sort(function (a, b) {
      return a.t - b.t;
    });
    let hn = 1;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].type === "hit") markers[i].n = hn++;
    }

    const breaks = [];
    const breakAt = [0.45, 0.78];
    for (let i = 0; i < breakAt.length; i++) {
      const rawT = tMin + (tEnd - tMin) * breakAt[i];
      const snapped = Math.round(rawT / bar) * bar;
      const bt = snapped > tMin + bar && snapped < tEnd - beat ? snapped : rawT;
      if (bt > tMin + beat && bt < tEnd - beat && !overlapsReserved(bt, 0.25)) {
        breaks.push({ t: round3(bt), kind: "meter" });
      }
    }
    if (!breaks.length && tEnd > tMin + bar * 2) {
      const mid = (tMin + tEnd) / 2;
      if (!overlapsReserved(mid, 0.2)) breaks.push({ t: round3(mid), kind: "meter" });
    }

    if (!markers.length) return melodyGridFallback(videoId, opts);

    // Analysis only covers the opening (~90s). Keep a beat grid after the last
    // melody marker so a longer video does not clear as soon as the clip ends.
    let lastMel = 0;
    for (let i = 0; i < markers.length; i++) lastMel = Math.max(lastMel, markerEndTime(markers[i]));
    if (duration - lastMel > bar * 4) {
      const tail = autoGenerateChart(videoId, {
        bpm: bpm,
        offset: Number(opts.offset) || 0,
        durationHint: duration,
        approachSec: approachSec,
        subdivision: subdiv,
        density: density,
        barsPerPhrase: opts.barsPerPhrase,
        melodyNotes: null,
        chartSource: "procedural",
      });
      const tailStart = lastMel + Math.max(0.45, beat * 0.9);
      const extra = [];
      const tailMarkers = (tail && tail.markers) || [];
      for (let i = 0; i < tailMarkers.length; i++) {
        if (tailMarkers[i].t >= tailStart) extra.push(tailMarkers[i]);
      }
      const tailBreaks = (tail && tail.breaks) || [];
      for (let i = 0; i < tailBreaks.length; i++) {
        if (tailBreaks[i].t >= tailStart) breaks.push(tailBreaks[i]);
      }
      for (let i = 0; i < extra.length; i++) markers.push(extra[i]);
      markers.sort(function (a, b) {
        return a.t - b.t;
      });
      let nHit = 1;
      for (let i = 0; i < markers.length; i++) {
        if (markers[i].type === "hit") markers[i].n = nHit++;
      }
      breaks.sort(function (a, b) {
        return a.t - b.t;
      });
    }

    return {
      version: SCHEMA_VERSION,
      videoId: videoId || "",
      title: melodyTitle(opts, videoId),
      bpm: bpm,
      offset: 0,
      approachSec: approachSec,
      durationHint: round3(duration),
      subdivision: subdiv,
      density: density,
      chartSource: "melody",
      markers: markers,
      breaks: breaks,
    };
  }

  function thinMelodyNotes(notes, minGap) {
    const order = notes.map(function (n, i) {
      return { n: n, i: i };
    });
    order.sort(function (a, b) {
      return b.n.strength - a.n.strength || a.n.t - b.n.t;
    });
    const picked = [];
    for (let i = 0; i < order.length; i++) {
      const n = order[i].n;
      let ok = true;
      for (let j = 0; j < picked.length; j++) {
        if (Math.abs(picked[j].t - n.t) < minGap) {
          ok = false;
          break;
        }
      }
      if (ok) picked.push(n);
    }
    picked.sort(function (a, b) {
      return a.t - b.t;
    });
    return picked;
  }

  /** Left → right along a melodic run; wrap back to the left when the run is long. */
  function assignMelodyX(notes, beat, yFor) {
    const beatGap = beat * 1.45;
    const maxRun = 6;
    const singles = [0.28, 0.5, 0.72, 0.38, 0.62];
    let i = 0;
    let runIndex = 0;
    while (i < notes.length) {
      let j = i + 1;
      while (j < notes.length && j - i < maxRun && notes[j].t - notes[j - 1].t <= beatGap) j++;
      const count = j - i;
      for (let k = 0; k < count; k++) {
        const n = notes[i + k];
        if (count === 1) n.x = singles[runIndex % singles.length];
        else n.x = 0.16 + (k / (count - 1)) * 0.68;
        n.y = yFor(n.midi);
      }
      runIndex++;
      i = j;
    }
  }

  function melodyContour(run) {
    let up = 0;
    let down = 0;
    for (let i = 1; i < run.length; i++) {
      const d = run[i].midi - run[i - 1].midi;
      if (d > 0.45) up++;
      else if (d < -0.45) down++;
    }
    const steps = run.length - 1;
    const net = run[run.length - 1].midi - run[0].midi;
    if (up >= steps * 0.66 && net >= 1.4) return "rise";
    if (down >= steps * 0.66 && net <= -1.4) return "fall";
    let peakI = 0;
    for (let i = 1; i < run.length; i++) if (run[i].midi > run[peakI].midi) peakI = i;
    const mid = (run.length - 1) / 2;
    if (peakI > 0 && peakI < run.length - 1 && Math.abs(peakI - mid) <= run.length * 0.4) {
      const peak = run[peakI].midi;
      if (peak - run[0].midi >= 1.2 && peak - run[run.length - 1].midi >= 1.2) return "arch";
    }
    return null;
  }

  function sampleContour(run) {
    // Phrase slides read left → right; Y stays on the pitch contour.
    const pts = [];
    const last = run.length - 1;
    const keep = Math.min(6, run.length);
    const idxs = [];
    for (let i = 0; i < keep; i++) idxs.push(keep === 1 ? 0 : Math.round((i * last) / (keep - 1)));
    for (let i = 0; i < idxs.length; i++) {
      const n = run[idxs[i]];
      const x = idxs.length === 1 ? 0.5 : 0.14 + (i / (idxs.length - 1)) * 0.72;
      const y = clamp01(n.y);
      const prev = pts.length ? pts[pts.length - 1] : null;
      if (prev && Math.abs(prev[0] - x) < 0.012 && Math.abs(prev[1] - y) < 0.012) continue;
      pts.push([round3(clamp01(x)), round3(y)]);
    }
    return pts;
  }

  /**
   * Smarter procedural auto-chart (no YT audio analysis).
   * opts: bpm, offset, durationHint, approachSec, subdivision (1|2|4),
   *        barsPerPhrase (default 8), title, density ('normal'|'sparse'|'dense')
   * When opts.melodyNotes is a non-empty array, hits follow that melody instead.
   */
  function autoGenerateChart(videoId, opts) {
    opts = opts || {};
    if (opts.melodyNotes && opts.melodyNotes.length) {
      return autoGenerateMelodyChart(videoId, opts);
    }
    const bpm = Math.max(60, Math.min(220, Number(opts.bpm) || 120));
    const offset = Number(opts.offset) || 0;
    const rawDur = Number(opts.durationHint);
    const duration = Math.max(5, (rawDur > 0 ? rawDur : 45));
    const margin = 0.45;
    const approachSec = Number(opts.approachSec) || 1.2;
    const subdiv = [1, 2, 4].includes(Number(opts.subdivision)) ? Number(opts.subdivision) : 1;
    const barsPerSpecial = Math.max(4, Number(opts.barsPerPhrase) || 8);
    const density = opts.density || "normal";
    const beat = 60 / bpm;
    const bar = beat * 4;
    const step = beat / subdiv;

    // Pattern templates (normalized coords) — Ouendan-like arcs / zigzags
    const PATTERNS = [
      // zigzag L→R
      [
        [0.18, 0.55],
        [0.35, 0.35],
        [0.52, 0.58],
        [0.68, 0.38],
        [0.82, 0.55],
      ],
      // arc top
      [
        [0.2, 0.62],
        [0.35, 0.4],
        [0.5, 0.32],
        [0.65, 0.4],
        [0.8, 0.62],
      ],
      // cross
      [
        [0.25, 0.35],
        [0.5, 0.55],
        [0.75, 0.35],
        [0.5, 0.7],
        [0.25, 0.55],
      ],
      // cascade down
      [
        [0.22, 0.3],
        [0.4, 0.42],
        [0.55, 0.54],
        [0.7, 0.66],
        [0.82, 0.45],
      ],
      // V shape
      [
        [0.2, 0.35],
        [0.35, 0.55],
        [0.5, 0.68],
        [0.65, 0.55],
        [0.8, 0.35],
      ],
    ];

    const phrasePaths = [
      [
        [0.12, 0.65],
        [0.32, 0.35],
        [0.55, 0.55],
        [0.78, 0.32],
        [0.9, 0.5],
      ],
      [
        [0.15, 0.4],
        [0.4, 0.62],
        [0.6, 0.35],
        [0.85, 0.58],
      ],
      [
        [0.1, 0.5],
        [0.3, 0.3],
        [0.5, 0.55],
        [0.7, 0.3],
        [0.9, 0.5],
      ],
    ];

    const markers = [];
    const reserved = []; // {t0,t1} blocked for hits

    function overlapsReserved(t, pad) {
      pad = pad || 0.05;
      for (const r of reserved) {
        if (t + pad >= r.t0 && t - pad <= r.t1) return true;
      }
      return false;
    }

    function reserve(t0, t1) {
      reserved.push({ t0, t1 });
    }

    // Playable window: skip short intro aligned to offset, leave outro
    let t0 = offset;
    // first hit at or after max(1.5, first downbeat-ish)
    while (t0 < 1.5) t0 += beat;
    // snap t0 to beat grid from offset
    const grid0 = offset;
    const beatsFromGrid = Math.ceil((t0 - grid0) / beat - 1e-9);
    t0 = grid0 + beatsFromGrid * beat;
    if (t0 < 1.2) t0 += beat;

    let tEnd = Math.min(duration - margin, Math.max(t0 + bar * 2, duration - Math.min(2.5, bar)));
    if (tEnd <= t0 + beat) tEnd = Math.max(t0 + beat, duration - margin);

    // Place phrase + spin on bar boundaries every barsPerSpecial bars
    let specialIdx = 0;
    const specials = [];
    for (let barIdx = barsPerSpecial; ; barIdx += barsPerSpecial) {
      const bt = grid0 + barIdx * bar;
      if (bt < t0 + bar) continue;
      if (bt > tEnd - bar * 1.5) break;
      const kind = specialIdx % 2 === 0 ? "phrase" : "spin";
      const durBeats = kind === "phrase" ? 4 : 3;
      const dur = durBeats * beat;
      specials.push({ kind, t: bt, duration: dur });
      reserve(bt - 0.05, bt + dur + 0.1);
      specialIdx++;
      if (specials.length >= 6) break; // cap
    }
    // Ensure at least 1 phrase + 1 spin if song long enough
    if (!specials.some((s) => s.kind === "phrase") && tEnd - t0 > bar * 4) {
      const bt = grid0 + Math.floor(((t0 + tEnd) / 2 - grid0) / bar) * bar;
      specials.push({ kind: "phrase", t: bt, duration: 4 * beat });
      reserve(bt - 0.05, bt + 4 * beat + 0.1);
    }
    if (!specials.some((s) => s.kind === "spin") && tEnd - t0 > bar * 6) {
      const bt = grid0 + Math.floor((t0 + (tEnd - t0) * 0.72 - grid0) / bar) * bar;
      specials.push({ kind: "spin", t: bt, duration: 3 * beat });
      reserve(bt - 0.05, bt + 3 * beat + 0.1);
    }

    for (const sp of specials) {
      if (sp.kind === "phrase") {
        const path = phrasePaths[specials.indexOf(sp) % phrasePaths.length];
        markers.push({
          type: "phrase",
          t: +sp.t.toFixed(3),
          duration: +sp.duration.toFixed(3),
          path: path.map(([x, y]) => [clamp01(x), clamp01(y)]),
        });
      } else {
        markers.push({
          type: "spin",
          t: +sp.t.toFixed(3),
          duration: +sp.duration.toFixed(3),
          x: 0.5,
          y: 0.5,
          revs: bpm >= 140 ? 1 : bpm >= 100 ? 1 : 1,
        });
      }
    }

    // Hits on grid with downbeat emphasis + pattern positions
    let patternIdx = 0;
    let posInPattern = 0;
    let n = 1;
    const skipOffbeat =
      density === "sparse" ? true : density === "dense" ? false : subdiv >= 2;

    for (let t = t0; t <= tEnd + 1e-6; t += step) {
      if (overlapsReserved(t, 0.12)) continue;

      // Beat index from offset
      const beatFloat = (t - grid0) / beat;
      const beatIdx = Math.round(beatFloat);
      const isNearBeat = Math.abs(beatFloat - beatIdx) < 0.02;
      const beatInBar = ((beatIdx % 4) + 4) % 4;
      const isDownbeat = isNearBeat && beatInBar === 0;
      const isBackbeat = isNearBeat && (beatInBar === 2);

      // Subdivision filtering
      if (subdiv === 1 && !isNearBeat) continue;
      if (density === "sparse" && !isDownbeat && !isBackbeat) continue;
      if (density === "normal" && subdiv === 2) {
        // keep all quarter beats; keep eighths mainly on downbeat/backbeat bars
        const isEighth = Math.abs((t - grid0) / step - Math.round((t - grid0) / step)) < 0.02
          && Math.round((t - grid0) / step) % 2 === 1;
        if (isEighth && beatInBar !== 0 && beatInBar !== 2) continue;
        if (isEighth && beatIdx % 2 === 1) continue;
      }
      if (density === "normal" && subdiv === 4) {
        const subIdx = ((Math.round((t - grid0) / step) % 4) + 4) % 4;
        // quarters always; 16ths only near downbeats of even bars
        if (subIdx !== 0) {
          if (!(isDownbeat || (isBackbeat && beatIdx % 8 < 4))) continue;
          if (subIdx === 1 || subIdx === 3) {
            if (beatIdx % 4 !== 0) continue;
          }
        }
      }
      // Soft density cap: skip if last hit too close for density mode
      const minGap =
        density === "sparse" ? beat * 0.95 : density === "dense" ? step * 0.85 : beat * (subdiv === 1 ? 0.9 : 0.45);
      const lastHit = (() => {
        for (let i = markers.length - 1; i >= 0; i--) if (markers[i].type === "hit") return markers[i];
        return null;
      })();
      if (lastHit && t - lastHit.t < minGap - 1e-6) continue;

      const pat = PATTERNS[patternIdx % PATTERNS.length];
      if (posInPattern >= pat.length) {
        patternIdx++;
        posInPattern = 0;
      }
      const [bx, by] = pat[posInPattern];
      // Slight jitter on offbeats; downbeats stay on pattern
      let x = bx;
      let y = by;
      if (!isDownbeat) {
        x = clamp01(bx + (posInPattern % 2 === 0 ? 0.03 : -0.03));
        y = clamp01(by + (isBackbeat ? 0.04 : -0.02));
      }
      // Avoid stacking too close in space+time with previous hit
      const prev = markers.length ? markers[markers.length - 1] : null;
      if (prev && prev.type === "hit" && Math.abs(prev.t - t) < step * 0.5) continue;
      if (prev && prev.type === "hit" && t - prev.t < 0.14) continue;

      markers.push({
        type: "hit",
        t: +t.toFixed(3),
        x: +clamp01(x).toFixed(3),
        y: +clamp01(y).toFixed(3),
        n: n++,
        downbeat: !!isDownbeat,
      });
      posInPattern++;
      // Advance pattern every bar on downbeat
      if (isDownbeat && posInPattern >= 2) {
        /* keep flowing */
      }
      if (isDownbeat && beatIdx > 0 && beatIdx % 8 === 0) {
        patternIdx++;
        posInPattern = 0;
      }
    }

    markers.sort((a, b) => a.t - b.t);
    let hn = 1;
    for (const m of markers) {
      if (m.type === "hit") m.n = hn++;
    }

    // Breaks on bar lines mid + late (avoid specials)
    const breaks = [];
    const breakCandidates = [
      grid0 + Math.floor(((t0 + tEnd) * 0.45 - grid0) / bar) * bar,
      grid0 + Math.floor(((t0 + tEnd) * 0.78 - grid0) / bar) * bar,
    ];
    for (const bt of breakCandidates) {
      if (bt > t0 + bar && bt < tEnd - beat && !overlapsReserved(bt, 0.2)) {
        breaks.push({ t: +bt.toFixed(3), kind: "meter" });
      }
    }
    if (!breaks.length && tEnd > t0 + bar * 2) {
      breaks.push({ t: +((t0 + tEnd) / 2).toFixed(3), kind: "meter" });
    }

    return {
      version: SCHEMA_VERSION,
      videoId: videoId || "",
      title: opts.title || (videoId ? "Auto Chart — " + videoId : "Auto Chart (audio)"),
      bpm,
      offset,
      approachSec,
      durationHint: +duration.toFixed(2),
      subdivision: subdiv,
      density,
      chartSource: opts.chartSource || "procedural",
      markers,
      breaks,
    };
  }


  function markerEndTime(m) {
    if (!m) return 0;
    if (m.type === "hit") return Number(m.t) || 0;
    return (Number(m.t) || 0) + (Number(m.duration) || 0);
  }

  /**
   * Drop / shorten markers that would play after the real video ends.
   * Prevents Sample softlock when chart outlasts YT duration.
   */
  function clampChartToDuration(chart, durationSec, marginSec) {
    if (!chart || !(durationSec > 0)) return chart;
    const margin = marginSec != null ? marginSec : 0.4;
    const limit = Math.max(1.2, durationSec - margin);
    const markers = [];
    for (const m of chart.markers || []) {
      const t0 = Number(m.t) || 0;
      if (m.type === "hit") {
        if (t0 <= limit) markers.push(Object.assign({}, m));
        continue;
      }
      if (t0 >= limit) continue;
      const copy = Object.assign({}, m);
      const end = t0 + (Number(m.duration) || 0);
      if (end > limit) copy.duration = +Math.max(0.35, limit - t0).toFixed(3);
      if (copy.duration >= 0.35) markers.push(copy);
    }
    let hn = 1;
    for (const m of markers) {
      if (m.type === "hit") m.n = hn++;
    }
    const breaks = (chart.breaks || [])
      .filter((b) => (Number(b.t) || 0) < limit)
      .map((b) => Object.assign({}, b));
    return Object.assign({}, chart, {
      markers,
      breaks,
      durationHint: +durationSec.toFixed(3),
    });
  }

  function normalizeChart(raw, fallbackVideoId) {
    if (!raw || typeof raw !== "object") return null;
    const videoId = raw.videoId || fallbackVideoId || "";
    if (!videoId && !(raw.markers && raw.markers.length)) return null;
    const markers = Array.isArray(raw.markers) ? raw.markers.slice() : [];
    markers.sort((a, b) => a.t - b.t);
    return {
      version: raw.version || SCHEMA_VERSION,
      videoId: videoId || raw.videoId || "",
      title: raw.title || videoId || "chart",
      bpm: raw.bpm || 120,
      offset: raw.offset || 0,
      approachSec: raw.approachSec || 1.2,
      durationHint: raw.durationHint || 45,
      subdivision: raw.subdivision || 1,
      density: raw.density || "normal",
      chartSource: raw.chartSource || "",
      markers,
      breaks: Array.isArray(raw.breaks) ? raw.breaks.slice() : [],
    };
  }

  function b64urlEncode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(s) {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function encodeShareHash(chart) {
    const slim = {
      version: chart.version,
      videoId: chart.videoId,
      title: chart.title,
      bpm: chart.bpm,
      offset: chart.offset,
      approachSec: chart.approachSec,
      subdivision: chart.subdivision,
      density: chart.density,
      chartSource: chart.chartSource,
      markers: chart.markers,
      breaks: chart.breaks,
    };
    return "v=" + encodeURIComponent(chart.videoId) + "&c=" + b64urlEncode(JSON.stringify(slim));
  }

  function buildShareUrl(chart) {
    const base = location.href.split("#")[0].split("?")[0];
    return base + "#" + encodeShareHash(chart);
  }

  function parseShareFromLocation() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return null;
    const params = new URLSearchParams(hash.includes("=") ? hash : "");
    // also support query
    const q = new URLSearchParams(location.search);
    const videoId = params.get("v") || q.get("v");
    const c = params.get("c") || q.get("c");
    if (c) {
      try {
        const json = JSON.parse(b64urlDecode(c));
        return normalizeChart(json, videoId);
      } catch (e) {
        console.warn("share chart decode failed", e);
        if (videoId) return autoGenerateChart(videoId);
      }
    }
    if (videoId) return autoGenerateChart(videoId);
    return null;
  }

  global.ChartUtil = {
    SCHEMA_VERSION,
    DIFFICULTY_PRESETS,
    parseVideoId,
    autoGenerateChart,
    autoGenerateMelodyChart,
    clampChartToDuration,
    markerEndTime,
    normalizeChart,
    buildShareUrl,
    parseShareFromLocation,
    encodeShareHash,
    guessBpmFromMeta,
    fetchVideoMeta,
  };
})(window);
