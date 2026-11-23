// Reproductor del segundo idioma DENTRO de la misma pestaña (Netflix).
// Descarga la pista de audio (AAC sin cifrar) por pedazos usando el índice "sidx" del archivo,
// la reproduce con Media Source Extensions en un <audio> oculto y la mantiene sincronizada con el video.
// La salida a los audífonos (setSinkId) y el muteo de seguridad los maneja content.js.
(() => {
  if (window.top !== window) return;
  const adapter = () => Object.values(window.__AudioDualAdapters || {}).find((a) => a.match() && a.mode === 'inline');
  if (!adapter()) return;

  const TAG = '__audioDual';
  const EL_ID = '__audio-dual';
  const AHEAD = 25; // segundos de audio a tener descargados por delante
  const post = (m) => window.postMessage({ [TAG]: 'page', ...m }, location.origin);
  const log = (...a) => console.log('%c[Watch Together Languages]', 'color:#5b4bff', ...a);
  const langName = (c) => {
    try {
      return new Intl.DisplayNames(['es'], { type: 'language' }).of(c) || c;
    } catch {
      return c;
    }
  };

  let active = false;
  let lang = null;
  let hold = true; // true mientras los audífonos no estén listos
  let offsetMs = 0;
  let src = null; // { movieId, el, ms, sb, segs, urls, urlIdx }
  let loadingFor = null;
  let failedFor = null;
  let pumping = false;

  // ---------- estado hacia el popup ----------
  let lastStatus = '';
  let lastSent = 0;
  function setStatus(status, drift) {
    const now = Date.now();
    if (status !== lastStatus || now - lastSent > 1500) {
      lastStatus = status;
      lastSent = now;
      post({ type: 'inlineStatus', status, drift });
    }
  }

  // ---------- utilidades MP4 ----------
  function readBoxes(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out = [];
    let p = 0;
    while (p + 8 <= b.length) {
      let size = dv.getUint32(p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      let hdr = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(p + 8));
        hdr = 16;
      } else if (size === 0) size = b.length - p;
      if (size < 8) break;
      out.push({ type, start: p, size, hdr });
      p += size;
    }
    return out;
  }

  function parseSidx(b, box) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = box.start + box.hdr;
    const version = b[p];
    p += 4; // versión + flags
    p += 4; // reference_ID
    const timescale = dv.getUint32(p);
    p += 4;
    let ept, firstOffset;
    if (version === 0) {
      ept = dv.getUint32(p);
      firstOffset = dv.getUint32(p + 4);
      p += 8;
    } else {
      ept = Number(dv.getBigUint64(p));
      firstOffset = Number(dv.getBigUint64(p + 8));
      p += 16;
    }
    p += 2; // reservado
    const count = dv.getUint16(p);
    p += 2;
    const segs = [];
    let offset = box.start + box.size + firstOffset;
    let t = ept / timescale;
    for (let i = 0; i < count; i++) {
      const size = dv.getUint32(p) & 0x7fffffff;
      const dur = dv.getUint32(p + 4) / timescale;
      p += 12;
      segs.push({ a: offset, b: offset + size - 1, t0: t, t1: t + dur });
      offset += size;
      t += dur;
    }
    return segs;
  }

  const indexOf = (b, s) => {
    const c = [...s].map((x) => x.charCodeAt(0));
    outer: for (let i = 0; i <= b.length - c.length; i++) {
      for (let j = 0; j < c.length; j++) if (b[i + j] !== c[j]) continue outer;
      return i;
    }
    return -1;
  };

  // Lee el códec real desde el "esds" (p. ej. xHE-AAC = mp4a.40.42).
  function detectCodec(moov) {
    if (indexOf(moov, 'enca') >= 0 || indexOf(moov, 'sinf') >= 0) return { encrypted: true };
    if (indexOf(moov, 'ec-3') >= 0) return { codec: 'ec-3' };
    const i = indexOf(moov, 'esds');
    if (i < 0) return { codec: 'mp4a.40.2' };
    const readDesc = (p) => {
      const tag = moov[p++];
      let len = 0;
      for (let k = 0; k < 4; k++) {
        const c = moov[p++];
        len = (len << 7) | (c & 0x7f);
        if (!(c & 0x80)) break;
      }
      return { tag, len, p };
    };
    try {
      let d = readDesc(i + 8);
      if (d.tag !== 3) throw 0;
      let p = d.p + 2;
      const flags = moov[p++];
      if (flags & 0x80) p += 2;
      if (flags & 0x40) p += moov[p] + 1;
      if (flags & 0x20) p += 2;
      d = readDesc(p);
      if (d.tag !== 4) throw 0;
      d = readDesc(d.p + 13);
      if (d.tag !== 5) throw 0;
      const b0 = moov[d.p];
      const b1 = moov[d.p + 1];
      let aot = b0 >> 3;
      if (aot === 31) aot = 32 + (((b0 & 7) << 3) | (b1 >> 5));
      return { codec: `mp4a.40.${aot}` };
    } catch {
      return { codec: 'mp4a.40.2' };
    }
  }

  // ---------- red ----------
  function rangeUrl(url, a, b) {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/$/, '') + `/range/${a}-${b}`;
    return u.toString();
  }

  async function fetchRange(s, a, b) {
    let lastErr;
    for (let k = 0; k < s.urls.length; k++) {
      const idx = (s.urlIdx + k) % s.urls.length;
      try {
        const r = await fetch(rangeUrl(s.urls[idx], a, b), { credentials: 'omit', signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        s.urlIdx = idx;
        return new Uint8Array(await r.arrayBuffer());
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async function loadInit(cand) {
    const s = { urls: cand.urls, urlIdx: 0 };
    let n = 65536;
    for (let tries = 0; tries < 4; tries++) {
      const bytes = await fetchRange(s, 0, n - 1);
      const boxes = readBoxes(bytes);
      const moov = boxes.find((x) => x.type === 'moov');
      const sidx = boxes.find((x) => x.type === 'sidx');
      const ftyp = boxes.find((x) => x.type === 'ftyp');
      const complete = (x) => x && x.start + x.size <= bytes.length;
      if (complete(moov) && complete(sidx)) {
        const moovBytes = bytes.subarray(moov.start, moov.start + moov.size);
        const codec = detectCodec(moovBytes);
        if (codec.encrypted) return { encrypted: true };
        const initEnd = Math.max(moov.start + moov.size, ftyp ? ftyp.start + ftyp.size : 0);
        return {
          init: bytes.slice(0, initEnd),
          codec: codec.codec,
          segs: parseSidx(bytes, sidx),
          urlIdx: s.urlIdx,
        };
      }
      const last = boxes[boxes.length - 1];
      n = Math.max(n * 2, last ? last.start + last.size + 1024 : n * 2);
    }
    throw new Error('No encontré el índice del audio');
  }

  // ---------- MSE ----------
  const once = (t, ev) => new Promise((r) => t.addEventListener(ev, r, { once: true }));

  async function append(sb, data) {
    try {
      sb.appendBuffer(data);
    } catch (e) {
      if (e.name === 'QuotaExceededError' && src) {
        const t = src.el.currentTime;
        await remove(sb, 0, Math.max(0, t - 5));
        sb.appendBuffer(data);
      } else throw e;
    }
    await once(sb, 'updateend');
  }

  async function remove(sb, a, b) {
    if (b <= a) return;
    if (sb.updating) await once(sb, 'updateend');
    sb.remove(a, b);
    await once(sb, 'updateend');
  }

  function teardown() {
    if (!src) return;
    try {
      src.el.pause();
      src.el.removeAttribute('src');
      src.el.load();
      src.el.remove();
      URL.revokeObjectURL(src.objectUrl);
    } catch {}
    src = null;
  }

  async function load(movieId) {
    loadingFor = movieId;
    teardown();
    setStatus('Preparando el audio…');
    try {
      const r = adapter().getAudioStreams(lang, movieId);
      if (r.error) {
        failedFor = movieId;
        const msg = {
          noManifest: 'Recarga la página (F5) para que la extensión vea los idiomas de este título',
          noTrack: `Este título no tiene audio en ${langName(lang)}`,
          noUrls: `Netflix no entregó el audio en ${langName(lang)} para este título`,
        }[r.error];
        return setStatus(msg);
      }
      log('Opciones de audio:', r.streams.map((s) => `${s.bitrate}kbps ${s.profile} drm=${s.drm} (${s.urls.length} enlaces)`).join(' | '));
      const cands = [...r.streams].sort((x, y) => x.drm - y.drm || y.bitrate - x.bitrate);
      let chosen = null;
      for (const c of cands) {
        try {
          const info = await loadInit(c);
          if (info.encrypted) continue;
          const mime = `audio/mp4; codecs="${info.codec}"`;
          if (!MediaSource.isTypeSupported(mime)) continue;
          chosen = { ...info, mime, urls: c.urls, bitrate: c.bitrate };
          break;
        } catch (e) {
          log('Opción descartada:', e?.message || e);
        }
      }
      if (!chosen) {
        failedFor = movieId;
        return setStatus(`El audio en ${langName(lang)} viene protegido o en un formato no compatible`);
      }
      if (loadingFor !== movieId || !active) return;

      const el = document.createElement('audio');
      el.id = EL_ID;
      el.muted = true; // content.js lo desmutea solo cuando ya está enviado a los audífonos
      el.preload = 'auto';
      el.style.display = 'none';
      document.documentElement.appendChild(el);
      const ms = new MediaSource();
      const objectUrl = URL.createObjectURL(ms);
      el.src = objectUrl;
      await once(ms, 'sourceopen');
      const sb = ms.addSourceBuffer(chosen.mime);
      const last = chosen.segs[chosen.segs.length - 1];
      if (last) ms.duration = last.t1;
      await append(sb, chosen.init);
      src = { movieId, el, ms, sb, objectUrl, segs: chosen.segs, urls: chosen.urls, urlIdx: chosen.urlIdx };
      log(`Audio listo: ${langName(lang)}, ${chosen.codec}, ${chosen.bitrate} kbps, ${chosen.segs.length} pedazos.`);
    } catch (e) {
      failedFor = movieId;
      log('Error preparando el audio:', e);
      setStatus('No se pudo preparar el audio. Recarga la página (F5) y vuelve a intentarlo');
    } finally {
      if (loadingFor === movieId) loadingFor = null;
    }
  }

  const covered = (el, t, ahead = 0.3) => {
    const b = el.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.05 && b.end(i) >= t + ahead) return true;
    return false;
  };

  // Descarga lo que falte alrededor del tiempo t.
  async function pump(t) {
    if (!src || pumping) return;
    pumping = true;
    const s = src;
    try {
      const { el, sb, segs } = s;
      if (sb.updating) return;
      // Salto grande (adelantar/retroceder): limpiar lo descargado.
      if (el.buffered.length && !covered(el, t, 0)) {
        const end = el.buffered.end(el.buffered.length - 1);
        if (t < el.buffered.start(0) - 1 || t > end + 1) await remove(sb, 0, s.ms.duration || end + 1);
      }
      // Liberar lo ya escuchado.
      if (el.buffered.length && el.buffered.start(0) < t - 60) await remove(sb, 0, t - 30);
      for (const seg of segs) {
        if (seg.t1 <= t) continue;
        if (seg.t0 > t + AHEAD) break;
        if (covered(el, (seg.t0 + seg.t1) / 2, 0)) continue;
        const data = await fetchRange(s, seg.a, seg.b);
        if (src !== s) return;
        await append(sb, data);
        break; // un pedazo por vuelta
      }
    } catch (e) {
      log('Error descargando audio:', e?.message || e);
    } finally {
      pumping = false;
    }
  }

  // ---------- sincronización ----------
  function tick() {
    if (!active) return;
    const a = adapter();
    if (!a.isReady()) {
      if (src) src.el.pause();
      return setStatus('Esperando a que reproduzcas algo…');
    }
    const st = a.getState();
    if (!st) return;
    if (!src || src.movieId !== st.videoId) {
      if (loadingFor !== st.videoId && failedFor !== st.videoId) load(st.videoId);
      if (failedFor === st.videoId) return;
      return;
    }
    const el = src.el;
    const t = st.time + offsetMs / 1000;
    pump(t);

    if (hold) {
      el.pause();
      return setStatus('Esperando a que conectes los audífonos…');
    }
    if (st.paused) {
      el.pause();
      if (covered(el, t, 0) && Math.abs(el.currentTime - t) > 0.25) el.currentTime = t;
      return setStatus('Sincronizado');
    }
    if (!covered(el, t)) {
      el.pause();
      return setStatus('Cargando audio…');
    }
    const drift = el.currentTime - t;
    if (Math.abs(drift) > 0.5) {
      el.currentTime = t + 0.05;
    } else {
      const corr = Math.max(-0.08, Math.min(0.08, -drift * 0.8));
      el.playbackRate = Math.abs(drift) < 0.03 ? st.rate : st.rate * (1 + corr);
    }
    if (el.paused) {
      el.play().catch(() => setStatus('Haz clic una vez sobre la película para activar el audio'));
    }
    setStatus('Sincronizado', drift);
  }

  setInterval(tick, 250);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'content') return;
    const m = e.data;
    switch (m.type) {
      case 'inlineStart':
        if (typeof m.offsetMs === 'number') offsetMs = m.offsetMs;
        if (!active || lang !== m.lang) {
          active = true;
          lang = m.lang;
          failedFor = null;
          loadingFor = null;
          teardown();
          lastStatus = '';
        }
        break;
      case 'inlineStop':
        active = false;
        teardown();
        break;
      case 'inlineHold':
        hold = !!m.hold;
        if (hold && src) src.el.pause();
        break;
      case 'inlineConfig':
        if (typeof m.offsetMs === 'number') offsetMs = m.offsetMs;
        break;
    }
  });
})();
