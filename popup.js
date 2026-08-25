/*
 * Fixate — popup controller.
 *
 * Reads state from the active tab's content script, renders the controls,
 * and sends changes back. Debounces storage writes for slider drags.
 */

(function () {
  'use strict';

  const el = {
    popup: document.querySelector('.popup'),
    modeSeg: document.getElementById('mode-seg'),
    modeHint: document.getElementById('mode-hint'),
    fixateEnabled: document.getElementById('fixate-enabled'),
    fixateStatus: document.getElementById('fixate-status'),
    intensity: document.getElementById('intensity'),
    intensityValue: document.getElementById('intensity-value'),
    preview: document.getElementById('preview'),
    themeSeg: document.getElementById('theme-seg'),
    fontScale: document.getElementById('font-scale'),
    fontValue: document.getElementById('font-value'),
    fontDec: document.getElementById('font-dec'),
    fontInc: document.getElementById('font-inc'),
    keepFiguresLight: document.getElementById('keep-figures-light'),
    neverThisSite: document.getElementById('never-this-site'),
    siteHost: document.getElementById('site-host'),
    siteHint: document.getElementById('site-hint')
  };

  const PREVIEW_TEXT = el.preview.textContent.trim();
  el.preview.dataset.text = PREVIEW_TEXT;

  const MODE_HINTS = {
    off:     'Pick a mode to start.',
    fixate:  'Bold the first part of each word, in place. Lightweight.',
    restyle: 'Repaint the page warmly in place. Keeps the page\u2019s structure.',
    reader:  'Extract the article and rebuild it in a clean column.'
  };

  function siteHintText(state) {
    if (state.neverThisSite) return 'Disabled on this site. Toggle off to re-enable.';
    if (state.mode === 'off') return 'Extension is OFF. Switch to Fixate, Restyle, or Reader above to apply here.';
    return 'When the extension is ON, it applies on every site. Toggle on to exclude this one.';
  }

  let tabId = null;
  let st = null;
  let saveTimer = null;

  function send(msg) {
    return new Promise((resolve) => {
      if (tabId == null) return resolve(null);
      try {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
          if (chrome.runtime && chrome.runtime.lastError) return resolve(null);
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function scheduleSave(patch) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.sync.set(patch), 60);
  }

  function clampScale(v) {
    return Math.min(1.6, Math.max(0.8, Math.round(v * 20) / 20));
  }

  function fixateify(text, intensity) {
    return text.split(/(\s+)/).map((token) => {
      if (token.length === 0 || /^\s+$/.test(token)) return token;
      if (token.length === 1) return '<b>' + token + '</b>';
      const n = Math.max(1, Math.round(token.length * intensity));
      return '<b>' + token.slice(0, n) + '</b>' + token.slice(n);
    }).join('');
  }

  function setActive(container, attr, value) {
    container.querySelectorAll('.seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset[attr] === value);
    });
  }

  function renderPreview() {
    const intensity = (Number(el.intensity.value) || 40) / 100;
    el.preview.innerHTML = fixateify(el.preview.dataset.text, intensity);
  }

  function render() {
    if (!st) {
      el.popup.classList.add('unavailable');
      return;
    }
    el.popup.classList.remove('unavailable');

    setActive(el.modeSeg, 'mode', st.mode || 'off');
    el.modeHint.textContent = MODE_HINTS[st.mode] || MODE_HINTS.off;

    el.fixateEnabled.checked = !!st.fixateEnabled;
    el.fixateStatus.textContent = st.fixateEnabled ? 'On' : 'Off';
    el.intensity.value = String(st.fixateIntensity);
    el.intensityValue.textContent = st.fixateIntensity + '%';
    el.intensity.disabled = !st.fixateEnabled;
    renderPreview();

    setActive(el.themeSeg, 'theme', st.theme);
    const scale = Number(st.fontScale) || 1;
    el.fontScale.value = String(scale);
    el.fontValue.textContent = Math.round(scale * 100) + '%';
    el.keepFiguresLight.checked = !!st.keepFiguresLight;

    el.siteHost.textContent = st.host || 'this site';
    el.neverThisSite.checked = !!st.neverThisSite;
    el.siteHint.textContent = siteHintText(st);

    const isHeavy = st.mode === 'restyle' || st.mode === 'reader';
    el.fontScale.disabled = !isHeavy;
    el.fontDec.disabled = !isHeavy;
    el.fontInc.disabled = !isHeavy;
    el.keepFiguresLight.disabled = !isHeavy;
  }

  /* ----- interactions ----- */

  el.modeSeg.addEventListener('click', async (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (st && st.mode === mode) return;
    const resp = await send({ type: 'setMode', mode });
    if (resp) { st = await send({ type: 'getState' }); render(); }
  });

  el.fixateEnabled.addEventListener('change', () => {
    el.fixateStatus.textContent = el.fixateEnabled.checked ? 'On' : 'Off';
    el.intensity.disabled = !el.fixateEnabled.checked;
    send({ type: 'setFixateEnabled', value: el.fixateEnabled.checked });
    scheduleSave({ fixateEnabled: el.fixateEnabled.checked });
  });

  el.intensity.addEventListener('input', () => {
    const v = Number(el.intensity.value);
    el.intensityValue.textContent = v + '%';
    renderPreview();
    send({ type: 'setFixateIntensity', value: v });
    scheduleSave({ fixateIntensity: v });
  });

  el.themeSeg.addEventListener('click', async (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    send({ type: 'setTheme', theme: btn.dataset.theme });
    scheduleSave({ theme: btn.dataset.theme });
    if (st) { st.theme = btn.dataset.theme; render(); }
  });

  async function applyFont(value) {
    const scale = clampScale(value);
    el.fontScale.value = String(scale);
    el.fontValue.textContent = Math.round(scale * 100) + '%';
    send({ type: 'setFontScale', value: scale });
    scheduleSave({ fontScale: scale });
  }

  el.fontScale.addEventListener('input', () => applyFont(parseFloat(el.fontScale.value)));
  el.fontInc.addEventListener('click', () => applyFont(parseFloat(el.fontScale.value) + 0.05));
  el.fontDec.addEventListener('click', () => applyFont(parseFloat(el.fontScale.value) - 0.05));

  el.keepFiguresLight.addEventListener('change', () => {
    send({ type: 'setKeepFiguresLight', value: el.keepFiguresLight.checked });
    scheduleSave({ keepFiguresLight: el.keepFiguresLight.checked });
  });

  el.neverThisSite.addEventListener('change', () => {
    const value = el.neverThisSite.checked ? 'never' : 'default';
    send({ type: 'setSiteOverride', value });
    if (st) {
      st.neverThisSite = el.neverThisSite.checked;
      st.siteOverride = value;
      render();
    }
  });

  /* ----- init ----- */

  chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
    if (!tab || tab.id == null ||
        /^(chrome|edge|about|chrome-extension|brave|view-source|devtools|moz-extension):/.test(tab.url || '')) {
      render();
      return;
    }
    tabId = tab.id;
    st = await send({ type: 'getState' });
    if (!st) {
      // Content script may not have loaded yet on a slow page — give it a
      // moment and try once more before declaring this page unavailable.
      await new Promise((r) => setTimeout(r, 250));
      st = await send({ type: 'getState' });
    }
    render();
  });
})();
