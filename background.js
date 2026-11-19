// Background service worker for uHighlight
//
// Highlighting itself is driven by the content script: it reads settings on load and listens
// to chrome.storage.onChanged, so no tab messaging is needed here. This worker handles:
// - install/update, and access granted to sites: injecting the content script into tabs
//   that were already open
// - the right-click "Highlight <selection>" menu
// - the keyboard shortcut that turns highlighting on/off for the current site
// - changes to the settings sent by the extension's pages (Shared.commit())
// - the number of matches on the toolbar icon, and "Pick a section" results from the page
//
// Deliberately no "write default settings on install": every reader passes defaults to
// storage.sync.get(), and on a fresh install sync data often hasn't arrived yet, so writing
// defaults could replace the user's synced word list on all of their devices.

importScripts('shared.js');

const Shared = globalThis.WordHighlighterShared;
const CONTENT_SCRIPT_FILES = ['shared.js', 'content.js'];
const MENU_ID = 'highlight-selection';
const MAX_SELECTION_LENGTH = 200;   // longer selections are almost certainly not meant as a word

chrome.runtime.onInstalled.addListener((details) => {
    console.log('uHighlight installed/updated', details.reason);

    // Context menu items persist once created; (re)create them on install/update.
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: MENU_ID,
            title: 'Highlight "%s"',
            contexts: ['selection']
        }, () => void chrome.runtime.lastError);
    });

    // Tabs that were already open don't get the (new) content script until they reload.
    // Inject it now so install/update doesn't require refreshing every page.
    // (Not on 'chrome_update': the existing content scripts are still alive then.)
    if (details.reason !== 'install' && details.reason !== 'update') return;
    // A new version may bring new content scripts: registered again
    registerContentScripts(true).then(() => {
        chrome.tabs.query({ url: Shared.ALL_ORIGINS }, tabs => tabs.forEach(tab => injectInto(tab.id)));
    });
});

// ---------------------------------------------------------------- content scripts
//
// Registered here rather than declared in the manifest: content scripts declared there run on
// every site they match, whatever access the user has granted, and their matches count as
// access to all of them. Registered ones only run on the sites the extension may read (those
// the user allowed), which is the point of asking for each.

const CONTENT_SCRIPTS = [
    {
        id: 'uh-shadow-hook',
        js: ['shadow-hook.js'],
        world: 'MAIN',
        runAt: 'document_start',
        matches: Shared.ALL_ORIGINS,
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true
    },
    {
        id: 'uh-content',
        js: CONTENT_SCRIPT_FILES,
        runAt: 'document_idle',
        matches: Shared.ALL_ORIGINS,
        allFrames: true,
        matchOriginAsFallback: true,
        persistAcrossSessions: true
    }
];

// One registration at a time (the worker's start and an update can both ask)
let registering = Promise.resolve();
function registerContentScripts(replace = false) {
    registering = registering.then(() => doRegisterContentScripts(replace));
    return registering;
}

async function doRegisterContentScripts(replace) {
    try {
        const ids = CONTENT_SCRIPTS.map(script => script.id);
        const existing = (await chrome.scripting.getRegisteredContentScripts({ ids })).map(script => script.id);
        if (replace && existing.length > 0) {
            await chrome.scripting.unregisterContentScripts({ ids: existing });
        }
        const missing = CONTENT_SCRIPTS.filter(script => replace || !existing.includes(script.id));
        if (missing.length > 0) await chrome.scripting.registerContentScripts(missing);
    } catch (error) {
        console.error('uHighlight: content scripts not registered', error);
    }
}

// Every time the worker starts: a browser which lost them (or a first start) gets them
registerContentScripts();

// Starts highlighting in an open tab: only where the extension may (sites it has access to,
// or the tab the user just acted on: the popup, the menu, the shortcut).
function injectInto(tabId) {
    // Shadow roots attached from now on (see shadow-hook.js); a page which was already
    // wrapped by the previous version is left as it is.
    chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['shadow-hook.js'],
        world: 'MAIN'
    }).catch(() => {});
    return chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: CONTENT_SCRIPT_FILES
    }).catch(() => {
        // No access, or a page which can't be scripted (the Web Store)
    });
}

// Access to sites was granted (from the popup or the settings page): highlight the open tabs
// of those sites now, not after they reload.
chrome.permissions.onAdded.addListener(permissions => {
    const origins = permissions.origins || [];
    if (origins.length === 0) return;
    chrome.tabs.query({ url: origins }, tabs => tabs.forEach(tab => injectInto(tab.id)));
});

// Does the extension have lasting access to this site?
async function hasAccess(site) {
    try {
        return await chrome.permissions.contains({ origins: Shared.originsFor(site) });
    } catch (e) {
        return false;
    }
}

// Hostname of a tab's page, or null for pages the extension can't highlight
function siteOf(tab) {
    try {
        const url = new URL(tab && tab.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return Shared.normalizeHostname(url.hostname) || null;
    } catch (e) {
        return null;
    }
}

// Short feedback on the toolbar icon for one tab (the popup isn't open for these actions);
// then the icon shows the number of matches again.
function flashBadge(tabId, text, color, title) {
    if (tabId === undefined || tabId < 0) return;
    chrome.action.setBadgeBackgroundColor({ tabId, color });
    chrome.action.setBadgeText({ tabId, text });
    if (title) chrome.action.setTitle({ tabId, title });
    setTimeout(() => {
        chrome.action.setTitle({ tabId, title: 'uHighlight' });
        updateBadge(tabId);
    }, 2500);
}

// ---------------------------------------------------------------- matches on the toolbar icon
//
// Every frame of a page reports how many matches it has (content.js, reportCounts()); the
// icon shows the sum for the tab. Kept in chrome.storage.session, which outlives this worker
// being stopped and started again, but not the browser.

const BADGE_COLOR = '#3558d8';
let counts = null;            // tabId -> { documentId: total }
let countsQueue = Promise.resolve();
let showBadge = true;

const settingsReady = Shared.loadSettings().then(settings => { showBadge = settings.showBadge; }, () => {});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.showBadge) {
        showBadge = changes.showBadge.newValue !== false;
        chrome.tabs.query({}, tabs => tabs.forEach(tab => updateBadge(tab.id)));
    }
});

// Changes to the counts, one at a time
function withCounts(change) {
    countsQueue = countsQueue.then(async () => {
        if (!counts) {
            const stored = (await chrome.storage.session.get('counts')).counts;
            counts = stored && typeof stored === 'object' ? stored : {};
        }
        if (change(counts) !== false) await chrome.storage.session.set({ counts });
    }).catch(error => console.warn('uHighlight: counts', error));
    return countsQueue;
}

function tabTotal(tabId) {
    const frames = counts && counts[tabId];
    return frames ? Object.values(frames).reduce((sum, n) => sum + n, 0) : 0;
}

async function updateBadge(tabId) {
    await settingsReady;
    const total = showBadge ? tabTotal(tabId) : 0;
    const text = total > 999 ? '999+' : total > 0 ? String(total) : '';
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
    if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
    chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

function onCounts(sender, total) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId === undefined || tabId < 0) return;
    const doc = sender.documentId || String(sender.frameId);
    withCounts(all => {
        const frames = all[tabId] || (all[tabId] = {});
        if (total > 0) frames[doc] = total; else delete frames[doc];
        if (Object.keys(frames).length === 0) delete all[tabId];
    }).then(() => updateBadge(tabId));
}

// The address of a tab changed without a new page (history.pushState() and replaceState() of
// single-page apps, #fragments): every frame of the tab is told, since saved lists may run on
// some addresses of a site only. (A new page loads its content scripts anew.)
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (!info.url) return;
    chrome.tabs.sendMessage(tabId, { action: 'pageUrl', url: info.url }).catch(() => {});
});

// A tab goes to another page: the counts of the one it leaves no longer apply
chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status !== 'loading' || !info.url) return;
    withCounts(all => {
        if (!all[tabId]) return false;
        delete all[tabId];
    }).then(() => updateBadge(tabId));
});
chrome.tabs.onRemoved.addListener(tabId => {
    withCounts(all => {
        if (!all[tabId]) return false;
        delete all[tabId];
    });
});

const QUOTES_AT_ENDS = /^["'`“”‘’«»]+|["'`“”‘’«»]+$/g;
const BRACKETS = { '(': ')', '[': ']', '{': '}', '<': '>' };

// True if the bracket opening `text` is the one closing it: "(evil.com)", "((a) b)", but not
// "(foo) + (bar)", whose first bracket closes after "foo".
function wrappedInBrackets(text) {
    const open = text[0];
    const close = BRACKETS[open];
    if (!close || text[text.length - 1] !== close) return false;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === open) depth++;
        else if (text[i] === close) depth--;
        if (depth === 0) return i === text.length - 1;
    }
    return false;
}

// Selections often include what surrounds the word: quotes ("evil.com"), brackets
// ((evil.com)), or sentence punctuation (evil.com, / evil.com.). Strip that, but keep
// punctuation that belongs to the word: ".exe", "C++", "func()", "(foo) + (bar)".
function cleanSelection(raw) {
    let text = (raw || '').trim().replace(/\s+/g, ' ');
    for (let pass = 0; pass < 10; pass++) {
        const before = text;
        text = text
            .replace(QUOTES_AT_ENDS, '')
            .replace(/[,;:!?]+$/, '')
            .replace(/(?<!\.)\.$/, '')   // one sentence-ending period (keeps "...")
            .trim();
        const count = ch => text.split(ch).length - 1;
        const first = text[0];
        const last = text[text.length - 1];
        if (wrappedInBrackets(text)) {
            text = text.slice(1, -1).trim();                 // wrapped: (evil.com)
        } else if (BRACKETS[first] && count(BRACKETS[first]) === 0) {
            text = text.slice(1).trim();                     // unmatched opener: (evil.com
        } else {
            const opener = Object.keys(BRACKETS).find(o => BRACKETS[o] === last);
            if (opener && count(opener) === 0) text = text.slice(0, -1).trim();   // evil.com)
        }
        if (text === before) break;
    }
    return text;
}

// Right-click "Highlight <selection>": add the selected text as a word (next unused preset
// color) and make sure highlighting is on for this site, so the result shows right away.
async function addSelection(selectionText, tab) {
    const text = cleanSelection(selectionText);
    const tabId = tab && tab.id;
    if (!text) {
        flashBadge(tabId, '!', '#cc0000', 'Select a word or phrase first');
        return null;
    }
    if (text.length > MAX_SELECTION_LENGTH) {
        flashBadge(tabId, '!', '#cc0000', `Select a shorter piece of text (up to ${MAX_SELECTION_LENGTH} characters)`);
        return null;
    }
    const site = siteOf(tab);

    let outcome = 'added';
    await Shared.updateSettings(settings => {
        const index = Shared.findWordIndex(settings.words, text, settings.caseSensitive);
        if (index === -1) {
            settings.words.push({ text, color: Shared.nextPresetColor(settings.words) });
        } else if (settings.words[index].paused) {
            delete settings.words[index].paused;
            outcome = 'resumed';
        } else {
            outcome = 'exists';
        }

        let siteTurnedOn = false;
        if (site && !Shared.isEnabledForHost(site, settings)) {
            Shared.toggleSite(settings, site, true);
            siteTurnedOn = Shared.isEnabledForHost(site, settings);
        }
        if (outcome === 'exists' && !siteTurnedOn) return null;   // nothing to save
        return {
            words: settings.words,
            enabledDomains: settings.enabledDomains,
            excludedDomains: settings.excludedDomains
        };
    });

    // The menu gives the extension access to this tab for now: highlight it right away
    if (tabId !== undefined && site) injectInto(tabId);
    const noAccess = site && !(await hasAccess(site))
        ? ' Open uHighlight on this site and choose Allow to highlight it on your next visits too.'
        : '';
    if (outcome === 'exists') {
        flashBadge(tabId, '✓', '#666666', `"${text}" is already highlighted.${noAccess}`);
    } else {
        flashBadge(tabId, '+1', '#0054e3', (outcome === 'resumed' ? `"${text}" turned back on.` : `Added "${text}".`) + noAccess);
    }
    return outcome;
}

// Keyboard shortcut: turn highlighting on/off for the current site.
async function toggleCurrentSite(tab) {
    const site = siteOf(tab);
    const tabId = tab && tab.id;
    if (!site) {
        flashBadge(tabId, '!', '#cc0000', "Highlighting isn't available on this page");
        return null;
    }

    // On: anything runs on the page (My words, or a saved list by its address pattern); off
    // stops all of it (see applyChange(), 'toggleSite').
    const runsHere = settings => {
        const scope = Shared.pageScope(settings, tab.url);
        return scope.defaultRuns || scope.lists.some(l => l.runs);
    };
    let result = null;
    await Shared.updateSettings(settings => {
        const wasOn = runsHere(settings);
        Shared.applyChange(settings, { type: 'toggleSite', domain: site, on: !wasOn, url: tab.url });
        const isOn = runsHere(settings);
        result = { site, on: isOn, blockedBy: !wasOn && !isOn ? Shared.findSiteRule(site, settings.excludedDomains) : null };
        if (isOn === wasOn) return null;
        return { enabledDomains: settings.enabledDomains, excludedDomains: settings.excludedDomains };
    });

    if (result.blockedBy) {
        flashBadge(tabId, '!', '#cc0000', `${site} is excluded by the rule ${result.blockedBy} (see Settings)`);
    } else if (result.on) {
        // The shortcut gives the extension access to this tab for now
        if (tabId !== undefined) injectInto(tabId);
        const noAccess = !(await hasAccess(site))
            ? '. Open uHighlight on this site and choose Allow to keep it on for your next visits' : '';
        flashBadge(tabId, 'ON', '#1a8f1a', `Highlighting on for ${site}${noAccess}`);
    } else {
        flashBadge(tabId, 'OFF', '#666666', `Highlighting off for ${site}`);
    }
    return result;
}

// The popup isn't open for these actions, so a failed save (storage quota, settings still
// syncing) is reported on the toolbar icon instead of only in the worker's console.
function reportFailure(tab, action, error) {
    console.error(`Could not ${action}:`, error);
    flashBadge(tab && tab.id, '!', '#cc0000', `Could not ${action}: ${error && error.message ? error.message : error}`);
}

// Changes to the settings made in the popup and on the settings page (see Shared.commit()):
// made here, so that closing the page can't cancel one the page has already shown as done.
// Only from the extension's own pages, never from a content script in a web page.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || sender.id !== chrome.runtime.id) return;

    // From the content script of a page
    if (message.uhighlightPageUrl && sender.tab) {
        // A frame of another site may only know the page's origin: the whole address
        sendResponse({ url: sender.tab.url || '' });
        return;
    }
    if (message.uhighlightCounts && sender.tab) {
        const total = Number(message.uhighlightCounts.total);
        onCounts(sender, Number.isFinite(total) && total > 0 ? Math.floor(total) : 0);
        return;
    }
    if (message.uhighlightPick && sender.tab) {
        // "Pick a section": only this one change is accepted from a page's content script
        const { list, section } = message.uhighlightPick;
        Shared.applyToStorage({ type: 'setListSection', id: String(list), section: String(section || '') }).then(
            () => flashBadge(sender.tab.id, '✓', '#1a8f1a', `Section saved: ${section}`),
            error => reportFailure(sender.tab, 'save the section', error)
        );
        return;
    }

    if (!message.uhighlightCommit) return;
    const ownPages = chrome.runtime.getURL('');
    if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(ownPages)) {
        sendResponse({ error: 'Not allowed.' });
        return;
    }
    Shared.applyToStorage(message.uhighlightCommit).then(
        result => sendResponse({ values: result.values, inverse: result.inverse }),
        error => sendResponse({ error: error && error.message ? error.message : String(error) })
    );
    return true;   // the answer comes later
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) {
        addSelection(info.selectionText, tab).catch(error => reportFailure(tab, 'add the selection', error));
    }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command !== 'toggle-site') return;
    try {
        if (!tab) {
            [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        }
        await toggleCurrentSite(tab);
    } catch (error) {
        reportFailure(tab, 'change highlighting for this site', error);
    }
});
