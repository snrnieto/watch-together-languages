// Guarda la lista de pistas que Netflix descifra en la página (por título),
// para que el reproductor de audio de la extensión sepa de dónde bajar el segundo idioma.
// Corre en MAIN y en document_start, antes que los scripts de Netflix.
(() => {
  if (!/(^|\.)netflix\.com$/.test(location.hostname) || window.top !== window) return;

  const origParse = JSON.parse;
  const isMediaUrl = (s) => typeof s === 'string' && /^https:\/\/[^/]*nflxvideo\.net\//.test(s);

  function urlsIn(o, out = [], depth = 0) {
    if (!o || typeof o !== 'object' || depth > 6) return out;
    for (const v of Object.values(o)) {
      if (isMediaUrl(v)) out.push(v);
      else if (v && typeof v === 'object') urlsIn(v, out, depth + 1);
    }
    return out;
  }

  function extractStreams(track) {
    const list = Array.isArray(track.streams) ? track.streams : [];
    const res = list
      .map((s) => ({
        urls: [...new Set(urlsIn(s))],
        bitrate: Number(s.bitrate || s.bitrateKbps || 0),
        drm: s.isDrm === true,
        profile: String(s.content_profile || s.contentProfile || ''),
      }))
      .filter((s) => s.urls.length);
    if (res.length) return res;
    const urls = [...new Set(urlsIn(track))];
    return urls.length ? [{ urls, bitrate: 0, drm: false, profile: '' }] : [];
  }

  function movieIdOf(o) {
    for (const c of [o, o?.result]) {
      for (const k of ['movieId', 'viewableId']) {
        if (c && (typeof c[k] === 'number' || typeof c[k] === 'string')) return String(c[k]);
      }
    }
    return null;
  }

  const audioTracksOf = (o) =>
    [o?.audio_tracks, o?.audioTracks, o?.result?.audioTracks, o?.result?.audio_tracks].find(
      (a) => Array.isArray(a) && a.length && typeof a[0] === 'object'
    ) || null;

  const store = (window.__AudioDualNetflix = { manifests: new Map(), extractStreams });

  JSON.parse = function (text, reviver) {
    const r = origParse.call(this, text, reviver);
    try {
      if (typeof text === 'string' && text.length > 2000 && text.includes('nflxvideo.net')) {
        const tracks = audioTracksOf(r);
        if (tracks) {
          const id = movieIdOf(r) || '__last';
          // Conservar la versión con más enlaces (Netflix manda la misma lista en dos formatos).
          const prev = store.manifests.get(id);
          const count = (ts) => ts.reduce((n, t) => n + urlsIn(t).length, 0);
          if (!prev || count(tracks) >= count(prev.audioTracks)) {
            store.manifests.set(id, { audioTracks: tracks, at: Date.now() });
            store.manifests.set('__last', { audioTracks: tracks, at: Date.now(), movieId: id });
          }
          const langs = tracks
            .filter((t) => urlsIn(t).length)
            .map((t) => t.language || t.bcp47)
            .join(', ');
          console.log(`%c[Watch Together Languages] Pistas capturadas (título ${id}). Idiomas con audio disponible: ${langs}`, 'color:#5b4bff');
        }
      }
    } catch {}
    return r;
  };
})();
