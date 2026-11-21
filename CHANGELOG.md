# Changelog

## 1.1.2

- Fixed: in Chrome and Edge, the popup could fail to open when the toolbar button was
  clicked. The popup's icons are now drawn in the page itself instead of being loaded from
  a separate file, which could hold the popup back until it was clicked again.
- Fixed: a saved list's address pattern with several `*` (such as
  `example.com/*/*/*/*/issues/*`) could freeze the page and the popup for seconds or
  minutes on long addresses. Patterns are now matched in a single pass.
- Fixed: when the settings couldn't be read (for example while sync was still bringing
  them in from another device), the popup stayed locked until it was closed and reopened.
  It now tries again by itself and unlocks as soon as the settings read fine. Other errors
  while opening the popup are no longer reported as "Could not load your settings".

## 1.1.1

- Color codes: next to each color picker in the popup, the color's code (#rrggbb) can be
  copied with one click, or a code pasted in: #ffcc00, #fc0, rgb(255, 204, 0) or
  255, 204, 0.
- The lists in the popup can be folded: click a list's name. Folded lists show how many
  words they hold, and stay folded the next time the popup opens.
- Settings → Lists shows the words of My words too, and each word's highlight color can be
  changed there with a click on its color square.

## 1.1.0

Initial release.
