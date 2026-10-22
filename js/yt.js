/**
 * YouTube IFrame Player API — fullscreen underlay, getCurrentTime clock.
 * Never downloads/caches/separates YT audio.
 */
(function (global) {
  let readyPromise = null;
  let player = null;
  let onReadyCb = null;
  let onStateCb = null;

  function loadApi() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => {
      if (global.YT && global.YT.Player) {
        resolve();
        return;
      }
      const prev = global.onYouTubeIframeAPIReady;
      global.onYouTubeIframeAPIReady = function () {
        if (typeof prev === "function") prev();
        resolve();
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
    return readyPromise;
  }

  function coverSize() {
    // CSS handles cover; setSize keeps internal player metrics sane
    const w = Math.max(window.innerWidth, 320);
    const h = Math.max(window.innerHeight, 180);
    return { w: Math.round(w), h: Math.round(h) };
  }

  function applyCoverSize() {
    if (!player || typeof player.setSize !== "function") return;
    const { w, h } = coverSize();
    try {
      player.setSize(w, h);
    } catch (_) {}
  }

  async function create(containerId, videoId, handlers) {
    await loadApi();
    onReadyCb = handlers && handlers.onReady;
    onStateCb = handlers && handlers.onStateChange;
    return new Promise((resolve) => {
      if (player) {
        try {
          player.destroy();
        } catch (_) {}
        player = null;
      }
      let mount = document.getElementById(containerId);
      const parent =
        mount && mount.parentNode
          ? mount.parentNode
          : document.getElementById("yt-bg") || document.body;
      if (mount) {
        const fresh = document.createElement("div");
        fresh.id = containerId;
        parent.replaceChild(fresh, mount);
      } else {
        mount = document.createElement("div");
        mount.id = containerId;
        parent.appendChild(mount);
      }
      const { w, h } = coverSize();
      player = new YT.Player(containerId, {
        width: w,
        height: h,
        videoId,
        playerVars: {
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          controls: 0,
          fs: 0,
          disablekb: 1,
          iv_load_policy: 3,
          origin: location.origin === "null" ? undefined : location.origin,
        },
        events: {
          onReady: (e) => {
            applyCoverSize();
            if (onReadyCb) onReadyCb(e);
            resolve(player);
          },
          onStateChange: (e) => {
            if (onStateCb) onStateCb(e);
          },
          onError: (e) => {
            console.warn("YT error", e.data);
            if (handlers && handlers.onError) handlers.onError(e);
          },
        },
      });
    });
  }

  function getTime() {
    if (!player || typeof player.getCurrentTime !== "function") return 0;
    try {
      return player.getCurrentTime() || 0;
    } catch (_) {
      return 0;
    }
  }

  function getState() {
    if (!player || typeof player.getPlayerState !== "function") return -1;
    try {
      return player.getPlayerState();
    } catch (_) {
      return -1;
    }
  }

  function play() {
    if (player && player.playVideo) player.playVideo();
  }
  function pause() {
    if (player && player.pauseVideo) player.pauseVideo();
  }
  function seek(t) {
    if (player && player.seekTo) player.seekTo(t, true);
  }
  function getDuration() {
    if (!player || typeof player.getDuration !== "function") return 0;
    try {
      return player.getDuration() || 0;
    } catch (_) {
      return 0;
    }
  }
  function loadVideo(id) {
    if (player && player.loadVideoById) player.loadVideoById(id);
  }
  function getVideoData() {
    if (!player || typeof player.getVideoData !== "function") return null;
    try {
      return player.getVideoData();
    } catch (_) {
      return null;
    }
  }

  window.addEventListener("resize", () => applyCoverSize());
  window.addEventListener("orientationchange", () => setTimeout(applyCoverSize, 200));

  global.YTBridge = {
    loadApi,
    create,
    getTime,
    getState,
    play,
    pause,
    seek,
    getDuration,
    loadVideo,
    getVideoData,
    applyCoverSize,
    get player() {
      return player;
    },
  };
})(window);
