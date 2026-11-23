// Adaptador de Netflix. Corre en el "mundo" de la página (MAIN) para poder usar
// la API interna del reproductor, la misma que usan Language Reactor y Teleparty.
(() => {
  const A = (window.__AudioDualAdapters = window.__AudioDualAdapters || {});

  function videoPlayerApi() {
    try {
      return window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
    } catch {
      return null;
    }
  }

  function player() {
    const vp = videoPlayerApi();
    if (!vp) return null;
    try {
      const ids = vp.getAllPlayerSessionIds() || [];
      const sid = ids.find((i) => String(i).startsWith('watch')) || ids[ids.length - 1];
      return sid ? vp.getVideoPlayerBySessionId(sid) : null;
    } catch {
      return null;
    }
  }

  function rawTracks() {
    try {
      return player()?.getAudioTrackList() || [];
    } catch {
      return [];
    }
  }

  A.netflix = {
    id: 'netflix',
    name: 'Netflix',
    match: () => /(^|\.)netflix\.com$/.test(location.hostname),

    isReady() {
      if (!location.pathname.startsWith('/watch')) return false;
      const p = player();
      try {
        return !!(p && p.getMovieId() && this.getVideoElement());
      } catch {
        return false;
      }
    },

    getState() {
      const p = player();
      if (!p) return null;
      const v = this.getVideoElement();
      return {
        videoId: String(p.getMovieId()),
        time: p.getCurrentTime() / 1000,
        paused: !!p.isPaused(),
        rate: v?.playbackRate || 1,
        inAd: false,
      };
    },

    getAudioTracks() {
      return rawTracks().map((t) => ({
        id: t.trackId,
        lang: String(t.bcp47 || t.language || '').toLowerCase(),
        label: t.displayName || t.bcp47 || t.trackId,
        assistive: /assistive|description|descrip/i.test(`${t.trackType || ''} ${t.displayName || ''}`),
      }));
    },

    getCurrentTrackId() {
      try {
        return player()?.getAudioTrack()?.trackId ?? null;
      } catch {
        return null;
      }
    },

    setAudioTrack(id) {
      const p = player();
      const t = rawTracks().find((x) => x.trackId === id);
      if (!p || !t) return false;
      p.setAudioTrack(t);
      return true;
    },

    // Netflix muestra un error si se mueve video.currentTime directamente: hay que usar su seek().
    seek(sec) {
      player()?.seek(Math.max(0, Math.round(sec * 1000)));
    },
    play() {
      player()?.play();
    },
    pause() {
      player()?.pause();
    },

    // Modo "en la misma pestaña": Netflix no deja dos reproducciones en el mismo navegador,
    // así que el segundo idioma se descarga desde la lista de pistas del propio reproductor.
    mode: 'inline',

    getAudioStreams(lang, movieId) {
      const store = window.__AudioDualNetflix;
      if (!store) return { error: 'noManifest' };
      let m = store.manifests.get(String(movieId));
      if (!m) {
        const last = store.manifests.get('__last');
        if (last && last.movieId === '__last') m = last;
      }
      if (!m) return { error: 'noManifest' };
      const base = (l) => String(l || '').toLowerCase().split('-')[0];
      const lt = (t) => String(t.language || t.bcp47 || t.languageCode || '').toLowerCase();
      const assist = (t) => /assist|descri/i.test(`${t.trackType || ''} ${t.languageDescription || ''} ${t.displayName || ''}`);
      const cands = m.audioTracks.filter((t) => base(lt(t)) === base(lang));
      const track = cands.find((t) => lt(t) === lang && !assist(t)) || cands.find((t) => !assist(t)) || cands[0];
      if (!track) return { error: 'noTrack' };
      const streams = store.extractStreams(track);
      if (!streams.length) return { error: 'noUrls' };
      return { streams };
    },

    contentUrl(state) {
      return `https://www.netflix.com/watch/${state.videoId}`;
    },

    getVideoElement() {
      return document.querySelector('video');
    },
  };
})();
