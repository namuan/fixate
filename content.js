/*
 * Fixate — content script.
 *
 * One mode (off/on) with three independent layers that compose when on:
 *   - Fixate   : bold the first part of each word in place (always-on feature)
 *   - Restyle  : repaint the page with the warm earthy palette + bundled fonts,
 *                keep the page's own structure
 *   - Reader   : extract the article and rebuild it in an isolated Shadow DOM
 *                overlay using the reader theme
 *
 * Composition when mode is 'on':
 *   - Fixate runs on document.body (or on the Reader's .article-body if Reader
 *     is active), controlled by the fixateEnabled toggle + intensity slider.
 *   - If readerEnabled is true, Reader is applied. It covers the whole
 *     viewport, so Restyle is skipped underneath.
 *   - Else if restyleEnabled is true, Restyle is applied.
 *   - Else: only Fixate runs.
 *
 * Theme, fontScale, and keepFiguresLight only take effect when Restyle or
 * Reader is on.
 *
 * Reads settings from chrome.storage, listens to storage changes, and
 * responds to messages from the popup / keyboard shortcut.
 */
(function () {
  'use strict';

  if (window.__fixateLoaded) return;
  window.__fixateLoaded = true;

  const HOST_ID = 'fixate-host';
  const FONT_STYLE_ID = 'fixate-fonts';
  const RESTYLE_LINK_ID = 'fixate-restyle';

  const DEFAULTS = {
    mode: 'on',                  // 'off' | 'on'
    fixateEnabled: true,         // independent on/off for the bolded prefix
    fixateIntensity: 40,         // 20-70 (%)
    restyleEnabled: false,       // in-place repaint with warm palette + fonts
    readerEnabled: false,        // extract article, rebuild in shadow-DOM column
    theme: 'auto',               // 'auto' | 'light' | 'dark'
    fontScale: 1,                // 0.8 - 1.6
    keepFiguresLight: false,     // in dark mode, leave images un-inverted
    siteOverrides: {}            // { hostname: 'never' }
  };

  const THEME_BG = { light: '#F1E9DF', dark: '#1a1714' };

  const state = {
    mode: 'off',
    fixateEnabled: true,
    intensity: 0.4,
    restyleEnabled: false,
    readerEnabled: false,
    theme: 'auto',
    fontScale: 1,
    keepFiguresLight: false,
    siteOverride: 'default',
    suspended: false,
    reader: { host: null, shadow: null, body: null, scrollY: 0 },
    restyle: { barEls: [] }
  };

  const host = () => location.hostname;
  const siteKey = (h) =>
    (typeof tldts !== 'undefined' && tldts.getDomain(h, { allowPrivateDomains: true })) || h;

  /* ----------------------------- settings ----------------------------- */

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (items) => {
        const s = { ...DEFAULTS, ...items };

        // Migrate legacy mode values ('fixate' / 'restyle' / 'reader') to the
        // new on/off + restyleEnabled + readerEnabled shape. The legacy
        // 'fixate' value is the equivalent of "on, with no reading style".
        if (s.mode === 'fixate') { s.mode = 'on'; }
        else if (s.mode === 'restyle') { s.mode = 'on'; s.restyleEnabled = true; }
        else if (s.mode === 'reader') { s.mode = 'on'; s.readerEnabled = true; }
        else if (s.mode !== 'off') { s.mode = 'on'; }
        if (s.restyleEnabled === undefined) s.restyleEnabled = DEFAULTS.restyleEnabled;
        if (s.readerEnabled === undefined) s.readerEnabled = DEFAULTS.readerEnabled;

        state.mode = s.mode === 'off' ? 'off' : 'on';
        state.fixateEnabled = !!s.fixateEnabled;
        const i = Number(s.fixateIntensity);
        state.intensity = Number.isFinite(i) ? Math.max(20, Math.min(70, i)) / 100 : 0.4;
        state.restyleEnabled = !!s.restyleEnabled;
        state.readerEnabled = !!s.readerEnabled;
        state.theme = ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : 'auto';
        const fs = Number(s.fontScale);
        state.fontScale = Number.isFinite(fs) ? Math.min(1.6, Math.max(0.8, fs)) : 1;
        state.keepFiguresLight = !!s.keepFiguresLight;
        state._siteOverrides = s.siteOverrides || {};
        state.siteOverride = state._siteOverrides[siteKey(host())] === 'never' ||
          state._siteOverrides[host()] === 'never' ? 'never' : 'default';

        // Persist the migrated shape so subsequent reads (popup, background)
        // always see the canonical keys and values.
        saveSettings({
          mode: state.mode,
          restyleEnabled: state.restyleEnabled,
          readerEnabled: state.readerEnabled
        });

        resolve();
      });
    });
  }

  function saveSettings(patch) {
    chrome.storage.sync.set(patch);
  }

  function resolvedTheme() {
    if (state.theme === 'light' || state.theme === 'dark') return state.theme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function isSuspended() {
    return !!state.suspended;
  }

  function isRestyleActive() {
    return !isSuspended() && state.mode === 'on' && state.restyleEnabled && !state.readerEnabled &&
      state.siteOverride !== 'never';
  }

  function isReaderActive() {
    return !isSuspended() && state.mode === 'on' && state.readerEnabled && state.siteOverride !== 'never';
  }

  /* ------------------------- document-level fonts --------------------- */

  function injectFonts() {
    if (document.getElementById(FONT_STYLE_ID)) return;
    const url = (f) => chrome.runtime.getURL('fonts/' + f);
    const css = `
@font-face{font-family:'National Park';font-style:normal;font-weight:400 700;font-display:swap;
  src:url('${url('nationalpark-latin.woff2')}') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'National Park';font-style:normal;font-weight:400 700;font-display:swap;
  src:url('${url('nationalpark-latinext.woff2')}') format('woff2');
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Fragment Mono';font-style:normal;font-weight:400;font-display:swap;
  src:url('${url('fragmentmono-latin.woff2')}') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Fragment Mono';font-style:normal;font-weight:400;font-display:swap;
  src:url('${url('fragmentmono-latinext.woff2')}') format('woff2');
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Playfair Display';font-style:normal;font-weight:400;font-display:swap;
  src:url('${url('playfair-latin.woff2')}') format('woff2');
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Playfair Display';font-style:normal;font-weight:400;font-display:swap;
  src:url('${url('playfair-latinext.woff2')}') format('woff2');
  unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF;}`;
    const el = document.createElement('style');
    el.id = FONT_STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function removeFonts() {
    const el = document.getElementById(FONT_STYLE_ID);
    if (el) el.remove();
  }

  /* ------------------------- fixate root selection -------------------- */

  function fixateRoot() {
    if (isSuspended()) return null;
    if (state.reader.body) return state.reader.body;
    if (state.mode === 'on' && state.siteOverride !== 'never') return document.body;
    return null;
  }

  function applyFixate() {
    const root = fixateRoot();
    if (!root) return;
    if (window.Fixate && !window.Fixate.isApplied(root)) {
      window.Fixate.apply(root, state.intensity);
    }
  }

  function refreshFixate() {
    const root = fixateRoot();
    if (!root) return;
    if (state.fixateEnabled) {
      if (window.Fixate && window.Fixate.isApplied(root)) {
        window.Fixate.update(root, state.intensity);
      } else {
        window.Fixate.apply(root, state.intensity);
      }
    } else {
      window.Fixate.unapply(root);
    }
  }

  function removeFixate() {
    if (!window.Fixate) return;
    if (state.reader.body) window.Fixate.unapply(state.reader.body);
    window.Fixate.unapply(document.body);
  }

  /* ----------------------------- reader mode -------------------------- */

  const ICONS = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function applyReader() {
    const parsed = window.PleasantReadability.parse();
    if (!parsed.ok) return applyRestyle();

    state.reader.scrollY = window.scrollY;
    injectFonts();

    const hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    const guard = {
      position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
      'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
      margin: '0', 'z-index': '2147483647', display: 'block',
      opacity: '1', 'pointer-events': 'auto',
      transform: 'none', scale: 'none', rotate: 'none', translate: 'none',
      filter: 'none', 'mix-blend-mode': 'normal',
      mask: 'none', '-webkit-mask': 'none',
      clip: 'auto', 'clip-path': 'none', contain: 'none', 'content-visibility': 'visible'
    };
    for (const k in guard) hostEl.style.setProperty(k, guard[k], 'important');
    const shadow = hostEl.attachShadow({ mode: 'open' });

    hostEl.style.setProperty('visibility', 'hidden', 'important');
    const linkEl = document.createElement('link');
    linkEl.rel = 'stylesheet';
    linkEl.href = chrome.runtime.getURL('reader.css');
    const reveal = () => { hostEl.style.setProperty('visibility', 'visible', 'important'); };
    linkEl.addEventListener('load', reveal);
    linkEl.addEventListener('error', reveal);
    setTimeout(reveal, 800);
    shadow.appendChild(linkEl);

    const t = resolvedTheme();
    shadow.host.setAttribute('data-theme', t);
    hostEl.style.setProperty('background-color', THEME_BG[t] || THEME_BG.light, 'important');
    shadow.host.setAttribute('data-figures', state.keepFiguresLight ? 'light' : 'invert');
    shadow.host.style.setProperty('--reader-font-scale', String(state.fontScale));

    shadow.appendChild(buildReaderDOM(parsed));
    highlightCodeBlocks(shadow);

    state.reader.host = hostEl;
    state.reader.shadow = shadow;
    state.reader.body = shadow.querySelector('.article-body');

    document.documentElement.appendChild(hostEl);
    document.documentElement.style.overflow = 'hidden';

    bindReaderEvents(shadow);
    watchSystemTheme();

    applyFixate();
    return true;
  }

  function buildReaderDOM(parsed) {
    const frag = document.createDocumentFragment();

    const bar = document.createElement('div');
    bar.className = 'reader-bar';
    bar.innerHTML = `
      <span class="reader-logo"><span class="dot"></span> Fixate</span>
      <button class="font-dec" title="Smaller text">A−</button>
      <button class="font-inc" title="Larger text">A+</button>
      <button class="theme-btn" title="Toggle theme"></button>
      <button class="close-btn" title="Close reader (Esc)">${ICONS.close}<span class="label">Close</span></button>
    `;
    frag.appendChild(bar);

    const header = document.createElement('div');
    header.className = 'article-header';
    const metaBits = [];
    if (parsed.byline) metaBits.push(`<span class="author-name">${escapeHtml(parsed.byline)}</span>`);
    if (parsed.published) metaBits.push(`<span class="date">${escapeHtml(parsed.published)}</span>`);
    header.innerHTML = `
      <h1>${escapeHtml(parsed.title || document.title)}</h1>
      <div class="article-meta">
        ${metaBits.join('')}
        <a class="source-link" href="${escapeHtml(location.href)}" target="_blank" rel="noopener">View original</a>
      </div>
    `;
    frag.appendChild(header);

    const body = document.createElement('div');
    body.className = 'article-body';
    body.appendChild(parsed.content);
    frag.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'reader-footer';
    footer.innerHTML = `Reformatted by Fixate · <a href="${escapeHtml(location.href)}" target="_blank" rel="noopener">${escapeHtml(host())}</a>`;
    frag.appendChild(footer);

    return frag;
  }

  /* --------------------- code syntax highlighting --------------------- */

  const CODE_KEYWORDS = new Set((
    'const let var function def lambda return if elif else for while do switch ' +
    'case default break continue new delete class struct enum interface trait ' +
    'impl extends implements super this self import from export package using ' +
    'namespace public private protected static final abstract async await yield ' +
    'try catch except finally throw raise with as in of is not and or typeof ' +
    'instanceof void sizeof typedef template type func fn go defer chan select ' +
    'map range mut pub use mod where match when then begin end pass global ' +
    'nonlocal del unsafe move ref dyn box union goto extern volatile register'
  ).split(' '));
  const CODE_BUILTINS = new Set((
    'true false null undefined None True False nil NaN Infinity void bool int ' +
    'float double char str string long short byte uint usize isize i32 i64 u32 ' +
    'u64 f32 f64 vec list dict set tuple object number boolean symbol bigint'
  ).split(' '));

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightCode(src) {
    const rules = [
      ['comment', /^(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|#(?=[ \t!])[^\n]*)/],
      ['string', /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/],
      ['number', /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+\.?\d*(?:[eE][+-]?\d+)?)/],
      ['word', /^[A-Za-z_$][\w$]*/],
      ['operator', /^[+\-*/%=<>!&|^~?:]+/],
      ['space', /^\s+/],
      ['any', /^[\s\S]/]
    ];
    let out = '';
    let s = src;
    while (s.length) {
      let advanced = false;
      for (const [type, re] of rules) {
        const m = re.exec(s);
        if (!m) continue;
        const text = m[0];
        if (type === 'word') {
          if (CODE_KEYWORDS.has(text)) out += `<span class="pr-tok-keyword">${escHtml(text)}</span>`;
          else if (CODE_BUILTINS.has(text)) out += `<span class="pr-tok-builtin">${escHtml(text)}</span>`;
          else if (/^\s*\(/.test(s.slice(text.length))) out += `<span class="pr-tok-function">${escHtml(text)}</span>`;
          else out += escHtml(text);
        } else if (type === 'space' || type === 'any') {
          out += escHtml(text);
        } else {
          out += `<span class="pr-tok-${type}">${escHtml(text)}</span>`;
        }
        s = s.slice(text.length);
        advanced = true;
        break;
      }
      if (!advanced) { out += escHtml(s[0]); s = s.slice(1); }
    }
    return out;
  }

  function highlightCodeBlocks(shadow) {
    shadow.querySelectorAll('.article-body pre').forEach((pre) => {
      const target = pre.querySelector('code') || pre;
      const text = target.textContent || '';
      if (!text.trim() || text.length > 20000) return;
      target.innerHTML = highlightCode(text);
    });
  }

  function setThemeButtonIcon(shadow) {
    const btn = shadow.querySelector('.theme-btn');
    if (!btn) return;
    const dark = shadow.host.getAttribute('data-theme') === 'dark';
    btn.innerHTML = dark ? ICONS.sun : ICONS.moon;
  }

  function bindReaderEvents(shadow) {
    setThemeButtonIcon(shadow);
    shadow.querySelector('.close-btn').addEventListener('click', () => setMode('off'));
    shadow.querySelector('.theme-btn').addEventListener('click', () => {
      const next = shadow.host.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
    shadow.querySelector('.font-inc').addEventListener('click', () => bumpFont(0.1));
    shadow.querySelector('.font-dec').addEventListener('click', () => bumpFont(-0.1));
    document.addEventListener('keydown', onReaderKeydown, true);
  }

  function bumpFont(delta) {
    const next = Math.min(1.6, Math.max(0.8, Math.round((state.fontScale + delta) * 10) / 10));
    state.fontScale = next;
    saveSettings({ fontScale: next });
    if (state.reader.shadow) {
      state.reader.shadow.host.style.setProperty('--reader-font-scale', String(next));
    }
  }

  function onReaderKeydown(e) {
    if (e.key === 'Escape' && isReaderActive()) {
      e.preventDefault();
      e.stopPropagation();
      setMode('off');
    }
  }

  function removeReader() {
    const el = document.getElementById(HOST_ID);
    if (el) el.remove();
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onReaderKeydown, true);
    unwatchSystemTheme();
    state.reader.host = null;
    state.reader.shadow = null;
    state.reader.body = null;
    if (state.reader.scrollY) {
      window.scrollTo(0, state.reader.scrollY);
      state.reader.scrollY = 0;
    }
  }

  /* ---------------------------- restyle mode -------------------------- */

  const BAR_SELECTOR = 'header, nav, aside, [role="banner"], [role="navigation"],' +
    ' [role="dialog"], [class*="nav" i], [class*="header" i], [class*="bar" i],' +
    ' [class*="banner" i], [class*="sticky" i], [class*="fixed" i], [class*="cookie" i],' +
    ' [class*="consent" i], [id*="nav" i], [id*="header" i]';

  function pinRestyleBars() {
    state.restyle.barEls = [];
    let els;
    try { els = document.querySelectorAll(BAR_SELECTOR); } catch (e) { return; }
    const bg = THEME_BG[resolvedTheme()] || THEME_BG.light;
    els.forEach((el) => {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') {
        el.style.setProperty('background-color', bg, 'important');
        state.restyle.barEls.push(el);
      }
    });
  }

  function unpinRestyleBars() {
    if (!state.restyle.barEls) return;
    state.restyle.barEls.forEach((el) => {
      try { el.style.removeProperty('background-color'); } catch (e) {}
    });
    state.restyle.barEls = [];
  }

  function applyRestyle() {
    injectFonts();

    if (!document.getElementById(RESTYLE_LINK_ID)) {
      const link = document.createElement('link');
      link.id = RESTYLE_LINK_ID;
      link.rel = 'stylesheet';
      link.href = chrome.runtime.getURL('restyle.css');
      (document.head || document.documentElement).appendChild(link);
    }
    document.documentElement.setAttribute('data-pleasant-restyle', resolvedTheme());
    document.documentElement.setAttribute('data-pleasant-figures', state.keepFiguresLight ? 'light' : 'invert');
    document.documentElement.style.setProperty('--pr-font-scale', String(state.fontScale));
    pinRestyleBars();
    watchSystemTheme();

    applyFixate();
    return true;
  }

  function removeRestyle() {
    const link = document.getElementById(RESTYLE_LINK_ID);
    if (link) link.remove();
    unpinRestyleBars();
    document.documentElement.removeAttribute('data-pleasant-restyle');
    document.documentElement.removeAttribute('data-pleasant-figures');
    document.documentElement.style.removeProperty('--pr-font-scale');
  }

  /* ----------------------- enabled-state orchestration ---------------- */

  function applyEnabled() {
    removeReader();
    removeRestyle();
    removeFixate();

    if (isSuspended() || state.mode !== 'on' || state.siteOverride === 'never') {
      notifyBackground();
      return;
    }

    // Composition: Reader takes precedence over Restyle (it covers the whole
    // viewport, so the in-place repaint underneath would be hidden anyway).
    if (state.readerEnabled) {
      applyReader();
    } else if (state.restyleEnabled) {
      applyRestyle();
    } else {
      applyFixate();
    }

    notifyBackground();
  }

  /* ----------------------------- theme sync --------------------------- */

  let mql = null;
  let onMqlChange = null;

  function applyResolvedTheme() {
    const t = resolvedTheme();
    if (state.reader.shadow) {
      state.reader.shadow.host.setAttribute('data-theme', t);
      state.reader.shadow.host.style.setProperty('background-color', THEME_BG[t] || THEME_BG.light, 'important');
      setThemeButtonIcon(state.reader.shadow);
    } else if (isRestyleActive()) {
      document.documentElement.setAttribute('data-pleasant-restyle', t);
      unpinRestyleBars();
      pinRestyleBars();
    }
  }

  function watchSystemTheme() {
    if (mql || state.theme !== 'auto') return;
    mql = window.matchMedia('(prefers-color-scheme: dark)');
    onMqlChange = () => applyResolvedTheme();
    mql.addEventListener('change', onMqlChange);
  }

  function unwatchSystemTheme() {
    if (mql && onMqlChange) mql.removeEventListener('change', onMqlChange);
    mql = null;
    onMqlChange = null;
  }

  function notifyBackground() {
    const effective = (!isSuspended() && state.mode === 'on' && state.siteOverride !== 'never') ? 'on' : 'off';
    try { chrome.runtime.sendMessage({ type: 'stateChanged', mode: effective }); } catch (e) {}
  }

  /* ------------------------------ control ----------------------------- */

  function setMode(mode) {
    if (mode !== 'off' && mode !== 'on') return;
    if (state.mode === mode) return;
    state.mode = mode;
    saveSettings({ mode });
    applyEnabled();
  }

  function toggleMode() {
    setMode(state.mode === 'on' ? 'off' : 'on');
  }

  function setTheme(theme) {
    state.theme = theme;
    saveSettings({ theme });
    unwatchSystemTheme();
    if (theme === 'auto' && (isReaderActive() || isRestyleActive())) {
      watchSystemTheme();
    }
    applyResolvedTheme();
  }

  function setFontScale(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    const next = Math.min(1.6, Math.max(0.8, v));
    state.fontScale = next;
    saveSettings({ fontScale: next });
    if (state.reader.shadow) {
      state.reader.shadow.host.style.setProperty('--reader-font-scale', String(next));
    }
    if (isRestyleActive()) {
      document.documentElement.style.setProperty('--pr-font-scale', String(next));
    }
  }

  function setKeepFiguresLight(value) {
    state.keepFiguresLight = !!value;
    saveSettings({ keepFiguresLight: state.keepFiguresLight });
    if (state.reader.shadow) {
      state.reader.shadow.host.setAttribute('data-figures', state.keepFiguresLight ? 'light' : 'invert');
    }
    if (isRestyleActive()) {
      document.documentElement.setAttribute('data-pleasant-figures', state.keepFiguresLight ? 'light' : 'invert');
    }
  }

  function setFixateEnabled(value) {
    state.fixateEnabled = !!value;
    saveSettings({ fixateEnabled: state.fixateEnabled });
    refreshFixate();
  }

  function setFixateIntensity(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    state.intensity = Math.max(0.2, Math.min(0.7, v / 100));
    saveSettings({ fixateIntensity: Math.round(v) });
    refreshFixate();
  }

  function setRestyleEnabled(value) {
    state.restyleEnabled = !!value;
    saveSettings({ restyleEnabled: state.restyleEnabled });
    applyEnabled();
  }

  function setReaderEnabled(value) {
    state.readerEnabled = !!value;
    saveSettings({ readerEnabled: state.readerEnabled });
    applyEnabled();
  }

  function setSiteOverride(value) {
    const o = { ...((state && state._siteOverrides) || {}) };
    const key = siteKey(host());
    if (value === 'default') delete o[key];
    else if (value === 'never') o[key] = 'never';
    state._siteOverrides = o;
    state.siteOverride = o[key] === 'never' ? 'never' : 'default';
    saveSettings({ siteOverrides: o });
    applyEnabled();
  }

  function setSuspended(value) {
    state.suspended = !!value;
    applyEnabled();
  }

  function toggleSuspended() {
    setSuspended(!state.suspended);
    return state.suspended;
  }

  function currentState() {
    return {
      mode: state.mode,
      host: host(),
      origin: location.origin,
      effectiveMode: isSuspended() || state.siteOverride === 'never' ? 'off' : state.mode,
      suspended: !!state.suspended,
      neverThisSite: state.siteOverride === 'never',
      siteOverrides: state._siteOverrides || {},
      fixateEnabled: state.fixateEnabled,
      fixateIntensity: Math.round(state.intensity * 100),
      restyleEnabled: state.restyleEnabled,
      readerEnabled: state.readerEnabled,
      theme: state.theme,
      fontScale: state.fontScale,
      keepFiguresLight: state.keepFiguresLight
    };
  }

  /* ----------------------------- messaging ---------------------------- */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (sender.id !== chrome.runtime.id) { sendResponse({ ok: false }); return; }
      if (!msg || typeof msg !== 'object') { sendResponse({ ok: false }); return; }
      switch (msg.type) {
        case 'getState':
          sendResponse(currentState());
          break;
        case 'reloadSettings':
          loadSettings().then(() => {
            applyEnabled();
            sendResponse(currentState());
          });
          break;
        case 'setMode':
          if (!['off', 'on'].includes(msg.mode)) { sendResponse({ ok: false }); break; }
          setMode(msg.mode);
          sendResponse({ mode: state.mode });
          break;
        case 'toggle':
          toggleMode();
          sendResponse({ mode: state.mode });
          break;
        case 'setFixateEnabled':
          setFixateEnabled(msg.value);
          sendResponse({ ok: true });
          break;
        case 'setFixateIntensity':
          setFixateIntensity(msg.value);
          sendResponse({ ok: true });
          break;
        case 'setRestyleEnabled':
          setRestyleEnabled(msg.value);
          sendResponse({ ok: true });
          break;
        case 'setReaderEnabled':
          setReaderEnabled(msg.value);
          sendResponse({ ok: true });
          break;
        case 'setTheme':
          if (!['auto', 'light', 'dark'].includes(msg.theme)) { sendResponse({ ok: false }); break; }
          setTheme(msg.theme);
          sendResponse({ ok: true });
          break;
        case 'setFontScale':
          setFontScale(msg.value);
          sendResponse({ ok: true });
          break;
        case 'setKeepFiguresLight':
          setKeepFiguresLight(msg.value);
          sendResponse({ ok: true });
          break;
        case 'setSiteOverride':
          if (!['always', 'never', 'default'].includes(msg.value)) { sendResponse({ ok: false }); break; }
          setSiteOverride(msg.value);
          sendResponse({ ok: true });
          break;
        case 'setSuspended':
          setSuspended(!!msg.value);
          sendResponse({ ok: true, suspended: !!state.suspended });
          break;
        case 'toggleSuspended':
        case 'suspendToggle':
        case 'toggleSuspend':
          toggleSuspended();
          sendResponse({ ok: true, suspended: !!state.suspended });
          break;
        case 'suspend':
          setSuspended(true);
          sendResponse({ ok: true, suspended: true });
          break;
        case 'resume':
        case 'unsuspend':
          setSuspended(false);
          sendResponse({ ok: true, suspended: false });
          break;
        case 'reapply':
          if (!isSuspended()) refreshFixate();
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false });
      }
    })().catch(() => { try { sendResponse({ ok: false }); } catch (e) {} });
    return true;
  });

  /* ------------------------------- init ------------------------------- */

  loadSettings().then(() => {
    applyEnabled();
  });
})();
