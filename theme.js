// uHighlight: the theme of the popup and of the settings page, as in uMatrixNG.
//
// `auto` (light or dark, as the browser), `light`, `dark`, or one of the themes of themes.css.
// The root element gets the name of the theme in `data-theme`, and the class `dark` for every
// theme but the light one.
//
// Loaded in the <head>, before anything is drawn, so pages never flash in the wrong colors:
// the setting is kept in the localStorage of the extension's pages, which is synchronous.
// The settings page changes it with WordHighlighterTheme.set(); other open pages follow
// through the `storage` event.

(function () {
    const KEY = 'theme';
    const THEMES = ['light', 'dark', 'dracula', 'nord', 'solarized', 'gruvbox'];
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    let theme = 'auto';

    const normalize = value => (THEMES.includes(value) ? value : 'auto');

    const apply = () => {
        const name = theme === 'auto' ? (media.matches ? 'dark' : 'light') : theme;
        document.documentElement.setAttribute('data-theme', name);
        document.documentElement.classList.toggle('dark', name !== 'light');
    };

    try {
        theme = normalize(window.localStorage.getItem(KEY));
    } catch (e) {
        // Storage blocked: the default
    }
    apply();

    // The browser's own theme changed while the page is open
    media.addEventListener('change', apply);

    // The setting was changed in another page of the extension
    window.addEventListener('storage', event => {
        if (event.key !== KEY) return;
        theme = normalize(event.newValue);
        apply();
    });

    globalThis.WordHighlighterTheme = {
        THEMES,
        get: () => theme,
        set(value) {
            theme = normalize(value);
            try {
                window.localStorage.setItem(KEY, theme);
            } catch (e) {
                // Applied to this page only
            }
            apply();
        }
    };
})();
