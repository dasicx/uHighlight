// uHighlight: runs in the page's own JavaScript world (manifest: "world": "MAIN"), before the
// page's scripts.
//
// When a page attaches a shadow root to an element which is already in the document (a
// custom element defined after the page has loaded, typically), nothing in the DOM changes
// that the content script could observe, and the text the page then puts in the shadow root
// would never be highlighted. This wraps Element.prototype.attachShadow to tell it: an event
// on the element, which the content script listens for. The event is "composed", so that it
// also reaches the document from inside another shadow root.
//
// The content script starts once the page has loaded, after many shadow roots have been
// attached: on its request (a "replay" event on the document), the event is sent again for
// every element which got one so far and is still there.
//
// Nothing else is read or changed, and attachShadow behaves exactly as before.
(() => {
    const EVENT = 'uhighlight-shadow-attached';
    const REPLAY_EVENT = 'uhighlight-shadow-replay';
    const proto = Element.prototype;
    const original = proto.attachShadow;
    if (typeof original !== 'function' || original.__uhighlightWrapped === true) return;

    const hosts = [];   // WeakRefs: never keeps an element alive

    const notify = host => {
        try {
            host.dispatchEvent(new Event(EVENT, { composed: true }));
        } catch (e) {
            // Never let the notification get in the way of the page
        }
    };

    const attachShadow = {
        attachShadow(init) {
            const root = original.call(this, init);
            hosts.push(new WeakRef(this));
            notify(this);
            return root;
        }
    }.attachShadow;
    Object.defineProperty(attachShadow, '__uhighlightWrapped', { value: true });

    const descriptor = Object.getOwnPropertyDescriptor(proto, 'attachShadow');
    Object.defineProperty(proto, 'attachShadow', { ...descriptor, value: attachShadow });

    document.addEventListener(REPLAY_EVENT, () => {
        for (let i = hosts.length - 1; i >= 0; i--) {
            const host = hosts[i].deref();
            if (!host) {
                hosts.splice(i, 1);
            } else if (host.isConnected) {
                notify(host);
            }
        }
    });
})();
