// Content script (mundo aislado). Hace de puente entre la página, el service worker y el popup,
// y se encarga de los dispositivos de audio: elegir por dónde suena cada pestaña y,
// en la pestaña secundaria, garantizar que NUNCA suene por el parlante.
(() => {
  if (window.top !== window) return;

  const TAG = '__audioDual';
  const DEFAULTS = {
    lang: 'en',
    primaryDeviceLabel: '',
    secondaryDeviceLabel: '',
    volume: 1,
    offsetMs: 0,
    auto: false,
  };

  let role = 'none';
  let settings = { ...DEFAULTS };
  let sessionLang = null; // idioma pedido para esta sesión (secundaria)
  let outputs = []; // [{id, label}] en el origen de esta página
  let defaultLabel = '';

  // ---------- mensajes con la página ----------
  let reqSeq = 0;
  const pending = new Map();
  const toPage = (msg) => window.postMessage({ [TAG]: 'content', ...msg }, location.origin);
  const askPage = (type, extra = {}, timeout = 1500) =>
    new Promise((resolve) => {
      const reqId = ++reqSeq;
      pending.set(reqId, resolve);
      toPage({ type, reqId, ...extra });
      setTimeout(() => {
        if (pending.delete(reqId)) resolve(null);
      }, timeout);
    });

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

  let lastDriftSent = 0;
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'page') return;
    const m = e.data;
    if (m.type === 'reply') {
      const r = pending.get(m.reqId);
      if (r) {
        pending.delete(m.reqId);
        r(m.data);
      }
    } else if (m.type === 'state' && role === 'primary') {
      m.state.deviceAvailable = !!resolveDevice(settings.secondaryDeviceLabel);
      send({ type: 'primaryState', state: m.state });
    } else if (m.type === 'inlineStatus' && role === 'inline') {
      send({ type: 'inlineStatus', status: m.status, drift: m.drift });
    } else if (m.type === 'drift' && role === 'secondary') {
      const now = Date.now();
      if (m.stuck || now - lastDriftSent > 1500) {
        lastDriftSent = now;
        send({ type: 'secondaryStatus', drift: m.drift, stuck: m.stuck, ready: unlockedAll() });
      }
    }
  });

  // ---------- dispositivos ----------
  async function refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const outs = all.filter((d) => d.kind === 'audiooutput');
      const def = outs.find((d) => d.deviceId === 'default');
      defaultLabel = def?.label || '';
      outputs = outs
        .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label)
        .map((d) => ({ id: d.deviceId, label: d.label }));
      return { hasLabels: outs.some((d) => d.label), outputs, defaultLabel };
    } catch {
      outputs = [];
      return { hasLabels: false, outputs: [], defaultLabel: '' };
    }
  }

  const resolveDevice = (label) => (label ? outputs.find((o) => o.label === label)?.id || null : null);

  async function requestPermission() {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop()); // no se graba nada: solo se pide para ver los nombres
    return refreshDevices();
  }

  // ---------- control de salida de audio de los <video> ----------
  // En la secundaria cada video queda muteado hasta que:
  //   1) está enviado a los audífonos (setSinkId terminó bien) y
  //   2) la pista de audio ya es la del idioma elegido.
  let trackOk = false;
  let deviceLost = false;
  const sinkBusy = new WeakSet();

  const videos = () => [...document.querySelectorAll('video')];

  function unlockedAll() {
    const target = resolveDevice(settings.secondaryDeviceLabel);
    const vs = videos();
    return !!target && trackOk && !deviceLost && vs.length > 0 && vs.every((v) => v.sinkId === target);
  }

  function enforceSecondary() {
    const target = resolveDevice(settings.secondaryDeviceLabel);
    for (const v of videos()) {
      const allowed = !!target && trackOk && !deviceLost && v.sinkId === target;
      if (!allowed) {
        if (!v.muted) v.muted = true;
        if (target && !deviceLost && v.sinkId !== target && !sinkBusy.has(v)) {
          sinkBusy.add(v);
          v.setSinkId(target)
            .catch(() => {})
            .finally(() => {
              sinkBusy.delete(v);
              enforceSecondary();
            });
        }
      } else {
        if (v.muted) v.muted = false;
        if (Math.abs(v.volume - settings.volume) > 0.01) v.volume = settings.volume;
      }
    }
  }

  function enforcePrimary() {
    const target = settings.primaryDeviceLabel ? resolveDevice(settings.primaryDeviceLabel) : '';
    const sink = target || ''; // '' = predeterminado de Windows
    for (const v of videos()) {
      if (v.sinkId !== sink && !sinkBusy.has(v)) {
        sinkBusy.add(v);
        v.setSinkId(sink)
          .catch(() => {})
          .finally(() => sinkBusy.delete(v));
      }
    }
  }

  // Modo "misma pestaña": el segundo idioma suena en un <audio id="__audio-dual"> creado por inline-player.js.
  // Queda muteado hasta que esté enviado a los audífonos; si los audífonos no están, se pausa.
  let lastHold = null;
  function enforceInline() {
    const target = resolveDevice(settings.secondaryDeviceLabel);
    const hold = !target;
    if (hold !== lastHold) {
      lastHold = hold;
      toPage({ type: 'inlineHold', hold });
    }
    const el = document.getElementById('__audio-dual');
    if (!el) return;
    if (hold) {
      if (!el.muted) el.muted = true;
      return;
    }
    if (el.sinkId !== target) {
      if (!el.muted) el.muted = true;
      if (!sinkBusy.has(el)) {
        sinkBusy.add(el);
        el.setSinkId(target)
          .catch(() => {})
          .finally(() => {
            sinkBusy.delete(el);
            enforceInline();
          });
      }
      return;
    }
    if (el.muted) el.muted = false;
    if (Math.abs(el.volume - settings.volume) > 0.01) el.volume = settings.volume;
  }

  function enforce() {
    if (role === 'secondary') enforceSecondary();
    else if (role === 'primary') enforcePrimary();
    else if (role === 'inline') {
      enforcePrimary();
      enforceInline();
    }
  }

  // Reaccionar al instante a cualquier intento de sonar o cambiar el volumen.
  for (const ev of ['play', 'playing', 'volumechange', 'loadedmetadata']) {
    document.addEventListener(
      ev,
      () => {
        if (role === 'secondary') enforceSecondary();
        else if (role === 'inline') enforceInline();
      },
      true
    );
  }

  navigator.mediaDevices?.addEventListener('devicechange', async () => {
    await refreshDevices();
    if (role === 'secondary') {
      const present = !!resolveDevice(settings.secondaryDeviceLabel);
      if (!present) {
        // Audífonos desconectados: silenciar YA, para que el segundo idioma no salga por el parlante.
        deviceLost = true;
        enforceSecondary();
        toPage({ type: 'pause' });
        send({ type: 'secondaryStatus', deviceLost: true });
      }
    }
    enforce();
  });

  // ---------- roles ----------
  function setRole(newRole, lang) {
    const prev = role;
    role = newRole;
    if (lang) sessionLang = lang;
    toPage({ type: 'role', role });
    if (role === 'inline') {
      lastHold = null;
      toPage({ type: 'inlineStart', lang: sessionLang || settings.lang, offsetMs: settings.offsetMs });
    } else if (prev === 'inline') {
      toPage({ type: 'inlineStop' });
    }
    enforce();
  }

  async function secondaryLoop() {
    const started = Date.now();
    let lastCheck = 0;
    while (role === 'secondary') {
      const r = await askPage('setTrack', { lang: sessionLang || settings.lang });
      if (r?.ok) {
        trackOk = true;
      } else if (r && r.reason === 'missing' && r.available && Date.now() - started > 8000) {
        send({ type: 'secondaryStatus', trackMissing: true });
      } else if (Date.now() - started > 25000 && !trackOk) {
        send({ type: 'secondaryStatus', trackMissing: true });
      }
      enforceSecondary();
      if (trackOk && Date.now() - lastCheck > 4000) {
        lastCheck = Date.now();
        send({ type: 'secondaryStatus', ready: unlockedAll() });
      }
      await new Promise((res) => setTimeout(res, trackOk ? 3000 : 700));
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'role':
        setRole(msg.role, msg.lang);
        if (msg.role === 'secondary') secondaryLoop();
        break;
      case 'sync':
        if (role === 'secondary') toPage({ type: 'sync', state: msg.state, offsetMs: settings.offsetMs });
        break;
      case 'popupInfo':
        (async () => {
          const devices = await refreshDevices();
          const info = await askPage('query');
          sendResponse({ info, devices, role });
        })();
        return true;
      case 'requestPermission':
        requestPermission()
          .then((d) => sendResponse({ ok: true, devices: d }))
          .catch((e) => sendResponse({ ok: false, error: String(e?.name || e) }));
        return true;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in DEFAULTS) settings[k] = newValue ?? DEFAULTS[k];
    }
    if (role === 'inline') toPage({ type: 'inlineConfig', offsetMs: settings.offsetMs });
    enforce();
  });

  // ---------- modo automático (pestañas sin sesión) ----------
  let lastAutoVideoId = null;
  async function autoCheck() {
    if (role !== 'none' || !settings.auto || !settings.secondaryDeviceLabel) return;
    if (!resolveDevice(settings.secondaryDeviceLabel)) return; // audífonos no conectados: todo normal
    const info = await askPage('query');
    if (!info?.ready || !info.state?.videoId || info.state.videoId === lastAutoVideoId) return;
    const base = (l) => (l || '').split('-')[0];
    const has = info.tracks.some((t) => base(t.lang) === base(settings.lang) && t.available !== false);
    const current = info.tracks.find((t) => t.id === info.currentTrackId);
    if (!has || base(current?.lang) === base(settings.lang)) return;
    lastAutoVideoId = info.state.videoId;
    send({ type: 'start', lang: settings.lang, auto: true, platform: info.platform });
  }

  // ---------- arranque ----------
  (async () => {
    settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
    await refreshDevices();
    const r = await chrome.runtime.sendMessage({ type: 'hello' }).catch(() => null);
    if (r?.role) {
      setRole(r.role, r.lang);
      if (r.role === 'secondary') secondaryLoop();
    }
    setInterval(() => {
      toPage({ type: 'role', role }); // por si page.js cargó después
      if (role === 'inline') toPage({ type: 'inlineStart', lang: sessionLang || settings.lang, offsetMs: settings.offsetMs });
      enforce();
      autoCheck();
    }, 1000);
  })();
})();
