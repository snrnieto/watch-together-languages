// Adaptador de YouTube. Solo sirve en videos con varias pistas de audio
// (doblaje oficial o doblaje automático de YouTube).
(() => {
  const A = (window.__AudioDualAdapters = window.__AudioDualAdapters || {});
  const TRACK_ID_RE = /^[a-z]{2,3}(-[A-Za-z0-9]+)*\.\d+$/;

  const playerEl = () => document.getElementById('movie_player');

  // Busca dentro de un objeto de pista interno un id del tipo "en-US.4".
  function findTrackId(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 2) return null;
    try {
      const info = obj.getLanguageInfo?.();
      const id = info?.getId?.() || info?.id;
      if (typeof id === 'string' && TRACK_ID_RE.test(id)) return id;
    } catch {}
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'string' && TRACK_ID_RE.test(v)) return v;
      if (v && typeof v === 'object') {
        const r = findTrackId(v, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function trackName(obj) {
    try {
      const info = obj.getLanguageInfo?.();
      return info?.getName?.() || info?.name || null;
    } catch {
      return null;
    }
  }

  // Lista de pistas: primero del JSON de la respuesta del reproductor (estable),
  // si no está, de los objetos internos.
  function listTracks() {
    const p = playerEl();
    if (!p) return [];
    const byId = new Map();
    try {
      const formats = p.getPlayerResponse?.()?.streamingData?.adaptiveFormats || [];
      for (const f of formats) {
        const at = f.audioTrack;
        if (at?.id && !byId.has(at.id)) byId.set(at.id, at.displayName || at.id);
      }
    } catch {}
    try {
      for (const t of p.getAvailableAudioTracks?.() || []) {
        const id = findTrackId(t);
        if (id && !byId.has(id)) byId.set(id, trackName(t) || id);
      }
    } catch {}
    return [...byId].map(([id, label]) => ({
      id,
      lang: id.split('.')[0].toLowerCase(),
      label,
      assistive: /descri/i.test(label),
    }));
  }

  A.youtube = {
    id: 'youtube',
    name: 'YouTube',
    match: () => /(^|\.)youtube\.com$/.test(location.hostname),

    isReady() {
      const p = playerEl();
      try {
        return !!(location.pathname === '/watch' && p?.getVideoData?.()?.video_id && this.getVideoElement());
      } catch {
        return false;
      }
    },

    getState() {
      const p = playerEl();
      if (!p?.getVideoData) return null;
      const s = p.getPlayerState(); // 1 reproduciendo, 3 cargando
      return {
        videoId: p.getVideoData().video_id,
        time: p.getCurrentTime(),
        paused: s !== 1 && s !== 3,
        rate: this.getVideoElement()?.playbackRate || 1,
        inAd: p.classList.contains('ad-showing'),
      };
    },

    getAudioTracks() {
      return listTracks();
    },

    getCurrentTrackId() {
      try {
        return findTrackId(playerEl()?.getAudioTrack?.());
      } catch {
        return null;
      }
    },

    setAudioTrack(id) {
      const p = playerEl();
      try {
        const t = (p?.getAvailableAudioTracks?.() || []).find((x) => findTrackId(x) === id);
        if (!t) return false;
        p.setAudioTrack(t);
        return true;
      } catch {
        return false;
      }
    },

    seek(sec) {
      playerEl()?.seekTo(Math.max(0, sec), true);
    },
    play() {
      playerEl()?.playVideo();
    },
    pause() {
      playerEl()?.pauseVideo();
    },

    contentUrl(state) {
      return `https://www.youtube.com/watch?v=${state.videoId}&t=${Math.floor(state.time)}s`;
    },

    getVideoElement() {
      return playerEl()?.querySelector('video') || null;
    },
  };
})();
