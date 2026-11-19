/* Depot Radar service worker. This file must be on the server as "sw.js",
   in the same folder as index.html, or the app cannot register it.
   - keeps a copy of the app so it starts without a connection
   - shows notifications (Android only accepts them from here)
   - receives push messages from the own server while the app is closed
   - runs the background check the app hands over                */
const SHELL = 'dr-shell-v3', BG = 'dr-bg';
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

/* a tap opens the app on the page the message is about: sell hints on
   "Gekauft", new signals on "Signale"                                */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './#signale';
  const tab = url.indexOf('#gekauft') >= 0 ? 'pos' : 'alerts';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const c of all) {
      if ('focus' in c) {
        try { await c.focus(); } catch (err) {}
        c.postMessage({type: 'open-tab', tab});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

/* A message from the own server (see worker.js). It carries the text to
   show and the records behind it; those wait in "pending" and "posnote"
   until the app opens and takes them into its lists.                   */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; }
  catch (err) { d = {title: 'Depot Radar', body: e.data ? e.data.text() : ''}; }
  e.waitUntil((async () => {
    try {
      const c = await caches.open(BG);
      if (Array.isArray(d.ev) && d.ev.length) {
        const pr = await c.match('pending');
        const pend = pr ? await pr.json() : [];
        const have = new Set(pend.map(x => x && x.id));
        await c.put('pending', json(pend.concat(d.ev.filter(x => x && x.id && !have.has(x.id))).slice(-60)));
      }
      if (Array.isArray(d.pn) && d.pn.length) {
        const nr = await c.match('posnote');
        const pn = nr ? await nr.json() : [];
        await c.put('posnote', json(pn.concat(d.pn).slice(-100)));
      }
    } catch (err) {}
    await self.registration.showNotification(d.title || 'Depot Radar', {body: d.body || '', tag: d.tag || 'dr-push',
      renotify: true, icon: 'icon-192.png', data: {url: d.url || './#signale'}});
    const wins = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    wins.forEach(w => w.postMessage({type: 'push-merge'}));        // an open app takes the news in at once
  })());
});

/* The push service replaced the subscription (rare). The new one goes to the
   server at once, so messages keep arriving before the app is opened again. */
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(BG), r = await c.match('push');
      if (!r) return;
      const p = await r.json();
      let sub = e.newSubscription;
      const old = e.oldSubscription && e.oldSubscription.endpoint;
      if (!sub) {
        const key = e.oldSubscription && e.oldSubscription.options && e.oldSubscription.options.applicationServerKey;
        if (!key) return;
        sub = await self.registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
      }
      await fetch(p.base + '/sub', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: p.id, tok: p.tok, sub: sub.toJSON(), keep: true, old: old || null})});
    } catch (err) {}
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
  /* with server push on, the server sends the messages; this check only fills the lists */
  if (out.note && cfg.notify && !cfg.pushOn && self.Notification && Notification.permission === 'granted') {
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
