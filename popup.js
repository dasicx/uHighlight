// uHighlight popup: the site, the words of every list (with their matches on this page), and
// adding, editing and removing words.

const Shared = globalThis.WordHighlighterShared; // from shared.js
const UI = globalThis.WordHighlighterUI;         // from ui.js
const PRESET_COLORS = Shared.PRESET_COLORS;

const CONTENT_SCRIPT_FILES = ['shared.js', 'content.js'];

// Show the word-list filter box from this many words on (all lists)
const FILTER_MIN_WORDS = 6;
// At most this many words pasted at once
const MAX_BULK = 500;
// How long "Undo" is offered after a removal
const UNDO_MS = 12000;

const STYLES = [
    { value: 'background', name: 'Background' },
    { value: 'underline', name: 'Underline' },
    { value: 'wavy', name: 'Wavy underline' }
];

// "2 matches", "2 entries", "2 words"
const plural = (count, noun) => `${count} ${count === 1 ? noun
    : /(s|x|ch|sh)$/.test(noun) ? noun + 'es'
    : /[^aeiou]y$/.test(noun) ? noun.slice(0, -1) + 'ies'
    : noun + 's'}`;

// Draws an element (list entry, preview, style sample) exactly like the word's highlight on a
// page, using the same CSS the content script uses.
function styleChip(chip, word) {
    chip.style.cssText = '';
    Shared.highlightDeclarations(word).forEach(([property, value]) => chip.style.setProperty(property, value));
}

// Same look (colors + style)?
function sameLook(word, color, textColor, style) {
    return word.color.toLowerCase() === color.toLowerCase() &&
        (word.textColor || null) === (textColor || null) &&
        Shared.wordStyle(word) === (style || 'background');
}

class Popup {
    constructor() {
        this.settings = Shared.sanitizeSettings(Shared.DEFAULT_SETTINGS);
        this.tab = null;               // { id, url }
        this.currentDomain = '';
        this.siteAvailable = false;
        this.access = null;            // lasting access to this site: true / false / null (unknown)
        this.counts = null;            // { total, words: { "<list>\u0001<word>": n } } for this tab
        this.editing = null;           // { list, text }: the entry open in the inline editor
        this.editDraft = null;
        this.filterText = '';
        this.pendingSaves = 0;
        this.init();
    }

    async init() {
        try {
            await this.loadTab();
            await this.loadSettings();
            this.setupEventListeners();
            this.setupPalette();
            this.render();
            if (this.loadFailed) {
                this.setReadOnly();
                return;
            }
            // Keep in sync with changes made on the Settings page while the popup is open
            chrome.storage.onChanged.addListener((changes, area) => this.onStorageChanged(changes, area));
            // A page reported new numbers of matches
            chrome.runtime.onMessage.addListener((message, sender) => {
                if (message && message.uhighlightCounts && sender.tab && this.tab && sender.tab.id === this.tab.id) {
                    this.scheduleCounts();
                }
            });
            await this.checkAccess();
            await this.updateHighlighting();
        } catch (error) {
            console.error('Error initializing popup:', error);
            this.loadFailed = true;
            try { this.render(); } catch (e) { /* as much as can be shown */ }
            this.setReadOnly();
        }
    }

    // Without the real settings, any save would replace them with the empty placeholder state,
    // so show an error and lock everything except the Settings button.
    setReadOnly() {
        this.loadFailed = true;
        const error = document.getElementById('loadError');
        error.textContent = 'Could not load your settings, so editing is turned off to protect them. ' +
            'Close and reopen this popup to try again.';
        error.hidden = false;
        document.querySelectorAll('input, button, select, textarea').forEach(el => {
            if (el.id !== 'openSettings') el.disabled = true;
        });
    }

    // The active tab, and its site when it is a web page (chrome://, edge://, file://, the Web
    // Store etc. can't be highlighted, so the toggle isn't offered there).
    async loadTab() {
        let label = 'Unknown';
        try {
            // ?tab=<id>: the popup opened as a page, for a given tab (tests)
            const forced = new URLSearchParams(location.search).get('tab');
            const [tab] = forced
                ? [await chrome.tabs.get(Number(forced))]
                : await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) this.tab = { id: tab.id, url: tab.url || '' };
            if (tab && tab.url) {
                if (!/^https?:/.test(tab.url)) {
                    label = 'N/A (System page)';
                } else {
                    const hostname = Shared.normalizeHostname(new URL(tab.url).hostname);
                    if (hostname) {
                        this.currentDomain = hostname;
                        this.siteAvailable = true;
                        label = hostname;
                    }
                }
            }
        } catch (error) {
            console.error('Error loading current tab:', error);
        }
        document.getElementById('currentDomain').textContent = label;
    }

    async loadSettings() {
        try {
            this.settings = await Shared.loadSettings();
        } catch (error) {
            console.error('Error loading settings:', error);
            this.loadFailed = true;
        }
    }

    onStorageChanged(changes, area) {
        if (!Shared.isSettingsChange(changes, area)) return;
        // While our own saves are in flight, storage may briefly hold an older state; re-sync
        // once they're done instead.
        if (this.pendingSaves > 0) {
            this.resyncAfterSave = true;
            return;
        }
        this.resync();
    }

    async resync() {
        let latest;
        try {
            latest = await Shared.loadSettings();
        } catch (error) {
            return;
        }
        if (this.pendingSaves > 0) {
            this.resyncAfterSave = true;
            return;
        }
        // Only redraw when something differs, so our own saves don't throw away text being
        // typed in the inline editor.
        if (JSON.stringify(latest) === JSON.stringify(this.settings)) return;
        const wordsChanged = JSON.stringify([latest.words, latest.lists]) !== JSON.stringify([this.settings.words, this.settings.lists]);
        this.settings = latest;
        if (wordsChanged && this.editing && !this.findEntry(this.editing.list, this.editing.text)) {
            this.editing = null;
            this.editDraft = null;
        }
        this.render(wordsChanged);
        this.checkAccess();
    }

    // ---------------------------------------------------------------- drawing

    render(wordsChanged = true) {
        this.updateOptionsUI();
        this.updateDomainUI();
        this.updateListChoice();
        if (wordsChanged || !this.editing) this.updateWordList();
        else this.updateCounts();
    }

    updateOptionsUI() {
        document.getElementById('caseSensitive').checked = this.settings.caseSensitive;
        document.getElementById('partialMatch').checked = this.settings.partialMatch;
        const badge = document.querySelector('#buttonOptions .fa-icon-badge');
        if (badge) {
            const on = [this.settings.caseSensitive, this.settings.partialMatch].filter(Boolean).length;
            badge.textContent = on ? String(on) : '';
        }
    }

    scope() {
        return Shared.pageScope(this.settings, this.tab && this.tab.url);
    }

    // The site pill shows whether highlighting runs on this site, and the status bar why.
    // Unticking excludes the site (or just drops its own "enabled" rule); a site excluded by a
    // "*." rule can only be changed in Settings.
    updateDomainUI() {
        const toggle = document.getElementById('domainToggle');
        const label = document.getElementById('domainToggleLabel');
        const hint = document.getElementById('domainHint');
        const s = this.settings;
        const showHint = text => {
            hint.textContent = text || '';
            hint.hidden = !text;
        };

        label.textContent = s.globalEnabled ? 'Enable on this site' : 'Enable for this domain';
        if (!this.siteAvailable) {
            toggle.checked = false;
            toggle.disabled = true;
            showHint('');
            this.updateAccessNotice();
            return;
        }

        const domain = this.currentDomain;
        const excludedBy = Shared.findSiteRule(domain, s.excludedDomains);
        const enabledBy = Shared.findSiteRule(domain, s.enabledDomains);
        // On when anything is highlighted here: My words, or a saved list by its address
        // pattern. Off stops all of it (the site is then excluded, when a list runs here).
        const scope = this.scope();
        const listsHere = scope.lists.filter(l => l.runs);
        toggle.checked = scope.defaultRuns || listsHere.length > 0;
        toggle.disabled = !!excludedBy && excludedBy !== domain;
        const byLists = listsHere.length > 0 && !scope.defaultRuns
            ? `On: ${listsHere.length === 1 ? `the list "${listsHere[0].name}" runs` : `${listsHere.length} saved lists run`} on this address. Untick to turn everything off on this site.`
            : '';

        if (excludedBy && excludedBy !== domain) {
            showHint(`Excluded by the rule ${excludedBy}. Change it in Settings.`);
        } else if (excludedBy) {
            showHint(s.globalEnabled
                ? 'Highlighting on all sites is on, but this site is excluded.'
                : 'This site is excluded.');
        } else if (s.globalEnabled) {
            showHint('On: highlighting on all websites is on. Untick to exclude this site.');
        } else if (enabledBy && enabledBy !== domain) {
            showHint(`On by the rule ${enabledBy}. Untick to exclude just this site.`);
        } else if (enabledBy) {
            showHint(`On by the rule ${enabledBy}.`);
        } else {
            showHint(byLists || this.relatedRuleHint(domain));
        }
        this.updateAccessNotice();
    }

    // Rules match exact hostnames, so "example.com" doesn't cover "www.example.com" (and vice
    // versa). Explain that instead of silently showing an unticked box.
    relatedRuleHint(domain) {
        const rules = Object.keys(this.settings.enabledDomains).filter(rule => !rule.startsWith('*.'));
        const parent = rules.find(rule => domain.endsWith('.' + rule));
        if (parent) {
            return `${parent} is in your list, but only covers that exact address. ` +
                `Tick to add this site, or use *.${parent} in Settings to include all its subdomains.`;
        }
        const www = rules.find(rule => rule === 'www.' + domain);
        if (www) {
            return `${www} is in your list, but this address has no "www.". Tick to add it too.`;
        }
        return '';
    }

    // ---------------------------------------------------------------- site access
    //
    // The extension only reads the sites it was allowed to. While the popup is open it may read
    // the current tab anyway (activeTab), so the page is highlighted now; the notice offers
    // lasting access, so it is highlighted on the next visits too.

    // The access this site needs: for the rule which turns it on, or for a list's pattern
    accessOrigins() {
        if (!this.siteAvailable) return [];
        const scope = this.scope();
        if (scope.excludedBy) return [];
        const needed = [];
        if (scope.defaultRuns) needed.push(...Shared.originsFor(scope.siteRule && scope.siteRule !== 'all websites' ? scope.siteRule : this.currentDomain));
        this.settings.lists.forEach(list => {
            const here = scope.lists.find(l => l.id === list.id);
            if (here && here.runs && list.urls.length > 0) needed.push(...Shared.originsFor(this.currentDomain));
        });
        return Array.from(new Set(needed));
    }

    async checkAccess() {
        const origins = this.accessOrigins();
        if (origins.length === 0) {
            this.access = null;
        } else {
            try {
                this.access = await chrome.permissions.contains({ origins });
            } catch (e) {
                this.access = null;
            }
        }
        this.updateAccessNotice();
    }

    updateAccessNotice() {
        const notice = document.getElementById('accessNotice');
        notice.hidden = !(this.access === false && this.accessOrigins().length > 0);
    }

    // Asks for lasting access to this site. Called right in a click handler: the browser only
    // asks the user in response to one. (The popup may close when the browser asks; the
    // background worker then starts highlighting in the site's open tabs.)
    requestAccess() {
        const origins = this.accessOrigins();
        if (origins.length === 0) return Promise.resolve(true);
        return chrome.permissions.request({ origins }).then(granted => {
            this.access = granted;
            this.updateAccessNotice();
            if (granted) this.updateHighlighting();
            return granted;
        }, () => false);
    }

    // ---------------------------------------------------------------- counts

    // Matches on this page, from every frame. Readable while the popup is open (activeTab).
    async loadCounts() {
        if (!this.tab || !this.siteAvailable) return;
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: this.tab.id, allFrames: true },
                func: () => (window.__wordHighlighter ? window.__wordHighlighter.counts() : null)
            });
            const counts = { total: 0, words: {} };
            results.forEach(({ result }) => {
                if (!result) return;
                counts.total += result.total;
                Object.entries(result.words).forEach(([key, n]) => { counts.words[key] = (counts.words[key] || 0) + n; });
            });
            this.counts = counts;
        } catch (e) {
            this.counts = null;   // can't read this page
        }
        this.updateCounts();
    }

    scheduleCounts() {
        clearTimeout(this.countsTimer);
        this.countsTimer = setTimeout(() => this.loadCounts(), 250);
    }

    countOf(list, text) {
        return this.counts ? this.counts.words[(list || '') + '\u0001' + text] || 0 : null;
    }

    // Updates the numbers without redrawing the list (which would close the inline editor)
    updateCounts() {
        document.querySelectorAll('#wordList .word-item[data-text]').forEach(row => {
            const pill = row.querySelector('.match-count');
            if (pill) this.fillCount(pill, this.countOf(row.dataset.list, row.dataset.text));
        });
        document.querySelectorAll('#wordList .group').forEach(group => {
            const pill = group.querySelector('.group-count');
            if (!pill) return;
            const words = this.wordsOf(group.dataset.list) || [];
            const sum = this.counts ? words.reduce((n, w) => n + (this.countOf(group.dataset.list, w.text) || 0), 0) : null;
            this.fillCount(pill, sum, true);
        });
        const total = document.getElementById('matchTotal');
        total.textContent = this.counts && this.counts.total > 0 ? plural(this.counts.total, 'match') : '';
        total.title = this.counts && this.counts.total > 0 ? 'On this page' : '';
    }

    fillCount(pill, count, forGroup = false) {
        pill.hidden = count === null;
        pill.textContent = count === null ? '' : String(count);
        pill.classList.toggle('zero', count === 0);
        pill.title = count === null ? '' : forGroup
            ? `${plural(count, 'match')} on this page`
            : count === 0 ? 'Not on this page' : `${plural(count, 'match')} on this page`;
    }

    // ---------------------------------------------------------------- events

    setupEventListeners() {
        const wordInput = document.getElementById('wordInput');
        const wordFilter = document.getElementById('wordFilter');

        wordFilter.addEventListener('input', () => {
            this.filterText = wordFilter.value;
            this.updateWordList();
        });
        wordFilter.addEventListener('keydown', e => {
            if (e.key === 'Escape' && wordFilter.value) {
                // Clear the filter (rather than closing the popup)
                e.preventDefault();
                e.stopPropagation();
                this.setFilter('');
            }
        });

        document.getElementById('addWord').addEventListener('click', () => this.addWord());
        wordInput.addEventListener('keydown', e => {
            // isComposing: don't add a half-typed word while an IME is composing
            if (e.key === 'Enter' && !e.isComposing) this.addWord();
        });
        // Pasting several lines: offer to add them all
        wordInput.addEventListener('paste', e => {
            const text = e.clipboardData && e.clipboardData.getData('text');
            if (text && /[\r\n]/.test(text.trim())) {
                e.preventDefault();
                this.openBulk(text);
            }
        });
        document.getElementById('addList').addEventListener('change', e => {
            this.addListId = e.target.value;
        });

        document.getElementById('openBulk').addEventListener('click', () => this.openBulk(''));
        document.getElementById('bulkCancel').addEventListener('click', () => this.closeBulk());
        document.getElementById('bulkAdd').addEventListener('click', () => this.addBulk());
        document.getElementById('bulkText').addEventListener('input', () => this.updateBulkCount());

        document.getElementById('caseSensitive').addEventListener('change', e => {
            this.change({ type: 'setOptions', values: { caseSensitive: e.target.checked } });
            const duplicates = this.caseDuplicates().size;
            this.showStatus(duplicates > 0
                ? `${plural(duplicates, 'entry')} only differ from another by case; only the first one's color is used.`
                : '');
            this.updateHighlighting();
        });
        document.getElementById('partialMatch').addEventListener('change', e => {
            this.change({ type: 'setOptions', values: { partialMatch: e.target.checked } });
            this.updateHighlighting();
        });

        document.getElementById('domainToggle').addEventListener('change', e => this.toggleCurrentSite(e.target.checked));
        document.getElementById('allowAccess').addEventListener('click', () => this.requestAccess());

        document.getElementById('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
        document.getElementById('gotoDashboard').addEventListener('click', e => {
            e.preventDefault();
            chrome.runtime.openOptionsPage();
        });
        document.getElementById('openResults').addEventListener('click', () => this.openResults());

        this.showShortcutHint();
    }

    // Mention the keyboard shortcut on the site pill (users can change it in Chrome).
    async showShortcutHint() {
        const label = document.getElementById('siteScope');
        try {
            const command = (await chrome.commands.getAll()).find(c => c.name === 'toggle-site');
            label.title = 'Turn highlighting on or off for this site\n' + (command && command.shortcut
                ? `Keyboard shortcut: ${command.shortcut}`
                : 'Tip: you can set a keyboard shortcut for this in Settings');
        } catch (e) {
            // Not important enough to report
        }
    }

    // The results panel: every match of this page, in the browser's side panel. Opened right
    // in the click handler (the browser only opens it in response to one).
    openResults() {
        if (!this.tab) return;
        chrome.sidePanel.open({ tabId: this.tab.id }).then(() => window.close(), error => {
            this.showStatus('Could not open the results: ' + error.message, { error: true });
        });
    }

    toggleCurrentSite(checked) {
        if (!this.siteAvailable) {
            this.updateDomainUI();
            return;
        }
        const domain = this.currentDomain;
        const change = { type: 'toggleSite', domain, on: checked, url: this.tab.url };
        const before = JSON.stringify([this.settings.enabledDomains, this.settings.excludedDomains]);
        const probe = this.snapshot();
        Shared.applyChange(probe, change);
        if (JSON.stringify([probe.enabledDomains, probe.excludedDomains]) !== before) {
            // Sent before asking for access: the popup may close while the browser asks
            this.change(change);
        }
        this.updateDomainUI();
        if (checked && document.getElementById('domainToggle').checked && this.access !== true) {
            this.requestAccess();
        }
        this.updateHighlighting();
    }

    // ---------------------------------------------------------------- adding words

    // Look controls of the "add" section: highlight swatches (new words default to a preset
    // that isn't used yet), text color, style, and a live preview of the result.
    setupPalette() {
        const container = document.getElementById('palette');
        const colorPicker = document.getElementById('colorPicker');
        const wordInput = document.getElementById('wordInput');

        const updatePreview = () => {
            const look = {
                color: colorPicker.value,
                textColor: this.addTextChoice.value,
                style: this.addStyleChoice.value
            };
            this.addPreview.update(wordInput.value, look);
            this.addTextChoice.refresh();
            this.addStyleChoice.refresh();
        };

        colorPicker.value = this.nextPresetColor();
        const palette = this.buildPalette(colorPicker, updatePreview);
        container.replaceWith(palette);
        palette.id = 'palette';

        this.addTextChoice = this.buildTextColorChoice(
            null, () => colorPicker.value, updatePreview,
            () => (this.addStyleChoice ? this.addStyleChoice.value : 'background'));
        document.getElementById('textColorChoice').replaceWith(this.addTextChoice.element);

        this.addStyleChoice = this.buildStyleChoice(
            'background', () => ({ color: colorPicker.value, textColor: this.addTextChoice.value }), updatePreview);
        document.getElementById('styleChoice').replaceWith(this.addStyleChoice.element);

        this.addPreview = this.buildPreview();
        this.addPreview.element.id = 'addPreview';
        document.getElementById('addPreview').replaceWith(this.addPreview.element);

        colorPicker.addEventListener('input', updatePreview);
        wordInput.addEventListener('input', updatePreview);
        this.updateAddPreview = updatePreview;
        updatePreview();
    }

    // The list new words go to: shown when there are saved lists
    updateListChoice() {
        const select = document.getElementById('addList');
        const lists = this.settings.lists;
        select.hidden = lists.length === 0;
        if (!lists.some(l => l.id === this.addListId)) this.addListId = '';
        select.textContent = '';
        const option = (value, text) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = text;
            select.appendChild(o);
        };
        option('', Shared.DEFAULT_LIST_NAME);
        lists.forEach(l => option(l.id, l.name));
        select.value = this.addListId || '';
    }

    currentLook() {
        return {
            color: document.getElementById('colorPicker').value,
            textColor: this.addTextChoice ? this.addTextChoice.value : null,   // null = automatic
            style: this.addStyleChoice ? this.addStyleChoice.value : 'background'
        };
    }

    addWord() {
        const wordInput = document.getElementById('wordInput');
        const colorPicker = document.getElementById('colorPicker');
        const word = Shared.sanitizeWords([{ text: wordInput.value }])[0];
        if (!word) return;
        const text = word.text;
        const list = this.addListId || '';
        const look = this.currentLook();
        const words = this.wordsOf(list);

        const existingIndex = Shared.findWordIndex(words, text, this.settings.caseSensitive);
        const isNew = existingIndex === -1;
        const existing = isNew ? null : words[existingIndex];
        const unchangedLook = !isNew && sameLook(existing, look.color, look.textColor, look.style);
        const wasPaused = !isNew && !!existing.paused;

        // An existing (or paused) entry gets the new look and is resumed: see applyChange()
        this.change({ type: 'addWord', list, text, look });

        if (isNew) {
            // Move on to a fresh color (with automatic text) so consecutive words are easy to
            // tell apart. The style is kept: it's more of a general preference.
            colorPicker.value = this.nextPresetColor();
            if (this.addTextChoice) this.addTextChoice.reset();
            colorPicker.dispatchEvent(new Event('input'));
        }
        wordInput.value = '';
        this.updateAddPreview();
        // Don't let the filter hide the word that was just added
        if (!this.matchesFilter({ text })) this.setFilter('');
        this.updateHighlighting();

        if (isNew) {
            this.showStatus('');
        } else {
            // Say what happened instead of silently recoloring the existing entry
            const done = [];
            if (!unchangedLook) done.push('look updated');
            if (wasPaused) done.push('turned back on');
            this.showStatus(done.length
                ? `"${existing.text}" is already in the list — ${done.join(', ')}.`
                : `"${existing.text}" is already in the list.`);
            const row = this.rowOf(list, existing.text);
            if (row) {
                row.classList.add('flash');
                row.scrollIntoView({ block: 'nearest' });
            }
        }
    }

    // ---------------------------------------------------------------- pasting many words

    openBulk(text) {
        const area = document.getElementById('bulkText');
        document.getElementById('bulkPane').hidden = false;
        area.value = text;
        this.updateBulkCount();
        area.focus();
    }

    closeBulk() {
        document.getElementById('bulkPane').hidden = true;
        document.getElementById('bulkText').value = '';
    }

    bulkLines() {
        const seen = new Set();
        return document.getElementById('bulkText').value
            .split(/\r?\n/)
            .map(line => line.trim().replace(/\s+/g, ' '))
            .filter(line => line && !seen.has(line) && seen.add(line));
    }

    updateBulkCount() {
        const lines = this.bulkLines();
        const button = document.getElementById('bulkAdd');
        button.textContent = lines.length > 0 ? `Add ${plural(Math.min(lines.length, MAX_BULK), 'word')}` : 'Add';
        button.disabled = lines.length === 0;
    }

    addBulk() {
        const lines = this.bulkLines().slice(0, MAX_BULK);
        if (lines.length === 0) return;
        const list = this.addListId || '';
        const before = this.wordsOf(list).length;
        const cycleColors = document.getElementById('bulkColors').checked;
        const done = this.change({ type: 'addWords', list, texts: lines, look: this.currentLook(), cycleColors },
            { undo: true });
        if (!done) return;
        const added = this.wordsOf(list).length - before;
        this.closeBulk();
        this.updateHighlighting();
        this.showStatus(added === lines.length
            ? `Added ${plural(added, 'word')}.`
            : `Added ${plural(added, 'word')}; ${lines.length - added} ${lines.length - added === 1 ? 'was' : 'were'} already in the list.`, { undo: added > 0 });
    }

    // ---------------------------------------------------------------- status bar

    // A message in the status bar: `error` in red, `undo` with an Undo button (for a while)
    showStatus(message, { error = false, undo = false } = {}) {
        const status = document.getElementById('addStatus');
        const text = document.getElementById('addStatusText');
        const undoButton = document.getElementById('undoButton');
        clearTimeout(this.statusTimer);
        text.textContent = message;
        status.hidden = !message;
        status.classList.toggle('error', !!message && error);
        // Shown once the background worker has said how to undo (see change())
        this.statusWantsUndo = !!(message && undo);
        undoButton.hidden = !(this.statusWantsUndo && this.undoChange);
        if (!message) return;
        // Errors stay until the next message: they say what wasn't saved
        if (!error) {
            this.statusTimer = setTimeout(() => {
                status.hidden = true;
                this.undoChange = null;
                this.statusWantsUndo = false;
            }, undo ? UNDO_MS : 4000);
        }
    }

    // Undoes the last removal or addition, and only it (see Shared.inverseOf())
    undo() {
        const change = this.undoChange;
        this.undoChange = null;
        if (!change) return;
        this.change(change);
        this.updateHighlighting();
        this.showStatus('Undone.');
    }

    // ---------------------------------------------------------------- the word lists

    // The words of a list ('' for My words); null if the list no longer exists
    wordsOf(list) {
        if (!list) return this.settings.words;
        const found = this.settings.lists.find(l => l.id === list);
        return found ? found.words : null;
    }

    findEntry(list, text) {
        const words = this.wordsOf(list);
        return words ? words.find(w => w.text === text) : null;
    }

    rowOf(list, text) {
        return Array.from(document.querySelectorAll('#wordList .word-item')).find(row =>
            row.dataset.list === (list || '') && row.dataset.text === text) || null;
    }

    removeWord(list, text) {
        if (this.editing && this.editing.list === list && this.editing.text === text) {
            this.editing = null;
            this.editDraft = null;
        }
        if (!this.change({ type: 'removeWord', list, text }, { undo: true })) return;
        this.updateHighlighting();
        this.showStatus(`Removed "${text}".`, { undo: true });
    }

    // Quick highlight-color change from the list (keeps the word's text color choice).
    changeWordColor(list, text, color, chip) {
        const word = this.findEntry(list, text);
        this.change({ type: 'setWordColor', list, text, color }, { redraw: false });
        if (chip && word) styleChip(chip, { ...word, color });
        this.updateHighlighting();
    }

    setPaused(list, text, paused) {
        this.change({ type: 'setPaused', list, text, paused });
        this.updateHighlighting();
    }

    startEdit(list, text) {
        this.editing = { list, text };
        this.editDraft = null;
        this.updateWordList();
    }

    cancelEdit() {
        this.editing = null;
        this.editDraft = null;
        this.updateWordList();
    }

    // Returns an error message, or null when the edit was saved. `textColor` null = automatic.
    saveEdit(list, original, rawText, color, textColor = null, style = 'background') {
        const text = (rawText || '').trim().replace(/\s+/g, ' ');
        if (!text) return 'Entry cannot be empty';
        const words = this.wordsOf(list) || [];
        const index = words.findIndex(w => w.text === original.text);
        if (Shared.findWordIndex(words, text, this.settings.caseSensitive, index) !== -1) {
            return `"${text}" is already in the list`;
        }
        const changed = original.text !== text || !sameLook(original, color, textColor, style);
        this.editing = null;
        this.editDraft = null;
        if (changed) {
            // Checked again when it is saved, against the stored list: another popup may have
            // just given another entry the same name.
            this.change({ type: 'editWord', list, text: original.text, newText: text, look: { color, textColor, style } });
            this.updateHighlighting();
        } else {
            this.updateWordList();
        }
        return null;
    }

    // Entries that, with case sensitivity off, repeat an earlier active entry of the same list
    // ("Browser" after "browser"). Pages use the first one's color, so these are marked in the
    // list. Paused entries don't count. Keys: "<list>\u0001<text>".
    caseDuplicates() {
        const duplicates = new Set();
        if (this.settings.caseSensitive) return duplicates;
        const check = (list, words) => {
            const seen = new Set();
            words.forEach(word => {
                if (word.paused) return;
                const key = word.text.toLowerCase();
                if (seen.has(key)) duplicates.add(list + '\u0001' + word.text);
                seen.add(key);
            });
        };
        check('', this.settings.words);
        this.settings.lists.forEach(l => check(l.id, l.words));
        return duplicates;
    }

    setFilter(text) {
        this.filterText = text;
        document.getElementById('wordFilter').value = text;
        this.updateWordList();
    }

    matchesFilter(word) {
        const query = (this.filterText || '').trim().toLowerCase();
        return !query || word.text.toLowerCase().includes(query);
    }

    totalWords() {
        return this.settings.words.length + this.settings.lists.reduce((n, l) => n + l.words.length, 0);
    }

    // The filter box only shows up once the lists are long enough to need it
    updateFilterRow(shown) {
        const row = document.getElementById('filterRow');
        const count = document.getElementById('filterCount');
        const total = this.totalWords();
        const filtering = !!(this.filterText || '').trim();
        row.hidden = !(total >= FILTER_MIN_WORDS || filtering);
        count.textContent = filtering ? `${shown} of ${total}` : '';
    }

    updateWordCount() {
        const total = this.totalWords();
        const paused = [this.settings.words, ...this.settings.lists.map(l => l.words)]
            .reduce((n, words) => n + words.filter(w => w.paused).length, 0);
        document.getElementById('wordCount').textContent = total === 0 ? '' :
            plural(total, 'word') + (paused ? ` · ${paused} paused` : '');
    }

    // Groups: My words, then each saved list, with whether it runs on this page and why.
    updateWordList() {
        const wordList = document.getElementById('wordList');
        wordList.textContent = '';
        const duplicates = this.caseDuplicates();
        const scope = this.scope();
        const filtering = !!(this.filterText || '').trim();
        let shown = 0;

        const groups = [{ list: '', name: Shared.DEFAULT_LIST_NAME, words: this.settings.words, saved: null }]
            .concat(this.settings.lists.map(l => ({ list: l.id, name: l.name, words: l.words, saved: l })));
        const withLists = groups.length > 1;

        groups.forEach(group => {
            const rows = [];
            // Built with DOM APIs rather than innerHTML: word text and colors can come from an
            // imported settings file, so they must never be parsed as markup.
            group.words.forEach(word => {
                const editing = this.editing && this.editing.list === group.list && this.editing.text === word.text;
                if (!editing && !this.matchesFilter(word)) return;
                rows.push(editing ? this.buildEditRow(group.list, word) : this.buildRow(group.list, word, duplicates));
            });
            shown += rows.length;
            if (filtering && rows.length === 0) return;

            if (withLists) wordList.appendChild(this.buildGroupHeader(group, scope));
            if (rows.length === 0 && withLists) {
                const empty = document.createElement('div');
                empty.className = 'group-empty';
                empty.textContent = 'No words yet.';
                wordList.appendChild(empty);
            }
            rows.forEach(row => wordList.appendChild(row));
        });

        if (shown === 0 && this.totalWords() > 0 && filtering) {
            const empty = document.createElement('div');
            empty.className = 'no-matches';
            empty.textContent = `No words match "${this.filterText.trim()}"`;
            wordList.appendChild(empty);
        }
        if (this.totalWords() === 0 && !withLists) wordList.textContent = '';   // :empty message
        this.updateFilterRow(shown);
        this.updateWordCount();
        this.updateCounts();
    }

    buildGroupHeader(group, scope) {
        const header = document.createElement('div');
        header.className = 'group';
        header.dataset.list = group.list;

        let runs;
        let why;
        if (!group.saved) {
            runs = scope.defaultRuns;
            why = !this.siteAvailable ? 'not a web page'
                : scope.excludedBy ? `excluded by ${scope.excludedBy}`
                : runs ? `on here (${scope.siteRule})` : 'off for this site';
        } else {
            const here = scope.lists.find(l => l.id === group.list) || { runs: false, why: '' };
            runs = here.runs;
            why = here.why;
        }
        header.classList.toggle('runs', !!runs);

        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = group.name;
        const state = document.createElement('span');
        state.className = 'group-state';
        state.textContent = why;
        state.title = why;
        const count = document.createElement('span');
        count.className = 'group-count match-pill';
        count.hidden = true;

        const text = document.createElement('div');
        text.className = 'group-text';
        text.append(name, state);
        header.append(text, count);

        if (group.saved && this.siteAvailable) {
            const pick = UI.iconButton('crosshairs',
                group.saved.section ? `Pick another section for "${group.name}" (now: ${group.saved.section})`
                    : `Pick a section of the page for "${group.name}"`, 'pick');
            pick.addEventListener('click', () => this.pickSection(group.saved));
            header.appendChild(pick);
        }
        return header;
    }

    buildRow(list, word, duplicates) {
        const row = document.createElement('div');
        row.className = 'word-item';
        row.dataset.list = list;
        row.dataset.text = word.text;

        // The word is shown the way it looks when highlighted on a page
        const text = document.createElement('span');
        text.className = 'word-text';
        const chip = document.createElement('span');
        chip.className = 'word-chip';
        chip.textContent = word.text;
        styleChip(chip, word);
        text.appendChild(chip);
        text.title = word.text + ' (double-click to edit)';
        text.addEventListener('dblclick', () => this.startEdit(list, word.text));

        // Tick box: highlight this word or not (keeps it in the list either way)
        const active = document.createElement('input');
        active.type = 'checkbox';
        active.className = 'word-active cell';
        active.checked = !word.paused;
        active.title = word.paused ? 'Paused: tick to highlight this word again' : 'Untick to pause this word';
        active.setAttribute('aria-label', `Highlight "${word.text}"`);
        active.addEventListener('change', () => this.setPaused(list, word.text, !active.checked));
        if (word.paused) {
            row.classList.add('paused');
            text.title = `${word.text} (paused)`;
        }
        if (duplicates.has(list + '\u0001' + word.text)) {
            row.classList.add('duplicate');
            text.title = 'Same as an earlier entry while case sensitivity is off, so this entry\'s ' +
                'color isn\'t used. Remove it or turn on "Case sensitive".';
        }

        const count = document.createElement('span');
        count.className = 'match-count match-pill';
        count.hidden = true;

        // Quick color change without opening the editor
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'word-color';
        colorInput.value = word.color;
        colorInput.title = 'Change highlight color';
        colorInput.addEventListener('change', e => this.changeWordColor(list, word.text, e.target.value, chip));

        const controls = document.createElement('div');
        controls.className = 'word-controls';
        const editBtn = UI.iconButton('pencil', `Edit "${word.text}"`, 'edit');
        editBtn.addEventListener('click', () => this.startEdit(list, word.text));
        const removeBtn = UI.iconButton('trash-o', `Remove "${word.text}"`, 'remove');
        removeBtn.addEventListener('click', () => this.removeWord(list, word.text));
        controls.append(editBtn, removeBtn);

        row.append(active, text, count, colorInput, controls);
        return row;
    }

    buildEditRow(list, word) {
        const row = document.createElement('div');
        row.className = 'word-item editing';
        row.dataset.list = list;
        row.dataset.text = word.text;

        // Unsaved edits survive the list being redrawn (e.g. pausing another word)
        const draft = this.editDraft || {
            text: word.text,
            color: word.color,
            textColor: word.textColor || null,
            style: Shared.wordStyle(word)
        };

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'edit-text field';
        textInput.value = draft.text;
        textInput.setAttribute('aria-label', 'Entry text');
        textInput.title = 'Enter to save, Esc to cancel';

        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'word-color';
        colorInput.value = draft.color;
        colorInput.title = 'Custom highlight color';

        const preview = this.buildPreview();
        let styleChoice = null;   // created after textChoice, which already asks for the style
        const updatePreview = () => {
            const look = { color: colorInput.value, textColor: textChoice.value, style: styleChoice.value };
            preview.update(textInput.value, look);
            textChoice.refresh();
            styleChoice.refresh();
            this.editDraft = { text: textInput.value, ...look };
        };
        const textChoice = this.buildTextColorChoice(
            draft.textColor, () => colorInput.value, updatePreview,
            () => (styleChoice ? styleChoice.value : draft.style));
        styleChoice = this.buildStyleChoice(
            draft.style, () => ({ color: colorInput.value, textColor: textChoice.value }), updatePreview);
        const palette = this.buildPalette(colorInput, updatePreview);
        colorInput.addEventListener('input', updatePreview);

        const error = document.createElement('div');
        error.className = 'edit-error';
        error.hidden = true;

        const save = () => {
            const message = this.saveEdit(list, word, textInput.value, colorInput.value, textChoice.value, styleChoice.value);
            if (message) {
                error.textContent = message;
                error.hidden = false;
                textInput.classList.add('invalid');
                textInput.focus();
            }
        };

        const controls = document.createElement('div');
        controls.className = 'word-controls';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn primary';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', save);
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => this.cancelEdit());

        textInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.isComposing) {
                save();
            } else if (e.key === 'Escape') {
                // Cancel the edit (rather than closing the popup)
                e.preventDefault();
                e.stopPropagation();
                this.cancelEdit();
            }
        });
        textInput.addEventListener('input', () => {
            error.hidden = true;
            textInput.classList.remove('invalid');
            updatePreview();
        });

        controls.append(saveBtn, cancelBtn);
        row.append(
            textInput,
            controls,
            this.colorRow('Highlight', colorInput, palette),
            this.colorRow('Text', textChoice.element),
            this.colorRow('Style', styleChoice.element),
            preview.element,
            error
        );
        updatePreview();
        setTimeout(() => {
            textInput.focus();
            textInput.select();
        }, 0);
        return row;
    }

    // ---------------------------------------------------------------- "Pick a section"

    // Lets the user point at the part of the page a saved list should be limited to. Runs in
    // the page; the popup closes so that the page can be clicked.
    async pickSection(list) {
        if (!this.tab) return;
        try {
            await this.ensureContentScript();
            const [result] = await chrome.scripting.executeScript({
                target: { tabId: this.tab.id, frameIds: [0] },
                func: (id, name) => !!(window.__wordHighlighter && window.__wordHighlighter.startPicker(id, name)),
                args: [list.id, list.name]
            });
            if (result && result.result) {
                window.close();
            } else {
                this.showStatus("Couldn't start picking on this page.", { error: true });
            }
        } catch (error) {
            this.showStatus("Couldn't start picking on this page: " + error.message, { error: true });
        }
    }

    // ---------------------------------------------------------------- look controls

    // Text color choice: Auto (with a background: black or white, whichever reads better; with
    // an underline: the page's own text color), black, white, or a custom color.
    // `value` is null for Auto.
    buildTextColorChoice(initial, getBackground, onChange, getStyle = () => 'background') {
        const box = document.createElement('div');
        box.className = 'text-choice';
        let value = Shared.isValidColor(initial) ? initial.toLowerCase() : null;

        const button = (className, label, title) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = className;
            b.textContent = label;
            b.title = title;
            b.setAttribute('aria-label', title);
            return b;
        };
        const auto = button('text-auto', 'Auto', '');
        const black = button('swatch-black', '', 'Black text');
        const white = button('swatch-white', '', 'White text');
        const custom = document.createElement('input');
        custom.type = 'color';
        custom.className = 'word-color text-custom';
        custom.title = 'Custom text color';
        custom.value = value && value !== '#000000' && value !== '#ffffff' ? value : '#cc0000';

        const refresh = () => {
            auto.classList.toggle('selected', value === null);
            black.classList.toggle('selected', value === '#000000');
            white.classList.toggle('selected', value === '#ffffff');
            custom.classList.toggle('selected', value !== null && value !== '#000000' && value !== '#ffffff');
            if (getStyle() === 'background') {
                const resolved = Shared.autoTextColor(getBackground());
                auto.title = `Automatic (currently ${resolved === '#000000' ? 'black' : 'white'} on this highlight color)`;
            } else {
                auto.title = "Automatic (keeps the page's own text color)";
            }
            auto.setAttribute('aria-label', auto.title);
        };
        const set = next => {
            value = next;
            refresh();
            if (onChange) onChange();
        };
        auto.addEventListener('click', () => set(null));
        black.addEventListener('click', () => set('#000000'));
        white.addEventListener('click', () => set('#ffffff'));
        custom.addEventListener('input', () => set(custom.value.toLowerCase()));

        box.append(auto, black, white, custom);
        refresh();
        return {
            element: box,
            get value() { return value; },
            reset() { value = null; refresh(); },
            refresh
        };
    }

    // Style choice: background / underline / wavy underline. Each button shows a sample in the
    // current colors.
    buildStyleChoice(initial, getLook, onChange) {
        const box = document.createElement('div');
        box.className = 'style-choice';
        let value = STYLES.some(s => s.value === initial) ? initial : 'background';

        const buttons = STYLES.map(style => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.style = style.value;
            b.title = style.name;
            b.setAttribute('aria-label', style.name);
            const sample = document.createElement('span');
            sample.className = 'style-sample';
            sample.textContent = 'abc';
            b.appendChild(sample);
            b.addEventListener('click', () => {
                value = style.value;
                refresh();
                if (onChange) onChange();
            });
            box.appendChild(b);
            return b;
        });

        const refresh = () => {
            const look = getLook();
            buttons.forEach(b => {
                b.classList.toggle('selected', b.dataset.style === value);
                styleChip(b.firstChild, { ...look, style: b.dataset.style });
            });
        };
        refresh();
        return {
            element: box,
            get value() { return value; },
            refresh
        };
    }

    // A line of sample text showing how the word will look when highlighted on a page.
    buildPreview() {
        const box = document.createElement('div');
        box.className = 'preview';
        const label = document.createElement('span');
        label.className = 'preview-label';
        label.textContent = 'Preview:';
        const word = document.createElement('span');
        word.className = 'preview-word';
        box.append(label, document.createTextNode('text with '), word, document.createTextNode(' in it'));
        return {
            element: box,
            // look: { color, textColor (null = auto), style }
            update(text, look) {
                const shown = text.trim().replace(/\s+/g, ' ');
                word.textContent = shown || 'your word';
                styleChip(word, look);
                box.title = `How "${word.textContent}" will look on a page`;
            }
        };
    }

    colorRow(label, ...children) {
        const row = document.createElement('div');
        row.className = 'color-row';
        const text = document.createElement('span');
        text.className = 'color-label';
        text.textContent = label;
        row.append(text, ...children);
        return row;
    }

    // Builds a row of preset swatches bound to a color <input>: clicking a swatch sets the input,
    // and the selected swatch follows the input when a custom color is picked.
    buildPalette(colorInput, onPick) {
        const palette = document.createElement('div');
        palette.className = 'palette';
        const swatches = PRESET_COLORS.map(preset => {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = 'swatch';
            swatch.style.backgroundColor = preset.value;
            swatch.title = preset.name;
            swatch.setAttribute('aria-label', preset.name);
            swatch.dataset.color = preset.value;
            swatch.addEventListener('click', () => {
                colorInput.value = preset.value;
                markSelected();
                if (onPick) onPick(preset.value);
            });
            palette.appendChild(swatch);
            return swatch;
        });
        const markSelected = () => {
            const current = colorInput.value.toLowerCase();
            swatches.forEach(s => s.classList.toggle('selected', s.dataset.color === current));
        };
        colorInput.addEventListener('input', markSelected);
        markSelected();
        return palette;
    }

    // First preset not used by any entry of the chosen list yet; cycles once all are taken.
    nextPresetColor() {
        return Shared.nextPresetColor(this.wordsOf(this.addListId || '') || this.settings.words);
    }

    // ---------------------------------------------------------------- saving

    // A copy of our settings, sanitized like stored ones (site lists without a prototype, so a
    // site called "__proto__" is an entry like any other).
    snapshot() {
        const copy = Shared.sanitizeSettings(JSON.parse(JSON.stringify(this.settings)));
        // Keep each list's place (synced or on this device): sanitizeSettings keeps it
        return copy;
    }

    // Shows a change at once (applied to our copy), and hands it to the background worker,
    // which makes it on the *latest stored* settings: a change made on the Settings page (or
    // synced from another device) a moment earlier isn't overwritten by our older copy, and
    // closing the popup can't cancel a change it has already shown.
    // `undo`: keep the change which undoes this one, for the Undo button. Returns false when the change
    // can't be made (the reason is shown).
    change(change, { undo = false, redraw = true } = {}) {
        if (this.loadFailed) return false;
        const before = this.snapshot();
        const mine = this.snapshot();
        let values;
        try {
            values = Shared.applyChange(mine, change, { checkExpect: false });
            // The revisions the background worker gives the change (so our copy stays the same
            // as the stored settings, and isn't redrawn when they come back)
            if (Object.keys(values).length > 0) Shared.bumpRevisions(Shared.sanitizeSettings(before), mine, values);
        } catch (error) {
            this.showStatus(error.message, { error: true });
            return false;
        }
        // The undo comes from the background worker, made from what it actually changed
        // in the stored settings (nothing, if another page had made the same change already)
        let token = null;
        if (undo) {
            token = this.undoToken = {};
            this.undoChange = null;
        }
        this.settings = mine;
        if (redraw) this.render();
        this.trackSave(() => Shared.commit(change).then(result => {
            if (token && token === this.undoToken) {
                this.undoChange = result.inverse;
                document.getElementById('undoButton').hidden = !(this.statusWantsUndo && this.undoChange);
            }
            return result;
        }));
        return true;
    }

    trackSave(write) {
        this.pendingSaves++;
        this.lastSave = write().then(() => true, error => {
            // e.g. the 100 KB total chrome.storage.sync quota
            console.error('Error saving settings:', error);
            this.showStatus('Not saved: ' + error.message, { error: true });
            return false;
        }).then(saved => {
            this.pendingSaves--;
            if (this.pendingSaves === 0 && (this.resyncAfterSave || !saved)) {
                // Pick up changes made elsewhere meanwhile, or show what's really stored
                // after a failed save.
                this.resyncAfterSave = false;
                this.resync();
            }
            return saved;
        });
        return this.lastSave;
    }

    // ---------------------------------------------------------------- the page

    // Content scripts pick up saved settings via chrome.storage.onChanged (in every tab). This
    // only makes sure the active tab actually has a live content script: it won't if the tab
    // was opened before the extension was installed or allowed on the site. While the popup is
    // open, the extension may run in the tab (activeTab).
    async ensureContentScript() {
        const tab = this.tab;
        if (!tab || !/^https?:/.test(tab.url || '')) return false;
        // Ask the top frame only: a frame could have a live script while the page doesn't
        const alive = await chrome.tabs.sendMessage(tab.id, { action: 'ping' }, { frameId: 0 })
            .then(response => !!(response && response.ok))
            .catch(() => false);
        if (!alive) {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: ['shadow-hook.js'],
                world: 'MAIN'
            }).catch(() => {});
            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: true },
                files: CONTENT_SCRIPT_FILES
            });
        }
        return true;
    }

    async updateHighlighting() {
        try {
            await this.lastSave;
            await this.ensureContentScript();
        } catch (error) {
            console.error('Error updating highlighting:', error);
        }
        // The page rescans when the settings change: count once it has
        this.scheduleCounts();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const popup = new Popup();
    window.uhPopup = popup;
    document.getElementById('undoButton').addEventListener('click', () => popup.undo());
});
