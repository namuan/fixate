/*
 * Fixate — text transform module.
 *
 * Walks a DOM root, finds processable text nodes, and replaces each one with a
 * <span class="fixate-wrapper"> whose <b> marks the bolded prefix of every
 * word. The wrapper stores the original text in a data attribute so toggling
 * off is a literal string restore — no re-derivation, idempotent across many
 * on/off cycles.
 *
 * The transform is mode-agnostic: the same apply()/unapply() pair runs on
 * document.body (Fixate, Restyle) or a shadow-DOM .article-body (Reader).
 * Exposed as window.Fixate for content.js to drive.
 */
(function () {
  'use strict';

  if (window.Fixate) return;

  const WRAPPER_CLASS = 'fixate-wrapper';
  const ORIGINAL_ATTR = 'data-fixate-original';
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION', 'OPTGROUP',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
    'CANVAS', 'SVG', 'MATH', 'MENU', 'DIALOG'
  ]);

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fixateWord(word, intensity) {
    if (word.length === 0) return word;
    if (word.length === 1) return '<b>' + escapeHtml(word) + '</b>';
    const boldLength = Math.max(1, Math.round(word.length * intensity));
    return '<b>' + escapeHtml(word.slice(0, boldLength)) + '</b>' + escapeHtml(word.slice(boldLength));
  }

  function fixateText(text, intensity) {
    return text.split(/(\s+)/).map((token) => {
      if (token.length === 0 || /^\s+$/.test(token)) return escapeHtml(token);
      return fixateWord(token, intensity);
    }).join('');
  }

  function isProcessableElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.isContentEditable) return false;
    if (el.closest('[' + ORIGINAL_ATTR + ']')) return false;
    if (el.closest('[data-fixate-skip]')) return false;
    return true;
  }

  function isWrapper(el) {
    return el && el.nodeType === Node.ELEMENT_NODE && el.classList && el.classList.contains(WRAPPER_CLASS);
  }

  function processTextNode(textNode, intensity) {
    if (!textNode || !textNode.parentNode) return;
    if (!isProcessableElement(textNode.parentNode)) return;

    const text = textNode.textContent;
    if (!text || !text.trim()) return;

    const wrapper = document.createElement('span');
    wrapper.className = WRAPPER_CLASS;
    wrapper.setAttribute(ORIGINAL_ATTR, text);
    wrapper.innerHTML = fixateText(text, intensity);

    textNode.parentNode.replaceChild(wrapper, textNode);
  }

  function unprocessWrapper(wrapper) {
    if (!wrapper || !wrapper.parentNode) return;
    const text = wrapper.getAttribute(ORIGINAL_ATTR);
    if (text === null) return;
    const textNode = document.createTextNode(text);
    wrapper.parentNode.replaceChild(textNode, wrapper);
  }

  function collectTextNodes(root) {
    const nodes = [];
    if (!root) return nodes;

    if (root.nodeType === Node.TEXT_NODE) {
      if (root.parentNode && isProcessableElement(root.parentNode)) nodes.push(root);
      return nodes;
    }

    if (!isProcessableElement(root)) return nodes;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.parentNode) return NodeFilter.FILTER_REJECT;
        if (!isProcessableElement(node.parentNode)) return NodeFilter.FILTER_REJECT;
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let current = walker.nextNode();
    while (current) {
      nodes.push(current);
      current = walker.nextNode();
    }
    return nodes;
  }

  function collectWrappers(root) {
    const out = [];
    if (!root) return out;
    if (isWrapper(root)) { out.push(root); return out; }
    let n = root.firstElementChild;
    while (n) {
      if (isWrapper(n)) out.push(n);
      if (n.firstElementChild) {
        const inner = collectWrappers(n);
        for (let i = 0; i < inner.length; i++) out.push(inner[i]);
      }
      n = n.nextElementSibling;
    }
    return out;
  }

  let activeObserver = null;
  let activeDebounce = null;
  let activeIntensity = 0.4;
  let activeRoot = null;

  function apply(root, intensity) {
    if (!root) return;
    activeRoot = root;
    activeIntensity = clampIntensity(intensity);
    const nodes = collectTextNodes(root);
    for (let i = 0; i < nodes.length; i++) processTextNode(nodes[i], activeIntensity);
    startObserver();
  }

  function unapply(root) {
    if (!root) return;
    const wrappers = collectWrappers(root);
    for (let i = 0; i < wrappers.length; i++) unprocessWrapper(wrappers[i]);
    if (activeRoot === root) {
      stopObserver();
      activeRoot = null;
    }
  }

  function update(root, intensity) {
    unapply(root);
    apply(root, intensity);
  }

  function isApplied(root) {
    if (!root) return false;
    return collectWrappers(root).length > 0;
  }

  function clampIntensity(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0.4;
    return Math.max(0.1, Math.min(0.9, n));
  }

  function startObserver() {
    if (activeObserver || !activeRoot) return;
    const observeRoot = activeRoot;
    activeObserver = new MutationObserver((mutations) => {
      const newRoots = [];
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            newRoots.push(node);
          }
        }
      }
      if (newRoots.length === 0) return;
      clearTimeout(activeDebounce);
      activeDebounce = setTimeout(() => {
        if (!activeRoot) return;
        for (const r of newRoots) {
          const nodes = collectTextNodes(r);
          for (let i = 0; i < nodes.length; i++) processTextNode(nodes[i], activeIntensity);
        }
      }, 80);
    });
    activeObserver.observe(observeRoot, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    clearTimeout(activeDebounce);
    activeDebounce = null;
  }

  window.Fixate = {
    apply,
    unapply,
    update,
    isApplied,
    fixateText,
    fixateWord
  };
})();
