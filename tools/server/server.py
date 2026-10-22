#!/usr/bin/env python3
"""
Personal-use localhost companion for Ouendan YT beat detect.

- Binds 127.0.0.1 ONLY (not public).
- yt-dlp extracts audio to a temp file, numpy onset/autocorr → BPM/offset,
  returns JSON for the game page. Does NOT host a public download API.
- NEVER deploy this process on github.io / public VPS for open use.

Usage:
  cd tools/server && .venv/bin/python server.py
  # then in the game (same machine): Load YT → 「本機自動對拍」
"""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("OUENDAN_HELPER_PORT", "8767"))
ROOT = Path(__file__).resolve().parent
VENV_YTDLP = ROOT / ".venv" / "bin" / "yt-dlp"
YTDLP = str(VENV_YTDLP if VENV_YTDLP.exists() else shutil.which("yt-dlp") or "yt-dlp")
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")


def cors_ok(origin: str | None) -> bool:
    if not origin or origin == "null":
        return True
    # Only localhost / 127.0.0.1 / file — never allow arbitrary public sites to drive downloads
    return bool(
        re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", origin)
        or origin.startswith("http://192.168.")  # same LAN phone→PC optional
        or origin.startswith("http://10.")
    )


def extract_bpm_offset(wav_path: Path) -> dict:
    import numpy as np

    with wave.open(str(wav_path), "rb") as wf:
        rate = wf.getframerate()
        nch = wf.getnchannels()
        sw = wf.getsampwidth()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)
    if sw != 2:
        raise RuntimeError("expected 16-bit wav")
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if nch > 1:
        audio = audio.reshape(-1, nch).mean(axis=1)
    # Cap 90s
    max_len = int(rate * 90)
    if audio.size > max_len:
        audio = audio[:max_len]
    duration = nframes / float(rate)

    # Downsample to ~22050
    target = 22050
    if rate != target:
        # crude linear resample
        n = int(audio.size * target / rate)
        x = np.linspace(0, audio.size - 1, n)
        audio = np.interp(x, np.arange(audio.size), audio)
        rate = target

    hop = max(1, int(rate * 0.01))
    win = max(1, int(rate * 0.04))
    n = max(0, (audio.size - win) // hop)
    env = np.zeros(n, dtype=np.float32)
    prev = 0.0
    for i in range(n):
        seg = audio[i * hop : i * hop + win]
        e = float(np.sqrt(np.mean(seg * seg) + 1e-12))
        flux = max(0.0, e - prev)
        env[i] = flux
        prev = e * 0.85 + prev * 0.15
    mx = float(env.max()) if env.size else 0.0
    if mx > 0:
        env /= mx

    fps = rate / hop
    min_bpm, max_bpm = 70, 180
    min_lag = int((60 / max_bpm) * fps)
    max_lag = int((60 / min_bpm) * fps)
    best_lag, best_s = min_lag, -1e9
    for lag in range(min_lag, max_lag + 1):
        a = env[:-lag]
        b = env[lag:]
        if a.size == 0:
            continue
        s = float(np.dot(a, b) / a.size)
        if s > best_s:
            best_s, best_lag = s, lag
    bpm = 60.0 / (best_lag / fps) if best_lag else 120.0
    while bpm < 80 and bpm * 2 <= max_bpm:
        bpm *= 2
    while bpm > 160 and bpm / 2 >= min_bpm:
        bpm /= 2
    bpm = round(bpm * 10) / 10

    # offset from first strong peak
    start = int(0.3 * fps)
    search_end = min(env.size, int(8 * fps))
    if search_end > start:
        best_i = int(np.argmax(env[start:search_end]) + start)
    else:
        best_i = start
    beat_sec = 60.0 / bpm
    first_beat = best_i / fps
    offset = first_beat % beat_sec
    if offset > beat_sec / 2:
        offset -= beat_sec
    offset = round(offset * 1000) / 1000

    return {
        "bpm": bpm,
        "offset": offset,
        "duration": round(duration, 3),
        "firstBeat": round(first_beat, 3),
        "source": "localhost-ytdlp",
    }


def download_audio_wav(video_id: str, out_wav: Path) -> None:
    url = f"https://www.youtube.com/watch?v={video_id}"
    tmpdir = out_wav.parent
    outtmpl = str(tmpdir / "media.%(ext)s")
    cmd = [
        YTDLP,
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "-x",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "-o",
        outtmpl,
        "--ffmpeg-location",
        str(Path(FFMPEG).parent if Path(FFMPEG).name == "ffmpeg" else FFMPEG),
        url,
    ]
    # ffmpeg-location wants directory
    ffdir = str(Path(shutil.which("ffmpeg") or "/usr/bin/ffmpeg").resolve().parent)
    cmd = [
        YTDLP,
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "-x",
        "--audio-format",
        "wav",
        "-o",
        outtmpl,
        "--ffmpeg-location",
        ffdir,
        url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp failed: {proc.stderr[-800:] or proc.stdout[-800:]}")
    # find wav
    wavs = list(tmpdir.glob("media*.wav"))
    if not wavs:
        # maybe already wav named differently
        wavs = list(tmpdir.glob("*.wav"))
    if not wavs:
        raise RuntimeError("no wav produced by yt-dlp")
    shutil.move(str(wavs[0]), str(out_wav))


class Handler(BaseHTTPRequestHandler):
    server_version = "OuendanLocalHelper/1.0"

    def _send(self, code: int, body: dict, origin: str | None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if cors_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin or "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        if not cors_ok(origin):
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin or "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        origin = self.headers.get("Origin")
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/health"):
            self._send(
                200,
                {
                    "ok": True,
                    "service": "ouendan-local-helper",
                    "bind": f"{HOST}:{PORT}",
                    "warning": "個人學習用；勿公開部署。github.io 唔會跑呢個 API。",
                },
                origin,
            )
            return
        if parsed.path != "/analyze":
            self._send(404, {"ok": False, "error": "not found"}, origin)
            return
        if not cors_ok(origin):
            self._send(403, {"ok": False, "error": "origin not allowed (localhost only)"}, origin)
            return
        qs = parse_qs(parsed.query)
        vid = (qs.get("v") or qs.get("videoId") or [""])[0].strip()
        if not VIDEO_ID_RE.match(vid):
            self._send(400, {"ok": False, "error": "invalid videoId"}, origin)
            return
        try:
            with tempfile.TemporaryDirectory(prefix="ouendan-yt-") as td:
                wav = Path(td) / "audio.wav"
                download_audio_wav(vid, wav)
                meta = extract_bpm_offset(wav)
            meta["ok"] = True
            meta["videoId"] = vid
            self._send(200, meta, origin)
        except Exception as e:
            traceback.print_exc()
            self._send(500, {"ok": False, "error": str(e)}, origin)

    def log_message(self, fmt, *args):
        sys_stderr = __import__("sys").stderr
        print(f"[helper] {self.address_string()} {fmt % args}", file=sys_stderr)


def main():
    if not shutil.which("ffmpeg") and not Path("/usr/bin/ffmpeg").exists():
        print("WARNING: ffmpeg not found — yt-dlp audio extract may fail")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Ouendan local helper on http://{HOST}:{PORT}/  (個人學習／127.0.0.1 only)")
    print("GET /health  |  GET /analyze?v=VIDEO_ID")
    print("Stop with Ctrl+C. Do NOT expose this port to the public internet.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
