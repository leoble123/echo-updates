// Echo's service worker: the app shell, cached, so Echo opens instantly and
// installs as an app; and, with Echo Server, notifications when Echo is closed.
// Messages and attachments always come from your Mac.
const CACHE = 'echo-shell-v3'

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  // Only our own files; the server, the relay and fonts go straight to the network.
  if (url.origin !== location.origin || e.request.method !== 'GET') return
  // Network first, so updates land at once; the cache when offline.
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)) }
      return res
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  )
})

// --- push -----------------------------------------------------------------------

/** Reads one value from the app's own cache (names, chats), or undefined. */
function cached(key) {
  return new Promise(resolve => {
    const open = indexedDB.open('echo-web', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('kv')
    open.onerror = () => resolve(undefined)
    open.onsuccess = () => {
      try {
        const req = open.result.transaction('kv').objectStore('kv').get(key)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(undefined)
      } catch { resolve(undefined) }
    }
  })
}

const chatKey = g => (g || '').slice((g || '').indexOf(';') + 1)

async function showMessage(d) {
  const [chats, contacts, hidden] = await Promise.all([cached('chats'), cached('contacts2'), cached('hidden')])
  // Hidden Chats: no name, no words, no face, no buttons.
  if ((hidden ?? []).some(g => chatKey(g) === chatKey(d.chat))) {
    return self.registration.showNotification('Echo', { body: 'New message', tag: 'echo-hidden', icon: 'icon-192.png', badge: 'icon-192.png', data: {} })
  }
  const names = new Map(contacts?.names ?? [])
  const avatars = new Map(contacts?.avatars ?? [])
  const chat = (chats ?? []).find(c => chatKey(c.guid) === chatKey(d.chat))
  const sender = d.from ? (names.get(d.from) ?? d.from) : ''
  const title = chat?.name || d.chatName || sender || 'New message'
  const what = d.text?.trim() || (d.attachments ? (d.attachments > 1 ? `${d.attachments} attachments` : 'Attachment') : 'New message')
  const group = chat ? chat.group : d.group
  const body = group && sender ? `${sender.split(' ')[0]}: ${what}` : what
  return self.registration.showNotification(title, {
    body,
    tag: chat?.guid ?? d.chat ?? undefined,
    renotify: true,
    icon: (!group && d.from && avatars.get(d.from)) || 'icon-192.png',
    badge: 'icon-192.png',
    timestamp: typeof d.at === 'number' ? d.at : Date.now(),
    data: { chat: chat?.guid ?? d.chat },
    // Answer or clear it without opening the whole conversation.
    actions: [{ action: 'reply', title: 'Reply' }, { action: 'read', title: 'Mark as Read' }],
  })
}

self.addEventListener('push', e => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { /* not ours */ }
  e.waitUntil((async () => {
    if (d.type === 'test') return self.registration.showNotification('Echo', { body: 'Notifications from your Mac are working.', icon: 'icon-192.png', tag: 'echo-test' })
    if (d.type !== 'message') return
    // An Echo window on screen shows its own alerts.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.some(w => w.visibilityState === 'visible')) return
    return showMessage(d)
  })())
})

/** Marks [chat] read on the Mac straight from here - Echo needn't be open. */
async function markReadOnMac(chat) {
  const server = await cached('server')
  if (!server?.url || !chat) return
  const q = new URLSearchParams({ password: server.password })
  await fetch(`${server.url}/api/v1/chat/${encodeURIComponent(chat)}/read?${q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).catch(() => {})
}

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const chat = e.notification.data?.chat
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find(w => new URL(w.url).pathname.startsWith(new URL(self.registration.scope).pathname))
    if (e.action === 'read') {
      // An open Echo clears its own dot (and tells the Mac); otherwise this does.
      if (open && chat) open.postMessage({ type: 'read', chat })
      else await markReadOnMac(chat)
      return
    }
    const type = e.action === 'reply' ? 'quick' : 'open'
    if (open) {
      await open.focus().catch(() => {})
      if (chat) open.postMessage({ type, chat })
      return
    }
    return self.clients.openWindow(chat ? `./#${type === 'quick' ? 'quick' : 'chat'}=${encodeURIComponent(chat)}` : './')
  })())
})
