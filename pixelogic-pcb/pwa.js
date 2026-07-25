(function () {
    // Fullscreen, on request only. Installed from the manifest the app runs
    // "standalone", which already hides the browser's chrome — so the
    // Fullscreen API is only needed in a plain browser tab, where the address
    // bar can't be dropped any other way. It used to be grabbed
    // opportunistically on the first pointerdown anywhere in the page; that
    // hijacked an ordinary tap into a jarring viewport change and had to be
    // undone, so now it happens only when the menu item asks for it. Exposed
    // as window.PixelogicFullscreen for ui.js to drive.
    const doc = document;
    const el = doc.documentElement;
    const requestFn = el.requestFullscreen || el.webkitRequestFullscreen;
    const exitFn = doc.exitFullscreen || doc.webkitExitFullscreen;
    function current() { return doc.fullscreenElement || doc.webkitFullscreenElement || null; }
    function request() {
        if (!requestFn || current()) return Promise.resolve();
        try { return Promise.resolve(requestFn.call(el)).catch(() => { }); }
        catch (e) { return Promise.resolve(); }
    }
    function exit() {
        if (!exitFn || !current()) return Promise.resolve();
        try { return Promise.resolve(exitFn.call(doc)).catch(() => { }); }
        catch (e) { return Promise.resolve(); }
    }
    window.PixelogicFullscreen = {
        supported: !!requestFn,
        isActive: () => !!current(),
        request, exit,
        toggle: () => current() ? exit() : request(),
    };
})();

(function () {
    // Registers the service worker and surfaces app updates without ever
    // yanking the page out from under an edit. When a new service worker
    // finishes installing (and one was already controlling the page, i.e.
    // this is an update rather than a first install), a small toast offers a
    // reload. Tapping it tells the waiting worker to take over, and the
    // resulting controllerchange reloads once to pick up the new code.
    if (!('serviceWorker' in navigator)) return;

    // Only a controllerchange that swaps out an EXISTING controller means a
    // real update the running page should reload for. The first-ever visit
    // also fires controllerchange (the worker calling clients.claim() takes
    // control for the first time) — reloading there would be a pointless
    // refresh of already-current code, so it's ignored.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        window.location.reload();
    });

    window.addEventListener('load', async () => {
        let reg;
        try {
            // updateViaCache:'none' makes the browser always revalidate sw.js
            // against the network, so a new service worker is never missed
            // because of HTTP caching.
            reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        } catch (e) {
            return;
        }

        function offerUpdate(worker) {
            showToast('New version available', 'Reload', () => worker.postMessage('skipWaiting'));
        }

        // A worker already waiting from a previous visit.
        if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);

        reg.addEventListener('updatefound', () => {
            const installing = reg.installing;
            if (!installing) return;
            installing.addEventListener('statechange', () => {
                if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                    offerUpdate(installing);
                }
            });
        });
    });

    function showToast(message, actionLabel, onAction) {
        let toast = document.getElementById('pwaToast');
        if (toast) toast.remove();
        toast = document.createElement('div');
        toast.id = 'pwaToast';
        toast.className = 'pwa-toast';

        const label = document.createElement('span');
        label.textContent = message;

        const btn = document.createElement('button');
        btn.className = 'tool-btn';
        btn.textContent = actionLabel;
        btn.addEventListener('click', () => { onAction(); toast.remove(); });

        const dismiss = document.createElement('button');
        dismiss.className = 'icon-btn';
        dismiss.textContent = '×';
        dismiss.title = 'Dismiss';
        dismiss.addEventListener('click', () => toast.remove());

        toast.append(label, btn, dismiss);
        document.body.appendChild(toast);
    }
})();
