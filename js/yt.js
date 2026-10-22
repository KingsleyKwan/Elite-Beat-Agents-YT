/**
 * YouTube IFrame Player API wrapper — visible player, getCurrentTime clock.
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
      // After destroy, ensure a fresh mount node exists (iframe replaces the div).
      let mount = document.getElementById(containerId);
      const parent = mount ? mount.parentNode : document.querySelector('.yt-pane');
      if (mount) {
        const fresh = document.createElement('div');
        fresh.id = containerId;
        fresh.style.width = '100%';
        fresh.style.flex = '1';
        fresh.style.minHeight = '120px';
        parent.replaceChild(fresh, mount);
      } else if (parent) {
        mount = document.createElement('div');
        mount.id = containerId;
        mount.style.width = '100%';
        mount.style.flex = '1';
        mount.style.minHeight = '120px';
        parent.insertBefore(mount, parent.firstChild);
      }
      player = new YT.Player(containerId, {
        videoId,
        playerVars: {
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          controls: 0, // hide scrubber — dragging desyncs chart clock
          fs: 0,
          disablekb: 1,
          origin: location.origin === "null" ? undefined : location.origin,
        },
        events: {
          onReady: (e) => {
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
    get player() {
      return player;
    },
  };
})(window);
