// uHighlight results panel (the browser's side panel): every match of the page in the active
// tab, grouped by the heading of the part of the page it is in. A click shows a match on the
// page. Review mode: what is new since the matches of the page were last marked as reviewed;
// selected matches can be copied, each with a link to its place on the page.

const Shared = globalThis.WordHighlighterShared; // from shared.js

const REVIEWS_KEY = 'reviews';       // chrome.storage.local: { page: { at, keys: [...] } }
const MAX_REVIEWED_PAGES = 300;
const MAX_REVIEWED_KEYS = 5000;

// "2 matches", "2 entries", "2 words"
const plural = (count, noun) => `${count} ${count === 1 ? noun
    : /(s|x|ch|sh)$/.test(noun) ? noun + 'es'
    : /[^aeiou]y$/.test(noun) ? noun.slice(0, -1) + 'ies'
    : noun + 's'}`;

class ResultsPanel {
    constructor() {
        this.tabId = null;
        this.windowId = null;
        this.page = null;             // { url, title }
        this.matches = [];            // { id, frameId, key, list, word, css, before, match, after, heading, review }
        this.reviewed = new Set();    // review keys of this page
        this.selected = new Set();    // "<frameId>:<id>"
        this.settings = null;
        this.loadTimer = null;
        this.init();
    }

    async init() {
        const params = new URLSearchParams(location.search);
        if (params.has('tab')) {
            this.tabId = Number(params.get('tab'));   // opened as a page (tests)
        } else {
            const win = await chrome.windows.getCurrent();
            this.windowId = win.id;
            const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
            this.tabId = tab ? tab.id : null;
        }
        this.setupEventListeners();
        await this.load();

        // Follow the active tab of this window, and the changes on its page
        chrome.tabs.onActivated.addListener(info => {
            if (this.windowId !== null && info.windowId !== this.windowId) return;
            this.tabId = info.tabId;
            this.selected.clear();
            this.load();
        });
        chrome.tabs.onUpdated.addListener((tabId, info) => {
            if (tabId === this.tabId && (info.status === 'complete' || info.title)) this.scheduleLoad();
        });
        chrome.runtime.onMessage.addListener((message, sender) => {
            if (message && message.uhighlightCounts && sender.tab && sender.tab.id === this.tabId) this.scheduleLoad();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (Shared.isSettingsChange(changes, area)) this.scheduleLoad();
            // Marks made in another panel (or this one): the page's stored ones are added
            if (area === 'local' && changes[REVIEWS_KEY] && this.page) {
                const page = (changes[REVIEWS_KEY].newValue || {})[this.pageKey()];
                if (page && Array.isArray(page.keys)) {
                    const before = this.reviewed.size;
                    page.keys.forEach(key => this.reviewed.add(key));
                    if (this.reviewed.size !== before) this.render();
                }
            }
        });
    }

    setupEventListeners() {
        document.getElementById('refresh').addEventListener('click', () => this.load());
        document.getElementById('wordFilter').addEventListener('change', () => this.render());
        document.getElementById('newOnly').addEventListener('change', () => this.render());
        document.getElementById('markAll').addEventListener('click', () => this.markReviewed(this.matches));
        document.getElementById('selectAll').addEventListener('change', e => {
            this.visible().forEach(m => {
                if (e.target.checked) this.selected.add(this.idOf(m)); else this.selected.delete(this.idOf(m));
            });
            this.render();
        });
        document.getElementById('copySelected').addEventListener('click', () => this.copySelected());
        document.getElementById('markSelected').addEventListener('click', () => {
            this.markReviewed(this.matches.filter(m => this.selected.has(this.idOf(m))));
            this.selected.clear();
        });
    }

    scheduleLoad() {
        clearTimeout(this.loadTimer);
        this.loadTimer = setTimeout(() => this.load(), 400);
    }

    // Match ids are only unique within a frame, and frame ids within a tab
    idOf(match) {
        return match.tabId + ':' + match.frameId + ':' + match.id;
    }

    // The page's address without its fragment: the matches reviewed belong to it
    pageKey(page = this.page) {
        try {
            const url = new URL(page.url);
            return url.origin + url.pathname + url.search;
        } catch (e) {
            return page ? page.url : '';
        }
    }

    // A match is the same match again when its word, the text around it and the heading it is
    // under are the same; `occurrence` tells apart identical ones (the first, the second...).
    reviewKey(match, occurrence) {
        const around = (match.before.slice(-30) + match.match + match.after.slice(0, 30)).replace(/\s+/g, ' ');
        return (match.word + '|' + around + '|' + match.heading).toLowerCase() + '|' + occurrence;
    }

    // ---------------------------------------------------------------- reading the page

    // Reads the matches of the page. Loads may overlap (the active tab changes, the page
    // changes): each works on its own copies, and only the latest one shows what it read; an
    // older one finishing late is dropped, so a page's matches never appear under another's.
    async load() {
        const seq = this.loadSeq = (this.loadSeq || 0) + 1;
        const current = () => seq === this.loadSeq;
        const tabId = this.tabId;
        if (tabId === null) return this.showEmpty('No page.');
        let tab;
        try {
            tab = await chrome.tabs.get(tabId);
        } catch (e) {
            if (current()) this.showEmpty('No page.');
            return;
        }
        if (!current()) return;
        const page = { url: tab.url || '', title: tab.title || tab.url || '' };
        // The page shown (its title, and the address its reviews are saved for) changes with
        // its matches, never before them: "All reviewed" must never save one page's matches
        // for another page's address.
        const showPage = matches => {
            this.page = page;
            this.matches = matches;
            document.getElementById('pageTitle').textContent = page.title;
            document.getElementById('pageTitle').title = page.url;
        };
        if (!/^https?:/.test(page.url)) {
            showPage([]);
            return this.showEmpty('Web pages only: this page can\'t be highlighted.');
        }

        let settings = null;
        try {
            settings = await Shared.loadSettings();
        } catch (e) {
            settings = null;
        }

        let results;
        try {
            results = await chrome.scripting.executeScript({
                target: { tabId, allFrames: true },
                func: () => (window.__wordHighlighter ? window.__wordHighlighter.collectMatches() : null)
            });
        } catch (e) {
            if (!current()) return;
            showPage([]);
            return this.showEmpty('uHighlight can\'t read this page. Open the uHighlight popup on it, ' +
                'or allow the site, to see its matches here.');
        }

        const matches = [];
        // The top frame first, then the frames in it
        results.sort((a, b) => (a.frameId === 0 ? -1 : b.frameId === 0 ? 1 : a.frameId - b.frameId));
        results.forEach(({ frameId, result }) => {
            if (!result) return;
            result.matches.forEach(m => matches.push({ ...m, tabId, frameId, frameUrl: result.top ? '' : result.url }));
        });
        const seen = new Map();
        matches.forEach(m => {
            const base = this.reviewKey(m, 0);
            const occurrence = seen.get(base) || 0;
            seen.set(base, occurrence + 1);
            m.review = this.reviewKey(m, occurrence);
        });

        const reviews = (await chrome.storage.local.get(REVIEWS_KEY))[REVIEWS_KEY] || {};
        if (!current()) return;
        const reviewed = reviews[this.pageKey(page)];

        this.settings = settings;
        showPage(matches);
        this.reviewed = new Set(reviewed && Array.isArray(reviewed.keys) ? reviewed.keys : []);
        // Selections of matches which are gone are dropped
        const ids = new Set(matches.map(m => this.idOf(m)));
        this.selected.forEach(id => { if (!ids.has(id)) this.selected.delete(id); });

        this.updateWordFilter();
        this.render();
    }

    showEmpty(message) {
        document.getElementById('results').textContent = '';
        const empty = document.getElementById('empty');
        empty.textContent = message;
        empty.hidden = false;
        document.getElementById('pageTotals').textContent = '';
        this.updateFooter();
    }

    // The name of the list a match comes from
    listName(list) {
        if (!list) return Shared.DEFAULT_LIST_NAME;
        const found = this.settings && this.settings.lists.find(l => l.id === list);
        return found ? found.name : 'List';
    }

    updateWordFilter() {
        const select = document.getElementById('wordFilter');
        const current = select.value;
        const counts = new Map();
        this.matches.forEach(m => counts.set(m.key, (counts.get(m.key) || { word: m.word, list: m.list, n: 0 })));
        this.matches.forEach(m => { counts.get(m.key).n++; });
        select.textContent = '';
        const option = (value, text) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = text;
            select.appendChild(o);
        };
        option('', `All words (${this.matches.length})`);
        const withLists = this.settings && this.settings.lists.length > 0;
        Array.from(counts.entries())
            .sort((a, b) => b[1].n - a[1].n || a[1].word.localeCompare(b[1].word))
            .forEach(([key, c]) => option(key, `${c.word} (${c.n})` + (withLists ? ` · ${this.listName(c.list)}` : '')));
        select.value = counts.has(current) ? current : '';
    }

    // The matches shown: of the chosen word, new ones only if asked
    visible() {
        const word = document.getElementById('wordFilter').value;
        const newOnly = document.getElementById('newOnly').checked;
        return this.matches.filter(m => (!word || m.key === word) && (!newOnly || !this.reviewed.has(m.review)));
    }

    // ---------------------------------------------------------------- drawing

    render() {
        const results = document.getElementById('results');
        const empty = document.getElementById('empty');
        results.textContent = '';
        const fresh = this.matches.filter(m => !this.reviewed.has(m.review)).length;
        const totals = document.getElementById('pageTotals');
        totals.textContent = this.matches.length === 0 ? 'No matches' : plural(this.matches.length, 'match');
        if (this.matches.length > 0) {
            const newCount = document.createElement('span');
            newCount.className = fresh > 0 ? 'new' : '';
            newCount.textContent = fresh > 0 ? ` · ${fresh} new since last review` : ' · all reviewed';
            totals.appendChild(newCount);
        }

        const shown = this.visible();
        if (shown.length === 0) {
            empty.hidden = false;
            empty.textContent = this.matches.length === 0
                ? 'No matches on this page.'
                : 'Nothing new since the last review. Turn off "New only" to see every match.';
            this.updateFooter();
            return;
        }
        empty.hidden = true;

        // Grouped by heading, in the order of the page (a heading appears again when the
        // matches come back to its part of the page after another)
        let lastGroup = null;
        shown.forEach(m => {
            const group = m.frameId + '|' + m.heading;
            if (group !== lastGroup) {
                lastGroup = group;
                const heading = document.createElement('div');
                heading.className = 'heading';
                heading.textContent = m.heading || 'Top of the page';
                if (m.frameUrl) {
                    const frame = document.createElement('span');
                    frame.className = 'frame';
                    frame.textContent = ' · in a frame';
                    frame.title = m.frameUrl;
                    heading.appendChild(frame);
                }
                results.appendChild(heading);
            }
            results.appendChild(this.buildRow(m));
        });
        this.updateFooter();
    }

    buildRow(m) {
        const row = document.createElement('div');
        const isNew = !this.reviewed.has(m.review);
        row.className = 'match ' + (isNew ? 'new' : 'reviewed');

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'cell';
        check.checked = this.selected.has(this.idOf(m));
        check.setAttribute('aria-label', `Select "${m.match}"`);
        check.addEventListener('change', () => {
            if (check.checked) this.selected.add(this.idOf(m)); else this.selected.delete(this.idOf(m));
            this.updateFooter();
        });

        // Built with DOM APIs: page text must never be parsed as markup
        const snippet = document.createElement('div');
        snippet.className = 'snippet';
        snippet.tabIndex = 0;
        snippet.title = 'Show it on the page' + (this.settings && this.settings.lists.length ? ` · ${this.listName(m.list)}` : '');
        const before = document.createElement('span');
        before.className = 'context';
        before.textContent = (m.before.length >= 60 ? '…' : '') + m.before.replace(/\s+/g, ' ').trimStart();
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.style.cssText = m.css;
        chip.textContent = m.match;
        const after = document.createElement('span');
        after.className = 'context';
        after.textContent = m.after.replace(/\s+/g, ' ').trimEnd() + (m.after.length >= 60 ? '…' : '');
        snippet.append(before, chip, after);
        snippet.addEventListener('click', () => this.reveal(m));
        snippet.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.reveal(m);
            }
        });

        const state = document.createElement('span');
        state.className = 'state fa-icon';
        if (!isNew) {
            state.appendChild(globalThis.WordHighlighterUI.icon('check'));
            state.title = 'Reviewed';
        } else {
            state.title = 'New since the last review';
        }

        row.append(check, snippet, state);
        return row;
    }

    updateFooter() {
        const count = this.matches.filter(m => this.selected.has(this.idOf(m))).length;
        document.getElementById('copySelected').disabled = count === 0;
        document.getElementById('markSelected').disabled = count === 0;
        const visible = this.visible();
        const all = document.getElementById('selectAll');
        all.checked = visible.length > 0 && visible.every(m => this.selected.has(this.idOf(m)));
        all.disabled = visible.length === 0;
        this.setStatus(count > 0 ? `${count} selected` : '');
    }

    setStatus(text, isError = false) {
        const status = document.getElementById('status');
        status.textContent = text;
        status.classList.toggle('error', isError);
    }

    // ---------------------------------------------------------------- actions

    // Shows a match on the page. The page may have redrawn it since (same text, a new match):
    // then the matches are read again and the same one (by its review key) is shown.
    // A row belongs to the tab it was read from: one clicked while another tab's results are
    // loading is shown in its own tab (brought to the front), never looked up in the new one.
    async reveal(m, again = true) {
        let shown = false;
        const own = m.tabId === this.tabId;
        try {
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: m.tabId, frameIds: [m.frameId] },
                func: id => !!(window.__wordHighlighter && window.__wordHighlighter.reveal(id)),
                args: [m.id]
            });
            shown = !!(result && result.result);
        } catch (e) {
            shown = false;
        }
        if (shown) {
            if (!own) chrome.tabs.update(m.tabId, { active: true }).catch(() => {});
            return;
        }
        if (again && own) {
            await this.load();
            const same = this.matches.find(x => x.review === m.review && x.frameId === m.frameId) ||
                this.matches.find(x => x.review === m.review);
            if (same) return this.reveal(same, false);
        }
        this.setStatus('This match is no longer on the page.', true);
    }

    // The marks are added to the ones stored, which another panel (another window) may have
    // added to since this one read them; the lock keeps two panels' saves from crossing.
    async markReviewed(matches) {
        if (matches.length === 0 || !this.page) return;
        const page = this.pageKey();
        const keys = matches.map(m => m.review);
        keys.forEach(key => this.reviewed.add(key));
        const save = () => this.saveReviewed(page, keys);
        await (navigator.locks ? navigator.locks.request('uhighlight-reviews', save) : save());
        this.render();
        this.setStatus(`${plural(matches.length, 'match')} marked as reviewed.`);
    }

    async saveReviewed(page, keys) {
        const reviews = (await chrome.storage.local.get(REVIEWS_KEY))[REVIEWS_KEY] || {};
        const stored = reviews[page] && Array.isArray(reviews[page].keys) ? reviews[page].keys : [];
        const all = new Set(stored);
        keys.forEach(key => { all.delete(key); all.add(key); });
        reviews[page] = { at: Date.now(), keys: Array.from(all).slice(-MAX_REVIEWED_KEYS) };
        // Keep the most recent pages
        const pages = Object.keys(reviews);
        if (pages.length > MAX_REVIEWED_PAGES) {
            pages.sort((a, b) => (reviews[a].at || 0) - (reviews[b].at || 0))
                .slice(0, pages.length - MAX_REVIEWED_PAGES)
                .forEach(page => { delete reviews[page]; });
        }
        await chrome.storage.local.set({ [REVIEWS_KEY]: reviews });
    }

    // A link to a match's place on the page: a text fragment (#:~:text=), which browsers
    // scroll to and highlight, with a little of the text around it to tell it apart.
    linkTo(m) {
        const enc = text => encodeURIComponent(text).replace(/-/g, '%2D').replace(/,/g, '%2C');
        const words = text => text.replace(/\s+/g, ' ').trim();
        const prefix = words(m.before).split(' ').slice(-3).join(' ');
        const suffix = words(m.after).split(' ').slice(0, 3).join(' ');
        // A srcdoc or about:blank frame has no address of its own: its text is in the page's
        let url = /^https?:/i.test(m.frameUrl || '') ? m.frameUrl : this.page.url;
        url = url.split('#')[0];
        return url + '#:~:text=' + (prefix ? enc(prefix) + '-,' : '') + enc(words(m.match)) + (suffix ? ',-' + enc(suffix) : '');
    }

    async copySelected() {
        const chosen = this.matches.filter(m => this.selected.has(this.idOf(m)));
        if (chosen.length === 0) return;
        const lines = [`${this.page.title}`, this.page.url, ''];
        chosen.forEach(m => {
            const before = m.before.replace(/\s+/g, ' ').trimStart();
            const after = m.after.replace(/\s+/g, ' ').trimEnd();
            lines.push(`• "${m.before.length >= 60 ? '…' : ''}${before}${m.match}${after}${m.after.length >= 60 ? '…' : ''}"`);
            lines.push(`  ${this.linkTo(m)}`);
        });
        const text = lines.join('\n');
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            const area = document.createElement('textarea');
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }
        this.setStatus(`Copied ${plural(chosen.length, 'match')} with their links.`);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.uhPanel = new ResultsPanel();
});
