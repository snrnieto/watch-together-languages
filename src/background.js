// Coordinador. Una "sesión" une una pestaña principal (la que se ve) con una pestaña
// secundaria oculta en una ventana minimizada (la que suena por los audífonos).

const STATUS = {
  starting: 'Abriendo el segundo idioma…',
  synced: 'Sincronizado',
  noDevice: 'Esperando a que conectes los audífonos…',
  deviceLost: 'Audífonos desconectados: segundo idioma apagado',
  needClick: 'Chrome bloqueó el audio: haz clic en Play en la ventana «Watch Together Languages»',
  noVideo: 'Esperando a que reproduzcas algo…',
};

// ---------- estado persistente (el service worker puede dormirse) ----------
let st = { sessions: {}, secondaryOf: {}, optedOut: {} };
const loaded = chrome.storage.session.get('st').then((r) => {
  if (r.st) st = r.st;
  for (const s of Object.values(st.sessions)) s.opening = false;
});
const save = () => chrome.storage.session.set({ st });

let creating = Promise.resolve();
const closingByUs = new Set();
const noVideoSince = {};

const langName = (code) => {
  try {
    return new Intl.DisplayNames(['es'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
};

const tell = (tabId, msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => {});

function setStatus(s, status) {
  if (s.status !== status) {
    s.status = status;
    save();
  }
}

async function closeSecondary(s) {
  if (!s.secondaryTabId) return;
  const tabId = s.secondaryTabId;
  closingByUs.add(tabId);
  delete st.secondaryOf[tabId];
  s.secondaryTabId = null;
  s.videoId = null;
  s.ready = false;
  const winId = s.secondaryWindowId;
  s.secondaryWindowId = null;
  await save();
  if (winId) await chrome.windows.remove(winId).catch(() => {});
  else await chrome.tabs.remove(tabId).catch(() => {});
}

async function openSecondary(primaryTabId, s, state) {
  s.opening = true;
  s.videoId = state.videoId;
  s.ready = false;
  setStatus(s, STATUS.starting);
  const primaryTab = await chrome.tabs.get(primaryTabId).catch(() => null);
  creating = (async () => {
    const win = await chrome.windows.create({
      url: state.url,
      type: 'popup',
      focused: false,
      width: 420,
      height: 280,
      left: 0,
      top: 0,
    });
    const tabId = win.tabs[0].id;
    s.secondaryTabId = tabId;
    s.secondaryWindowId = win.id;
    st.secondaryOf[tabId] = primaryTabId;
    await save();
    if (primaryTab) chrome.windows.update(primaryTab.windowId, { focused: true }).catch(() => {});
  })().catch(() => {});
  await creating;
  s.opening = false;
  await save();
}

// Netflix: el segundo idioma suena en la MISMA pestaña ("inline").
// Otras plataformas (YouTube): pestaña secundaria en una ventana minimizada ("tab").
const roleMsg = (s) => (s.mode === 'inline' ? { type: 'role', role: 'inline', lang: s.lang } : { type: 'role', role: 'primary' });

async function startSession(tabId, lang, auto, platform) {
  if (auto && st.optedOut[tabId]) return;
  const mode = platform === 'netflix' ? 'inline' : 'tab';
  const existing = st.sessions[tabId];
  if (existing) {
    if (existing.lang !== lang) {
      existing.lang = lang;
      await closeSecondary(existing); // se vuelve a abrir con el nuevo idioma
    }
    existing.mode = mode;
  } else {
    st.sessions[tabId] = { mode, lang, status: mode === 'inline' ? 'Preparando el audio…' : STATUS.noVideo, secondaryTabId: null, secondaryWindowId: null, videoId: null };
  }
  delete st.optedOut[tabId];
  await save();
  tell(tabId, roleMsg(st.sessions[tabId]));
}

async function stopSession(tabId, byUser) {
  const s = st.sessions[tabId];
  if (s) await closeSecondary(s);
  delete st.sessions[tabId];
  if (byUser) st.optedOut[tabId] = true;
  await save();
  tell(tabId, { type: 'role', role: 'none' });
}

async function onPrimaryState(tabId, state) {
  const s = st.sessions[tabId];
  if (!s) return tell(tabId, { type: 'role', role: 'none' });
  if (s.mode === 'inline') return;
  if (s.opening) return;

  if (!state.deviceAvailable) {
    if (s.secondaryTabId) await closeSecondary(s);
    return setStatus(s, STATUS.noDevice);
  }

  if (!state.videoId) {
    // Sin video (menú, entre episodios…): pausar y, si dura, cerrar la secundaria.
    noVideoSince[tabId] = noVideoSince[tabId] || Date.now();
    if (s.secondaryTabId) {
      tell(s.secondaryTabId, { type: 'sync', state: { ...state, paused: true } });
      if (Date.now() - noVideoSince[tabId] > 8000) await closeSecondary(s);
    }
    if (!s.secondaryTabId) setStatus(s, STATUS.noVideo);
    return;
  }
  delete noVideoSince[tabId];

  if (s.trackMissing === state.videoId) return; // ya sabemos que este título no tiene el idioma
  if (!s.secondaryTabId) return openSecondary(tabId, s, state);

  if (s.videoId !== state.videoId) {
    // Cambió el episodio o el video: la secundaria lo sigue.
    s.videoId = state.videoId;
    s.ready = false;
    setStatus(s, STATUS.starting);
    await save();
    return chrome.tabs.update(s.secondaryTabId, { url: state.url }).catch(() => {});
  }

  tell(s.secondaryTabId, { type: 'sync', state });
}

async function onSecondaryStatus(secTabId, m) {
  const primaryTabId = st.secondaryOf[secTabId];
  const s = primaryTabId != null && st.sessions[primaryTabId];
  if (!s) return;

  if (m.deviceLost) {
    await closeSecondary(s);
    return setStatus(s, STATUS.deviceLost);
  }
  if (m.trackMissing) {
    s.status = `Este título no tiene audio en ${langName(s.lang)}`;
    s.trackMissing = s.videoId;
    await closeSecondary(s);
    return;
  }
  if (m.stuck) {
    if (!s.needClick) {
      s.needClick = true;
      setStatus(s, STATUS.needClick);
      if (s.secondaryWindowId) chrome.windows.update(s.secondaryWindowId, { state: 'normal', focused: true }).catch(() => {});
    }
    return;
  }
  if (typeof m.drift === 'number') s.drift = m.drift;
  const hide = () => {
    // Ya suena por los audífonos: esconder la ventana y devolver el foco a la película.
    if (s.secondaryWindowId) chrome.windows.update(s.secondaryWindowId, { state: 'minimized' }).catch(() => {});
    chrome.tabs.get(primaryTabId).then((t) => chrome.windows.update(t.windowId, { focused: true })).catch(() => {});
  };
  if (s.needClick && m.stuck === false) {
    s.needClick = false;
    hide();
  }
  if (m.ready && !s.ready) {
    s.ready = true;
    hide();
  }
  if (s.ready) setStatus(s, STATUS.synced);
  save();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await loaded;
    const tabId = msg.tabId ?? sender.tab?.id;
    switch (msg.type) {
      case 'hello': {
        await creating;
        const primaryTabId = st.secondaryOf[tabId];
        if (primaryTabId != null && st.sessions[primaryTabId]) {
          return sendResponse({ role: 'secondary', lang: st.sessions[primaryTabId].lang });
        }
        if (st.sessions[tabId]) {
          const { role, lang } = roleMsg(st.sessions[tabId]);
          return sendResponse({ role, lang });
        }
        return sendResponse({ role: 'none' });
      }
      case 'start': {
        const s = st.sessions[tabId];
        // Modo automático: no insistir con un título que no tiene ese idioma.
        if (msg.auto && s?.trackMissing) return sendResponse({ ok: false });
        await startSession(tabId, msg.lang, !!msg.auto, msg.platform);
        return sendResponse({ ok: true });
      }
      case 'inlineStatus': {
        const s = st.sessions[tabId];
        if (s?.mode === 'inline') {
          if (typeof msg.drift === 'number') s.drift = msg.drift;
          setStatus(s, msg.status);
          save();
        }
        return sendResponse({});
      }
      case 'stop':
        await stopSession(tabId, true);
        return sendResponse({ ok: true });
      case 'primaryState':
        await onPrimaryState(tabId, msg.state);
        return sendResponse({});
      case 'secondaryStatus':
        await onSecondaryStatus(tabId, msg);
        return sendResponse({});
      case 'getStatus': {
        const s = st.sessions[tabId];
        return sendResponse(s ? { active: true, status: s.status, drift: s.drift, lang: s.lang } : { active: false });
      }
    }
    sendResponse({});
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loaded;
  if (st.sessions[tabId]) {
    // Se cerró la principal: cerrar también la secundaria.
    await closeSecondary(st.sessions[tabId]);
    delete st.sessions[tabId];
  }
  delete st.optedOut[tabId];
  const primaryTabId = st.secondaryOf[tabId];
  if (primaryTabId != null) {
    delete st.secondaryOf[tabId];
    const s = st.sessions[primaryTabId];
    if (s && !closingByUs.has(tabId)) {
      // El usuario cerró la ventana del segundo idioma: lo tomamos como "apagar".
      delete st.sessions[primaryTabId];
      st.optedOut[primaryTabId] = true;
      tell(primaryTabId, { type: 'role', role: 'none' });
    }
  }
  closingByUs.delete(tabId);
  save();
});
