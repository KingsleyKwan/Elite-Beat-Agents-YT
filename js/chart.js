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



/**
   * Smarter procedural auto-chart (no YT audio analysis).
   * opts: bpm, offset, durationHint, approachSec, subdivision (1|2|4),
   *        barsPerPhrase (default 8), title, density ('normal'|'sparse'|'dense')
   */
  function autoGenerateChart(videoId, opts) {
    opts = opts || {};
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
