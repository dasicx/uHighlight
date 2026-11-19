// uHighlight content script.
//
// Highlights are painted with the CSS Custom Highlight API (CSS.highlights + ::highlight()),
// so the page DOM is never modified. That keeps highlighted text selectable and copyable,
// doesn't break pages whose DOM is owned by a framework (React etc.), and never re-parses
// page text as HTML. A MutationObserver picks up content added after the initial scan.
//
// Text is matched a run at a time, not a text node at a time: the text of a box (a paragraph,
// a table cell...) including its inline elements, read as it is displayed. So "hello
// <em>world</em>" is found as the phrase "hello world", "cat<em>alog</em>" is one word, not
// "cat", hidden elements don't split or join words, and the content of shadow roots is read
// in the order their slots show it.
(() => {
    const Shared = globalThis.WordHighlighterShared; // from shared.js, injected before this file
    // Elements whose text is never visible page text (or can't be painted by the highlight API).
    // <pre>/<code>/<button> are deliberately NOT here: plain-text files, raw logs and JSON are
    // shown by Chrome inside a <pre>, and code blocks are where indicators often appear.
    const SKIP_SELECTOR = 'head, script, style, noscript, iframe, svg, canvas, input, textarea, ' +
                          'select, option, template';
    const DEFAULT_COLOR = '#FFFF00';
    const DEFAULT_STYLE = { css: Shared.highlightCss({ color: DEFAULT_COLOR }) };

    // The index of the character after the one at `index` (an emoji is two UTF-16 units)
    function nextCharacter(text, index) {
        const code = text.codePointAt(index);
        return index + (code !== undefined && code > 0xFFFF ? 2 : 1);
    }
    const RESCAN_DELAY_MS = 200;
    // Unicode-aware "word character" (letters incl. combining marks, digits, underscore)
    const WORD_CHAR = /[\p{L}\p{M}\p{N}_]/u;
    const NOT_AFTER_WORD_CHAR = '(?<![\\p{L}\\p{M}\\p{N}_])';
    const NOT_BEFORE_WORD_CHAR = '(?![\\p{L}\\p{M}\\p{N}_])';

    // Attributes: an element whose class, style or hidden attribute changes may now be laid
    // out differently (block instead of inline, shown instead of hidden).
    const OBSERVE_OPTIONS = {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden', 'id']
    };

    // Elements which end a run of text even when they are displayed inline: a line break, and
    // replaced elements and controls, which show none of the page's text between two words.
    // (<wbr> is not one: it only allows a line break inside a word.)
    const BREAK_TAGS = new Set(['br', 'hr', 'img', 'picture', 'video', 'audio', 'object', 'embed',
        'input', 'button', 'select', 'textarea', 'meter', 'progress', 'iframe', 'svg', 'canvas', 'math']);

    // Sent by shadow-hook.js (in the page's own JavaScript world) when the page attaches a
    // shadow root to an element: nothing else tells us about it.
    const SHADOW_EVENT = 'uhighlight-shadow-attached';
    // Asks shadow-hook.js to send SHADOW_EVENT again for the shadow roots attached before this
    // script started (it runs at document_start, this script once the page has loaded).
    const SHADOW_REPLAY_EVENT = 'uhighlight-shadow-replay';

    // Frames are switched on/off with the page the user is looking at (the top page), so an
    // enabled site's embedded frames (mail bodies, viewers, consoles) get highlighted too; a
    // frame whose own site is excluded is the exception (see loadSettings()). The top page's
    // address, for the site rules and the saved lists' address patterns: from a frame of
    // another site, only its origin can be known.
    function pageUrl() {
        if (window === window.top) return location.href;
        try {
            return window.top.location.href;
        } catch (e) {
            // a frame of another site
        }
        const origins = location.ancestorOrigins;
        if (origins && origins.length > 0) return origins[origins.length - 1] + '/';
        return location.href;
    }

    // Results: how many matches the toolbar icon shows, at most
    const MAX_BADGE = 999;
    const SNIPPET_CONTEXT = 60;   // characters of text on either side of a match, for results

    // After an extension reload/update the previous instance may still be attached to this page.
    if (window.__wordHighlighter) {
        try { window.__wordHighlighter.destroy(); } catch (e) { /* old context may be gone */ }
    }

    class ContentHighlighter {
        constructor() {
            this.settings = {
                sources: [],          // the word lists which run on this page: My words, saved lists
                caseSensitive: false,
                partialMatch: false,
                enabled: false
            };
            this.entries = new Map();      // match id -> { id, key, list, text, ranges, highlight, snippet }
            this.entrySeq = 0;
            this.current = null;           // the match shown from the results panel
            this.currentTimer = null;
            this.reportTimer = null;
            this.reportedTotal = null;
            this.picker = null;            // "Pick a section" in progress
            this.topUrl = null;            // the address of the page (the top frame's), when told
            // Unique per instance so an old, orphaned instance can't clobber our registrations.
            this.prefix = 'word-highlighter-' + Math.random().toString(36).slice(2, 8) + '-';
            this.matcher = null;
            this.highlights = new Map();   // look (css) -> { name, highlight, css }
            this.nodeRanges = new Map();   // text node -> [{ range, highlight }] (a range across
                                           // several text nodes is listed under each of them)
            this.pendingRoots = new Set();       // added or changed nodes, to scan
            this.pendingContainers = new Set();  // nodes whose children changed: their run of text
            this.pendingAttrs = new Set();       // elements whose class/style/hidden changed
            this.kindCache = new WeakMap();      // element -> 'inline' | 'box' | 'none' (per scan)
            this.kindRecord = new WeakMap();     // element -> its kind when last scanned
            this.knownHosts = new WeakSet();     // elements shadow-hook.js reported
            this.sectionElements = new Set();    // elements which were a saved list's section
            this.matchedSections = null;         // the elements the sections' selectors matched
            this.needsPurge = false;
            this.rescanTimer = null;
            this.appliedSettingsKey = null;
            this.sheet = null;             // constructed stylesheet with the ::highlight() rules
            this.sheetCss = '';
            this.styleEl = null;           // fallback if constructed stylesheets aren't usable
            this.shadowRoots = new Set();  // shadow roots being scanned/observed
            this.destroyed = false;

            this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
            this.onStorageChanged = this.onStorageChanged.bind(this);
            this.onMessage = this.onMessage.bind(this);
            this.onPageActivated = this.onPageActivated.bind(this);
            this.onShadowAttached = this.onShadowAttached.bind(this);
            this.onSlotChange = this.onSlotChange.bind(this);

            this.init();
        }

        async init() {
            if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') {
                return; // Browser too old for the Custom Highlight API (Chrome < 105)
            }

            chrome.storage.onChanged.addListener(this.onStorageChanged);
            chrome.runtime.onMessage.addListener(this.onMessage);
            document.addEventListener('visibilitychange', this.onPageActivated);
            window.addEventListener('focus', this.onPageActivated);
            // The page goes away: its matches no longer count on the toolbar icon
            window.addEventListener('pagehide', () => this.sendCounts(0));
            window.addEventListener('pageshow', event => {
                if (!event.persisted) return;   // back from the back/forward cache: count again
                this.reportedTotal = null;
                this.reportCounts();
            });
            // Capture: the event is dispatched on the element and doesn't bubble
            document.addEventListener(SHADOW_EVENT, this.onShadowAttached, true);
            document.dispatchEvent(new Event(SHADOW_REPLAY_EVENT));

            this.removeLegacyMarks();
            // A frame of another site can't read the page's address, only its origin: the
            // background worker knows it (saved lists may run on some of a site's paths only)
            if (window !== window.top) {
                try {
                    const answer = await chrome.runtime.sendMessage({ uhighlightPageUrl: true });
                    if (answer && typeof answer.url === 'string') this.topUrl = answer.url;
                } catch (e) {
                    // The origin will do
                }
            }
            await this.loadSettings();
            this.refresh();
        }

        // Versions <= 1.8.x wrapped matches in <mark>/<span data-wh> elements. When this script is
        // injected into an already-open tab after an update, unwrap those so they don't linger.
        // Only elements that are unmistakably ours are touched: the old <mark> plus the <span>
        // wrapper directly around it. A page's own span[data-wh] is left alone.
        removeLegacyMarks() {
            const marks = document.querySelectorAll('mark.word-highlight[data-wh-mark="true"]');
            if (marks.length === 0) return;

            const wrappers = new Set();
            const parents = new Set();
            marks.forEach(mark => {
                const parent = mark.parentNode;
                if (!parent) return;
                if (parent.nodeType === Node.ELEMENT_NODE && parent.matches('span[data-wh="true"]')) {
                    wrappers.add(parent);
                }
                parent.replaceChild(document.createTextNode(mark.textContent), mark);
                parents.add(parent);
            });
            wrappers.forEach(wrapper => {
                const parent = wrapper.parentNode;
                if (!parent) return;
                const fragment = document.createDocumentFragment();
                while (wrapper.firstChild) fragment.appendChild(wrapper.firstChild);
                parent.replaceChild(fragment, wrapper);
                parents.add(parent);
            });
            parents.forEach(parent => {
                if (parent.isConnected) parent.normalize();
            });
        }

        destroy() {
            this.destroyed = true;
            this.stopPicker();
            this.sendCounts(0);
            this.observer.disconnect();
            clearTimeout(this.rescanTimer);
            this.clearAll();
            document.removeEventListener('visibilitychange', this.onPageActivated);
            window.removeEventListener('focus', this.onPageActivated);
            document.removeEventListener(SHADOW_EVENT, this.onShadowAttached, true);
            try {
                chrome.storage.onChanged.removeListener(this.onStorageChanged);
                chrome.runtime.onMessage.removeListener(this.onMessage);
            } catch (e) {
                // Extension context already invalidated
            }
        }

        isContextValid() {
            try {
                return !!chrome.runtime?.id;
            } catch (e) {
                return false;
            }
        }

        async loadSettings() {
            try {
                // Sanitized, so malformed stored data can't break the matcher
                const result = await Shared.loadSettings();
                const scope = Shared.pageScope(result, this.currentPageUrl());

                // Excluded sites are never highlighted, not even inside a page which is: a frame
                // is off when its own site, or the site of any frame it is in, is excluded (a
                // frame of about:blank or srcdoc has no site of its own: it goes with the frame
                // it is in).
                let frameExcluded = false;
                if (window !== window.top) {
                    const sites = [location.hostname];
                    Array.from(location.ancestorOrigins || []).forEach(origin => {
                        try { sites.push(new URL(origin).hostname); } catch (e) { /* opaque origin */ }
                    });
                    frameExcluded = sites.some(site => site && Shared.findSiteRule(site, result.excludedDomains));
                }

                const sources = [];
                if (!frameExcluded) {
                    if (scope.defaultRuns) {
                        sources.push({ list: '', section: '', words: result.words });
                    }
                    result.lists.forEach(list => {
                        const here = scope.lists.find(l => l.id === list.id);
                        if (here && here.runs) sources.push({ list: list.id, section: list.section, words: list.words });
                    });
                }

                this.settings = {
                    sources,
                    caseSensitive: result.caseSensitive,
                    partialMatch: result.partialMatch,
                    enabled: sources.length > 0
                };
            } catch (e) {
                // Fail silently
            }
        }

        onStorageChanged(changes, area) {
            if (this.destroyed || !Shared.isSettingsChange(changes, area)) return;
            this.loadSettings().then(() => {
                // Skip the full rescan when nothing that affects this page changed
                // (e.g. highlighting was toggled for some other domain).
                if (JSON.stringify(this.settings) !== this.appliedSettingsKey) {
                    this.refresh();
                }
            });
        }

        // When the user comes back to the tab:
        // - if the extension was disabled/removed/reloaded meanwhile (that happens on another
        //   tab), clear our highlights instead of leaving them painted until the page changes;
        // - make sure our stylesheet is still attached (a page can replace
        //   document.adoptedStyleSheets without any DOM change we'd notice).
        onPageActivated() {
            if (this.destroyed) return;
            if (!this.isContextValid()) {
                this.destroy();
                return;
            }
            if (this.matcher) this.ensureStyle();
        }

        onMessage(request, sender, sendResponse) {
            // Lets the popup check whether this script is alive before injecting it again.
            if (request && request.action === 'ping' && window === window.top) {
                sendResponse({ ok: true });
            }
            // The page went to another address without loading (a single-page app's
            // history.pushState()/replaceState(), or a #fragment): the lists which run here may
            // be others now. Sent by the background worker to every frame of the tab.
            if (request && request.action === 'pageUrl' && typeof request.url === 'string') {
                this.onPageUrl(request.url);
            }
        }

        // The address of the page, for the lists' address patterns: the top frame's own; in a
        // frame, the one the background worker told (or the best guess, see pageUrl()).
        currentPageUrl() {
            if (window === window.top) return location.href;
            return this.topUrl || pageUrl();
        }

        onPageUrl(url) {
            if (this.destroyed) return;
            if (window !== window.top) {
                if (url === this.topUrl) return;
                this.topUrl = url;
            }
            this.loadSettings().then(() => {
                if (JSON.stringify(this.settings) !== this.appliedSettingsKey) this.refresh();
            });
        }

        // Full rebuild: used on load and whenever settings change.
        refresh() {
            if (this.destroyed) return;

            this.appliedSettingsKey = JSON.stringify(this.settings);
            this.observer.disconnect();
            clearTimeout(this.rescanTimer);
            this.rescanTimer = null;
            this.pendingRoots.clear();
            this.pendingContainers.clear();
            this.pendingAttrs.clear();
            this.needsPurge = false;
            this.clearAll();

            // No <body> (SVG/XML documents opened directly): nothing to highlight, and nothing
            // should be added to the document either.
            if (!this.settings.enabled || !document.body) {
                this.reportCounts();
                return;
            }
            this.matcher = this.buildMatchers();
            if (!this.matcher) {
                this.reportCounts();
                return;
            }

            this.ensureStyle();
            this.kindCache = new WeakMap();
            this.scanContainer(document.body, true);
            this.matchedSections = this.findSections();
            // Watch the whole document, not just this <body>: rich-text editors (document.open/
            // write in their iframes) and some single-page apps replace the body entirely.
            this.observer.observe(document, this.observeOptions());
            this.reportCounts();
        }

        clearAll() {
            this.highlights.forEach(({ name }) => CSS.highlights.delete(name));
            this.highlights.clear();
            this.nodeRanges.clear();
            this.entries.clear();
            this.sectionElements.clear();
            this.matchedSections = null;
            if (this.current) {
                CSS.highlights.delete(this.prefix + 'current');
                this.current = null;
            }
            this.matcher = null;
            if (this.sheet) {
                this.unadoptSheet(document);
                this.shadowRoots.forEach(root => this.unadoptSheet(root));
            }
            this.shadowRoots.forEach(root => root.removeEventListener('slotchange', this.onSlotChange));
            this.shadowRoots.clear();
            if (this.styleEl) {
                this.styleEl.remove();
                this.styleEl = null;
            }
        }

        // The words which run on this page: those of the lists without a section (`base`) are
        // looked for everywhere; a list limited to a section (`sections`) only in the parts of
        // the page its selector matches. A word of the page's lists counts once, in the first
        // list which has it (My words, then the saved lists in their order); a word of a
        // section's list counts there unless the page's lists have it already, so the same word
        // can be in lists for different sections.
        buildMatchers() {
            const seenBase = new Set();       // normalized words
            const seenSection = new Map();    // selector -> Set of normalized words
            const base = [];
            const sections = [];
            this.settings.sources.forEach(source => {
                const entries = [];
                const seen = source.section
                    ? seenSection.get(source.section) || seenSection.set(source.section, new Set()).get(source.section)
                    : seenBase;
                source.words.forEach(wordObj => {
                    if (!wordObj || typeof wordObj.text !== 'string' || wordObj.paused) return;
                    const text = wordObj.text.trim();
                    if (!text) return;
                    const key = this.normalize(text);
                    if (seenBase.has(key) || seen.has(key)) return;
                    seen.add(key);
                    entries.push({
                        text,
                        norm: key,
                        list: source.list,
                        section: source.section || '',
                        key: source.list + '\u0001' + text,
                        style: { css: Shared.highlightCss(wordObj) }
                    });
                });
                if (entries.length === 0) return;
                if (source.section) sections.push({ list: source.list, selector: source.section, entries });
                else base.push(...entries);
            });
            if (base.length === 0 && sections.length === 0) return null;
            return { base, sections, cache: new Map() };
        }

        // One regular expression for a set of words, each word in a group of its own: the group
        // which matched tells which word it was, and so its look. (Looking the matched text up
        // by its lowercase form fails where case-insensitive matching and toLowerCase() differ:
        // "Σ" matches "ς", but lowercases to "σ".)
        makeMatcher(words) {
            // Longest first so "foo bar" wins over "foo" at the same position (sort is stable).
            const entries = words.slice().sort((a, b) => b.text.length - a.text.length);
            const alternation = entries.map(e => `(${this.wordToPattern(e.text)})`).join('|');
            try {
                return { regex: new RegExp(alternation, this.settings.caseSensitive ? 'gu' : 'giu'), entries };
            } catch (e) {
                return null;
            }
        }

        // The matcher for a run of text: the page's words, and those of the lists whose section
        // some of the run is in. The section may be the box of the run or an element inside it
        // (an inline one: <em class="focus">); each match of a section's word is checked to be
        // in it (see scanRun()). Built once per combination.
        matcherFor(nodes) {
            const { base, sections, cache } = this.matcher;
            const inside = sections.length > 0
                ? sections.filter(section => nodes.some(node => this.nodeInSection(node, section.selector)))
                : [];
            const key = inside.map(section => section.list).join(',');
            if (!cache.has(key)) {
                // The same word in two sections' lists: one alternative, the first list's
                const seen = new Set();
                const words = base.concat(...inside.map(section => section.entries)).filter(word => {
                    if (!word.section) return true;
                    if (seen.has(word.norm)) return false;
                    seen.add(word.norm);
                    return true;
                });
                cache.set(key, words.length > 0 ? this.makeMatcher(words) : null);
            }
            return cache.get(key);
        }

        // What the observer watches. While a saved list is limited to a section, every
        // attribute: a section's selector may use any (class, id, data-*, aria-*...).
        observeOptions() {
            return this.matcher && this.matcher.sections.length > 0
                ? { childList: true, subtree: true, characterData: true, attributes: true }
                : OBSERVE_OPTIONS;
        }

        // The elements the saved lists' sections match now, in the page and its shadow trees
        findSections() {
            const found = new Set();
            const sections = this.matcher ? this.matcher.sections : [];
            if (sections.length === 0) return found;
            const roots = [document, ...this.shadowRoots];
            sections.forEach(section => roots.forEach(root => {
                try {
                    root.querySelectorAll(section.selector).forEach(element => found.add(element));
                } catch (e) {
                    // not a valid selector
                }
            }));
            return found;
        }

        // Is a text node in a part of the page the selector matches?
        nodeInSection(node, selector) {
            const element = node.nodeType === Node.ELEMENT_NODE ? node
                : node.parentElement || (node.parentNode && node.parentNode.host) || null;
            return !!element && this.insideSection(element, selector);
        }

        // Is the element in a part of the page the selector matches (across shadow roots)?
        insideSection(element, selector) {
            let current = element;
            while (current) {
                try {
                    const section = current.closest(selector);
                    if (section) {
                        this.sectionElements.add(section);
                        return true;
                    }
                } catch (e) {
                    return false;   // not a valid selector
                }
                const root = current.getRootNode();
                current = root && root.host ? root.host : null;
            }
            return false;
        }

        wordToPattern(word) {
            // Any run of whitespace in a phrase matches any whitespace on the page: page text
            // often contains line breaks, repeated spaces or &nbsp; between words.
            const body = word.split(/\s+/).map(part => this.escapeRegExp(part)).join('\\s+');
            if (this.settings.partialMatch) return body;

            // Whole-word mode. Only require a boundary on a side where the word itself starts/ends
            // with a letter or digit, so ".exe" still matches in "payload.exe" and "C++" before
            // punctuation. Unlike \b this is Unicode-aware ("Überbrowser" is not "browser").
            const chars = Array.from(word);
            const start = WORD_CHAR.test(chars[0]) ? NOT_AFTER_WORD_CHAR : '';
            const end = WORD_CHAR.test(chars[chars.length - 1]) ? NOT_BEFORE_WORD_CHAR : '';
            return start + body + end;
        }

        // Key used to find words entered twice ("Browser" and "browser" without case sensitivity).
        normalize(text) {
            const collapsed = text.replace(/\s+/g, ' ');
            return this.settings.caseSensitive ? collapsed : collapsed.toLowerCase();
        }

        // One Highlight per distinct look (colors + style)
        getHighlight({ css }) {
            let entry = this.highlights.get(css);
            if (!entry) {
                const name = this.prefix + this.highlights.size;
                const highlight = new Highlight();
                CSS.highlights.set(name, highlight);
                entry = { name, highlight, css };
                this.highlights.set(css, entry);
                this.ensureStyle();
            }
            return entry.highlight;
        }

        // The ::highlight() rules (colors are user-defined) live in a constructed stylesheet that
        // is adopted by the document and by every scanned shadow root: document styles don't
        // reach into shadow trees, and an adopted sheet isn't a DOM node the page can remove.
        ensureStyle() {
            let css = '';
            this.highlights.forEach(({ name, css: declarations }) => {
                css += `::highlight(${name}) { ${declarations} }\n`;
            });
            if (this.current) {
                // The match shown from the results panel: stands out from every color
                css += `::highlight(${this.prefix}current) { background-color: #ff6a00; color: #ffffff; ` +
                    'text-decoration: underline 2px #000000; }\n';
            }

            if (!this.styleEl) {
                try {
                    if (!this.sheet) this.sheet = new CSSStyleSheet();
                    if (css !== this.sheetCss) {
                        this.sheet.replaceSync(css);
                        this.sheetCss = css;
                    }
                    this.adoptSheet(document);
                    this.shadowRoots.forEach(root => this.adoptSheet(root));
                    return;
                } catch (e) {
                    // Constructed stylesheets unusable here: fall back to a <style> element
                    this.sheet = null;
                    this.styleEl = document.createElement('style');
                    this.styleEl.setAttribute('data-word-highlighter', '');
                }
            }

            if (this.styleEl.textContent !== css) {
                this.styleEl.textContent = css;
            }
            // Some pages rewrite <head>; put it back if it was removed.
            if (!this.styleEl.isConnected) {
                (document.head || document.documentElement).appendChild(this.styleEl);
            }
        }

        // Also re-adds the sheet if the page replaced its adoptedStyleSheets list.
        adoptSheet(root) {
            if (this.sheet && !root.adoptedStyleSheets.includes(this.sheet)) {
                root.adoptedStyleSheets = [...root.adoptedStyleSheets, this.sheet];
            }
        }

        unadoptSheet(root) {
            try {
                if (root.adoptedStyleSheets.includes(this.sheet)) {
                    root.adoptedStyleSheets = root.adoptedStyleSheets.filter(sheet => sheet !== this.sheet);
                }
            } catch (e) {
                // Root may belong to a document that's gone
            }
        }

        // ---------------------------------------------------------------- the page as shown
        //
        // Text is read in the order it is displayed: the "flat tree". An element with a shadow
        // root shows its shadow root's content, not its own children; those are shown where a
        // <slot> of the shadow root takes them in, in the slot's place and order (or not at all,
        // when no slot takes them).

        // An element's shadow root, which is then observed and gets our stylesheet. Open ones
        // directly; closed ones through chrome.dom, for custom elements (<my-widget>, in
        // practice the ones which use closed roots) and for elements shadow-hook.js reported:
        // asking chrome.dom about every element would cost an extension API call each.
        shadowRootOf(element) {
            let root = element.shadowRoot;
            if (!root && (element.localName.includes('-') || this.knownHosts.has(element))) {
                try {
                    root = (chrome.dom && chrome.dom.openOrClosedShadowRoot)
                        ? chrome.dom.openOrClosedShadowRoot(element) || null
                        : null;
                } catch (e) {
                    root = null;
                }
            }
            if (root && !this.shadowRoots.has(root)) {
                this.shadowRoots.add(root);
                this.observer.observe(root, this.observeOptions());
                root.addEventListener('slotchange', this.onSlotChange);
                this.adoptSheet(root);
            }
            return root || null;
        }

        // The children of a node as displayed
        flatChildren(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
                const root = this.shadowRootOf(node);
                if (root) return Array.from(root.childNodes);
                if (node.localName === 'slot' && node.getRootNode() instanceof ShadowRoot) {
                    const assigned = node.assignedNodes();
                    if (assigned.length > 0) return assigned;   // otherwise its fallback content
                }
            }
            return Array.from(node.childNodes);
        }

        // The parent of a node as displayed: the slot which shows it, the host of a shadow
        // root's top-level nodes; null for a child of a shadow host which no slot shows.
        flatParent(node) {
            if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return node.host || null;
            const parent = node.parentNode;
            if (!parent) return null;
            if (parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return parent.host || null;
            if (parent.nodeType === Node.ELEMENT_NODE) {
                const root = this.shadowRootOf(parent);
                if (root) return node.assignedSlot || this.slotIn(root, node);
            }
            return parent;
        }

        // The slot of a (closed) shadow root which shows `node`: assignedSlot hides those
        slotIn(root, node) {
            for (const slot of root.querySelectorAll('slot')) {
                if (slot.assignedNodes().includes(node)) return slot;
            }
            return null;
        }

        // How an element is laid out: 'inline' (its text runs on with the text around it),
        // 'none' (not shown) or 'box'. Decided by its actual display, so a <span> shown as a
        // block, or as an item of a flex or grid container, is a box of its own. Cached for the
        // duration of a scan; the last value seen is kept, to notice when it changes.
        kind(element) {
            let kind = this.kindCache.get(element);
            if (kind === undefined) {
                if (BREAK_TAGS.has(element.localName)) {
                    kind = 'box';
                } else {
                    const display = getComputedStyle(element).display;
                    kind = display === 'none' ? 'none'
                        : display === 'inline' || display === 'contents' ? 'inline'
                        : 'box';
                }
                this.kindCache.set(element, kind);
                this.kindRecord.set(element, kind);
            }
            return kind;
        }

        // The box whose text `node` is part of: its nearest displayed ancestor (or itself) which
        // isn't inline; the document at the top; null when it isn't displayed anywhere.
        containerOf(node) {
            let current = node.nodeType === Node.TEXT_NODE ? this.flatParent(node) : node;
            while (current) {
                if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
                    current = current.host || null;
                } else if (current.nodeType === Node.ELEMENT_NODE && this.kind(current) === 'inline') {
                    current = this.flatParent(current);
                } else {
                    break;
                }
            }
            return current;
        }

        // The outermost boxes inside an inline element (a <div> inside a <span>), into `boxes`.
        collectBoxes(element, boxes) {
            this.flatChildren(element).forEach(child => {
                if (child.nodeType !== Node.ELEMENT_NODE || child.matches(SKIP_SELECTOR)) return;
                if (this.kind(child) === 'inline') this.collectBoxes(child, boxes);
                else boxes.add(child);
            });
        }

        // ---------------------------------------------------------------- changes

        // shadow-hook.js: the page attached a shadow root to an element. Remembered (so that
        // a closed one is looked for, see shadowRootOf()), and scanned with the next batch of
        // changes, by when the page has usually put its content in it.
        onShadowAttached(event) {
            if (this.destroyed) return;
            // In a closed shadow tree the element itself is hidden from us: the path then
            // starts at the outermost host we may see, which is scanned again.
            const host = event.composedPath()[0] || event.target;
            if (!host || host.nodeType !== Node.ELEMENT_NODE) return;
            this.knownHosts.add(host);
            if (!this.matcher) return;
            this.pendingRoots.add(host);
            this.scheduleFlush();
        }

        // A slot now shows other nodes (added, removed, or moved to another slot)
        onSlotChange(event) {
            if (this.destroyed || !this.matcher) return;
            const slot = event.composedPath()[0] || event.target;
            if (slot && slot.nodeType === Node.ELEMENT_NODE) {
                this.pendingContainers.add(slot);
                this.scheduleFlush();
            }
        }

        onMutations(mutations) {
            if (this.destroyed) return;
            if (!this.isContextValid()) {
                // Extension was reloaded/removed; stop and clean up after ourselves.
                this.destroy();
                return;
            }

            for (const mutation of mutations) {
                if (mutation.type === 'characterData') {
                    this.pendingRoots.add(mutation.target);
                } else if (mutation.type === 'attributes') {
                    // class, style, hidden: maybe shown differently (see flushPending())
                    this.pendingAttrs.add(mutation.target);
                } else {
                    mutation.addedNodes.forEach(node => this.pendingRoots.add(node));
                    if (mutation.removedNodes.length > 0) this.needsPurge = true;
                    // The text on either side of what was added or removed may now read differently
                    this.pendingContainers.add(mutation.target);
                }
            }

            if (this.pendingRoots.size > 0 || this.pendingContainers.size > 0 ||
                this.pendingAttrs.size > 0 || this.needsPurge) {
                this.scheduleFlush();
            }
        }

        scheduleFlush() {
            if (!this.rescanTimer) {
                this.rescanTimer = setTimeout(() => this.flushPending(), RESCAN_DELAY_MS);
            }
        }

        flushPending() {
            this.rescanTimer = null;
            if (this.destroyed || !this.matcher) return;
            this.kindCache = new WeakMap();   // the page's layout may have changed

            // Drop ranges for text that is no longer in the page (they'd keep it in memory).
            if (this.needsPurge) {
                this.needsPurge = false;
                this.nodeRanges.forEach((entries, node) => {
                    if (!node.isConnected) this.clearNode(node);
                });
                this.shadowRoots.forEach(root => {
                    if (!root.host.isConnected) this.shadowRoots.delete(root);
                });
                this.sectionElements.forEach(element => {
                    if (!element.isConnected) this.sectionElements.delete(element);
                });
            }

            // What to scan: boxes which are new or shown anew, in full ("deep"); and the boxes
            // around changed text, only their own runs of text ("direct"), not the boxes inside.
            const deep = new Set();
            const direct = new Set();
            const changed = node => {
                if (!node.isConnected) return;
                if (node.nodeType === Node.TEXT_NODE) {
                    direct.add(this.containerOf(node));
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    if (this.kind(node) === 'inline') {
                        direct.add(this.containerOf(node));
                        this.collectBoxes(node, deep);
                    } else {
                        deep.add(node);
                    }
                }
            };
            this.pendingRoots.forEach(changed);
            this.pendingContainers.forEach(node => {
                if (node.isConnected) direct.add(this.containerOf(node));
            });
            // An element now laid out differently (inline <-> box, shown <-> hidden): the text
            // around it reads differently, and its own text is scanned again.
            // Also the saved lists' sections an attribute change may have made or unmade: the
            // element itself (class="focus"), or elements inside it (".wrapper .target" when
            // the wrapper's class changes; [data-mode="active"]): those which were sections,
            // and those which are now.
            const sections = this.matcher.sections;
            const affected = new Set();
            this.pendingAttrs.forEach(element => {
                if (!element.isConnected || element.nodeType !== Node.ELEMENT_NODE) return;
                const before = this.kindRecord.get(element);
                if (before !== undefined && this.kind(element) !== before) affected.add(element);
                if (sections.length === 0) return;
                this.sectionElements.forEach(section => {
                    if (section === element || element.contains(section)) affected.add(section);
                });
                sections.forEach(section => {
                    try {
                        if (element.matches(section.selector)) affected.add(element);
                        element.querySelectorAll(section.selector).forEach(found => affected.add(found));
                    } catch (e) {
                        // not a valid selector
                    }
                });
            });
            // A section may also be made or unmade by a change anywhere else: a child
            // (.card:has(.flag)), a sibling (.switch.on + p), its place (:first-child)... So
            // the elements the selectors match are compared with those they matched before.
            if (sections.length > 0) {
                const now = this.findSections();
                const was = this.matchedSections || new Set();
                now.forEach(element => { if (!was.has(element)) affected.add(element); });
                was.forEach(element => { if (!now.has(element) && element.isConnected) affected.add(element); });
                this.matchedSections = now;
            }
            affected.forEach(element => {
                this.sectionElements.delete(element);   // recorded again if still a section
                const parent = this.flatParent(element);
                if (parent) direct.add(this.containerOf(parent));
                changed(element);
            });
            this.pendingRoots.clear();
            this.pendingContainers.clear();
            this.pendingAttrs.clear();

            const insideDeep = node => {
                for (let parent = this.flatParent(node); parent; parent = this.flatParent(parent)) {
                    if (deep.has(parent)) return true;
                }
                return false;
            };
            deep.forEach(node => {
                if (!insideDeep(node)) this.scanContainer(node, true);
            });
            direct.forEach(node => {
                if (node && !deep.has(node) && !insideDeep(node)) this.scanContainer(node, false);
            });

            if (sections.length > 0) this.matchedSections = this.findSections();
            this.ensureStyle();
            this.reportCounts();
        }

        // ---------------------------------------------------------------- scanning

        // Highlights the text of a box (an element which isn't inline, or the document), a
        // run of text at a time. A run is the text shown in a row in the same box, inline
        // elements included: it ends at a box inside it, a line break, an image or a control.
        // Elements which aren't shown are left out of the run around them (their text is
        // scanned on its own, for when they are shown). `deep`: also the boxes inside it;
        // otherwise only its own runs.
        scanContainer(container, deep) {
            if (!container || !container.isConnected) return;
            if (container.nodeType === Node.ELEMENT_NODE) {
                if (container.closest(SKIP_SELECTOR)) {
                    // e.g. highlighted text moved into a <noscript>/<template>
                    this.clearSubtree(container);
                    return;
                }
            } else if (container.nodeType !== Node.DOCUMENT_NODE) {
                return;
            }

            let run = [];
            let runBox = null;
            const endRun = () => {
                if (run.length > 0) this.scanRun(run, runBox);
                run = [];
                runBox = null;
            };
            const visit = (node, box) => {
                if (node.nodeType === Node.TEXT_NODE) {
                    if (runBox !== box) {
                        endRun();
                        runBox = box;
                    }
                    run.push(node);
                    return;
                }
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                if (node.matches(SKIP_SELECTOR)) {
                    endRun();
                    this.clearSubtree(node);
                    return;
                }
                const kind = this.kind(node);
                if (kind === 'inline') {
                    this.flatChildren(node).forEach(child => visit(child, box));
                } else if (kind === 'none') {
                    if (deep) this.scanContainer(node, true);   // a run of its own, not the one around it
                } else {
                    endRun();
                    if (!deep) return;
                    this.flatChildren(node).forEach(child => visit(child, node));
                    endRun();
                }
            };

            this.flatChildren(container).forEach(child => visit(child, container));
            endRun();
        }

        // Matches the words in a run of text nodes, read as one text. A match may start in one
        // text node and end in another: its range then spans them (one range per shadow tree
        // it crosses: a range can't have its ends in two different trees).
        scanRun(nodes, box) {
            nodes.forEach(node => this.clearNode(node));

            const starts = [];
            let text = '';
            nodes.forEach(node => {
                starts.push(text.length);
                text += node.data;
            });
            if (!text.trim()) return;

            const matcher = this.matcherFor(nodes);
            if (!matcher) return;
            const { regex, entries: words } = matcher;
            let first = 0;
            let match;
            regex.lastIndex = 0;
            while ((match = regex.exec(text)) !== null) {
                if (match[0].length === 0) {
                    regex.lastIndex = nextCharacter(text, match.index);
                    continue;
                }
                let group = 1;
                while (group < match.length && match[group] === undefined) group++;
                const word = words[group - 1];

                const start = match.index;
                let end = start + match[0].length;
                // Matches come in order: the text node of the start only moves forward
                while (first < nodes.length - 1 && starts[first + 1] <= start) first++;
                const lastFor = stop => {
                    let l = first;
                    while (l < nodes.length - 1 && starts[l + 1] < stop) l++;
                    return l;
                };
                let last = lastFor(end);
                // A section's word counts only when all of the match is inside its section: a
                // phrase which starts in the section and ends after it isn't one of its matches.
                // Then the same word may be another section's (a list for another section), or
                // a shorter word may match at the same place ("zed" where "zed tail" ran out).
                const inside = (selector, upTo) => {
                    for (let i = first; i <= upTo; i++) {
                        if (!this.nodeInSection(nodes[i], selector)) return false;
                    }
                    return true;
                };
                let entryWord = word;
                if (word && word.section && !inside(word.section, last)) {
                    entryWord = this.matcher.sections
                        .flatMap(section => section.entries)
                        .find(other => other.norm === word.norm && inside(other.section, last)) || null;
                    for (let j = group; !entryWord && j < words.length; j++) {
                        const other = words[j];
                        other.sticky = other.sticky ||
                            new RegExp(this.wordToPattern(other.text), this.settings.caseSensitive ? 'uy' : 'iuy');
                        other.sticky.lastIndex = start;
                        const found = other.sticky.exec(text);
                        if (!found || found[0].length === 0) continue;
                        const otherEnd = start + found[0].length;
                        const otherLast = lastFor(otherEnd);
                        if (!other.section || inside(other.section, otherLast)) {
                            entryWord = other;
                            end = otherEnd;
                            last = otherLast;
                        }
                    }
                    if (!entryWord) {
                        // On from the next character: from inside an emoji's two UTF-16 units,
                        // the regular expression ("u") would back up to the same match again
                        regex.lastIndex = nextCharacter(text, start);
                        continue;
                    }
                    regex.lastIndex = end;
                }

                // One range per text node of the match: the text is read in the order it is
                // displayed, which shadow slots can make another than the order of the DOM, where
                // one range from the first node to the last would be reversed (and empty); and a
                // range can't go from one shadow tree to another either.
                const ranges = [];
                for (let i = first; i <= last; i++) {
                    const range = document.createRange();
                    range.setStart(nodes[i], i === first ? start - starts[first] : 0);
                    range.setEnd(nodes[i], i === last ? end - starts[last] : nodes[i].length);
                    if (!range.collapsed) ranges.push(range);
                }
                if (ranges.length === 0) continue;

                const highlight = this.getHighlight(entryWord ? entryWord.style : DEFAULT_STYLE);
                ranges.forEach(range => highlight.add(range));
                const entry = {
                    id: ++this.entrySeq,
                    key: entryWord ? entryWord.key : '',
                    list: entryWord ? entryWord.list : '',
                    text: entryWord ? entryWord.text : match[0],
                    ranges,
                    highlight,
                    snippet: {
                        before: text.slice(Math.max(0, start - SNIPPET_CONTEXT), start),
                        match: text.slice(start, end),
                        after: text.slice(end, end + SNIPPET_CONTEXT)
                    }
                };
                this.entries.set(entry.id, entry);
                for (let i = first; i <= last; i++) {
                    const list = this.nodeRanges.get(nodes[i]);
                    if (list) list.push(entry); else this.nodeRanges.set(nodes[i], [entry]);
                }
            }
        }

        // Drops highlights for all text inside `root` (text that is no longer highlightable).
        clearSubtree(root) {
            if (this.nodeRanges.size === 0) return;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                this.clearNode(node);
            }
        }

        // Drops the highlights of a text node, all of each: a match which also covers other
        // text nodes is removed for them too (the run they belong to is scanned again).
        clearNode(node) {
            const entries = this.nodeRanges.get(node);
            if (!entries) return;
            entries.forEach(entry => {
                entry.ranges.forEach(range => entry.highlight.delete(range));
                this.entries.delete(entry.id);
            });
            this.nodeRanges.delete(node);
        }

        // ---------------------------------------------------------------- results

        // Matches per word ("<list id>\u0001<word>": count) and in all, in this frame
        counts() {
            const words = {};
            this.entries.forEach(entry => {
                words[entry.key] = (words[entry.key] || 0) + 1;
            });
            return { total: this.entries.size, words, active: !!this.matcher };
        }

        // Tells the background worker how many matches this frame has, for the toolbar icon
        // (shortly after a change, and only when the number changed).
        // Sent whenever the matches change, not only their number (one word replaced by another
        // keeps the total): the results panel reads the page again then.
        reportCounts() {
            clearTimeout(this.reportTimer);
            this.reportTimer = setTimeout(() => this.sendCounts(this.destroyed ? 0 : this.entries.size), 300);
        }

        // A fingerprint of the matches: their words and the text around them, in any order
        matchesFingerprint() {
            let sum = 0;
            this.entries.forEach(entry => {
                const text = entry.key + '' + entry.snippet.before.slice(-20) + entry.snippet.match +
                    entry.snippet.after.slice(0, 20);
                let hash = 0x811c9dc5;
                for (let i = 0; i < text.length; i++) {
                    hash ^= text.charCodeAt(i);
                    hash = Math.imul(hash, 0x01000193) >>> 0;
                }
                sum = (sum + hash) >>> 0;
            });
            return this.entries.size + ':' + sum.toString(16);
        }

        sendCounts(total) {
            const fingerprint = total === 0 ? '0' : this.matchesFingerprint();
            if (fingerprint === this.reportedTotal) return;
            this.reportedTotal = fingerprint;
            try {
                chrome.runtime.sendMessage({ uhighlightCounts: { total, fingerprint } }).catch(() => {});
            } catch (e) {
                // Extension context gone
            }
        }

        // The matches of this frame for the results panel, in the order of the page, each with
        // the text around it and the heading of the part of the page it is in.
        collectMatches() {
            // A node inside shadow roots: the host in the document that shows it
            const inDocument = node => {
                let current = node;
                while (current) {
                    const root = current.getRootNode();
                    if (root === document) return current;
                    current = root.host || null;
                }
                return node;
            };
            const before = (a, b) => a === b ? 0
                : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

            const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
                .filter(h => h.textContent.trim());
            const headingOf = node => {
                // The last heading which starts before the node
                let low = 0;
                let high = headings.length - 1;
                let found = null;
                while (low <= high) {
                    const middle = (low + high) >> 1;
                    const heading = headings[middle];
                    if (heading === node || heading.contains(node) || before(heading, node) < 0) {
                        found = heading;
                        low = middle + 1;
                    } else {
                        high = middle - 1;
                    }
                }
                return found;
            };

            const list = [];
            this.entries.forEach(entry => {
                const range = entry.ranges[0];
                if (!range || !range.startContainer.isConnected) return;
                list.push({ entry, node: inDocument(range.startContainer) });
            });
            list.sort((a, b) => before(a.node, b.node) || a.entry.id - b.entry.id);

            return {
                url: location.href,
                title: document.title,
                top: window === window.top,
                matches: list.map(({ entry, node }) => {
                    const heading = headingOf(node);
                    return {
                        id: entry.id,
                        key: entry.key,
                        list: entry.list,
                        word: entry.text,
                        css: entry.highlight ? this.cssOf(entry.highlight) : '',
                        before: entry.snippet.before,
                        match: entry.snippet.match,
                        after: entry.snippet.after,
                        heading: heading ? heading.textContent.trim().replace(/\s+/g, ' ').slice(0, 140) : ''
                    };
                })
            };
        }

        cssOf(highlight) {
            for (const entry of this.highlights.values()) {
                if (entry.highlight === highlight) return entry.css;
            }
            return '';
        }

        // Scrolls a match into view and marks it for a moment (from the results panel)
        reveal(id) {
            const entry = this.entries.get(id);
            if (!entry || !entry.ranges[0]) return false;
            const node = entry.ranges[0].startContainer;
            const element = node.nodeType === Node.ELEMENT_NODE ? node
                : node.parentElement || (node.parentNode && node.parentNode.host);
            if (element) element.scrollIntoView({ block: 'center', behavior: 'smooth' });

            if (!this.current) {
                this.current = new Highlight();
                this.current.priority = 10;
                CSS.highlights.set(this.prefix + 'current', this.current);
                this.ensureStyle();
            }
            this.current.clear();
            entry.ranges.forEach(range => this.current.add(range));
            clearTimeout(this.currentTimer);
            this.currentTimer = setTimeout(() => {
                if (this.current) this.current.clear();
            }, 2500);
            return true;
        }

        // ---------------------------------------------------------------- "Pick a section"
        //
        // Limits a saved list to a part of the page: the user points at it and clicks; its
        // selector is saved with the list. A box follows the pointer meanwhile, in an element of
        // our own (removed at the end), whose shadow root keeps the page's styles out.

        startPicker(listId, listName) {
            this.stopPicker();
            if (window !== window.top || !document.body) return false;

            const host = document.createElement('div');
            host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
            const root = host.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = `
                .box { position: fixed; display: none; box-sizing: border-box; border: 2px solid #3558d8;
                       background: rgba(53, 88, 216, 0.14); border-radius: 3px; }
                .tip { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); max-width: 90vw;
                       background: #1f1f1f; color: #e0e0e0; font: 13px/1.45 system-ui, sans-serif;
                       padding: 8px 12px; border-radius: 6px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35); }
                .tip b { color: #8fb0ff; font-weight: 600; }
                .sel { display: block; margin-top: 2px; color: #aaa; font: 12px ui-monospace, Consolas, monospace;
                       white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`;
            const box = document.createElement('div');
            box.className = 'box';
            const tip = document.createElement('div');
            tip.className = 'tip';
            const title = document.createElement('span');
            const name = document.createElement('b');
            name.textContent = listName || 'this list';
            title.append('Click the part of the page for ', name, ' · Esc to cancel');
            const preview = document.createElement('span');
            preview.className = 'sel';
            tip.append(title, preview);
            root.append(style, box, tip);
            document.documentElement.appendChild(host);

            let target = null;
            const place = () => {
                if (!target) return;
                const rect = target.getBoundingClientRect();
                Object.assign(box.style, {
                    display: 'block',
                    left: rect.left + 'px', top: rect.top + 'px',
                    width: rect.width + 'px', height: rect.height + 'px'
                });
            };
            const onMove = event => {
                const element = document.elementFromPoint(event.clientX, event.clientY);
                if (!element || element === target || element === document.documentElement) return;
                target = element;
                preview.textContent = this.selectorFor(target);
                place();
            };
            const swallow = event => {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            };
            const onClick = event => {
                swallow(event);
                if (!target) return;
                const section = this.selectorFor(target);
                this.stopPicker();
                try {
                    chrome.runtime.sendMessage({ uhighlightPick: { list: listId, section } }).catch(() => {});
                } catch (e) {
                    // Extension context gone
                }
            };
            const onKey = event => {
                if (event.key !== 'Escape') return;
                swallow(event);
                this.stopPicker();
            };

            const listeners = [
                ['mousemove', onMove], ['click', onClick], ['keydown', onKey], ['scroll', place],
                ['mousedown', swallow], ['mouseup', swallow], ['pointerdown', swallow], ['pointerup', swallow],
                ['auxclick', swallow], ['contextmenu', swallow]
            ];
            listeners.forEach(([type, listener]) => document.addEventListener(type, listener, true));
            this.picker = {
                stop: () => {
                    listeners.forEach(([type, listener]) => document.removeEventListener(type, listener, true));
                    host.remove();
                }
            };
            return true;
        }

        stopPicker() {
            if (!this.picker) return;
            this.picker.stop();
            this.picker = null;
        }

        // A selector for the picked element, meant to find the same part on other pages of
        // the site: the element's own classes when they describe it, else a stable id, else a
        // short path.
        selectorFor(element) {
            const esc = value => CSS.escape(value);
            const stable = e => Array.from(e.classList)
                .filter(c => c.length < 40 && !/\d{3,}/.test(c) && !/^(is-|has-|js-)|active|hover|focus|selected|open/i.test(c))
                .slice(0, 3);
            const matches = selector => {
                try {
                    return element.matches(selector) ? document.querySelectorAll(selector).length : 0;
                } catch (e) {
                    return 0;
                }
            };

            const classes = stable(element);
            if (classes.length > 0) {
                const selector = element.localName + classes.map(c => '.' + esc(c)).join('');
                const count = matches(selector);
                if (count > 0 && count <= 5) return selector;
            }
            if (element.id && !/\d{3,}|:/.test(element.id)) {
                const selector = '#' + esc(element.id);
                if (matches(selector) === 1) return selector;
            }
            const parts = [];
            let current = element;
            while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && parts.length < 5) {
                if (current.id && !/\d{3,}|:/.test(current.id)) {
                    parts.unshift('#' + esc(current.id));
                    break;
                }
                let part = current.localName;
                const own = stable(current);
                if (own.length > 0) {
                    part += own.map(c => '.' + esc(c)).join('');
                } else if (current.parentElement) {
                    const same = Array.from(current.parentElement.children).filter(c => c.localName === current.localName);
                    if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
                }
                parts.unshift(part);
                if (matches(parts.join(' > ')) === 1) return parts.join(' > ');
                current = current.parentElement;
            }
            return parts.join(' > ');
        }

        escapeRegExp(string) {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
    }

    window.__wordHighlighter = new ContentHighlighter();
})();
