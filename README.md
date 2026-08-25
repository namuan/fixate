# Fixate

A Chrome extension that helps you read the web — bold the first part of every word so your eyes fixate faster, and optionally rebuild the page in a calm, pleasant reader view (warm earthy palette, custom typography, distraction-free article extraction) inspired by pleasant-reader.

Pick the mode that fits the page:

- **Fixate** — bolds the leading part of each word in place. Lightweight; keeps the page's own layout and colors.
- **Restyle** — repaints the page with a warm earthy palette and bundled fonts in place. Cleaner than the bare Fixate mode, lighter than the Reader.
- **Reader** — extracts the article and rebuilds it in an isolated ~65-character column with fluid typography. Best for long-form.

Fixate (the bolding) is **independent of mode**: toggle it on/off and adjust its intensity inside any of the three modes. The other reading controls (theme, text size, keep figures light) apply to Restyle and Reader.

## Features

- **Four modes** — Off, Fixate, Restyle, Reader
- **Adjustable intensity** (20–70%) for the bolded prefix, with a live preview in the popup
- **Warm earthy palette** — cream background, rust accent, dark brown headings, body text in muted brown
- **Bundled fonts** — National Park (body), Playfair Display (headings), Fragment Mono (code). All woff2, served from the extension so it works on strict-CSP pages and offline
- **Light / Dark / Auto** theme with `prefers-color-scheme` awareness
- **Adjustable text size** (80–160%) — separate from page zoom
- **Code syntax highlighting** — language-agnostic tokenizer with a Monokai palette
- **Per-site opt-out** — when ON, the extension applies on every site. Flip **Never on this site** in the popup to exclude the current hostname
- **Keyboard shortcut** — `Alt+B` toggles the active mode on the current page
- **Toolbar badge** — shows "ON" when a mode is active
- **Shadow-DOM isolation** for Reader mode — page CSS can't leak in, reader CSS can't leak out
- **Inline `!important` security guards** on the Reader host element so page CSS can't hide or de-stack the reader
- **DOM walker + MutationObserver** — dynamic content (SPAs, infinite scroll) gets the same treatment
- **Settings sync** via `chrome.storage.sync`

## Install (unpacked)

1. Open `chrome://extensions` (Chrome, Edge, Brave, Arc, etc.).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the icon. Click it to open the popup and pick a mode.

To re-load after editing files, hit the circular refresh icon on the extension's card.

## Usage

- **Mode** — pick Off / Fixate / Restyle / Reader. The mode is remembered; the next page you visit starts in the same mode.
- **Fixate toggle** — disable the bolding for a particular site without leaving the mode.
- **Intensity** — drag the slider. The popup preview updates live so you can feel the effect.
- **Theme / Text size / Keep figures light** — apply to Restyle and Reader.
- **This site → Never on this site** — excludes the current hostname. Everything else still gets the extension.
- **Alt+B** — toggles the active mode on the current page. Rebind at `chrome://extensions/shortcuts`.

## How the four modes compose

| Mode | What you see | Bolded prefix | Theme | Font scale | Code highlight |
|------|--------------|:------:|:-----:|:----------:|:--------------:|
| Off | Page unchanged | — | — | — | — |
| Fixate | Page, with first part of each word bolded | ✓ | inherited from page | inherited from page | inherited from page |
| Restyle | Page, repainted with warm palette and bundled fonts | ✓ | ✓ | ✓ | — |
| Reader | Extracted article in a clean column, Shadow-DOM-isolated | ✓ | ✓ | ✓ | ✓ |

The bolding is the same function in all three modes — it just runs on `document.body` (Fixate, Restyle) or the shadow-DOM `.article-body` (Reader). The wrapper uses `display: contents` so it never shifts layout.

## Project structure

```
fixate/
├── manifest.json         MV3, three content scripts, web-accessible resources
├── background.js         Alt+B shortcut, toolbar badge
├── fixate.js             text transform module — apply/unapply/update/isApplied
├── content.js            orchestrator: modes, themes, state, messaging
├── readability.js        article extraction (Readability-inspired)
├── fixate.css            wrapper styles for the host page
├── restyle.css           in-place warm repaint
├── reader.css            reader theme loaded into a Shadow DOM
├── popup.html / .css / .js
├── fonts/                6 woff2 files (latin + latin-ext for 3 families)
└── icons/                16/32/48/128 px PNG + SVG source
```

## How the bolded-prefix transform works

For each word of length *n* at intensity *i* (0.2–0.7), the first `max(1, round(n × i))` characters get wrapped in `<b>`. The original text is stashed in `data-fixate-original` on the wrapper, so toggling off is a literal string restore — no re-derivation, idempotent across many on/off cycles. The wrapper itself is `display: contents`, so the box tree is identical to the original.

A `MutationObserver` (debounced at 80 ms) watches the active root so dynamic content gets the same treatment without thrashing.

## Things you can add later

The reference project (pleasant-reader) also bundles KaTeX for LaTeX math rendering. The reader's `.article-body` is the right hook for it — a `bodyHasMath()` check followed by `import(chrome.runtime.getURL('vendor/katex/auto-render.mjs'))`. Skipped here because the math payload is ~1 MB.

## Privacy

No network requests, no analytics, no remote code. The only data the extension stores is your settings, kept in `chrome.storage.sync` so they follow your Google account.

## License

MIT.
