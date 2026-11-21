// Settings helpers shared by the content script, popup, options page and background worker.
//
// Assigned to a global rather than declared with const/class: the content script files can be
// injected into the same page more than once, and a second top-level declaration would throw.
globalThis.WordHighlighterShared = (() => {
    const DEFAULT_SETTINGS = {
        words: [],
        caseSensitive: false,
        partialMatch: false,
        globalEnabled: false,   // highlight on every site (except excludedDomains)
        enabledDomains: {},     // site rule -> true; where to highlight when globalEnabled is off
        excludedDomains: {},    // site rule -> true; never highlight here (in either mode)
        lists: [],              // saved lists, each with its own scope (see sanitizeLists())
        showBadge: true,        // the number of matches on the toolbar icon
        wordsRev: 0             // revision of `words`, one more at each change (see bumpRevisions())
    };
    const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

    // The words of `settings.words` are the default list, "My words": they run where the site
    // rules say. Saved lists (`settings.lists`) have a scope of their own.
    const DEFAULT_LIST_NAME = 'My words';

    // Turns user input ("https://www.Example.com/path", "*.example.com", "example.com:8080")
    // into a site rule: a hostname (that exact site) or "*." + hostname (the domain and all of
    // its subdomains). Returns null when the input isn't a usable host.
    function normalizeSiteRule(input) {
        if (typeof input !== 'string') return null;
        // Drop any scheme first so pasted URLs like "https://*.example.com/x" work too
        let value = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
        let wildcard = false;
        if (value.startsWith('*.')) {
            wildcard = true;
            value = value.slice(2);
        }
        if (!value) return null;

        let hostname;
        try {
            // URL() also converts internationalized names to the punycode form pages report
            hostname = normalizeHostname(new URL('http://' + value).hostname);
        } catch (e) {
            return null;
        }

        const validHost = /^\[[0-9a-f:.]+\]$/.test(hostname) ||
            /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(hostname);
        if (!validHost) return null;

        return wildcard ? '*.' + hostname : hostname;
    }

    // "Example.com." and "example.com" are the same site (a trailing dot is a valid, fully
    // qualified spelling that location.hostname keeps).
    function normalizeHostname(hostname) {
        return typeof hostname === 'string' ? hostname.toLowerCase().replace(/\.+$/, '') : '';
    }

    // Returns the rule in `rules` that covers `hostname`: an exact entry first, otherwise the
    // most specific "*." entry. Null when no rule applies.
    function findSiteRule(hostname, rules) {
        hostname = normalizeHostname(hostname);
        if (!hostname || !rules) return null;
        if (hasSiteRule(rules, hostname)) return hostname;

        let suffix = hostname;
        while (suffix) {
            if (hasSiteRule(rules, '*.' + suffix)) return '*.' + suffix;
            const dot = suffix.indexOf('.');
            if (dot === -1) break;
            suffix = suffix.slice(dot + 1);
        }
        return null;
    }

    // Exclusions win in both modes, so e.g. "*.corp.net" can be enabled with "wiki.corp.net"
    // excluded.
    function isEnabledForHost(hostname, settings) {
        if (findSiteRule(hostname, settings.excludedDomains)) return false;
        return !!settings.globalEnabled || !!findSiteRule(hostname, settings.enabledDomains);
    }

    function isValidColor(color) {
        return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
    }

    // Relative luminance (WCAG) of a #rrggbb color
    function luminance(hex) {
        const channel = i => {
            const c = parseInt(hex.slice(i, i + 2), 16) / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    }

    // "Auto" text color: black or white, whichever has more contrast on the background.
    // (The old rule switched at 50% luminance and put white text on red, which is harder to
    // read than black: 4.0:1 vs 5.25:1.)
    function autoTextColor(background) {
        if (!isValidColor(background)) return '#000000';
        const l = luminance(background);
        const onBlack = (l + 0.05) / 0.05;
        const onWhite = 1.05 / (l + 0.05);
        return onBlack >= onWhite ? '#000000' : '#ffffff';
    }

    // The text color a word is drawn with: its own choice, or automatic.
    function textColorFor(word) {
        return word && isValidColor(word.textColor) ? word.textColor : autoTextColor(word && word.color);
    }

    // ------------------------------------------------------------------ words

    // Preset highlight colors (popup swatches; also used for words added via the right-click menu)
    const PRESET_COLORS = [
        { name: 'Yellow', value: '#ffff00' },
        { name: 'Green', value: '#90ee90' },
        { name: 'Blue', value: '#87cefa' },
        { name: 'Pink', value: '#ffb6c1' },
        { name: 'Orange', value: '#ffa500' },
        { name: 'Purple', value: '#dda0dd' },
        { name: 'Red', value: '#ff6b6b' },
        { name: 'Turquoise', value: '#40e0d0' }
    ];

    // First preset not used by any entry yet; cycles through the presets once all are taken.
    function nextPresetColor(words) {
        const used = new Set(words.map(w => String(w.color).toLowerCase()));
        const unused = PRESET_COLORS.find(p => !used.has(p.value));
        return (unused || PRESET_COLORS[words.length % PRESET_COLORS.length]).value;
    }

    // Index of an entry in `words` (-1 if none). Without case sensitivity "Browser" and
    // "browser" are the same entry.
    function findWordIndex(words, text, caseSensitive, exceptIndex = -1) {
        const key = caseSensitive ? text : text.toLowerCase();
        return words.findIndex((w, i) =>
            i !== exceptIndex && (caseSensitive ? w.text : w.text.toLowerCase()) === key);
    }

    // Turns highlighting on/off for one site (popup checkbox, keyboard shortcut), editing the
    // settings object in place. Only exact-hostname rules are added/removed here; "*." rules are
    // managed in Settings. Rules are only stored when "on", so sync storage doesn't fill up.
    function toggleSite(settings, domain, on) {
        const isEnabled = () => isEnabledForHost(domain, settings);
        if (on) {
            delete settings.excludedDomains[domain];
            // Still excluded by a "*." rule: can't be turned on here, so don't store a useless
            // "enabled" rule either.
            if (findSiteRule(domain, settings.excludedDomains)) return;
            if (!isEnabled() && !settings.globalEnabled) {
                settings.enabledDomains[domain] = true;
            }
        } else {
            // Drop this site's own rule; if a "*." rule (or all-sites mode) still covers it,
            // exclude it explicitly.
            if (!settings.globalEnabled) {
                delete settings.enabledDomains[domain];
            }
            if (isEnabled()) {
                settings.excludedDomains[domain] = true;
            }
        }
    }

    // The same entry: same text and same look
    function sameEntry(a, b) {
        return !!a && !!b && a.text === b.text &&
            String(a.color).toLowerCase() === String(b.color).toLowerCase() &&
            String(a.textColor || '').toLowerCase() === String(b.textColor || '').toLowerCase() &&
            (a.style || 'background') === (b.style || 'background') && !!a.paused === !!b.paused;
    }

    // How a word is drawn: 'background' (default), 'underline' or 'wavy' (underline).
    function wordStyle(word) {
        return word && (word.style === 'underline' || word.style === 'wavy') ? word.style : 'background';
    }

    // CSS declarations for how a word is drawn, as [property, value] pairs. Used for the page's
    // ::highlight() rules and for the popup's previews, so the two always match.
    // Underline styles draw the line in the word's color; with "automatic" text color they leave
    // the page's own text color alone.
    function highlightDeclarations(word) {
        const color = isValidColor(word && word.color) ? word.color : '#ffff00';
        const style = wordStyle(word);
        if (style === 'background') {
            return [['background-color', color], ['color', textColorFor({ ...word, color })]];
        }
        const declarations = [
            ['text-decoration-line', 'underline'],
            ['text-decoration-style', style === 'wavy' ? 'wavy' : 'solid'],
            ['text-decoration-color', color],
            ['text-decoration-thickness', style === 'wavy' ? '1.5px' : '2px']
        ];
        if (isValidColor(word.textColor)) declarations.push(['color', word.textColor]);
        return declarations;
    }

    function highlightCss(word) {
        return highlightDeclarations(word).map(([property, value]) => `${property}: ${value};`).join(' ');
    }

    // Accepts arbitrary (e.g. imported) data and returns only well-formed word entries.
    // Optional fields are only stored when set: `textColor` (missing = automatic), `style`
    // (missing = background) and `paused` (missing = highlighted).
    // Entries with exactly the same text are merged into the first one: pages only ever use
    // the first, and the popup finds entries by their text, so a second copy could neither be
    // seen on a page nor be edited or removed on its own.
    function sanitizeWords(words) {
        if (!Array.isArray(words)) return [];
        const seen = new Set();
        const clean = [];
        words.forEach(w => {
            if (!w || typeof w.text !== 'string' || !w.text.trim()) return;
            const text = w.text.trim().replace(/\s+/g, ' ');
            if (seen.has(text)) return;
            seen.add(text);
            const word = {
                text,
                color: isValidColor(w.color) ? w.color : '#ffff00'
            };
            if (isValidColor(w.textColor)) word.textColor = w.textColor;
            if (w.style === 'underline' || w.style === 'wavy') word.style = w.style;
            if (w.paused === true) word.paused = true;
            clean.push(word);
        });
        return clean;
    }

    // Keeps only valid `rule: true` entries (older versions also stored `domain: false`).
    // Without a prototype, so a site named like an Object property ("constructor",
    // "__proto__") is an ordinary entry, never an inherited one.
    function sanitizeSiteRules(rules) {
        const clean = Object.create(null);
        if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
            Object.keys(rules).forEach(key => {
                if (rules[key] !== true) return;
                const rule = normalizeSiteRule(key);
                if (rule) clean[rule] = true;
            });
        }
        return clean;
    }

    // True if `rules` has its own entry for `rule` (not one inherited from Object.prototype)
    function hasSiteRule(rules, rule) {
        return !!rules && Object.prototype.hasOwnProperty.call(rules, rule) && rules[rule] === true;
    }

    // ------------------------------------------------------------------ saved lists
    //
    // A saved list: { id, name, enabled, words, urls, section, local }
    // - urls: where it runs, as patterns of addresses ("github.com/*/issues/*"); none = wherever
    //   highlighting is on for the site (like My words);
    // - section: a CSS selector; when set, the list is only highlighted inside the parts of the
    //   page it matches (the issue's text, a product's specifications...);
    // - local: kept on this device only (chrome.storage.local), never synced.

    const MAX_LIST_NAME = 60;
    // A section's selector: never shortened (a cut selector is no selector), refused when longer
    const MAX_SECTION = 1000;

    function newId() {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        return 'l' + Array.from(bytes, b => (b % 36).toString(36)).join('');
    }

    // "https://GitHub.com/*/issues/*" -> "github.com/*/issues/*"; a bare host covers all of it
    // ("example.com" -> "example.com/*"). The host may start with "*." (and its subdomains).
    // Null when it isn't usable.
    function normalizeUrlPattern(input) {
        if (typeof input !== 'string') return null;
        const value = input.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
        if (!value) return null;
        const slash = value.indexOf('/');
        const hostPart = slash === -1 ? value : value.slice(0, slash);
        let path = slash === -1 ? '/*' : value.slice(slash);
        const host = normalizeSiteRule(hostPart);
        if (!host) return null;
        if (/\s/.test(path) || path.length > 500) return null;
        return host + path;
    }

    // Does the pattern cover this address? "*" in the path stands for anything (slashes included);
    // the path is matched against the address's path and query.
    function urlPatternMatches(pattern, url) {
        let address;
        try {
            address = typeof url === 'string' ? new URL(url) : url;
        } catch (e) {
            return false;
        }
        const slash = pattern.indexOf('/');
        const hostRule = slash === -1 ? pattern : pattern.slice(0, slash);
        const pathGlob = slash === -1 ? '/*' : pattern.slice(slash);
        const host = normalizeHostname(address.hostname);
        const hostOk = hostRule.startsWith('*.')
            ? host === hostRule.slice(2) || host.endsWith('.' + hostRule.slice(2))
            : host === hostRule;
        if (!hostOk) return false;
        const regex = new RegExp('^' + pathGlob.split('*').map(part =>
            part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return regex.test(address.pathname + address.search) || regex.test(address.pathname);
    }

    function sanitizeRev(rev) {
        return Number.isInteger(rev) && rev >= 0 ? rev : 0;
    }

    function sanitizeLists(lists) {
        if (!Array.isArray(lists)) return [];
        const ids = new Set();
        const clean = [];
        lists.forEach(l => {
            if (!l || typeof l !== 'object') return;
            let id = typeof l.id === 'string' && /^[a-z0-9]{1,16}$/.test(l.id) ? l.id : newId();
            if (ids.has(id)) return;   // the same list twice (e.g. in sync and on this device)
            ids.add(id);
            const name = (typeof l.name === 'string' ? l.name.trim().replace(/\s+/g, ' ') : '').slice(0, MAX_LIST_NAME);
            const urls = [];
            const given = (Array.isArray(l.urls) ? l.urls : []).filter(u => typeof u === 'string' && u.trim());
            given.forEach(u => {
                const pattern = normalizeUrlPattern(u);
                if (pattern && !urls.includes(pattern)) urls.push(pattern);
            });
            // Addresses were given but none is usable: without them the list would run on every
            // site where highlighting is on, far more than meant. It is turned off instead.
            const unusable = given.length > 0 && urls.length === 0;
            // A section too long to keep (from an imported file): left out, and the list turned
            // off, as without it the list would run on the whole page
            const givenSection = typeof l.section === 'string' ? l.section.trim() : '';
            const tooLong = givenSection.length > MAX_SECTION;
            const section = tooLong ? '' : givenSection;
            clean.push({
                id,
                name: name || 'List',
                enabled: l.enabled !== false && !unusable && !tooLong,
                words: sanitizeWords(l.words),
                urls,
                section,
                local: l.local === true,
                rev: sanitizeRev(l.rev)
            });
        });
        return clean;
    }

    // What runs on a page, and why, for the popup, the settings page's tester and the content
    // script. `url`: the page's address (string or URL).
    // Returns { host, excludedBy, siteOn, siteRule, defaultRuns, lists: [{ id, name, runs, why }] }
    function pageScope(settings, url) {
        let address = null;
        try {
            address = typeof url === 'string' ? new URL(url) : url;
        } catch (e) {
            address = null;
        }
        const host = address && /^https?:$/.test(address.protocol) ? normalizeHostname(address.hostname) : '';
        const result = { host, excludedBy: null, siteOn: false, siteRule: null, defaultRuns: false, lists: [] };
        if (!host) {
            result.lists = (settings.lists || []).map(l => ({ id: l.id, name: l.name, runs: false, why: 'not a web page' }));
            return result;
        }
        result.excludedBy = findSiteRule(host, settings.excludedDomains);
        const enabledBy = findSiteRule(host, settings.enabledDomains);
        result.siteOn = !result.excludedBy && (!!settings.globalEnabled || !!enabledBy);
        result.siteRule = settings.globalEnabled ? 'all websites' : enabledBy;
        result.defaultRuns = result.siteOn;
        result.lists = (settings.lists || []).map(l => {
            const out = { id: l.id, name: l.name, runs: false, why: '' };
            if (result.excludedBy) {
                out.why = `excluded by ${result.excludedBy}`;
            } else if (!l.enabled) {
                out.why = 'turned off';
            } else if (l.urls.length > 0) {
                const pattern = l.urls.find(p => urlPatternMatches(p, address));
                out.runs = !!pattern;
                out.why = pattern ? `matches ${pattern}` : 'no address pattern matches';
            } else {
                out.runs = result.siteOn;
                out.why = result.siteOn ? `highlighting is on (${result.siteRule})` : 'highlighting is off for this site';
            }
            if (out.runs && l.section) out.why += `, only in ${l.section}`;
            return out;
        });
        return result;
    }

    // ------------------------------------------------------------------ site access
    //
    // Access to websites is optional: the extension asks for a site when highlighting is
    // turned on for it (or for all websites when that is turned on).

    const ALL_ORIGINS = ['http://*/*', 'https://*/*'];

    // Match patterns for a site rule ("example.com", "*.example.com") or an address pattern.
    // http and https spelled out: "*://" covers more schemes than the optional host
    // permissions do, so asking for it, or checking it, would fail.
    function originsFor(ruleOrPattern) {
        const host = String(ruleOrPattern || '').split('/')[0];
        if (!host) return [];
        return [`http://${host}/*`, `https://${host}/*`];
    }

    // The origins the settings need: every enabled site, every saved list's address patterns,
    // or all of them in all-websites mode.
    function originsNeeded(settings) {
        if (settings.globalEnabled) return ALL_ORIGINS.slice();
        const origins = new Set();
        Object.keys(settings.enabledDomains || {}).forEach(rule => originsFor(rule).forEach(o => origins.add(o)));
        (settings.lists || []).forEach(l => {
            if (l.enabled) l.urls.forEach(p => originsFor(p).forEach(o => origins.add(o)));
        });
        return Array.from(origins);
    }

    // ------------------------------------------------------------------ storage
    //
    // chrome.storage.sync allows only 8 KB per item, which a single "words" item hits at roughly
    // 150-200 words. The lists are therefore stored as JSON split over several items, under a
    // name of their own for every save (a "generation"), with one index item which says which:
    //   words__index: { gen: 'k3x9q2m1', count: 2, hash: '9a0c33f1' }
    //   words__k3x9q2m1__0: '[{"text":...',  words__k3x9q2m1__1: '...}]'
    // (total sync quota is 100 KB). The index is a single item, written in the same set() call
    // as its chunks, so a reader never mixes the chunks of two saves: if sync has delivered a
    // new index before its chunks, they are missing and the list reads as "not arrived yet"
    // (DamagedSettingsError), never as a mix of old and new entries; the hash catches the rest.
    // Older formats are still read, and converted on the next save: chunks without a generation
    // (words__count: 2, words__0, words__1), and a plain "words" item.
    // words__count is still written, so that an older version of the extension, reading this
    // format, finds its chunks missing and refuses to save rather than taking the list for empty.

    const CHUNKED_KEYS = ['words', 'enabledDomains', 'excludedDomains', 'lists'];
    // Saved lists kept on this device only: in chrome.storage.local, never synced
    const LOCAL_LISTS_KEY = 'localLists';
    const MAX_CHUNK_BYTES = 7000;   // per item, leaving headroom below the 8192-byte limit
    const utf8 = new TextEncoder();

    const indexKey = key => `${key}__index`;
    const countKey = key => `${key}__count`;
    const chunkKey = (key, gen, index) => gen ? `${key}__${gen}__${index}` : `${key}__${index}`;
    // Every chunk of a value, of any generation or of the older format
    const chunkPattern = key => new RegExp(`^${key}__(?:[a-z0-9]+__)?\\d+$`);

    function newGeneration() {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
    }

    // FNV-1a, 32 bits: enough to tell that the chunks read are the ones the index was written with
    function hashOf(text) {
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }

    // Splits a string into pieces whose stored size (JSON-encoded) stays under the item limit.
    function splitIntoChunks(text) {
        const chunks = [];
        let start = 0;
        while (start < text.length) {
            let length = Math.min(MAX_CHUNK_BYTES, text.length - start);
            while (length > 1 && utf8.encode(JSON.stringify(text.slice(start, start + length))).length > MAX_CHUNK_BYTES) {
                length = Math.floor(length / 2);
            }
            // Don't cut a surrogate pair (emoji etc.) in half
            const last = text.charCodeAt(start + length - 1);
            if (length > 1 && start + length < text.length && last >= 0xD800 && last <= 0xDBFF) {
                length--;
            }
            chunks.push(text.slice(start, start + length));
            start += length;
        }
        return chunks;
    }

    // Rebuilds a chunked value from raw stored items; undefined if the value isn't stored in
    // chunks at all (then the plain single item is used).
    // Throws if chunks exist but are incomplete or unreadable, e.g. while sync is still
    // delivering them to a new device. Treating that as "no words" would be dangerous: the next
    // edit would save a nearly empty list over the real one, on every synced device.
    function joinChunks(items, key) {
        const index = items[indexKey(key)];
        let gen = null;
        let count;
        let hash = null;
        if (index !== undefined) {
            if (!index || typeof index !== 'object' || typeof index.gen !== 'string' ||
                !/^[a-z0-9]+$/.test(index.gen) || typeof index.hash !== 'string') {
                throw new DamagedSettingsError(key);
            }
            ({ gen, count, hash } = index);
        } else {
            count = items[countKey(key)];
            if (count === undefined) return undefined;
        }
        if (!Number.isInteger(count) || count < 1) throw new DamagedSettingsError(key);

        const parts = [];
        for (let i = 0; i < count; i++) {
            const part = items[chunkKey(key, gen, i)];
            if (typeof part !== 'string') throw new DamagedSettingsError(key);
            parts.push(part);
        }
        const text = parts.join('');
        if (hash !== null && hashOf(text) !== hash) throw new DamagedSettingsError(key);
        try {
            return JSON.parse(text);
        } catch (e) {
            throw new DamagedSettingsError(key);
        }
    }

    class DamagedSettingsError extends Error {
        constructor(key) {
            super(`Saved settings ("${key}") are incomplete or damaged. If you use Chrome sync, ` +
                'they may still be arriving from another device.');
            this.name = 'DamagedSettingsError';
        }
    }

    function defaultStorage() {
        return chrome.storage.sync;
    }

    function settingsFromItems(items) {
        const raw = {};
        SETTING_KEYS.forEach(key => {
            if (CHUNKED_KEYS.includes(key)) {
                const joined = joinChunks(items, key);
                raw[key] = joined !== undefined ? joined : items[key];   // fall back to old format
            } else {
                raw[key] = items[key];
            }
        });
        return sanitizeSettings(raw);
    }

    // ------------------------------------------------------------------ journal
    //
    // Replacing settings when the sync storage is nearly full: the new value doesn't fit next
    // to the old one, so the old one has to be removed first, and for a moment nothing complete
    // is stored. Before that, the old items are copied to chrome.storage.local (a separate,
    // larger store, never synced): the "journal". Should the write then fail, they are put
    // back; should putting them back fail too, the journal stays, readers use it, and the next
    // save puts them back first. So the settings are never lost, nor unreadable.

    const JOURNAL_KEY = 'uhighlightSyncJournal';

    function journalStore(storage) {
        return storage === chrome.storage.sync && chrome.storage.local ? chrome.storage.local : null;
    }

    async function readJournal(storage) {
        const local = journalStore(storage);
        if (!local) return null;
        const journal = (await local.get(JOURNAL_KEY))[JOURNAL_KEY];
        return journal && journal.items && typeof journal.items === 'object' ? journal : null;
    }

    // Puts the journaled items back into sync storage, and forgets the journal.
    async function restoreJournal(storage, journal) {
        if (Array.isArray(journal.added) && journal.added.length > 0) {
            await storage.remove(journal.added);   // the new value's items, to make room
        }
        await storage.set(journal.items);
        await journalStore(storage).remove(JOURNAL_KEY);
    }

    // Before a write (the caller holds the lock): a journal left by a write which failed half-
    // way is put back if the stored settings are unreadable, and forgotten if they are fine
    // (the write did complete; only forgetting the journal had failed).
    async function recoverJournal(storage) {
        const journal = await readJournal(storage);
        if (!journal) return;
        try {
            settingsFromItems(await storage.get(null));
            await journalStore(storage).remove(JOURNAL_KEY);
        } catch (e) {
            await restoreJournal(storage, journal);
        }
    }

    // Reads all settings (sanitized, defaults filled in). Throws DamagedSettingsError when the
    // stored lists are incomplete, so callers never mistake them for empty ones; unless a
    // journal holds the complete settings of before an interrupted write (see above).
    async function loadSettings(storage = defaultStorage()) {
        const items = await storage.get(null);
        let settings;
        try {
            settings = settingsFromItems(items);
        } catch (error) {
            const journal = await readJournal(storage).catch(() => null);
            if (!journal) throw error;
            const view = { ...items };
            (journal.added || []).forEach(key => { delete view[key]; });
            Object.assign(view, journal.items);
            settings = settingsFromItems(view);
        }
        return withLocalLists(settings, storage);
    }

    // Adds the saved lists kept on this device (after the synced ones)
    async function withLocalLists(settings, storage) {
        const local = journalStore(storage);
        if (!local) return settings;
        const stored = (await local.get(LOCAL_LISTS_KEY))[LOCAL_LISTS_KEY];
        if (Array.isArray(stored) && stored.length > 0) {
            settings.lists = sanitizeLists(settings.lists.concat(stored.map(l => ({ ...l, local: true }))));
        }
        return settings;
    }

    // Every write to the settings runs while holding one lock, shared by all the extension's
    // pages and its background worker (Web Locks are per origin, and they all have the
    // extension's origin). Pages send their changes to the background worker (see commit()),
    // which makes the writes; the lock still keeps any two writes from interleaving: a read and
    // a write of one change never have another write in between. Where Web Locks aren't
    // available, writes from one context at least run one at a time.
    const LOCK_NAME = 'uhighlight-settings';
    let localQueue = Promise.resolve();
    function withSettingsLock(task) {
        const locks = globalThis.navigator && globalThis.navigator.locks;
        if (locks && typeof locks.request === 'function') {
            return locks.request(LOCK_NAME, () => task());
        }
        const run = localQueue.then(() => task());
        localQueue = run.catch(() => {});
        return run;
    }

    // The total size quota, the only one that removing the old value first can help with:
    // "QUOTA_BYTES quota exceeded" (older Chromium), "Resource::kQuotaBytes quota exceeded"
    // (newer). Not the size of one item (QUOTA_BYTES_PER_ITEM, kQuotaBytesPerItem), nor the
    // write rate limits (MAX_WRITE_OPERATIONS_PER_*).
    function isQuotaError(error) {
        return /\b(?:k)?QUOTA_?BYTES\b(?!_?PER)/i.test(String(error && error.message || error));
    }

    // Writes the given settings; the caller holds the lock. A value and its index are written
    // in one set() call, so readers never see a half-written list.
    async function writeSettings(values, storage) {
        await recoverJournal(storage);

        // Saved lists: the synced ones in sync storage, the others on this device. Written so
        // that a failure leaves everything as it was:
        // 1. this device gets its lists' new versions, and keeps those leaving for sync storage
        //    next to them (only those: a list deleted or replaced isn't kept, so that a smaller
        //    set of lists always fits where a larger one was): the largest write of this
        //    device's storage comes first, so that a
        //    full storage fails before anything at all has changed (synced words included), and
        //    a list moving here is in its new place before it leaves the old one;
        // 2. sync storage is written; if that fails, this device's lists are put back as they
        //    were (so a failed import changes nothing);
        // 3. the lists which left for sync storage are dropped from this device (a smaller
        //    write; if even that fails, their old copies are harmless, see below).
        // Meanwhile a list may be in both places: readers take the synced one (see
        // withLocalLists()), which is the one of before until sync storage has been written.
        const local = journalStore(storage);
        let localLists = null;
        let previous = null;
        if (local && Object.prototype.hasOwnProperty.call(values, 'lists')) {
            const all = sanitizeLists(values.lists);
            localLists = all.filter(l => l.local);
            values = { ...values, lists: all.filter(l => !l.local) };
            const stored = (await local.get(LOCAL_LISTS_KEY))[LOCAL_LISTS_KEY];
            previous = Array.isArray(stored) ? stored : [];
            const leaving = sanitizeLists(previous)
                .filter(l => !localLists.some(n => n.id === l.id) && values.lists.some(n => n.id === l.id))
                .map(l => ({ ...l, local: true }));
            await local.set({ [LOCAL_LISTS_KEY]: localLists.concat(leaving) });
        }
        try {
            await writeSyncSettings(values, storage);
        } catch (error) {
            if (localLists) await local.set({ [LOCAL_LISTS_KEY]: previous }).catch(() => {});
            throw error;
        }
        if (localLists) {
            await local.set({ [LOCAL_LISTS_KEY]: localLists }).catch(error =>
                console.warn('uHighlight: lists which moved to sync storage still on this device', error));
        }
    }

    async function writeSyncSettings(values, storage) {

        const toSet = {};
        const toRemove = [];
        const existing = await storage.get(null);
        const has = key => Object.prototype.hasOwnProperty.call(existing, key);

        // A value already stored as given isn't written again: a change to this device's lists
        // only, or a setting set to what it is, then makes no write of sync storage at all (which
        // Chrome limits, per minute and per hour, and may refuse for a while).
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const storedAs = key => {
            if (existing[indexKey(key)] === undefined || has(key)) return undefined;  // older format
            try {
                const value = joinChunks(existing, key);
                return value === undefined ? undefined : JSON.stringify(value);
            } catch (e) {
                return undefined;
            }
        };

        for (const key of Object.keys(values)) {
            if (!SETTING_KEYS.includes(key)) continue;
            if (!CHUNKED_KEYS.includes(key)) {
                if (!has(key) || !same(existing[key], values[key])) toSet[key] = values[key];
                continue;
            }

            const text = JSON.stringify(values[key]);
            if (storedAs(key) === text) continue;
            const chunks = splitIntoChunks(text);
            const gen = newGeneration();
            chunks.forEach((chunk, i) => { toSet[chunkKey(key, gen, i)] = chunk; });
            toSet[indexKey(key)] = { gen, count: chunks.length, hash: hashOf(text) };
            toSet[countKey(key)] = chunks.length;

            // Everything of the value as it was: its chunks (any generation, or the older
            // format), and the plain single item. The new generation's names are all new.
            const pattern = chunkPattern(key);
            Object.keys(existing).forEach(name => {
                if (pattern.test(name)) toRemove.push(name);
            });
            if (has(key)) toRemove.push(key);
        }

        if (Object.keys(toSet).length === 0 && toRemove.length === 0) return;
        try {
            await storage.set(toSet);
        } catch (error) {
            if (!isQuotaError(error) || toRemove.length === 0) throw error;
            await replaceWithJournal(storage, existing, toSet, toRemove);
            return;
        }
        if (toRemove.length > 0) {
            // The new value is complete; old chunks left over by a failure here are harmless,
            // and removed by the next save.
            await storage.remove(toRemove).catch(error => console.warn('uHighlight: cleanup failed', error));
        }
    }

    // The new value doesn't fit next to the one it replaces: journal the old items, remove
    // them, write the new value. On failure, put the old items back (or leave the journal).
    async function replaceWithJournal(storage, existing, toSet, toRemove) {
        const local = journalStore(storage);
        const has = key => Object.prototype.hasOwnProperty.call(existing, key);
        const items = {};
        toRemove.forEach(key => { if (has(key)) items[key] = existing[key]; });
        Object.keys(toSet).forEach(key => { if (has(key)) items[key] = existing[key]; });
        const added = Object.keys(toSet).filter(key => !has(key));
        const journal = { items, added, time: Date.now() };

        if (!local) {
            // A storage area without a journal (tests): the old behavior, best effort
            await storage.remove(toRemove);
            try {
                await storage.set(toSet);
            } catch (error) {
                await storage.set(items).catch(() => {});
                throw error;
            }
            return;
        }

        await local.set({ [JOURNAL_KEY]: journal });
        await storage.remove(toRemove);
        try {
            await storage.set(toSet);
        } catch (error) {
            await restoreJournal(storage, journal).catch(() => {
                // Left in the journal: read from there, and put back on the next save
            });
            throw error;
        }
        await local.remove(JOURNAL_KEY).catch(() => {});
    }

    // Saves only the given settings.
    function saveSettings(values, storage = defaultStorage()) {
        return withSettingsLock(() => writeSettings(values, storage));
    }

    // Read-modify-write against the *latest* stored settings: `change(settings)` edits a fresh
    // copy and returns the keys to save. This keeps a change made in the popup from wiping out
    // one made on the Settings page (or synced from another device) a moment earlier. The read
    // and the write happen under the lock, so no other write can come in between.
    function updateSettings(change, storage = defaultStorage()) {
        return withSettingsLock(async () => {
            await recoverJournal(storage);
            const latest = await loadSettings(storage);
            const values = change(latest);
            if (values && Object.keys(values).length > 0) {
                await writeSettings(values, storage);
            }
            return values;
        });
    }

    // ------------------------------------------------------------------ changes
    //
    // A change to the settings, described as data ({ type: 'addWord', text, look }...) rather
    // than as a function, so that a page can hand it to the background worker (commit()), and
    // so that the very same change can be shown at once in the page (applyChange() on its own
    // copy) and then made on the latest stored settings. Checks which depend on the stored
    // list (a name already taken) are made again there, under the lock.

    function cleanText(text) {
        return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
    }

    // A word with the given look: { color, textColor (null = automatic), style }.
    // Defaults aren't stored: no textColor = automatic, no style = background.
    function withLook(word, look) {
        const l = look || {};
        word.color = isValidColor(l.color) ? l.color : (isValidColor(word.color) ? word.color : '#ffff00');
        if (isValidColor(l.textColor)) word.textColor = l.textColor; else delete word.textColor;
        if (l.style === 'underline' || l.style === 'wavy') word.style = l.style; else delete word.style;
        return word;
    }

    // Only the parts of a look which are given (an edit sends what was changed in it): the
    // others stay as the word has them, which another page may have just changed. textColor
    // null = automatic, style 'background' = the default.
    function withLookChanges(word, look) {
        const l = look || {};
        const given = key => Object.prototype.hasOwnProperty.call(l, key);
        if (given('color') && isValidColor(l.color)) word.color = l.color;
        if (!isValidColor(word.color)) word.color = '#ffff00';
        if (given('textColor')) {
            if (isValidColor(l.textColor)) word.textColor = l.textColor; else delete word.textColor;
        }
        if (given('style')) {
            if (l.style === 'underline' || l.style === 'wavy') word.style = l.style; else delete word.style;
        }
        return word;
    }

    function sectionTooLong(section) {
        return `The section is too long: ${section.length} characters, at most ${MAX_SECTION}. Pick a smaller part of the page, or shorten the selector.`;
    }

    const SITE_LISTS = ['enabledDomains', 'excludedDomains'];

    // Applies a change to `settings` (edited in place) and returns the settings to save.
    // Throws an Error with a message for the user when the change can't be made.
    // Changes to words take `list`: a saved list's id, or nothing for My words.
    // `options.checkExpect` (default true): refuse an undo whose target changed since (see
    // inverseOf()). Pages showing a change at once on their own copy, which may be behind,
    // leave the check to the background worker, which makes it on the stored settings.
    function applyChange(settings, change, options = {}) {
        const checkExpect = options.checkExpect !== false;
        const expectOk = actual => {
            if (checkExpect && change && change.expect && fingerprint(actual) !== change.expect) {
                throw new Error('it has changed since, so nothing was undone.');
            }
        };
        const sites = () => ({ enabledDomains: settings.enabledDomains, excludedDomains: settings.excludedDomains });
        const lists = () => ({ lists: settings.lists });
        const c = change || {};
        const has = (object, key) => !!object && Object.prototype.hasOwnProperty.call(object, key);

        // The word list a change is about
        const target = () => {
            if (!c.list) {
                return { words: settings.words, set: words => { settings.words = words; }, saved: () => ({ words: settings.words }) };
            }
            const list = settings.lists.find(l => l.id === c.list);
            if (!list) throw new Error('That list no longer exists.');
            return { words: list.words, set: words => { list.words = words; }, saved: lists };
        };
        const findList = id => {
            const list = settings.lists.find(l => l.id === id);
            if (!list) throw new Error('That list no longer exists.');
            return list;
        };

        switch (c.type) {
            case 'setOptions': {
                const out = {};
                ['caseSensitive', 'partialMatch', 'globalEnabled', 'showBadge'].forEach(key => {
                    if (has(c.values, key)) {
                        settings[key] = c.values[key] === true;
                        out[key] = settings[key];
                    }
                });
                return out;
            }
            case 'addWord': {
                const t = target();
                const text = cleanText(c.text);
                if (!text) throw new Error('Enter a word or phrase first.');
                const index = findWordIndex(t.words, text, settings.caseSensitive);
                if (index !== -1) {
                    // Adding a paused word again means "I want this highlighted": resume it
                    withLook(t.words[index], c.look);
                    delete t.words[index].paused;
                } else {
                    t.words.push(withLook({ text }, c.look));
                }
                return t.saved();
            }
            case 'addWords': {
                // Many at once (pasted, one per line); words already in the list are left as they are
                const t = target();
                const texts = Array.isArray(c.texts) ? c.texts.map(cleanText).filter(Boolean) : [];
                if (texts.length === 0) throw new Error('Nothing to add.');
                texts.forEach(text => {
                    if (findWordIndex(t.words, text, settings.caseSensitive) !== -1) return;
                    const look = c.cycleColors ? { ...c.look, color: nextPresetColor(t.words) } : c.look;
                    t.words.push(withLook({ text }, look));
                });
                return t.saved();
            }
            case 'removeWord': {
                const t = target();
                t.set(t.words.filter(w => w.text !== c.text));
                return t.saved();
            }
            case 'setWordColor': {
                const t = target();
                if (!isValidColor(c.color)) throw new Error('Not a valid color.');
                t.words.forEach(w => { if (w.text === c.text) w.color = c.color; });
                return t.saved();
            }
            case 'setPaused': {
                const t = target();
                t.words.forEach(w => {
                    if (w.text !== c.text) return;
                    if (c.paused === true) w.paused = true; else delete w.paused;
                });
                return t.saved();
            }
            case 'editWord': {
                const t = target();
                const index = t.words.findIndex(w => w.text === c.text);
                if (index === -1) throw new Error(`"${c.text}" is no longer in the list.`);
                const text = cleanText(c.newText);
                if (!text) throw new Error('Entry cannot be empty.');
                if (findWordIndex(t.words, text, settings.caseSensitive, index) !== -1) {
                    throw new Error(`"${text}" is already in the list.`);
                }
                // Keeps the entry's other settings (paused), and the parts of its look which
                // weren't changed
                t.words[index] = withLookChanges({ ...t.words[index], text }, c.look);
                return t.saved();
            }
            case 'restoreWords': {
                // Undo of a removal: the words come back where they were, unless they are
                // there again already. Other changes made meanwhile are kept.
                const t = target();
                const items = (Array.isArray(c.words) ? c.words : [])
                    .map(item => ({ word: sanitizeWords([item && item.word])[0], index: Number(item && item.index) || 0 }))
                    .filter(item => item.word)
                    .sort((a, b) => a.index - b.index);
                items.forEach(({ word, index }) => {
                    if (t.words.some(w => w.text === word.text)) return;
                    t.words.splice(Math.min(Math.max(0, index), t.words.length), 0, word);
                });
                return t.saved();
            }
            case 'removeListUrls': {
                // Undo of a merge: the addresses it added to a list
                const list = findList(c.id);
                const urls = new Set(Array.isArray(c.urls) ? c.urls : []);
                list.urls = list.urls.filter(u => !urls.has(u));
                return lists();
            }
            case 'removeWords': {
                // Undo of an addition: only the entries it added, as it added them. An entry with
                // the same text but another look was added again since (removed and re-added
                // elsewhere): it stays. (`texts`: by text alone.)
                const t = target();
                expectOk(wordsRevision(settings, c.list));
                if (Array.isArray(c.words)) {
                    const added = sanitizeWords(c.words);
                    t.set(t.words.filter(w => !added.some(a => sameEntry(a, w))));
                } else {
                    const texts = new Set(Array.isArray(c.texts) ? c.texts : []);
                    t.set(t.words.filter(w => !texts.has(w.text)));
                }
                return t.saved();
            }
            case 'restoreList': {
                // Undo of deleting a list: back in its place, unless it is there again
                const [list] = sanitizeLists([c.list]);
                if (!list) throw new Error('Not a valid list.');
                if (!settings.lists.some(l => l.id === list.id)) {
                    settings.lists.splice(Math.min(Math.max(0, Number(c.index) || 0), settings.lists.length), 0, list);
                }
                return lists();
            }
            case 'batch': {
                // Several changes as one (Undo of an import merge)
                const out = {};
                (Array.isArray(c.changes) ? c.changes : []).forEach(each => {
                    if (each && each.type === 'batch') throw new Error('Unknown change.');
                    Object.assign(out, applyChange(settings, each, options));
                });
                // The values are the settings' own objects: take their final state
                Object.keys(out).forEach(key => { out[key] = settings[key]; });
                return out;
            }
            case 'addList': {
                const [list] = sanitizeLists([c.list]);
                if (!list) throw new Error('Not a valid list.');
                if (settings.lists.some(l => l.id === list.id)) throw new Error('That list already exists.');
                settings.lists.push(list);
                return lists();
            }
            case 'updateList': {
                const list = findList(c.id);
                const patch = c.patch && typeof c.patch === 'object' ? c.patch : {};
                if (has(patch, 'section') && typeof patch.section === 'string' && patch.section.trim().length > MAX_SECTION) {
                    throw new Error(sectionTooLong(patch.section.trim()));
                }
                if (has(patch, 'urls')) {
                    const bad = (Array.isArray(patch.urls) ? patch.urls : []).filter(u => cleanText(u) && !normalizeUrlPattern(u));
                    if (bad.length > 0) throw new Error(`Not an address pattern: ${bad.join(', ')}`);
                }
                const merged = { ...list };
                ['name', 'enabled', 'urls', 'section', 'local', 'words'].forEach(key => {
                    if (has(patch, key)) merged[key] = patch[key];
                });
                const [clean] = sanitizeLists([merged]);
                settings.lists[settings.lists.indexOf(list)] = clean;
                return lists();
            }
            case 'setListSection': {
                const list = findList(c.id);
                const section = typeof c.section === 'string' ? c.section.trim() : '';
                if (section.length > MAX_SECTION) throw new Error(sectionTooLong(section));
                list.section = section;
                return lists();
            }
            case 'removeList': {
                const list = settings.lists.find(l => l.id === c.id);
                if (list) expectOk(list);
                settings.lists = settings.lists.filter(l => l.id !== c.id);
                return lists();
            }
            case 'toggleSite': {
                // Off means nothing is highlighted on the site: not My words, and not a saved
                // list which runs there by its address pattern either (the site is excluded
                // then). `url`: the page's address, for those patterns.
                const domain = normalizeHostname(c.domain);
                if (!domain) throw new Error('No site to change.');
                if (c.on === true && c.url) {
                    // Back on after it was turned off: dropping this site's exclusion is enough
                    // when something runs on the page again (a saved list by its address), and
                    // My words aren't turned on for the whole site as well
                    delete settings.excludedDomains[domain];
                    const scope = pageScope(settings, c.url);
                    if (!scope.excludedBy && (scope.defaultRuns || scope.lists.some(l => l.runs))) return sites();
                }
                toggleSite(settings, domain, c.on === true);
                if (c.on !== true && c.url && pageScope(settings, c.url).lists.some(l => l.runs)) {
                    settings.excludedDomains[domain] = true;
                }
                return sites();
            }
            case 'addSiteRule':
            case 'removeSiteRule': {
                if (!SITE_LISTS.includes(c.list)) throw new Error('Unknown list.');
                const rule = normalizeSiteRule(c.rule);
                if (!rule) throw new Error(`"${c.rule}" doesn't look like a website.`);
                if (c.type === 'addSiteRule') settings[c.list][rule] = true;
                else delete settings[c.list][rule];
                return { [c.list]: settings[c.list] };
            }
            case 'replace': {
                // Import, undo, clearing the words: the given settings replace the stored ones
                const values = c.values && typeof c.values === 'object' ? c.values : {};
                const present = SETTING_KEYS.filter(key => has(values, key));
                expectOk(present.map(key => settings[key]));
                const clean = sanitizeSettings(values);
                const out = {};
                present.forEach(key => {
                    settings[key] = clean[key];
                    out[key] = clean[key];
                });
                return out;
            }
            case 'merge': {
                // Import, keeping what is there: words, lists and websites are added to; options
                // are left as they are
                const values = c.values && typeof c.values === 'object' ? c.values : {};
                const clean = sanitizeSettings(values);
                const out = {};
                const addWords = (into, words) => words.forEach(w => {
                    if (findWordIndex(into, w.text, settings.caseSensitive) === -1) into.push(w);
                });
                if (has(values, 'words')) {
                    addWords(settings.words, clean.words);
                    out.words = settings.words;
                }
                if (has(values, 'lists')) {
                    clean.lists.forEach(incoming => {
                        // Only into a list kept in the same place: the words of a list kept
                        // on this device must never end up in a synced one (nor the reverse)
                        const candidates = settings.lists.filter(l => l.local === incoming.local);
                        const same = candidates.find(l => l.id === incoming.id) ||
                            candidates.find(l => l.name.toLowerCase() === incoming.name.toLowerCase());
                        if (same) {
                            addWords(same.words, incoming.words);
                            incoming.urls.forEach(u => { if (!same.urls.includes(u)) same.urls.push(u); });
                        } else {
                            // Its own id, or (taken) one derived from it: the same in the page
                            // and in the background worker, so that Undo finds it
                            const taken = settings.lists.some(l => l.id === incoming.id);
                            settings.lists.push({ ...incoming, id: taken ? 'm' + hashOf(incoming.id + '|' + incoming.name) : incoming.id });
                        }
                    });
                    out.lists = settings.lists;
                }
                SITE_LISTS.forEach(key => {
                    if (!has(values, key)) return;
                    Object.keys(clean[key]).forEach(rule => { settings[key][rule] = true; });
                    out[key] = settings[key];
                });
                return out;
            }
            default:
                throw new Error('Unknown change.');
        }
    }

    // A fingerprint of a part of the settings, the same however it was read: object keys in
    // order, saved lists by id (the ones kept on this device are read after the synced ones).
    function fingerprint(value) {
        const canonical = v => {
            if (Array.isArray(v)) {
                const items = v.map(canonical);
                return v.length && v.every(x => x && typeof x === 'object' && typeof x.id === 'string')
                    ? items.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
                    : items;
            }
            if (v && typeof v === 'object') {
                const out = {};
                Object.keys(v).sort().forEach(key => { out[key] = canonical(v[key]); });
                return out;
            }
            return v;
        };
        return hashOf(JSON.stringify(canonical(value === undefined ? null : value)));
    }

    // A set of words (My words, or a saved list's) and its revision: what an undo acting on
    // it checks (see inverseOf()). Null for a list which isn't there.
    function wordsRevision(settings, list) {
        if (!list) return { words: settings.words, rev: settings.wordsRev };
        const found = settings.lists.find(l => l.id === list);
        return found ? { words: found.words, rev: found.rev } : null;
    }

    // Every change of a set of words gives it a new revision, and every list which appears
    // (added, put back, imported) too: words have no identity of their own, so without it a
    // word removed and added again as it was would look as if it had never left, and an undo
    // of its first addition would remove it. `values`: the settings to save, completed.
    function bumpRevisions(before, after, values) {
        const differ = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
        if (differ(before.words, after.words) || before.wordsRev !== after.wordsRev) {
            after.wordsRev = Math.max(before.wordsRev, after.wordsRev) + 1;
            values.wordsRev = after.wordsRev;
        }
        let lists = false;
        after.lists.forEach(list => {
            const was = before.lists.find(l => l.id === list.id);
            if (!was || differ(was.words, list.words) || was.rev !== list.rev) {
                list.rev = Math.max(was ? was.rev : 0, list.rev) + 1;
                lists = true;
            }
        });
        if (lists) values.lists = after.lists;
        return values;
    }

    // The change which undoes `change`, from the settings before and after it: only what it
    // did is undone (a removed word comes back, added words go), so that other changes made
    // meanwhile, in another page or on another device, are kept. Null when it can't be undone.
    // (Undoing an import which replaced the settings puts back the settings it replaced.)
    // An undo which removes or replaces something carries `expect`: the fingerprint of what it
    // acts on, as the change left it. Changed since (a word added to the list, a word removed and
    // added again...), the undo is refused rather than taking those changes with it.
    function inverseOf(change, before, after) {
        const c = change || {};
        const wordsIn = (settings, list) => {
            if (!list) return settings.words;
            const found = settings.lists.find(l => l.id === list);
            return found ? found.words : [];
        };
        // The entries added (as they are), not only their texts: see 'removeWords'
        const added = (list, from, to) => {
            const had = new Set(wordsIn(from, list).map(w => w.text));
            return wordsIn(to, list).filter(w => !had.has(w.text));
        };
        const removed = (list, from, to) => {
            const has = new Set(wordsIn(to, list).map(w => w.text));
            return wordsIn(from, list)
                .map((word, index) => ({ word, index }))
                .filter(item => !has.has(item.word.text));
        };
        const addedSites = key => Object.keys(after[key]).filter(rule => !hasSiteRule(before[key], rule));

        switch (c.type) {
            case 'removeWord':
            case 'removeWords': {
                const words = removed(c.list, before, after);
                return words.length ? { type: 'restoreWords', list: c.list || '', words } : null;
            }
            case 'addWord':
            case 'addWords': {
                const words = added(c.list, before, after);
                return words.length ? {
                    type: 'removeWords', list: c.list || '', words, expect: fingerprint(wordsRevision(after, c.list))
                } : null;
            }
            case 'removeList': {
                const index = before.lists.findIndex(l => l.id === c.id);
                return index === -1 ? null : { type: 'restoreList', list: before.lists[index], index };
            }
            case 'addList': {
                const list = c.list && after.lists.find(l => l.id === c.list.id);
                return list ? { type: 'removeList', id: list.id, expect: fingerprint(list) } : null;
            }
            case 'removeSiteRule':
            case 'addSiteRule': {
                const rule = normalizeSiteRule(c.rule);
                if (!rule) return null;
                const had = hasSiteRule(before[c.list], rule);
                const has = hasSiteRule(after[c.list], rule);
                if (had === has) return null;
                return { type: had ? 'addSiteRule' : 'removeSiteRule', list: c.list, rule };
            }
            case 'replace': {
                const values = c.values && typeof c.values === 'object' ? c.values : {};
                const keys = SETTING_KEYS.filter(key => Object.prototype.hasOwnProperty.call(values, key) ||
                    (key === 'wordsRev' && Object.prototype.hasOwnProperty.call(values, 'words')));
                // Clearing My words: they come back, next to any added meanwhile. (Replacing
                // them with others, an import: the words of before replace them again.)
                if (keys.length === 1 && keys[0] === 'words' && Array.isArray(values.words) && values.words.length === 0) {
                    const words = removed('', before, after);
                    return words.length ? { type: 'restoreWords', list: '', words } : null;
                }
                const back = {};
                keys.forEach(key => { back[key] = before[key]; });
                return { type: 'replace', values: back, expect: fingerprint(keys.map(key => after[key])) };
            }
            case 'merge': {
                const changes = [];
                const words = added('', before, after);
                if (words.length) changes.push({ type: 'removeWords', list: '', words, expect: fingerprint(wordsRevision(after, '')) });
                after.lists.forEach(list => {
                    if (!before.lists.some(l => l.id === list.id)) {
                        changes.push({ type: 'removeList', id: list.id, expect: fingerprint(list) });
                    } else {
                        const more = added(list.id, before, after);
                        if (more.length) changes.push({ type: 'removeWords', list: list.id, words: more, expect: fingerprint(wordsRevision(after, list.id)) });
                        const was = before.lists.find(l => l.id === list.id);
                        const urls = list.urls.filter(u => !was.urls.includes(u));
                        if (urls.length) changes.push({ type: 'removeListUrls', id: list.id, urls });
                    }
                });
                SITE_LISTS.forEach(key => addedSites(key).forEach(rule =>
                    changes.push({ type: 'removeSiteRule', list: key, rule })));
                return changes.length ? { type: 'batch', changes } : null;
            }
            default:
                return null;
        }
    }

    // Returns { values, inverse }: what was saved, and the change which undoes what was
    // actually done to the stored settings (null when nothing was, or it can't be undone).
    // Computed here, on the latest settings: a page's own copy may be behind (another page may
    // have made the same change already, and then this one changed nothing).
    async function applyToStorage(change) {
        const copy = settings => sanitizeSettings(JSON.parse(JSON.stringify(settings)));
        if (change && change.type === 'replace') {
            // The given settings are written as they are, without reading the stored ones
            // first: so that importing a backup repairs settings which can't be read anymore.
            // (The fingerprint of an undo is checked against the stored settings, below.)
            const values = applyChange(sanitizeSettings({}), change, { checkExpect: false });
            return withSettingsLock(async () => {
                let before = null;
                try {
                    before = await loadSettings();
                } catch (e) {
                    before = null;   // damaged: what is replaced can't be put back
                }
                if (change.expect) {
                    // An undo: only if what it replaces is still as the import left it
                    const keys = Object.keys(values);
                    if (!before || fingerprint(keys.map(key => before[key])) !== change.expect) {
                        throw new Error('it has changed since, so nothing was undone.');
                    }
                }
                const base = before || sanitizeSettings({});
                bumpRevisions(base, copy({ ...base, ...values }), values);
                if (Object.keys(values).length > 0) await writeSettings(values, defaultStorage());
                const inverse = before ? inverseOf(change, before, copy({ ...before, ...values })) : null;
                return { values, inverse };
            });
        }
        let inverse = null;
        const values = await updateSettings(latest => {
            const before = copy(latest);
            const out = applyChange(latest, change);
            if (Object.keys(out).length > 0) bumpRevisions(before, latest, out);
            inverse = inverseOf(change, before, latest);
            return out;
        });
        return { values: values || {}, inverse };
    }

    const IN_BACKGROUND = typeof ServiceWorkerGlobalScope !== 'undefined' &&
        globalThis instanceof ServiceWorkerGlobalScope;

    // From a page (popup, settings): hands the change to the background worker, which makes
    // it. Not made in the page itself: a page can be closed at any moment (the popup, as soon
    // as it loses focus), and a change still waiting for the lock would be lost with it, after
    // the page had already shown it as done. Once sent, the change is the worker's to make.
    async function commit(change) {
        if (IN_BACKGROUND) return applyToStorage(change);
        const response = await chrome.runtime.sendMessage({ uhighlightCommit: change });
        if (!response) throw new Error("uHighlight's background worker didn't answer.");
        if (response.error) throw new Error(response.error);
        return { values: response.values || {}, inverse: response.inverse || null };
    }

    // True if a storage.onChanged event touches any setting (in any format).
    function isSettingsChange(changes, area = 'sync') {
        if (area === 'local') return Object.prototype.hasOwnProperty.call(changes, LOCAL_LISTS_KEY);
        if (area !== 'sync') return false;
        return Object.keys(changes).some(key =>
            SETTING_KEYS.includes(key) || CHUNKED_KEYS.some(chunked => key.startsWith(chunked + '__')));
    }

    function sanitizeSettings(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        return {
            words: sanitizeWords(source.words),
            caseSensitive: source.caseSensitive === true,
            partialMatch: source.partialMatch === true,
            globalEnabled: source.globalEnabled === true,
            enabledDomains: sanitizeSiteRules(source.enabledDomains),
            excludedDomains: sanitizeSiteRules(source.excludedDomains),
            lists: sanitizeLists(source.lists),
            showBadge: source.showBadge !== false,
            wordsRev: sanitizeRev(source.wordsRev)
        };
    }

    // An imported file: which settings it has, and whether each is of the right kind. Returns
    // { values, problems }: `values` only has the settings present in the file; `problems`
    // says what is wrong (then nothing should be imported: a list of the wrong type would
    // otherwise replace the stored one with an empty one).
    function validateImport(parsed) {
        const problems = [];
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { values: {}, problems: ['the file is not a uHighlight settings file'] };
        }
        const present = SETTING_KEYS.filter(key => key !== 'wordsRev' && Object.prototype.hasOwnProperty.call(parsed, key));
        if (present.length === 0) {
            return { values: {}, problems: ["the file doesn't contain uHighlight settings"] };
        }
        const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
        present.forEach(key => {
            const value = parsed[key];
            if (key === 'words') {
                if (!Array.isArray(value)) {
                    problems.push('"words" should be a list');
                } else if (value.length > 0 && sanitizeWords(value).length === 0) {
                    problems.push('none of its words is valid');
                }
            } else if (key === 'lists') {
                if (!Array.isArray(value)) {
                    problems.push('"lists" should be a list');
                } else if (value.some(l => !isPlainObject(l))) {
                    problems.push('some of its saved lists are not valid');
                } else {
                    value.forEach((l, i) => {
                        const name = typeof l.name === 'string' && l.name.trim() ? `"${l.name.trim()}"` : `number ${i + 1}`;
                        if (Object.prototype.hasOwnProperty.call(l, 'words')) {
                            if (!Array.isArray(l.words)) {
                                problems.push(`the words of saved list ${name} should be a list`);
                            } else if (l.words.length > 0 && sanitizeWords(l.words).length === 0) {
                                problems.push(`none of the words of saved list ${name} is valid`);
                            }
                        }
                        if (Object.prototype.hasOwnProperty.call(l, 'urls')) {
                            if (!Array.isArray(l.urls)) {
                                problems.push(`the addresses of saved list ${name} should be a list`);
                            } else {
                                l.urls.filter(u => typeof u !== 'string' || (u.trim() && !normalizeUrlPattern(u)))
                                    .forEach(u => problems.push(`"${String(u)}" in saved list ${name} is not an address pattern`));
                            }
                        }
                    });
                }
            } else if (SITE_LISTS.includes(key)) {
                if (!isPlainObject(value)) {
                    problems.push(`"${key}" should be a list of websites`);
                } else {
                    const entries = Object.keys(value).filter(rule => value[rule] === true);
                    if (entries.length > 0 && Object.keys(sanitizeSiteRules(value)).length === 0) {
                        problems.push(`none of the websites in "${key}" is valid`);
                    }
                }
            } else if (typeof value !== 'boolean') {
                problems.push(`"${key}" should be true or false`);
            }
        });
        const clean = sanitizeSettings(parsed);
        const values = {};
        present.forEach(key => { values[key] = clean[key]; });
        return { values, problems };
    }

    return {
        DEFAULT_SETTINGS,
        SETTING_KEYS,
        loadSettings,
        saveSettings,
        updateSettings,
        applyChange,
        bumpRevisions,
        inverseOf,
        applyToStorage,
        commit,
        validateImport,
        DamagedSettingsError,
        isSettingsChange,
        splitIntoChunks,
        normalizeHostname,
        normalizeSiteRule,
        findSiteRule,
        hasSiteRule,
        DEFAULT_LIST_NAME,
        LOCAL_LISTS_KEY,
        MAX_SECTION,
        newListId: newId,
        sanitizeLists,
        normalizeUrlPattern,
        urlPatternMatches,
        pageScope,
        ALL_ORIGINS,
        originsFor,
        originsNeeded,
        isEnabledForHost,
        isValidColor,
        PRESET_COLORS,
        nextPresetColor,
        findWordIndex,
        toggleSite,
        autoTextColor,
        textColorFor,
        wordStyle,
        highlightDeclarations,
        highlightCss,
        sanitizeWords,
        sanitizeSiteRules,
        sanitizeSettings
    };
})();
