const DEFAULTS = {
  lang: 'en',
  primaryDeviceLabel: '',
  secondaryDeviceLabel: '',
  volume: 1,
  offsetMs: 0,
  auto: false,
};
const SUPPORTED = /^https:\/\/www\.(netflix|youtube)\.com\//;

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const base = (l) => (l || '').split('-')[0];
const langName = (code) => {
  try {
    const n = new Intl.DisplayNames(['es'], { type: 'language' }).of(code);
    return n ? n[0].toUpperCase() + n.slice(1) : code;
  } catch {
    return code;
  }
};

let tab, data, settings, status;

async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (!tab || !SUPPORTED.test(tab.url || '')) return renderUnsupported();
  data = await chrome.tabs.sendMessage(tab.id, { type: 'popupInfo' }).catch(() => null);
  if (!data) return renderReload();
  if (data.role === 'secondary') return renderIsSecondary();
  status = await chrome.runtime.sendMessage({ type: 'getStatus', tabId: tab.id }).catch(() => ({ active: false }));
  render();
}

const save = (patch) => {
  Object.assign(settings, patch);
  return chrome.storage.local.set(patch);
};

function renderUnsupported() {
  app.innerHTML = `
    <p>Abre una película, serie o video en <b>Netflix</b> o <b>YouTube</b> y vuelve a abrir este menú.</p>
    <p class="muted small">Próximamente: Prime Video, Disney+ y Max.</p>`;
}

function renderReload() {
  app.innerHTML = `
    <p>Recarga la página (<b>F5</b>) y vuelve a abrir este menú.</p>
    <p class="muted small">Pasa cuando la página ya estaba abierta antes de instalar o actualizar la extensión.</p>`;
}

function renderIsSecondary() {
  app.innerHTML = `
    <p>Esta es la ventana del <b>segundo idioma</b>. No hace falta tocarla: se maneja sola desde la película.</p>
    <p class="muted small">Si Chrome bloqueó el audio, dale Play aquí una vez y la ventana se esconderá sola.</p>`;
}

function deviceOptions(selected, includeDefault) {
  const opts = data.devices.outputs.map(
    (o) => `<option value="${esc(o.label)}" ${o.label === selected ? 'selected' : ''}>${esc(o.label)}</option>`
  );
  if (includeDefault) {
    opts.unshift(`<option value="" ${!selected ? 'selected' : ''}>Salida predeterminada de Windows</option>`);
  } else if (!selected) {
    opts.unshift('<option value="" selected disabled>Elige tus audífonos…</option>');
  }
  // Dispositivo guardado pero no conectado ahora mismo.
  if (selected && !data.devices.outputs.some((o) => o.label === selected)) {
    opts.push(`<option value="${esc(selected)}" selected>${esc(selected)} (no conectado)</option>`);
  }
  return opts.join('');
}

function render() {
  const { info, devices } = data;
  const platform = document.getElementById('platform');
  if (info?.platformName) {
    platform.textContent = info.platformName;
    platform.hidden = false;
  }

  const parts = [];

  // ---- Paso 0: permiso para ver dispositivos ----
  if (!devices.hasLabels) {
    parts.push(`
      <section class="card">
        <h2>Primer paso</h2>
        <p>Para mandar cada idioma a un dispositivo distinto, la extensión necesita ver tus parlantes y audífonos.</p>
        <p class="muted small">Chrome lo muestra como <b>"usar tu micrófono"</b> porque es el único permiso que da acceso a la lista de dispositivos. <b>No se graba ni se escucha nada.</b> Elige <b>Permitir</b>; este menú se cerrará y luego lo vuelves a abrir.</p>
        <button id="perm">Permitir ver mis dispositivos de audio</button>
      </section>`);
    app.innerHTML = parts.join('');
    document.getElementById('perm').onclick = requestPermission;
    return;
  }

  // ---- Estado actual ----
  if (status?.active) {
    const synced = status.status === 'Sincronizado';
    const drift = synced && typeof status.drift === 'number' ? ` <span class="muted small">(±${Math.abs(status.drift).toFixed(2)} s)</span>` : '';
    parts.push(`
      <section class="card">
        <div class="status"><span class="dot ${synced ? 'on' : ''}"></span><span>${esc(status.status)}</span>${drift}</div>
        <p class="muted small">${esc(langName(status.lang))} por: ${esc(settings.secondaryDeviceLabel)}</p>
      </section>`);
  }

  // ---- Idiomas del título abierto ----
  let langOk = false;
  if (!info?.ready) {
    parts.push(`
      <section class="card">
        <p>Abre la película, serie o video y dale <b>play</b>.</p>
        <p class="muted small">La extensión necesita el título abierto para saber en qué idiomas está disponible.</p>
      </section>`);
  } else {
    const current = info.tracks.find((t) => t.id === info.currentTrackId);
    const seen = new Set();
    const others = info.tracks.filter((t) => {
      if (t.assistive || t.available === false || base(t.lang) === base(current?.lang)) return false;
      if (seen.has(base(t.lang))) return false;
      seen.add(base(t.lang));
      return true;
    });
    const selectedLang = status?.active ? status.lang : settings.lang;
    if (!others.length) {
      parts.push(`
        <section class="card">
          ${
            info.mode === 'inline' && info.tracks.length > 1
              ? '<p>Netflix no entregó el audio de otros idiomas para este título. Si acabas de instalar o actualizar la extensión, recarga la página (<b>F5</b>).</p>'
              : `<p>Este título solo tiene audio en <b>${esc(current ? langName(current.lang) : 'un idioma')}</b>, así que no hay un segundo idioma para tus audífonos.</p>`
          }
          ${info.platform === 'youtube' ? '<p class="muted small">En YouTube solo funciona con videos que tengan varias pistas de audio (doblaje).</p>' : ''}
        </section>`);
    } else {
      langOk = true;
      parts.push(`
        <section class="card">
          <h2>Idiomas</h2>
          <p class="small">Esta pestaña suena en <b>${esc(current ? langName(current.lang) : '—')}</b>.</p>
          <label class="field">
            <span>Idioma para los audífonos</span>
            <select id="lang">
              ${others
                .map((t) => `<option value="${esc(t.lang)}" ${base(t.lang) === base(selectedLang) ? 'selected' : ''}>${esc(langName(t.lang))}</option>`)
                .join('')}
            </select>
          </label>
        </section>`);
    }
  }

  // ---- Dispositivos ----
  const warn = [];
  const sec = settings.secondaryDeviceLabel;
  const pri = settings.primaryDeviceLabel;
  if (sec && pri && sec === pri) {
    warn.push('Elegiste el mismo dispositivo para los dos idiomas: sonarían mezclados.');
  } else if (sec && !pri && devices.defaultLabel.endsWith(sec)) {
    warn.push(`Tus audífonos son ahora la salida predeterminada de Windows, así que la película también sonaría en ellos. En <b>"La película sale por"</b> elige tu parlante.`);
  }
  if (sec && !devices.outputs.some((o) => o.label === sec)) {
    warn.push('Tus audífonos no están conectados. Cuando los conectes, el segundo idioma arranca solo.');
  }
  parts.push(`
    <section class="card">
      <h2>Salidas de audio</h2>
      <label class="field">
        <span>La película sale por</span>
        <select id="priDev">${deviceOptions(pri, true)}</select>
      </label>
      <label class="field">
        <span>El segundo idioma sale por</span>
        <select id="secDev">${deviceOptions(sec, false)}</select>
      </label>
      ${warn.map((w) => `<div class="warn">${w}</div>`).join('')}
    </section>`);

  // ---- Botón principal ----
  if (status?.active) {
    parts.push('<button id="toggle" class="secondary">Apagar audio dual</button>');
  } else {
    const can = langOk && !!sec;
    parts.push(`<button id="toggle" ${can ? '' : 'disabled'}>Activar audio dual</button>`);
  }

  // ---- Ajustes ----
  parts.push(`
    <section class="card">
      <h2>Ajustes</h2>
      <label class="field">
        <span class="row">Volumen de los audífonos <span class="muted" id="volV">${Math.round(settings.volume * 100)}%</span></span>
        <input type="range" id="vol" min="0" max="1" step="0.05" value="${settings.volume}">
      </label>
      <label class="field">
        <span class="row">Adelantar audífonos <span class="muted" id="offV">${settings.offsetMs} ms</span></span>
        <input type="range" id="off" min="0" max="400" step="10" value="${settings.offsetMs}">
      </label>
      <p class="muted small">Útil con audífonos Bluetooth, que suenan unos 0,2 s tarde: súbelo hasta que la voz coincida con los labios.</p>
    </section>`);

  // ---- Modo automático ----
  parts.push(`
    <section class="card">
      <label class="check">
        <input type="checkbox" id="auto" ${settings.auto ? 'checked' : ''}>
        <span><b>Activar automáticamente</b><br><span class="muted small">Cada vez que pongas algo, el segundo idioma arranca solo si tus audífonos están conectados.</span></span>
      </label>
      <details>
        <summary>¿Cómo funciona con los audífonos?</summary>
        <ul>
          <li><b>No necesitas tener los audífonos siempre conectados.</b> Si no lo están, todo suena normal, solo por el parlante.</li>
          <li><b>Si los conectas a mitad del capítulo</b>, el segundo idioma arranca solo y ya sincronizado.</li>
          <li><b>Si se desconectan</b> (se apagan o se quedan sin batería), el segundo idioma se apaga al instante. Así nunca vas a oír los dos idiomas mezclados por el parlante.</li>
          ${
            info?.mode === 'inline'
              ? '<li>Todo pasa en esta misma pestaña: no se abre nada más y no usa otra pantalla de tu plan.</li>'
              : '<li>El segundo idioma se reproduce en una ventana pequeña que se minimiza sola. No la cierres: si la cierras, el audio dual se apaga.</li>'
          }
        </ul>
      </details>
    </section>`);

  app.innerHTML = parts.join('');
  bind();
}

function bind() {
  const $ = (id) => document.getElementById(id);
  $('lang')?.addEventListener('change', async (e) => {
    await save({ lang: e.target.value });
    if (status?.active) await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, lang: e.target.value, platform: data.info?.platform });
    refresh();
  });
  $('priDev').onchange = (e) => save({ primaryDeviceLabel: e.target.value }).then(refresh);
  $('secDev').onchange = (e) => save({ secondaryDeviceLabel: e.target.value }).then(refresh);
  $('vol').oninput = (e) => {
    $('volV').textContent = `${Math.round(e.target.value * 100)}%`;
    save({ volume: Number(e.target.value) });
  };
  $('off').oninput = (e) => {
    $('offV').textContent = `${e.target.value} ms`;
    save({ offsetMs: Number(e.target.value) });
  };
  $('auto').onchange = (e) => save({ auto: e.target.checked });
  $('toggle').onclick = async () => {
    if (status?.active) {
      await chrome.runtime.sendMessage({ type: 'stop', tabId: tab.id });
    } else {
      const lang = $('lang')?.value || settings.lang;
      await save({ lang });
      await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, lang, platform: data.info?.platform });
    }
    refresh();
  };
}

async function requestPermission() {
  const btn = document.getElementById('perm');
  btn.disabled = true;
  btn.textContent = 'Revisa el aviso de Chrome en la página…';
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'requestPermission' }).catch(() => null);
  if (!r?.ok) {
    btn.disabled = false;
    btn.textContent = 'Intentar de nuevo';
    app.insertAdjacentHTML(
      'beforeend',
      '<div class="warn">No se dio el permiso. Si lo bloqueaste, haz clic en el candado junto a la dirección de la página, activa "Micrófono" y recarga.</div>'
    );
    return;
  }
  refresh();
}

async function refresh() {
  data = await chrome.tabs.sendMessage(tab.id, { type: 'popupInfo' }).catch(() => data);
  status = await chrome.runtime.sendMessage({ type: 'getStatus', tabId: tab.id }).catch(() => status);
  render();
}

// Mantener el estado al día mientras el menú está abierto (sin redibujar los controles).
setInterval(async () => {
  if (!tab || !data || !status) return;
  const s = await chrome.runtime.sendMessage({ type: 'getStatus', tabId: tab.id }).catch(() => null);
  if (s && (s.active !== status.active || s.status !== status.status)) {
    status = s;
    render();
  }
}, 1000);

load();
