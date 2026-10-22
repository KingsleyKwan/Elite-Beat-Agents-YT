/**
 * Game loop: markers, life, scoring, canvas render, pointer input.
 */
(function (global) {
  const HIT_WINDOWS = { perfect: 0.05, great: 0.1, good: 0.15 };
  const HIT_R = 46; // px target radius (touch-friendly)

  function createGame(canvas, hooks) {
    const ctx = canvas.getContext("2d");
    let chart = null;
    let running = false;
    let failed = false;
    let cleared = false;
    let life = 100;
    let score = 0;
    let combo = 0;
    let maxCombo = 0;
    const counts = { 300: 0, 100: 0, 50: 0, 0: 0 };
    let markerStates = []; // runtime
    let breakStates = [];
    let activePhrase = null;
    let activeSpin = null;
    let pointers = new Map(); // pointerId -> {x,y}
    let lastBreakShown = -1;
    let approachSec = 1.2;
    let offset = 0;
    let endTime = 0;
    let dpr = 1;
    let deviceLatencySec = 0; // input/display lag compensation (separate from beat offset)
    let videoDuration = 0; // real YT duration when known
    let ending = false;

    function resize() {
      const parent = canvas.parentElement;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function cssSize() {
      return { w: canvas.width / dpr, h: canvas.height / dpr };
    }

    function toPx(nx, ny) {
      const { w, h } = cssSize();
      return { x: nx * w, y: ny * h };
    }

    function resetRuntime(c) {
      chart = c;
      approachSec = c.approachSec || 1.2;
      offset = c.offset || 0;
      life = 100;
      score = 0;
      combo = 0;
      maxCombo = 0;
      counts[300] = counts[100] = counts[50] = counts[0] = 0;
      failed = false;
      cleared = false;
      lastBreakShown = -1;
      activePhrase = null;
      activeSpin = null;
      markerStates = c.markers.map((m, i) => ({
        idx: i,
        def: m,
        judged: false,
        result: null,
        // phrase
        progress: 0,
        // spin
        angleAcc: 0,
        lastAngle: null,
      }));
      breakStates = (c.breaks || []).map((b) => ({ def: b, shown: false }));
      ending = false;
      const lastT = c.markers.reduce((mx, m) => {
        const end = m.type === "hit" ? m.t : m.t + (m.duration || 0);
        return Math.max(mx, end);
      }, 0);
      const hint = c.durationHint || 0;
      const durCap = videoDuration > 0 ? videoDuration : hint > 0 ? hint : 0;
      // Chart should end with last marker, but never past real video (+ small grace)
      if (durCap > 0) {
        endTime = Math.min(lastT + 0.35, durCap - 0.05);
        if (endTime < lastT && lastT <= durCap) endTime = Math.min(lastT + 0.2, durCap);
      } else {
        endTime = lastT + 0.5;
      }
      if (hooks.onHud) hooks.onHud(snapshot());
    }

    function snapshot() {
      return { life, score, combo, maxCombo, counts, failed, cleared };
    }

    function applyLifeDelta(d) {
      life = Math.max(0, Math.min(100, life + d));
      if (life <= 0) {
        life = 0;
        failed = true;
        running = false;
        if (hooks.onFail) hooks.onFail(snapshot());
      }
      if (hooks.onHud) hooks.onHud(snapshot());
    }

    function judgeHit(grade, timingDt) {
      counts[grade] = (counts[grade] || 0) + 1;
      score += grade;
      if (grade === 0) {
        combo = 0;
        applyLifeDelta(-8);
      } else {
        combo += 1;
        maxCombo = Math.max(maxCombo, combo);
        if (grade === 300) applyLifeDelta(2);
        else if (grade === 100) applyLifeDelta(1);
        else applyLifeDelta(0);
      }
      let earlyLate = null;
      if (timingDt != null && grade !== 0) {
        earlyLate = timingDt < -0.012 ? "EARLY" : timingDt > 0.012 ? "LATE" : "OK";
      } else if (grade === 0) {
        earlyLate = "MISS";
      }
      if (hooks.onJudgment) hooks.onJudgment(grade, combo, { earlyLate: earlyLate, dt: timingDt });
      if (hooks.onHud) hooks.onHud(snapshot());
    }

    function judgeHoldLike(grade) {
      counts[grade] = (counts[grade] || 0) + 1;
      score += grade;
      if (grade === 0) {
        combo = 0;
        applyLifeDelta(-10);
      } else {
        combo += 1;
        maxCombo = Math.max(maxCombo, combo);
        applyLifeDelta(grade >= 50 ? 3 : 0);
      }
      if (hooks.onJudgment) hooks.onJudgment(grade, combo, { earlyLate: grade === 0 ? "MISS" : null });
      if (hooks.onHud) hooks.onHud(snapshot());
    }

    function gradeFromAbsDt(dt) {
      const a = Math.abs(dt);
      if (a <= HIT_WINDOWS.perfect) return 300;
      if (a <= HIT_WINDOWS.great) return 100;
      if (a <= HIT_WINDOWS.good) return 50;
      return 0;
    }

    function gradeFromProgress(p) {
      if (p >= 0.85) return 300;
      if (p >= 0.6) return 100;
      if (p >= 0.4) return 50;
      return 0;
    }

    function gameTime(ytTime) {
      // beat offset shifts chart; device latency pulls judgement earlier (phone lag)
      return ytTime + offset - deviceLatencySec;
    }

    function tryHitAt(cssX, cssY, t) {
      // nearest unjudged hit in window
      let best = null;
      let bestScore = Infinity;
      for (const st of markerStates) {
        if (st.judged || st.def.type !== "hit") continue;
        const dt = t - st.def.t;
        if (dt < -HIT_WINDOWS.good || dt > HIT_WINDOWS.good) continue;
        const p = toPx(st.def.x, st.def.y);
        const dist = Math.hypot(cssX - p.x, cssY - p.y);
        if (dist <= HIT_R * 1.55 && Math.abs(dt) < bestScore) {
          bestScore = Math.abs(dt);
          best = st;
        }
      }
      if (!best) return false;
      best.judged = true;
      const timingDt = t - best.def.t;
      best.result = gradeFromAbsDt(timingDt);
      best.timingDt = timingDt;
      judgeHit(best.result, timingDt);
      return true;
    }

    function distToPath(pathPx, x, y) {
      let min = Infinity;
      let bestSeg = 0;
      let bestT = 0;
      for (let i = 0; i < pathPx.length - 1; i++) {
        const a = pathPx[i];
        const b = pathPx[i + 1];
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const len2 = abx * abx + aby * aby || 1;
        let u = ((x - a.x) * abx + (y - a.y) * aby) / len2;
        u = Math.max(0, Math.min(1, u));
        const px = a.x + abx * u;
        const py = a.y + aby * u;
        const d = Math.hypot(x - px, y - py);
        if (d < min) {
          min = d;
          bestSeg = i;
          bestT = u;
        }
      }
      const segLens = [];
      let total = 0;
      for (let i = 0; i < pathPx.length - 1; i++) {
        const len = Math.hypot(pathPx[i + 1].x - pathPx[i].x, pathPx[i + 1].y - pathPx[i].y);
        segLens.push(len);
        total += len;
      }
      let along = 0;
      for (let i = 0; i < bestSeg; i++) along += segLens[i];
      along += segLens[bestSeg] * bestT;
      const progress = total > 0 ? along / total : 1;
      return { dist: min, progress };
    }

    function updatePhrase(t) {
      if (!activePhrase) {
        for (const st of markerStates) {
          if (st.judged || st.def.type !== "phrase") continue;
          if (t >= st.def.t && t <= st.def.t + st.def.duration) {
            activePhrase = st;
            break;
          }
        }
      }
      if (!activePhrase) return;
      const st = activePhrase;
      const end = st.def.t + st.def.duration;
      if (!st.judged && st.progress >= 0.85) {
        st.judged = true;
        st.result = 300;
        judgeHoldLike(300);
        activePhrase = null;
        return;
      }
      if (t > end && !st.judged) {
        st.judged = true;
        st.result = gradeFromProgress(st.progress);
        judgeHoldLike(st.result);
        activePhrase = null;
      }
    }

    function updateSpin(t) {
      if (!activeSpin) {
        for (const st of markerStates) {
          if (st.judged || st.def.type !== "spin") continue;
          if (t >= st.def.t && t <= st.def.t + st.def.duration) {
            activeSpin = st;
            st.lastAngle = null;
            break;
          }
        }
      }
      if (!activeSpin) return;
      const st = activeSpin;
      const end = st.def.t + st.def.duration;
      const need = (st.def.revs || 1) * Math.PI * 2;
      if (t > end && !st.judged) {
        st.judged = true;
        const p = Math.min(1, st.angleAcc / need);
        st.result = gradeFromProgress(p);
        judgeHoldLike(st.result);
        activeSpin = null;
      } else if (!st.judged && st.angleAcc >= need * 0.85) {
        // early complete
        st.judged = true;
        st.result = 300;
        judgeHoldLike(300);
        activeSpin = null;
      }
    }

    function missExpired(t) {
      for (const st of markerStates) {
        if (st.judged) continue;
        if (st.def.type === "hit" && t > st.def.t + HIT_WINDOWS.good) {
          st.judged = true;
          st.result = 0;
          judgeHit(0);
        }
      }
    }

    function checkBreaks(t) {
      for (let i = 0; i < breakStates.length; i++) {
        const b = breakStates[i];
        if (b.shown) continue;
        if (t >= b.def.t) {
          b.shown = true;
          lastBreakShown = i;
          let kind = "mid";
          if (life >= 70) kind = "o";
          else if (life < 40) kind = "x";
          if (hooks.onBreak) hooks.onBreak(kind, life);
        }
      }
    }

    function allJudged() {
      return markerStates.length === 0 || markerStates.every((s) => s.judged);
    }

    function finishClear() {
      if (failed || cleared) return;
      ending = true;
      cleared = true;
      running = false;
      if (hooks.onClear) hooks.onClear(snapshot());
    }

    /** Miss any leftover markers then Clear/Fail — never softlock past video end. */
    function forceResolveEnd(reason) {
      if (!running || failed || cleared || ending) return;
      ending = true; // re-entrancy guard (YT ended + RAF may both fire)
      const t = gameTime(hooks.getTime ? hooks.getTime() : 0);
      for (const st of markerStates) {
        if (st.judged) continue;
        st.judged = true;
        st.result = 0;
        if (st.def.type === "hit") judgeHit(0, null);
        else judgeHoldLike(0);
        if (failed) return; // life emptied mid-resolve
      }
      activePhrase = null;
      activeSpin = null;
      if (!failed) finishClear();
    }

    function tick(ytTime, meta) {
      if (!running || !chart || failed || cleared) return;
      meta = meta || {};
      if (meta.videoDuration > 0) videoDuration = meta.videoDuration;

      const rawYt = ytTime;
      const t = gameTime(rawYt);
      missExpired(t);
      updatePhrase(t);
      updateSpin(t);
      checkBreaks(t);
      draw(t);

      const dur = videoDuration > 0 ? videoDuration : meta.videoDuration || 0;
      const endedFlag = !!meta.ended;
      const pastVideo =
        dur > 0 && (rawYt >= dur - 0.05 || (hooks.getState && hooks.getState() === 0));
      // Also: game clock past chart endTime
      const pastChart = t >= endTime + 0.15;

      if (endedFlag || pastVideo) {
        forceResolveEnd(endedFlag ? "yt-ended" : "past-video");
        return;
      }

      if (!failed && (allJudged() || pastChart)) {
        if (allJudged() || t >= endTime + 0.35) {
          finishClear();
        }
      }
    }

    function draw(t) {
      const { w, h } = cssSize();
      ctx.clearRect(0, 0, w, h);

      // subtle grid
      ctx.strokeStyle = "rgba(148,163,184,0.06)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo((w * i) / 4, 0);
        ctx.lineTo((w * i) / 4, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, (h * i) / 4);
        ctx.lineTo(w, (h * i) / 4);
        ctx.stroke();
      }

      drawHitGuides(t);

      for (const st of markerStates) {
        const m = st.def;
        if (m.type === "hit") drawHit(st, t);
        else if (m.type === "phrase") drawPhrase(st, t);
        else if (m.type === "spin") drawSpin(st, t);
      }
    }

    function drawHitGuides(t) {
      const upcoming = markerStates
        .filter((st) => !st.judged && st.def.type === "hit" && st.def.t >= t - 0.05 && st.def.t <= t + approachSec * 1.6)
        .sort((a, b) => a.def.t - b.def.t || (a.def.n || 0) - (b.def.n || 0));
      if (upcoming.length < 2) return;
      ctx.save();
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 8]);
      for (let i = 0; i < upcoming.length - 1; i++) {
        const a = toPx(upcoming[i].def.x, upcoming[i].def.y);
        const b = toPx(upcoming[i + 1].def.x, upcoming[i + 1].def.y);
        const fade = 1 - i * 0.18;
        ctx.strokeStyle = "rgba(255, 209, 102, " + Math.max(0.25, 0.55 * fade) + ")";
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    function drawHit(st, t) {
      const m = st.def;
      const appear = m.t - approachSec;
      if (t < appear || (st.judged && t > m.t + 0.25)) return;
      const p = toPx(m.x, m.y);
      const progress = Math.min(1, Math.max(0, (t - appear) / approachSec));
      const ringR = HIT_R + (1 - progress) * 70;

      if (!st.judged) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(76,201,240,0.85)";
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, HIT_R, 0, Math.PI * 2);
      if (st.judged) {
        const col =
          st.result === 300
            ? "#06d6a0"
            : st.result === 100
              ? "#4cc9f0"
              : st.result === 50
                ? "#ffd166"
                : "#ef476f";
        ctx.fillStyle = col;
      } else {
        ctx.fillStyle = "rgba(255,255,255,0.92)";
      }
      ctx.fill();
      ctx.strokeStyle = "rgba(15,23,42,0.5)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = "#0f172a";
      ctx.font = "bold 18px system-ui,sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.n != null ? m.n : ""), p.x, p.y + 1);
    }

    function drawPhrase(st, t) {
      const m = st.def;
      const appear = m.t - 0.4;
      const end = m.t + m.duration;
      if (t < appear || (st.judged && t > end + 0.3)) return;
      const pathPx = m.path.map(([x, y]) => toPx(x, y));
      ctx.beginPath();
      pathPx.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.strokeStyle = st.judged ? "rgba(6,214,160,0.5)" : "rgba(255,77,109,0.75)";
      ctx.lineWidth = 6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();

      // progress overlay
      if (st.progress > 0 && pathPx.length >= 2) {
        const total = pathPx.reduce((acc, p, i) => {
          if (i === 0) return 0;
          return acc + Math.hypot(p.x - pathPx[i - 1].x, p.y - pathPx[i - 1].y);
        }, 0);
        let remain = total * st.progress;
        ctx.beginPath();
        ctx.moveTo(pathPx[0].x, pathPx[0].y);
        for (let i = 1; i < pathPx.length; i++) {
          const seg = Math.hypot(pathPx[i].x - pathPx[i - 1].x, pathPx[i].y - pathPx[i - 1].y);
          if (remain >= seg) {
            ctx.lineTo(pathPx[i].x, pathPx[i].y);
            remain -= seg;
          } else {
            const u = remain / (seg || 1);
            ctx.lineTo(
              pathPx[i - 1].x + (pathPx[i].x - pathPx[i - 1].x) * u,
              pathPx[i - 1].y + (pathPx[i].y - pathPx[i - 1].y) * u
            );
            break;
          }
        }
        ctx.strokeStyle = "#06d6a0";
        ctx.lineWidth = 8;
        ctx.stroke();
      }

      // follow ball position along expected time or progress
      let ballP = pathPx[0];
      if (t >= m.t && t <= end) {
        const u = st.progress > 0.05 ? st.progress : Math.min(1, (t - m.t) / m.duration);
        // interpolate by arc length ratio u
        const total = pathPx.reduce((acc, p, i) => {
          if (i === 0) return 0;
          return acc + Math.hypot(p.x - pathPx[i - 1].x, p.y - pathPx[i - 1].y);
        }, 0);
        let remain = total * u;
        for (let i = 1; i < pathPx.length; i++) {
          const seg = Math.hypot(pathPx[i].x - pathPx[i - 1].x, pathPx[i].y - pathPx[i - 1].y);
          if (remain <= seg) {
            const r = remain / (seg || 1);
            ballP = {
              x: pathPx[i - 1].x + (pathPx[i].x - pathPx[i - 1].x) * r,
              y: pathPx[i - 1].y + (pathPx[i].y - pathPx[i - 1].y) * r,
            };
            break;
          }
          remain -= seg;
          ballP = pathPx[i];
        }
      }
      ctx.beginPath();
      ctx.arc(ballP.x, ballP.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = "#ff4d6d";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    function drawSpin(st, t) {
      const m = st.def;
      const appear = m.t - 0.35;
      const end = m.t + m.duration;
      if (t < appear || (st.judged && t > end + 0.3)) return;
      const p = toPx(m.x, m.y);
      const R = 54;
      const need = (m.revs || 1) * Math.PI * 2;
      const fill = Math.min(1, st.angleAcc / need);

      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(148,163,184,0.45)";
      ctx.lineWidth = 10;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, R, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2);
      ctx.strokeStyle = "#4cc9f0";
      ctx.lineWidth = 10;
      ctx.lineCap = "round";
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
      ctx.fillStyle = "#0f172a";
      ctx.font = "bold 14px system-ui";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("SPIN", p.x, p.y + 1);
    }

    function onPointerDown(e) {
      if (!running) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      pointers.set(e.pointerId, { x, y });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch (_) {}
      const t = gameTime(hooks.getTime());
      if (activeSpin) {
        const p = toPx(activeSpin.def.x, activeSpin.def.y);
        activeSpin.lastAngle = Math.atan2(y - p.y, x - p.x);
      }
      tryHitAt(x, y, t);
      if (activePhrase) {
        const pathPx = activePhrase.def.path.map(([nx, ny]) => toPx(nx, ny));
        const { dist, progress } = distToPath(pathPx, x, y);
        if (dist < 64) {
          activePhrase.progress = Math.max(activePhrase.progress, progress);
        }
      }
    }

    function onPointerMove(e) {
      if (!running || !pointers.has(e.pointerId)) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      pointers.set(e.pointerId, { x, y });
      if (activePhrase) {
        const pathPx = activePhrase.def.path.map(([nx, ny]) => toPx(nx, ny));
        const { dist, progress } = distToPath(pathPx, x, y);
        if (dist < 72 && progress >= activePhrase.progress - 0.05) {
          activePhrase.progress = Math.max(activePhrase.progress, progress);
        }
      }
      if (activeSpin && !activeSpin.judged) {
        const p = toPx(activeSpin.def.x, activeSpin.def.y);
        const ang = Math.atan2(y - p.y, x - p.x);
        const dist = Math.hypot(x - p.x, y - p.y);
        if (dist > 14 && dist < 130 && activeSpin.lastAngle != null) {
          let d = ang - activeSpin.lastAngle;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          activeSpin.angleAcc += Math.abs(d);
        }
        activeSpin.lastAngle = ang;
      }
    }

    function onPointerUp(e) {
      pointers.delete(e.pointerId);
      if (activeSpin) activeSpin.lastAngle = null;
    }

    function start() {
      running = true;
      failed = false;
      cleared = false;
      ending = false;
    }
    function stop() {
      running = false;
    }
    function isRunning() {
      return running;
    }

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    // Block long-press select / iOS callout / Android context menu during play
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("selectstart", (e) => e.preventDefault());
    canvas.addEventListener("dragstart", (e) => e.preventDefault());

    function setDeviceLatencyMs(ms) {
      deviceLatencySec = (Number(ms) || 0) / 1000;
    }
    function getDeviceLatencyMs() {
      return Math.round(deviceLatencySec * 1000);
    }
    function setVideoDuration(sec) {
      videoDuration = Number(sec) || 0;
      if (chart && videoDuration > 0) {
        const lastT = chart.markers.reduce((mx, m) => {
          const end = m.type === "hit" ? m.t : m.t + (m.duration || 0);
          return Math.max(mx, end);
        }, 0);
        endTime = Math.min(Math.max(lastT, lastT + 0.2), videoDuration - 0.05);
      }
    }

    return {
      resize,
      resetRuntime,
      tick,
      start,
      stop,
      isRunning,
      snapshot,
      draw,
      forceResolveEnd,
      setDeviceLatencyMs,
      getDeviceLatencyMs,
      setVideoDuration,
      get chart() {
        return chart;
      },
      get endTime() {
        return endTime;
      },
    };
  }

  global.GameEngine = { createGame, HIT_WINDOWS };
})(window);
