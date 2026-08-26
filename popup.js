/*
 * Fixate — popup controller.
 *
 * Reads state from the active tab's content script, renders the controls,
 * and sends changes back. Debounces storage writes for slider drags.
 *
 * Mode shape:
 *   - mode: 'off' | 'on'
 *   - restyleEnabled, readerEnabled: independent layered reading styles
 *
 * The popup normalises any pre-2.1 mode values from a stale content script
 * (running on a tab that wasn't reloaded after the extension updated) so it
 * keeps showing the right state until the user reloads the page.
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
    restyleEnabled: document.getElementById('restyle-enabled'),
    readerEnabled: document.getElementById('reader-enabled'),
    styleHint: document.getElementById('style-hint'),
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
    off: 'Nothing is applied. Switch On to use Fixate and any reading style below.',
    on:  'Fixate is applied, plus any reading styles you have toggled on below.'
  };

  const STYLE_HINTS = {
    none:    'Both off — only the bolded prefixes run.',
    restyle: 'Restyle is repainting the page in place. Toggle Reader on to extract an article instead.',
    reader:  'Reader is extracting the article. It covers Restyle while open.'
  };

  function siteHintText(state) {
    if (state.neverThisSite) return 'Disabled on this site. Toggle off to re-enable.';
    if (state.mode === 'off') return 'Extension is OFF. Switch to On above to apply here.';
    return 'When the extension is ON, it applies on every site. Toggle on to exclude this one.';
  }

  function styleHintText(state) {
    if (state.readerEnabled) return STYLE_HINTS.reader;
    if (state.restyleEnabled) return STYLE_HINTS.restyle;
    return STYLE_HINTS.none;
  }

  function normaliseState(s) {
    if (!s || typeof s !== 'object') return s;
    // Legacy mode values from before the on/off + toggles shape (pre-2.1).
    if (s.mode === 'fixate') {
      s.mode = 'on';
      if (typeof s.restyleEnabled !== 'boolean') s.restyleEnabled = false;
      if (typeof s.readerEnabled !== 'boolean') s.readerEnabled = false;
    } else if (s.mode === 'restyle') {
      s.mode = 'on';
      s.restyleEnabled = true;
      if (typeof s.readerEnabled !== 'boolean') s.readerEnabled = false;
    } else if (s.mode === 'reader') {
      s.mode = 'on';
      if (typeof s.restyleEnabled !== 'boolean') s.restyleEnabled = false;
      s.readerEnabled = true;
    } else if (s.mode !== 'off' && s.mode !== 'on') {
      s.mode = 'off';
    }
    if (typeof s.restyleEnabled !== 'boolean') s.restyleEnabled = false;
    if (typeof s.readerEnabled !== 'boolean') s.readerEnabled = false;
    return s;
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

    const mode = st.mode === 'on' ? 'on' : 'off';
    el.popup.classList.toggle('mode-off', mode === 'off');
    setActive(el.modeSeg, 'mode', mode);
    el.modeHint.textContent = MODE_HINTS[mode] || MODE_HINTS.off;

    el.fixateEnabled.checked = !!st.fixateEnabled;
    el.fixateStatus.textContent = st.fixateEnabled ? 'On' : 'Off';
    el.intensity.value = String(st.fixateIntensity);
    el.intensityValue.textContent = st.fixateIntensity + '%';
    el.intensity.disabled = !st.fixateEnabled;
    renderPreview();

    el.restyleEnabled.checked = !!st.restyleEnabled;
    el.readerEnabled.checked = !!st.readerEnabled;
    el.styleHint.textContent = styleHintText(st);

    setActive(el.themeSeg, 'theme', st.theme);
    const scale = Number(st.fontScale) || 1;
    el.fontScale.value = String(scale);
    el.fontValue.textContent = Math.round(scale * 100) + '%';
    el.keepFiguresLight.checked = !!st.keepFiguresLight;

    const readingActive = !!st.restyleEnabled || !!st.readerEnabled;
    el.fontScale.disabled = !readingActive;
    el.fontDec.disabled = !readingActive;
    el.fontInc.disabled = !readingActive;
    el.keepFiguresLight.disabled = !readingActive;

    el.siteHost.textContent = st.host || 'this site';
    el.neverThisSite.checked = !!st.neverThisSite;
    el.siteHint.textContent = siteHintText(st);
  }

  /* ----- interactions ----- */

  el.modeSeg.addEventListener('click', async (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (st && st.mode === mode) return;
    const resp = await send({ type: 'setMode', mode });
    if (resp) { st = normaliseState(await send({ type: 'getState' })); render(); }
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

  el.restyleEnabled.addEventListener('change', () => {
    send({ type: 'setRestyleEnabled', value: el.restyleEnabled.checked });
    scheduleSave({ restyleEnabled: el.restyleEnabled.checked });
    if (st) { st.restyleEnabled = el.restyleEnabled.checked; render(); }
  });

  el.readerEnabled.addEventListener('change', () => {
    send({ type: 'setReaderEnabled', value: el.readerEnabled.checked });
    scheduleSave({ readerEnabled: el.readerEnabled.checked });
    if (st) { st.readerEnabled = el.readerEnabled.checked; render(); }
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
    st = normaliseState(await send({ type: 'getState' }));
    if (!st) {
      // Content script may not have loaded yet on a slow page — give it a
      // moment and try once more before declaring this page unavailable.
      await new Promise((r) => setTimeout(r, 250));
      st = normaliseState(await send({ type: 'getState' }));
    }
    render();
  });
})();
