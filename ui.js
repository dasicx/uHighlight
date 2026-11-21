// uHighlight: what the popup and the settings page have in common - the icons, the
// menus, the version.

(function () {
    const SVG = 'http://www.w3.org/2000/svg';
    const SPRITE = '/img/icons.svg';

    // The drawing of an icon of img/icons.svg
    function icon(name) {
        const svg = document.createElementNS(SVG, 'svg');
        svg.setAttribute('class', 'fa-icon_' + name);
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(SVG, 'use');
        use.setAttribute('href', SPRITE + '#' + name);
        svg.appendChild(use);
        return svg;
    }

    // <span class="fa-icon">cog</span>: the name is replaced with the drawing
    function initIcons(root = document) {
        root.querySelectorAll('.fa-icon').forEach(el => {
            const first = el.firstChild;
            if (!first || first.nodeType !== Node.TEXT_NODE || !first.nodeValue.trim()) return;
            el.replaceChild(icon(first.nodeValue.trim()), first);
            if (el.classList.contains('fa-icon-badged')) {
                const badge = document.createElement('span');
                badge.className = 'fa-icon-badge';
                el.appendChild(badge);
            }
        });
    }

    // A button with an icon and no words (its name is its tooltip and accessible name)
    function iconButton(name, label, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = ('fa-icon icon-button ' + className).trim();
        button.title = label;
        button.setAttribute('aria-label', label);
        button.appendChild(icon(name));
        return button;
    }

    // Menus: a button with data-dropdown="<id of a .dropdown-menu-capture>" opens it under
    // itself. A click outside the menu, or Esc, closes it.
    function initMenus() {
        document.querySelectorAll('[data-dropdown]').forEach(button => {
            const capture = document.getElementById(button.dataset.dropdown);
            if (!capture) return;
            const menu = capture.querySelector('.dropdown-menu');
            button.setAttribute('aria-haspopup', 'true');
            button.setAttribute('aria-expanded', 'false');

            const close = () => {
                capture.classList.remove('show');
                button.setAttribute('aria-expanded', 'false');
            };
            const open = () => {
                capture.classList.add('show');
                // Under the button, its right edge on the button's
                const rect = button.getBoundingClientRect();
                menu.style.top = Math.round(rect.bottom + 3) + 'px';
                menu.style.left = Math.max(4, Math.round(rect.right - menu.offsetWidth)) + 'px';
                button.setAttribute('aria-expanded', 'true');
                const first = menu.querySelector('input, button, [tabindex]');
                if (first) first.focus();
            };

            button.addEventListener('click', () => {
                if (capture.classList.contains('show')) close(); else open();
            });
            capture.addEventListener('click', event => {
                if (event.target === capture) close();
            });
            capture.addEventListener('keydown', event => {
                if (event.key !== 'Escape') return;
                // Close the menu, not the popup
                event.preventDefault();
                event.stopPropagation();
                close();
                button.focus();
            });
        });
    }

    function initVersion() {
        try {
            const version = chrome.runtime.getManifest().version;
            document.querySelectorAll('.version').forEach(el => { el.textContent = version; });
        } catch (e) {
            // Not in the extension
        }
    }

    // A color code as #rrggbb, from what people copy out of other tools: #rgb, #rrggbb (also
    // without the #), rgb(255, 204, 0), rgba(...) (the alpha is ignored), or the three
    // numbers alone ("255, 204, 0", "255 204 0"). null when it isn't one.
    function parseColor(text) {
        const s = String(text || '').trim().toLowerCase().replace(/;$/, '');
        // (#rgb needs its #: "255" is the start of "255, 204, 0")
        let m = /^(?:#([0-9a-f]{3})|#?([0-9a-f]{6}))$/.exec(s);
        if (m) m = [m[0], m[1] || m[2]];
        if (m) {
            const hex = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
            return '#' + hex;
        }
        m = RGB_FORMS.map(form => form.exec(s)).find(Boolean);
        if (m) {
            const channels = m.slice(1, 4).map(Number);
            if (channels.every(c => c <= 255)) {
                return '#' + channels.map(c => c.toString(16).padStart(2, '0')).join('');
            }
        }
        return null;
    }

    // rgb() as CSS writes it: commas between all the values, or spaces between all of them
    // (then the alpha after a /); the alpha a number (1, 0.5, .5) or a percentage. The three
    // numbers alone too, with the same separators throughout.
    const N = '(\\d{1,3})';
    const ALPHA = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)%?';
    const RGB_FORMS = [
        new RegExp(`^rgba?\\(\\s*${N}\\s*,\\s*${N}\\s*,\\s*${N}\\s*(?:,\\s*${ALPHA}\\s*)?\\)$`),
        new RegExp(`^rgba?\\(\\s*${N}\\s+${N}\\s+${N}\\s*(?:\\/\\s*${ALPHA}\\s*)?\\)$`),
        new RegExp(`^${N}\\s*,\\s*${N}\\s*,\\s*${N}$`),
        new RegExp(`^${N}\\s+${N}\\s+${N}$`)
    ];

    async function copyText(text, fallbackField) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (e) {
            if (!fallbackField) return false;
            fallbackField.focus();
            fallbackField.select();
            return document.execCommand('copy');
        }
    }

    // The fields made by colorCodeField(), by their <input> (see colorCodeOf())
    const codeFields = new WeakMap();

    // The code of a color, to copy it or paste one: a small text field which shows the color
    // as #rrggbb and takes a pasted or typed code (see parseColor()), and a copy button.
    // `get()` gives the color shown (null: none, e.g. automatic), `set(hex)` applies one;
    // `set(hex, { rollback: true, memo })` puts back the color from before the typing, which
    // began with a call of `begin()` (if given): `memo` is what it returned. `refresh()` shows the current color again (it
    // leaves the field alone while it's being typed in). `state()` and `restore(state)` carry
    // a code being typed over to a new field, when the field is drawn again.
    function colorCodeField({ get, set, begin = null, label = 'Color code', empty = '' }) {
        const box = document.createElement('span');
        box.className = 'color-code';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'field color-code-input';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.maxLength = 40;
        input.placeholder = empty;
        input.setAttribute('aria-label', label);
        input.title = `${label}: copy it, or paste one such as #ffcc00 or rgb(255, 204, 0)`;
        const copy = iconButton('copy', 'Copy the color code', 'color-copy');
        let copiedTimer = null;
        // The color when typing began: what an unfinished or wrong code goes back to (so
        // "#123g" doesn't leave the #112233 of "#123" behind)
        let start;
        let memo;
        let restoring = false;
        const beginTyping = () => {
            start = get();
            memo = begin ? begin() : undefined;
        };
        // Back to the color from before the typing
        const rollback = () => {
            if (start !== undefined && get() !== start) set(start, { rollback: true, memo });
            copy.disabled = !get();
        };

        const show = () => {
            const value = get();
            input.value = value || '';
            input.classList.remove('invalid');
            copy.disabled = !value;
        };
        const apply = (text, { normalize = false } = {}) => {
            const hex = parseColor(text);
            input.classList.toggle('invalid', !hex && !!text.trim());
            if (hex) {
                if (normalize) input.value = hex;
                if (hex !== get()) set(hex);
                copy.disabled = false;
            } else {
                rollback();
            }
            return hex;
        };
        // Leaves the field showing the color in use: an unfinished code is dropped
        const settle = () => {
            if (!parseColor(input.value)) rollback();
            show();
        };

        // Focusing selects the whole code, ready to copy or to type over. (A click would put
        // the cursor where it was released: the first click selects all instead.)
        let selectOnMouseUp = false;
        input.addEventListener('mousedown', () => {
            selectOnMouseUp = document.activeElement !== input;
        });
        input.addEventListener('mouseup', e => {
            if (!selectOnMouseUp) return;
            selectOnMouseUp = false;
            e.preventDefault();
            input.select();
        });
        input.addEventListener('focus', () => {
            if (restoring) return;   // carried on from the field this one replaces
            beginTyping();
            input.select();
        });
        input.addEventListener('input', () => apply(input.value));
        input.addEventListener('paste', e => {
            const text = e.clipboardData && e.clipboardData.getData('text');
            if (text && parseColor(text)) {
                e.preventDefault();
                apply(text, { normalize: true });
                input.select();
            }
        });
        input.addEventListener('blur', settle);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter' && !e.isComposing) {
                // Don't let the Enter reach a form or the word field's "add"
                e.preventDefault();
                e.stopPropagation();
                settle();
                beginTyping();   // kept: Escape now goes back to this one
                input.select();
            } else if (e.key === 'Escape' && start !== undefined &&
                    (get() !== start || input.value !== (start || ''))) {
                // Undo the typing: back to the color from before (rather than closing the popup)
                e.preventDefault();
                e.stopPropagation();
                rollback();
                show();
                input.select();
            }
        });
        copy.addEventListener('click', async () => {
            const value = get();
            if (!value) return;
            if (!(await copyText(value, input))) return;
            clearTimeout(copiedTimer);
            copy.replaceChildren(icon('check'));
            copy.classList.add('copied');
            copy.title = `Copied ${value}`;
            copiedTimer = setTimeout(() => {
                copy.replaceChildren(icon('copy'));
                copy.classList.remove('copied');
                copy.title = 'Copy the color code';
            }, 1400);
        });

        box.append(input, copy);
        show();
        const field = {
            element: box,
            input,
            refresh() {
                if (document.activeElement !== input) show();
            },
            state() {
                return {
                    // A code is being typed: the field doesn't just show the color, or a code
                    // typed in full has already changed it (not kept yet with Enter, so
                    // Escape can still take it back)
                    typing: input.value !== (get() || '') || (start !== undefined && get() !== start),
                    text: input.value,
                    start,
                    memo,
                    selection: [input.selectionStart, input.selectionEnd]
                };
            },
            // Focuses this field and goes on with the typing of another one. When nothing was
            // being typed, it starts afresh from its own color (which may have just been
            // changed elsewhere): Escape mustn't bring back the color the other one showed.
            restore(state) {
                if (!state.typing) {
                    input.focus();   // (begins anew, from the color shown)
                    input.setSelectionRange(state.selection[0], state.selection[1]);
                    return;
                }
                input.value = state.text;
                input.classList.toggle('invalid', !parseColor(state.text) && !!state.text.trim());
                restoring = true;
                try {
                    input.focus();
                } finally {
                    restoring = false;
                }
                start = state.start;
                memo = state.memo;
                copy.disabled = !get();
                input.setSelectionRange(state.selection[0], state.selection[1]);
            }
        };
        codeFields.set(input, field);
        return field;
    }

    // The colorCodeField() an <input> belongs to, or null
    function colorCodeOf(element) {
        return codeFields.get(element) || null;
    }

    globalThis.WordHighlighterUI = { icon, iconButton, initIcons, parseColor, colorCodeField, colorCodeOf };

    const init = () => {
        initIcons();
        initMenus();
        initVersion();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
