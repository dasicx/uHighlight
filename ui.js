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

    globalThis.WordHighlighterUI = { icon, iconButton, initIcons };

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
