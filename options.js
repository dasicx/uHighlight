// uHighlight settings page: options, websites (with access), saved lists (with a page tester),
// import (with a preview: merge or replace) and export, undo.

const Shared = globalThis.WordHighlighterShared; // from shared.js
const UI = globalThis.WordHighlighterUI;         // from ui.js
const Theme = globalThis.WordHighlighterTheme;   // from theme.js

const PANES = ['settings', 'websites', 'lists', 'about'];
const MAX_BULK = 500;
const UNDO_MS = 15000;

// "2 matches", "2 entries", "2 words"
const plural = (count, noun) => `${count} ${count === 1 ? noun
    : /(s|x|ch|sh)$/.test(noun) ? noun + 'es'
    : /[^aeiou]y$/.test(noun) ? noun.slice(0, -1) + 'ies'
    : noun + 's'}`;
const listOfLines = text => text.split(/\r?\n/).map(l => l.trim().replace(/\s+/g, ' ')).filter(Boolean);

class SettingsPage {
    constructor() {
        this.settings = Shared.sanitizeSettings(Shared.DEFAULT_SETTINGS);
        this.statusTimer = null;
        this.pendingSaves = 0;
        this.undoChange = null;
        this.init();
    }

    async init() {
        this.setupTabs();
        this.setupAppearance();
        this.setupAbout();
        this.setupEventListeners();
        try {
            this.settings = await Shared.loadSettings();
        } catch (error) {
            // Changes re-read storage first, so they'll fail safely too. Importing a backup (or
            // clearing the words) writes fresh data and repairs things.
            this.loadError = true;
            this.showStatus('Could not load settings: ' + error.message +
                ' Reload this page in a moment; if it keeps happening, import a backup to repair them.', { error: true });
        }
        this.render();

        // The popup (or another settings tab) may change things while this page is open
        chrome.storage.onChanged.addListener((changes, area) => {
            if (!Shared.isSettingsChange(changes, area)) return;
            // While our own saves are in flight, storage may briefly hold an older state
            if (this.pendingSaves > 0) {
                this.resyncAfterSave = true;
                return;
            }
            this.resync();
        });
        chrome.permissions.onAdded.addListener(() => this.updateAccess());
        chrome.permissions.onRemoved.addListener(() => this.updateAccess());
    }

    async resync() {
        try {
            const latest = await Shared.loadSettings();
            if (this.pendingSaves > 0) {
                this.resyncAfterSave = true;
                return;
            }
            const listsChanged = JSON.stringify(latest.lists) !== JSON.stringify(this.settings.lists);
            this.settings = latest;
            this.render(listsChanged);
            if (this.loadError) {
                // e.g. the missing pieces have finished syncing
                this.loadError = false;
                document.getElementById('status').hidden = true;
            }
        } catch (error) {
            // Keep showing the current state
        }
    }

    // The tabs at the top: one pane at a time, as told by the address (#settings,
    // #websites, #lists, #about), so that links and the back button work.
    setupTabs() {
        const show = () => {
            const name = location.hash.slice(1);
            const pane = PANES.includes(name) ? name : 'settings';
            PANES.forEach(p => { document.getElementById('pane-' + p).hidden = p !== pane; });
            document.querySelectorAll('.tabButton').forEach(tab => {
                const selected = tab.dataset.pane === pane;
                tab.classList.toggle('selected', selected);
                if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
            });
            window.scrollTo(0, 0);
        };
        window.addEventListener('hashchange', show);
        show();
    }

    // The theme is kept by theme.js, for every page of the extension
    setupAppearance() {
        const select = document.getElementById('theme');
        select.value = Theme.get();
        select.addEventListener('change', () => Theme.set(select.value));
        // Changed in another settings tab
        window.addEventListener('storage', (e) => {
            if (e.key === 'theme') select.value = Theme.get();
        });
    }

    setupAbout() {
        try {
            document.getElementById('aboutDescription').textContent = chrome.runtime.getManifest().description;
        } catch (e) {
            // Not in the extension
        }
    }

    setupEventListeners() {
        document.getElementById('globalEnabled').addEventListener('change', e => {
            const on = e.target.checked;
            this.change({ type: 'setOptions', values: { globalEnabled: on } });
            // Every website: ask for access to all of them (right in the click handler)
            if (on) this.requestAccess(Shared.ALL_ORIGINS);
        });
        document.getElementById('showBadge').addEventListener('change', e => {
            this.change({ type: 'setOptions', values: { showBadge: e.target.checked } });
        });

        document.querySelectorAll('.add-site[data-list]').forEach(form => {
            const input = form.querySelector('input');
            const error = form.nextElementSibling;
            form.addEventListener('submit', e => {
                e.preventDefault();
                const message = this.addSite(form.dataset.list, input.value);
                if (message) {
                    error.textContent = message;
                    error.hidden = false;
                    input.classList.add('invalid');
                } else {
                    input.value = '';
                }
                input.focus();
            });
            input.addEventListener('input', () => {
                error.hidden = true;
                input.classList.remove('invalid');
            });
        });
        document.getElementById('allowSites').addEventListener('click', () => this.requestAccess(this.missingOrigins || []));

        document.getElementById('exportSettings').addEventListener('click', () => this.exportSettings());
        document.getElementById('importSettings').addEventListener('click', () => {
            document.getElementById('importFile').click();
        });
        document.getElementById('importFile').addEventListener('change', e => this.importSettings(e));
        document.getElementById('clearWords').addEventListener('click', () => this.clearWords());
        document.getElementById('undoButton').addEventListener('click', () => this.undo());

        // Lists
        document.getElementById('newList').addEventListener('click', () => this.newList());
        document.getElementById('testForm').addEventListener('submit', e => {
            e.preventDefault();
            this.renderTest();
        });
        document.getElementById('myWordsAdd').addEventListener('click', () => {
            const area = document.getElementById('myWordsBulk');
            const text = area.value;
            area.value = '';
            if (!this.addWords('', text, area.id)) area.value = text;
        });

        // Chrome owns keyboard shortcuts; its own page is where they're changed
        document.getElementById('changeShortcut').addEventListener('click', () => {
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        });
        this.showShortcut();
        window.addEventListener('focus', () => this.showShortcut());   // after changing it
    }

    async showShortcut() {
        const key = document.getElementById('shortcutKey');
        try {
            const command = (await chrome.commands.getAll()).find(c => c.name === 'toggle-site');
            key.textContent = command && command.shortcut ? command.shortcut : 'not set';
        } catch (e) {
            key.textContent = 'not set';
        }
    }

    // ---------------------------------------------------------------- drawing

    render(listsChanged = true) {
        const global = this.settings.globalEnabled;
        document.getElementById('globalEnabled').checked = global;
        document.getElementById('showBadge').checked = this.settings.showBadge;

        // The enabled list doesn't matter in all-sites mode; exclusions always apply.
        document.getElementById('enabledPanel').classList.toggle('inactive', global);
        document.getElementById('enabledInactive').hidden = !global;

        this.renderList('enabledList', 'enabledDomains',
            'No websites yet. You can also enable the current site from the toolbar popup.');
        this.renderList('excludedList', 'excludedDomains', 'No excluded websites.');
        document.getElementById('myWordsCount').textContent =
            `${plural(this.settings.words.length, 'word')}. They run wherever highlighting is on for the site (see Websites).`;
        this.renderMyWords();
        if (listsChanged) this.renderLists();
        if (document.getElementById('testUrl').value.trim()) this.renderTest();
        this.updateAccess();
    }

    renderList(listId, key, emptyText) {
        const list = document.getElementById(listId);
        list.textContent = '';
        const rules = Object.keys(this.settings[key]).sort((a, b) =>
            this.sortKey(a).localeCompare(this.sortKey(b)));
        if (rules.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'empty';
            empty.textContent = emptyText;
            list.appendChild(empty);
            return;
        }
        rules.forEach(rule => {
            const item = document.createElement('li');
            item.dataset.rule = rule;
            const name = document.createElement('span');
            name.className = 'site-name';
            if (rule.startsWith('*.')) {
                const wildcard = document.createElement('span');
                wildcard.className = 'wildcard';
                wildcard.textContent = '*.';
                name.append(wildcard, rule.slice(2));
            } else {
                name.textContent = rule;
            }
            name.title = rule.startsWith('*.') ? `${rule.slice(2)} and all of its subdomains` : 'This exact site';
            const access = document.createElement('span');
            access.className = 'site-access';
            const remove = UI.iconButton('trash-o', `Remove ${rule}`);
            remove.addEventListener('click', () => this.removeSite(key, rule));
            item.append(name, access, remove);
            list.appendChild(item);
        });
    }

    // Sort "*.example.com" next to "example.com"
    sortKey(rule) {
        return rule.startsWith('*.') ? rule.slice(2) + ' *' : rule;
    }

    // ---------------------------------------------------------------- site access
    //
    // The extension only reads the sites it was allowed to. Which of the sites the settings
    // need it can't read yet: marked in the list, with one button to allow them all.

    async updateAccess() {
        const needed = Shared.originsNeeded(this.settings);
        const missing = [];
        await Promise.all(needed.map(async origin => {
            let ok = false;
            try { ok = await chrome.permissions.contains({ origins: [origin] }); } catch (e) { ok = false; }
            if (!ok) missing.push(origin);
        }));
        this.missingOrigins = missing;
        const notice = document.getElementById('accessNotice');
        notice.hidden = missing.length === 0;
        document.getElementById('accessText').textContent = this.settings.globalEnabled
            ? 'uHighlight is set to highlight every website, but may not read them yet.'
            : `uHighlight may not read ${missing.length === 1 ? 'one of your websites' : missing.length + ' of your websites'} yet: they aren't highlighted until you allow it.`;
        document.querySelectorAll('#enabledList li[data-rule]').forEach(item => {
            const lacking = missing.some(origin => Shared.originsFor(item.dataset.rule).includes(origin));
            const access = item.querySelector('.site-access');
            access.textContent = lacking ? 'not allowed yet' : '';
            access.title = lacking ? 'uHighlight may not read this site yet: use Allow above' : '';
        });
    }

    // Asks for access to sites. Called right in a click handler: the browser only asks the
    // user in response to one.
    requestAccess(origins) {
        if (!origins || origins.length === 0) return Promise.resolve(true);
        return chrome.permissions.request({ origins }).then(granted => {
            this.updateAccess();
            if (!granted) this.showStatus('Access not allowed: those sites won\'t be highlighted until you allow it.', { error: true });
            return granted;
        }, error => {
            this.showStatus('Could not ask for access: ' + error.message, { error: true });
            return false;
        });
    }

    // Returns an error message, or null when the site was added.
    addSite(key, input) {
        const rule = Shared.normalizeSiteRule(input);
        if (!rule) {
            return input.trim()
                ? `"${input.trim()}" doesn't look like a website. Try example.com or *.example.com.`
                : 'Enter a website first.';
        }
        if (Shared.hasSiteRule(this.settings[key], rule)) {
            return `${rule} is already in the list.`;
        }
        this.change({ type: 'addSiteRule', list: key, rule });
        if (key === 'enabledDomains' && !this.settings.globalEnabled) this.requestAccess(Shared.originsFor(rule));
        return null;
    }

    removeSite(key, rule) {
        if (this.change({ type: 'removeSiteRule', list: key, rule }, { undo: true })) {
            this.showStatus(`Removed ${rule}.`, { undo: true });
        }
    }

    // ---------------------------------------------------------------- saved lists

    // Draws the cards again. A field edited but not saved yet (a name, the addresses, the
    // section, the storage box, words to add) keeps what was typed: the cards are redrawn
    // after any change of a list (a word removed, a color changed, a save that failed and was
    // taken back). The card being saved shows what was saved instead (a name is trimmed, an
    // address tidied up), so that a later change made elsewhere shows too.
    renderLists() {
        const container = document.getElementById('lists');
        const drafts = this.listDrafts().filter(d => !this.savingList || !d.id.startsWith(`list-${this.savingList}-`) ||
            d.id.endsWith('-add'));
        container.textContent = '';
        this.settings.lists.forEach(list => container.appendChild(this.buildListCard(list)));
        document.getElementById('noLists').hidden = this.settings.lists.length > 0;
        drafts.forEach(({ id, value, focused, selection }) => {
            const field = document.getElementById(id);
            if (!field) return;   // the list is gone
            // (its data-drawn stays the stored value: once that is saved, it's no draft anymore)
            if (field.type === 'checkbox') field.checked = value; else field.value = value;
            if (focused) {
                field.focus();
                if (selection) field.setSelectionRange(selection[0], selection[1]);
            }
        });
    }

    // Counts the saves which send a field: a failed one gives back what it sent only when it
    // is the field's latest (see the Save of a list)
    noteFieldSave(id) {
        if (!this.fieldSaves) this.fieldSaves = new Map();
        const n = (this.fieldSaves.get(id) || 0) + 1;
        this.fieldSaves.set(id, n);
        return n;
    }

    // Puts back what was typed in a field, once the stored settings are shown again after a
    // save which failed (see trackSave()). `prepend` (words to add): the batches which failed
    // all come back, before what has been typed there since. Otherwise what was typed again
    // since the save wins over what that save sent, and so does a later save of the field
    // (`send`: the noteFieldSave() of the save which failed).
    keepDraft(id, value, { prepend = false, send = null } = {}) {
        if (!this.pendingDrafts) this.pendingDrafts = new Map();
        const earlier = this.pendingDrafts.get(id);
        if (prepend && earlier) value = earlier.value.replace(/\s+$/, '') + '\n' + value;
        this.pendingDrafts.set(id, { value, prepend, send });
    }

    applyPendingDrafts() {
        if (!this.pendingDrafts || this.pendingSaves > 0) return;
        this.pendingDrafts.forEach(({ value, prepend, send }, id) => {
            const field = document.getElementById(id);
            if (!field) return;   // its list is gone
            // Saved again since the save which failed: that one is newer
            if (send !== null && this.fieldSaves && this.fieldSaves.get(id) !== send) return;
            if (prepend) {
                field.value = field.value.trim() ? value.replace(/\s+$/, '') + '\n' + field.value : value;
                return;
            }
            // Edited again meanwhile (it differs from the stored value it was drawn with)
            const current = field.type === 'checkbox' ? String(field.checked) : field.value;
            if (field.dataset.drawn !== undefined && current !== field.dataset.drawn) return;
            if (field.type === 'checkbox') field.checked = value; else field.value = value;
        });
        this.pendingDrafts = null;
    }

    // The fields of the cards which differ from what they were drawn with
    listDrafts() {
        const drafts = [];
        document.querySelectorAll('#lists [data-drawn]').forEach(field => {
            const value = field.type === 'checkbox' ? field.checked : field.value;
            const drawn = field.type === 'checkbox' ? field.dataset.drawn === 'true' : field.dataset.drawn;
            if (value === drawn) return;
            drafts.push({
                id: field.id,
                value,
                focused: document.activeElement === field,
                selection: field.type === 'checkbox' ? null : [field.selectionStart, field.selectionEnd]
            });
        });
        return drafts;
    }

    buildListCard(list) {
        const section = document.createElement('section');
        section.className = 'group list-card';
        section.dataset.list = list.id;

        const title = document.createElement('h3');
        title.textContent = list.name;
        const body = document.createElement('div');
        body.className = 'groupBody';

        const row = (label, control, help, forId) => {
            const r = document.createElement('div');
            r.className = 'list-row';
            const l = document.createElement('label');
            l.className = 'list-label';
            l.textContent = label;
            if (forId) l.htmlFor = forId;
            const right = document.createElement('div');
            right.className = 'list-control';
            right.appendChild(control);
            if (help) {
                const p = document.createElement('p');
                p.className = 'desc';
                p.textContent = help;
                right.appendChild(p);
            }
            r.append(l, right);
            return r;
        };
        const id = suffix => `list-${list.id}-${suffix}`;

        const name = document.createElement('input');
        name.type = 'text';
        name.className = 'field';
        name.id = id('name');
        name.value = list.name;
        name.maxLength = 60;

        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.className = 'cell';
        enabled.checked = list.enabled;
        enabled.setAttribute('aria-label', 'List on');
        enabled.addEventListener('change', () => {
            this.change({ type: 'updateList', id: list.id, patch: { enabled: enabled.checked } });
        });
        const enabledBox = document.createElement('label');
        enabledBox.className = 'inline-check';
        enabledBox.append(enabled, document.createTextNode(' On'));

        const urls = document.createElement('textarea');
        urls.className = 'field';
        urls.id = id('urls');
        urls.rows = Math.max(2, Math.min(6, list.urls.length + 1));
        urls.spellcheck = false;
        urls.placeholder = 'github.com/*/issues/*\n*.example.com/docs/*';
        urls.value = list.urls.join('\n');

        const sectionInput = document.createElement('input');
        sectionInput.type = 'text';
        sectionInput.className = 'field mono';
        sectionInput.id = id('section');
        sectionInput.spellcheck = false;
        sectionInput.placeholder = 'the whole page';
        sectionInput.value = list.section;

        const local = document.createElement('input');
        local.type = 'checkbox';
        local.className = 'cell';
        local.id = id('local');
        local.checked = list.local;
        // What they were drawn with: an edit not saved yet survives a redraw (see renderLists())
        [name, urls, sectionInput].forEach(field => { field.dataset.drawn = field.value; });
        local.dataset.drawn = String(local.checked);
        const localBox = document.createElement('label');
        localBox.className = 'inline-check';
        localBox.append(local, document.createTextNode(' On this device only'));

        const error = document.createElement('div');
        error.className = 'form-error';
        error.hidden = true;

        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'btn primary';
        save.textContent = 'Save changes';
        save.addEventListener('click', () => {
            const patterns = listOfLines(urls.value);
            const bad = patterns.filter(p => !Shared.normalizeUrlPattern(p));
            if (bad.length > 0) {
                error.textContent = `Not an address pattern: ${bad.join(', ')}. Try example.com/path/* or *.example.com.`;
                error.hidden = false;
                urls.classList.add('invalid');
                return;
            }
            const sel = sectionInput.value.trim();
            if (sel.length > Shared.MAX_SECTION) {
                error.textContent = `The section is too long: ${sel.length} characters, at most ${Shared.MAX_SECTION}. ` +
                    'Shorten the selector, or pick a smaller part of the page.';
                error.hidden = false;
                sectionInput.classList.add('invalid');
                return;
            }
            if (sel) {
                try {
                    document.createDocumentFragment().querySelector(sel);
                } catch (e) {
                    error.textContent = `"${sel}" is not a valid CSS selector.`;
                    error.hidden = false;
                    sectionInput.classList.add('invalid');
                    return;
                }
            }
            error.hidden = true;
            urls.classList.remove('invalid');
            sectionInput.classList.remove('invalid');
            const normalized = patterns.map(p => Shared.normalizeUrlPattern(p));
            // Ask for the sites of the patterns (right in the click handler)
            const origins = Array.from(new Set(normalized.flatMap(p => Shared.originsFor(p))));
            if (origins.length > 0) this.requestAccess(origins);
            // Only the fields edited here are sent: the others keep what they are when the
            // change is made, which another page may have just changed. (Each is compared
            // with what the card was drawn with.)
            const patch = {};
            const typed = {};
            // (spaces around or inside a name aren't kept: only a different name is a rename)
            const cleanName = name.value.trim().replace(/\s+/g, ' ');
            if (!cleanName) {
                error.textContent = 'Give the list a name.';
                error.hidden = false;
                name.classList.add('invalid');
                return;
            }
            name.classList.remove('invalid');
            if (cleanName !== name.dataset.drawn) {
                patch.name = cleanName;
                typed[name.id] = name.value;
            }
            if (normalized.join('\n') !== urls.dataset.drawn) {
                patch.urls = normalized;
                typed[urls.id] = urls.value;
            }
            if (sel !== sectionInput.dataset.drawn) {
                patch.section = sel;
                typed[sectionInput.id] = sectionInput.value;
            }
            if (String(local.checked) !== local.dataset.drawn) {
                patch.local = local.checked;
                typed[local.id] = local.checked;
            }
            const changed = Object.keys(patch).length > 0;
            // Not stored after all: what was typed comes back, to save again. Not a field
            // which a later save has sent since: that one is newer (and may have been stored).
            const sends = {};
            Object.keys(typed).forEach(id => { sends[id] = this.noteFieldSave(id); });
            const giveBack = () => Object.entries(typed).forEach(([id, value]) => {
                if (this.fieldSaves.get(id) === sends[id]) this.keepDraft(id, value, { send: sends[id] });
            });
            const savedName = (changed && patch.name !== undefined ? patch.name : list.name).trim() || 'List';
            // The card shows what is saved (a name trimmed, addresses tidied up: see
            // renderLists()), even when that is what it had already
            this.savingList = list.id;
            let done;
            try {
                done = !changed || this.change(
                    { type: 'updateList', id: list.id, patch },
                    // Not stored after all: what was typed stays, to save again
                    { onFailure: giveBack });
                this.renderLists();
            } finally {
                this.savingList = null;
            }
            if (done) this.showStatus(changed ? `Saved "${savedName}".` : 'Nothing to save: no changes.');
        });

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn danger';
        remove.append(UI.icon('trash-o'), document.createTextNode('Delete list'));
        remove.addEventListener('click', () => {
            if (this.change({ type: 'removeList', id: list.id }, { undo: true })) {
                this.showStatus(`Deleted "${list.name}".`, { undo: true });
            }
        });

        const actions = document.createElement('div');
        actions.className = 'list-actions';
        actions.append(save, remove);

        body.append(
            row('Name', name, null, name.id),
            row('Highlighting', enabledBox, 'Off: the list is kept, but not highlighted anywhere.'),
            row('Runs on', urls, 'Addresses, one per line: example.com, *.example.com (and its subdomains), ' +
                'github.com/*/issues/* (* stands for anything). Empty: wherever highlighting is on for the site.', urls.id),
            row('Only in', sectionInput, 'A part of the page (a CSS selector), e.g. .comment-body. ' +
                'Point at it on a page with "Pick a section" in the popup.', sectionInput.id),
            row('Storage', localBox, 'Kept in this browser only, never synced with your other devices.'),
            error,
            actions,
            this.buildWordsBlock(list)
        );
        section.append(title, body);
        return section;
    }

    // The words of a saved list: shown as on a page, with remove buttons, and an area to add
    // many at once
    buildWordsBlock(list) {
        const block = document.createElement('div');
        block.className = 'list-words';
        const head = document.createElement('div');
        head.className = 'list-label';
        head.textContent = `Words (${list.words.length})`;
        const chips = this.buildChips(list.id, list.words);

        const area = document.createElement('textarea');
        area.className = 'field';
        area.rows = 3;
        area.spellcheck = false;
        area.placeholder = 'Words to add, one per line';
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn';
        add.append(UI.icon('plus'), document.createTextNode('Add words'));
        // Words typed here survive the card being drawn again (see renderLists())
        area.id = `list-${list.id}-add`;
        area.dataset.drawn = '';
        add.addEventListener('click', () => {
            // Emptied first: adding draws the card again, which would keep them as typed
            const text = area.value;
            area.value = '';
            if (!this.addWords(list.id, text, area.id)) area.value = text;
        });
        const addRow = document.createElement('div');
        addRow.className = 'bulk-add';
        addRow.append(area, add);

        block.append(head, chips, addRow);
        return block;
    }

    // The words of a list ('' = My words), shown as on a page: each with its highlight color
    // (a click on the square changes it) and a remove button.
    buildChips(listId, words) {
        const chips = document.createElement('div');
        chips.className = 'chips';
        if (words.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'dim';
            empty.textContent = 'No words yet.';
            chips.appendChild(empty);
        }
        const paint = (label, word) => {
            label.style.cssText = '';
            Shared.highlightDeclarations(word).forEach(([property, value]) => label.style.setProperty(property, value));
        };
        words.forEach(word => {
            const chip = document.createElement('span');
            chip.className = 'word-chip' + (word.paused ? ' paused' : '');
            chip.title = word.paused ? `${word.text} (paused)` : word.text;

            const color = document.createElement('input');
            color.type = 'color';
            color.className = 'chip-color';
            color.value = word.color;
            color.title = `Change the highlight color of "${word.text}"`;
            color.setAttribute('aria-label', color.title);

            const label = document.createElement('span');
            label.className = 'chip-text';
            label.textContent = word.text;
            paint(label, word);

            // Shown while picking, saved once the picker closes
            color.addEventListener('input', () => paint(label, { ...word, color: color.value }));
            color.addEventListener('change', () => {
                const value = color.value.toLowerCase();
                if (value === String(word.color).toLowerCase()) return;
                // Not redrawn: the other fields of the list may hold unsaved edits
                if (this.change({ type: 'setWordColor', list: listId, text: word.text, color: value }, { redraw: false })) {
                    word = { ...word, color: value };
                    // The chips already show it: don't draw them again later, which would take
                    // the keyboard focus away from this square
                    if (!listId) this.renderedWords = JSON.stringify(this.settings.words);
                }
            });

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'chip-remove';
            remove.textContent = '×';
            remove.title = `Remove "${word.text}"`;
            remove.setAttribute('aria-label', remove.title);
            remove.addEventListener('click', () => {
                if (this.change({ type: 'removeWord', list: listId, text: word.text }, { undo: true })) {
                    this.showStatus(`Removed "${word.text}".`, { undo: true });
                }
            });
            chip.append(color, label, remove);
            chips.appendChild(chip);
        });
        return chips;
    }

    // My words, as chips. Drawn again only when they changed (not while a color is picked).
    renderMyWords() {
        const key = JSON.stringify(this.settings.words);
        if (key === this.renderedWords) return;
        this.renderedWords = key;
        const chips = this.buildChips('', this.settings.words);
        chips.id = 'myWordsChips';
        document.getElementById('myWordsChips').replaceWith(chips);
    }

    // Adds pasted words (one per line) to a list ('' = My words). Returns true when added.
    // `fieldId`: the box they were typed in, which gets them back if they aren't stored.
    // At most MAX_BULK at once: the others stay in the box, to add next.
    addWords(list, text, fieldId = null) {
        const all = Array.from(new Set(listOfLines(text)));
        const lines = all.slice(0, MAX_BULK);
        const rest = all.slice(MAX_BULK);
        if (lines.length === 0) {
            this.showStatus('Type or paste words first, one per line.', { error: true });
            return false;
        }
        const words = () => list ? (this.settings.lists.find(l => l.id === list) || { words: [] }).words : this.settings.words;
        const before = words().length;
        const onFailure = fieldId ? () => this.keepDraft(fieldId, lines.join('\n'), { prepend: true }) : null;
        if (!this.change({ type: 'addWords', list, texts: lines, look: {}, cycleColors: true }, { undo: true, onFailure })) return false;
        const field = fieldId && document.getElementById(fieldId);
        if (rest.length > 0 && field) {
            field.value = rest.join('\n') + (field.value.trim() ? '\n' + field.value : '');
        }
        const added = words().length - before;
        const left = rest.length > 0 ? ` ${plural(rest.length, 'more word')} (over ${MAX_BULK} at once) ${rest.length === 1 ? 'is' : 'are'} still in the box: add ${rest.length === 1 ? 'it' : 'them'} next.` : '';
        this.showStatus((added === lines.length
            ? `Added ${plural(added, 'word')}.`
            : `Added ${plural(added, 'word')}; ${lines.length - added} ${lines.length - added === 1 ? 'was' : 'were'} already in the list.`) + left,
            { undo: added > 0 });
        return true;
    }

    newList() {
        const id = Shared.newListId();
        const taken = new Set(this.settings.lists.map(l => l.name));
        let name = 'New list';
        for (let n = 2; taken.has(name); n++) name = `New list ${n}`;
        if (this.change({ type: 'addList', list: { id, name, words: [], urls: [], section: '' } })) {
            const field = document.getElementById(`list-${id}-name`);
            if (field) {
                field.scrollIntoView({ block: 'center' });
                field.focus();
                field.select();
            }
        }
    }

    // "Test a page": which lists run on an address, and why
    renderTest() {
        const input = document.getElementById('testUrl');
        const out = document.getElementById('testResult');
        out.textContent = '';
        let value = input.value.trim();
        if (!value) return;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'https://' + value;
        let url;
        try {
            url = new URL(value);
        } catch (e) {
            const li = document.createElement('li');
            li.className = 'empty';
            li.textContent = 'Not a web address.';
            out.appendChild(li);
            return;
        }
        const scope = Shared.pageScope(this.settings, url);
        const line = (name, runs, why) => {
            const li = document.createElement('li');
            li.className = runs ? 'runs' : 'off';
            const state = document.createElement('span');
            state.className = 'test-state';
            state.textContent = runs ? 'runs' : 'off';
            const n = document.createElement('span');
            n.className = 'test-name';
            n.textContent = name;
            const w = document.createElement('span');
            w.className = 'test-why';
            w.textContent = why;
            li.append(state, n, w);
            out.appendChild(li);
        };
        line(Shared.DEFAULT_LIST_NAME, scope.defaultRuns,
            !scope.host ? 'not a web page'
                : scope.excludedBy ? `excluded by ${scope.excludedBy}`
                : scope.defaultRuns ? `highlighting is on (${scope.siteRule})` : 'highlighting is off for this site');
        scope.lists.forEach(l => line(l.name, l.runs, l.why));
    }

    // ---------------------------------------------------------------- saving

    // Shows a change at once (applied to our copy), and hands it to the background worker,
    // which makes it on the *latest stored* settings: a site added in the popup a moment ago
    // isn't lost, and closing this tab can't cancel a change it has already shown.
    // `undo`: keep the change which undoes this one, for the Undo button. `redraw: false`: the
    // page already shows it. `onFailure`: called when it isn't stored after all (before the
    // stored settings are shown again). Returns false when the change can't be made (the
    // reason is shown).
    change(change, { undo = false, redraw = true, onFailure = null } = {}) {
        const before = JSON.parse(JSON.stringify(this.settings));
        const mine = Shared.sanitizeSettings(JSON.parse(JSON.stringify(this.settings)));
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
        const listsChanged = JSON.stringify(mine.lists) !== JSON.stringify(this.settings.lists);
        this.settings = mine;
        if (redraw) this.render(listsChanged);
        this.lastSave = this.trackSave(() => Shared.commit(change).then(result => {
            if (token && token === this.undoToken) {
                this.undoChange = result.inverse;
                document.getElementById('undoButton').hidden = !(this.statusWantsUndo && this.undoChange);
            }
            return result;
        }), onFailure);
        return true;
    }

    async trackSave(write, onFailure = null) {
        this.pendingSaves++;
        let saved = true;
        try {
            await write();
        } catch (error) {
            // e.g. the 100 KB total chrome.storage.sync quota
            this.showStatus('Could not save settings: ' + error.message, { error: true });
            saved = false;
            // Read the stored settings again once all saves are done, even if a later one
            // succeeds: our copy still shows this one
            this.resyncAfterSave = true;
            if (onFailure) onFailure();
        }
        this.pendingSaves--;
        if (this.pendingSaves === 0 && (this.resyncAfterSave || !saved)) {
            // Pick up changes made elsewhere meanwhile, or show what's really stored after a failure
            this.resyncAfterSave = false;
            await this.resync();
        }
        this.applyPendingDrafts();
        return saved;
    }

    // Undoes the last removal, addition or import, and only it (see Shared.inverseOf())
    undo() {
        const change = this.undoChange;
        this.undoChange = null;
        if (!change) return;
        if (this.change(change)) this.showStatus('Undone.');
    }

    // ---------------------------------------------------------------- backup

    // Exports what is actually stored, read again now: never the defaults this page shows
    // when the stored settings couldn't be read (importing such a file would replace the real
    // settings with empty ones).
    async exportSettings() {
        let settings;
        try {
            settings = await Shared.loadSettings();
        } catch (error) {
            this.showStatus('Could not export: your saved settings could not be read. ' + error.message, { error: true });
            return;
        }

        const data = {
            exportedBy: 'uHighlight ' + chrome.runtime.getManifest().version,
            exportedAt: new Date().toISOString(),
            ...settings
        };
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'uhighlight-settings.json';
        link.click();
        // Revoking synchronously can cancel the download before it starts
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        const lists = settings.lists.length ? `, ${plural(settings.lists.length, 'saved list')}` : '';
        this.showStatus(`Exported ${plural(settings.words.length, 'word')}${lists} and your website settings.`);
    }

    // Import: the file is checked first, then a preview says what it holds and what it would
    // change, and offers to merge it with the current settings or to replace them.
    async importSettings(event) {
        const input = event.target;
        const file = input.files[0];
        input.value = ''; // allow importing the same file again
        if (!file) return;

        // Only what the file actually contains is used (a words-only file keeps the website
        // lists), and only if all of it is of the right kind: a list of the wrong type would
        // otherwise replace the stored one with an empty one.
        let values;
        try {
            let parsed;
            try {
                parsed = JSON.parse(await file.text());
            } catch (e) {
                throw new Error('the file is not valid JSON');
            }
            const result = Shared.validateImport(parsed);
            if (result.problems.length > 0) {
                throw new Error(result.problems.join('; ') + '. Nothing was imported.');
            }
            values = result.values;
        } catch (error) {
            this.showStatus('Could not import: ' + error.message, { error: true });
            return;
        }

        const choice = await this.previewImport(file.name, values);
        if (!choice) return;
        const change = { type: choice, values };
        if (this.change(change, { undo: true })) {
            this.showStatus(choice === 'merge' ? `Merged "${file.name}".` : `Imported "${file.name}".`, { undo: true });
            // The imported websites and lists may need access
            const origins = Shared.originsNeeded(this.settings);
            if (origins.length > 0) this.updateAccess();
        }
    }

    // What the import would do: one line per kind of setting, for merging and for replacing
    previewImport(fileName, values) {
        const dialog = document.getElementById('importDialog');
        const has = key => Object.prototype.hasOwnProperty.call(values, key);
        const cs = this.settings.caseSensitive;
        const rows = [];
        if (has('words')) {
            const fresh = values.words.filter(w => Shared.findWordIndex(this.settings.words, w.text, cs) === -1).length;
            rows.push([`My words: ${plural(values.words.length, 'word')}`,
                `${fresh} new added, yours kept (${this.settings.words.length})`,
                `yours (${this.settings.words.length}) replaced`]);
        }
        if (has('lists')) {
            const names = new Set(this.settings.lists.map(l => l.name.toLowerCase()));
            const fresh = values.lists.filter(l => !names.has(l.name.toLowerCase())).length;
            rows.push([`Saved lists: ${values.lists.length}`,
                `${fresh} new, the others' words added to yours`,
                `yours (${this.settings.lists.length}) replaced`]);
        }
        [['enabledDomains', 'Enabled websites'], ['excludedDomains', 'Excluded websites']].forEach(([key, label]) => {
            if (!has(key)) return;
            const incoming = Object.keys(values[key]);
            const fresh = incoming.filter(rule => !Shared.hasSiteRule(this.settings[key], rule)).length;
            rows.push([`${label}: ${incoming.length}`, `${fresh} new added`, 'yours replaced']);
        });
        if (['caseSensitive', 'partialMatch', 'globalEnabled', 'showBadge'].some(has)) {
            rows.push(['Options', 'yours kept', "the file's used"]);
        }

        document.getElementById('importFileName').textContent = fileName;
        const table = document.getElementById('importRows');
        table.textContent = '';
        rows.forEach(([what, merge, replace]) => {
            const tr = document.createElement('tr');
            [what, merge, replace].forEach(text => {
                const td = document.createElement('td');
                td.textContent = text;
                tr.appendChild(td);
            });
            table.appendChild(tr);
        });

        return new Promise(resolve => {
            const done = value => {
                dialog.close();
                resolve(value);
            };
            document.getElementById('importMerge').onclick = () => done('merge');
            document.getElementById('importReplace').onclick = () => done('replace');
            document.getElementById('importCancel').onclick = () => done(null);
            dialog.oncancel = () => resolve(null);
            dialog.showModal();
        });
    }

    async clearWords() {
        const count = this.settings.words.length;
        if (count === 0) {
            this.showStatus('There are no words to clear.');
            return;
        }
        if (this.change({ type: 'replace', values: { words: [] } }, { undo: true })) {
            this.showStatus(`Removed ${plural(count, 'word')} from My words.`, { undo: true });
        }
    }

    // A message at the bottom: `error` in red (stays), `undo` with an Undo button (for a while)
    showStatus(message, { error = false, undo = false } = {}) {
        const status = document.getElementById('status');
        document.getElementById('statusText').textContent = message;
        status.classList.toggle('error', error);
        // Shown once the background worker has said how to undo (see change())
        this.statusWantsUndo = !!undo;
        document.getElementById('undoButton').hidden = !(undo && this.undoChange);
        status.hidden = false;
        clearTimeout(this.statusTimer);
        if (!error) {
            this.statusTimer = setTimeout(() => {
                status.hidden = true;
                this.undoChange = null;
                this.statusWantsUndo = false;
            }, undo ? UNDO_MS : 6000);
        }
    }
}

document.addEventListener('DOMContentLoaded', () => { window.uhOptions = new SettingsPage(); });
