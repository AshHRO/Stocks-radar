/* Depot Radar service worker. This file must be on the server as "sw.js",
   in the same folder as index.html, or the app cannot register it.
   - keeps a copy of the app so it starts without a connection
   - shows notifications (Android only accepts them from here)
   - runs the background check the app hands over                */
const SHELL = 'dr-shell-v2', BG = 'dr-bg';
const ROOT = new URL('./', self.location).pathname;
const json = o => new Response(JSON.stringify(o), {headers: {'Content-Type': 'application/json'}});

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']))
    .catch(() => {}));
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k.startsWith('dr-shell-') && k !== SHELL).map(k => caches.delete(k)));
  await self.clients.claim();
})()));

/* Network first: a new index.html on the server always wins, the stored copy
   is only the fallback when there is no connection. Price data, exchange
   rates and Firebase live on other hosts and are never touched here.       */
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== self.location.origin || !u.pathname.startsWith(ROOT)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(r);
      if (res && res.ok && !u.search) {
        const c = await caches.open(SHELL);
        c.put(r, res.clone()).catch(() => {});
      }
      return res;
    } catch (err) {
      const c = await caches.open(SHELL);
      const hit = await c.match(r, {ignoreSearch: true}) || (r.mode === 'navigate' ? await c.match('./') : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) {
      if ('focus' in c) {
        try { await c.focus(); } catch (err) {}
        c.postMessage({type: 'open-alerts'});
        return;
      }
    }
    await self.clients.openWindow('./#signale');
  })());
});

/* The rules and the maths are not duplicated here. The app stores its own
   functions next to the list of assets to watch, and this worker runs exactly
   that code, so the background check can never disagree with the app.

   Everything fetched is written to three places:
   "items"   fresh prices; the app folds them into its scan data when it opens
   "pending" new signals; the app adds them to the Alerts list
   "cfg"     the baseline for the next comparison, so nothing is reported twice
   It is written every 15 seconds and at the end, so a check that Android cuts
   short still leaves its results behind.                                      */
async function persist(c, cfg, out, st) {
  for (const sym in out.items) {
    const m = Object.assign({}, out.items[sym]); delete m.spark;
    cfg.items[sym] = m;
  }
  const fresh = out.events.slice(st.ev); st.ev = out.events.length;
  fresh.forEach(ev => ev.kinds.forEach(k => { cfg.cool[ev.sym + '|' + k] = ev.at; }));
  await c.put('cfg', json(cfg));
  const ir = await c.match('items');
  const all = ir ? await ir.json() : {};
  Object.assign(all, out.items);
  await c.put('items', json(all));
  if (fresh.length) {
    const pr = await c.match('pending');
    const pend = pr ? await pr.json() : [];
    await c.put('pending', json(pend.concat(fresh).slice(-60)));
  }
  await c.put('last', json({at: Date.now(), checked: out.checked, found: out.events.length}));
}
async function bgCheck(force) {
  const c = await caches.open(BG);
  const cfgR = await c.match('cfg'), coreR = await c.match('core');
  if (!cfgR || !coreR) return {skipped: 'no-config'};
  if (!force) {
    const wins = await self.clients.matchAll({type: 'window'});
    if (wins.some(w => w.visibilityState === 'visible')) return {skipped: 'app-open'};   // the app checks by itself
  }
  const cfg = await cfgR.json(), core = await coreR.text();
  const st = {ev: 0};
  let out;
  try {
    out = await (new Function('cfg', 'flush', core + '\nreturn bgRun(cfg, flush);'))(cfg, o => persist(c, cfg, o, st));
  } catch (err) { return {error: String(err)}; }
  await persist(c, cfg, out, st);
  if (out.note && cfg.notify && self.Notification && Notification.permission === 'granted') {
    await self.registration.showNotification(out.note.title, {body: out.note.body, tag: 'dr-alerts',
      renotify: true, icon: 'icon-192.png', data: {url: './#signale'}});
  }
  return {checked: out.checked, found: out.events.length, broken: !!out.broken};
}
self.addEventListener('periodicsync', e => { if (e.tag === 'dr-check') e.waitUntil(bgCheck(false)); });
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'bg-check') {
    e.waitUntil(bgCheck(true).then(r => { if (e.source) e.source.postMessage({type: 'bg-done', result: r}); }));
  }
});
