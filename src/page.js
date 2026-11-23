// Puente en el mundo de la página (MAIN). Habla con el reproductor a través del
// adaptador de la plataforma y con content.js mediante window.postMessage.
(() => {
  const adapters = window.__AudioDualAdapters || {};
  const ad = Object.values(adapters).find((a) => a.match());
  if (!ad || window.top !== window) return;

  const TAG = '__audioDual';
  let role = 'none'; // 'primary' | 'secondary' | 'none'
  let lastSeekAt = 0;
  let pausedSince = 0;

  const post = (msg) => window.postMessage({ [TAG]: 'page', ...msg }, location.origin);

  function chooseTrack(lang) {
    const tracks = ad.getAudioTracks();
    const base = (l) => l.split('-')[0];
    const normal = tracks.filter((t) => !t.assistive);
    return (
      normal.find((t) => t.lang === lang) ||
      normal.find((t) => base(t.lang) === base(lang)) ||
      tracks.find((t) => base(t.lang) === base(lang)) ||
      null
    );
  }

  function info() {
    const ready = ad.isReady();
    let state = null;
    let tracks = [];
    let currentTrackId = null;
    if (ready) {
      try {
        state = ad.getState();
        tracks = ad.getAudioTracks();
        currentTrackId = ad.getCurrentTrackId();
        // En modo "misma pestaña" solo sirven los idiomas cuyo audio entregó Netflix.
        if (ad.getAudioStreams && state) {
          tracks = tracks.map((t) => ({ ...t, available: !ad.getAudioStreams(t.lang, state.videoId).error }));
        }
      } catch {}
    }
    return { platform: ad.id, platformName: ad.name, mode: ad.mode || 'tab', ready, state, tracks, currentTrackId };
  }

  function applyTrack(lang) {
    if (!ad.isReady()) return { ok: false, reason: 'not-ready' };
    const t = chooseTrack(lang);
    if (!t) return { ok: false, reason: 'missing', available: ad.getAudioTracks().length > 0 };
    if (ad.getCurrentTrackId() === t.id) return { ok: true, track: t };
    const ok = ad.setAudioTrack(t.id);
    return { ok: false, reason: ok ? 'switching' : 'failed' };
  }

  // Sincroniza la pestaña secundaria con el estado de la principal.
  function applySync(s, offsetMs) {
    if (!ad.isReady() || !s?.videoId) return;
    const me = ad.getState();
    if (!me || me.videoId !== s.videoId) return;
    if (me.inAd) return; // anuncio en la secundaria: esperar a que termine

    const now = Date.now();
    const v = ad.getVideoElement();

    if (s.inAd || s.paused) {
      if (!me.paused) ad.pause();
      const expected = s.time + offsetMs / 1000;
      if (!s.inAd && Math.abs(me.time - expected) > 0.3 && now - lastSeekAt > 1000) {
        ad.seek(expected);
        lastSeekAt = now;
      }
      if (v) v.playbackRate = s.rate || 1;
      pausedSince = 0;
      post({ type: 'drift', drift: me.time - expected, stuck: false });
      return;
    }

    const rate = s.rate || 1;
    const expected = s.time + ((now - s.sentAt) / 1000) * rate + offsetMs / 1000;

    if (me.paused) {
      ad.play();
      pausedSince = pausedSince || now;
    } else {
      pausedSince = 0;
    }

    const drift = me.time - expected;
    if (Math.abs(drift) > 1) {
      if (now - lastSeekAt > 2500) {
        ad.seek(expected + 0.2);
        lastSeekAt = now;
      }
    } else if (v) {
      // Desfase pequeño: acelera o frena un poco en vez de saltar.
      const corr = Math.max(-0.08, Math.min(0.08, -drift * 0.8));
      v.playbackRate = Math.abs(drift) < 0.04 ? rate : rate * (1 + corr);
    }

    // Si Chrome bloquea el play() de la pestaña oculta, avisar.
    const stuck = !!pausedSince && now - pausedSince > 4000;
    post({ type: 'drift', drift, stuck });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'content') return;
    const m = e.data;
    switch (m.type) {
      case 'role':
        role = m.role;
        break;
      case 'query':
        post({ type: 'reply', reqId: m.reqId, data: info() });
        break;
      case 'setTrack':
        post({ type: 'reply', reqId: m.reqId, data: applyTrack(m.lang) });
        break;
      case 'sync':
        if (role === 'secondary') {
          try {
            applySync(m.state, m.offsetMs || 0);
          } catch {}
        }
        break;
      case 'pause':
        try {
          ad.pause();
        } catch {}
        break;
    }
  });

  // La pestaña principal transmite su estado continuamente.
  setInterval(() => {
    if (role !== 'primary') return;
    let state = { videoId: null };
    try {
      if (ad.isReady()) {
        const st = ad.getState();
        if (st) state = { ...st, url: ad.contentUrl(st) };
      }
    } catch {}
    state.sentAt = Date.now();
    post({ type: 'state', state });
  }, 400);
})();
