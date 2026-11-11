# Periodic Sync Push Notifications — Future Plan

For true background notifications (when the patchwork tab is closed), we need to add periodic sync support to the patchwork bootloader service worker.

## What needs to happen

### 1. Bootloader service worker changes (`@inkandswitch/patchwork-bootloader`)

Add these event handlers to the service worker:

```js
// Periodic background sync — check for unread chat messages
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "check-chat-messages") {
    event.waitUntil(checkForUnreadChats());
  }
});

async function checkForUnreadChats() {
  const db = await openDB("chat-notifications", 1);
  const chats = await db.getAll("chats");
  for (const chat of chats) {
    if (chat.lastMessageTimestamp > chat.readPosition && chat.lastMessageAuthor !== chat.myName) {
      await self.registration.showNotification(chat.chatTitle, {
        body: `${chat.lastMessageAuthor}: ${chat.lastMessageText}`,
        tag: chat.chatUrl, // deduplicates
        data: { chatUrl: chat.chatUrl },
      });
    }
  }
}

// Click notification → focus or open the chat
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chatUrl = event.notification.data?.chatUrl;
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      // Try to focus an existing patchwork tab
      for (const client of windowClients) {
        if (client.url.includes(chatUrl)) {
          return client.focus();
        }
      }
      // Otherwise open a new tab (needs a URL scheme for opening specific chat docs)
      // return clients.openWindow(`/?open=${chatUrl}`);
    })
  );
});
```

### 2. Chat tool changes (chat.js)

Register periodic sync after the Notification permission is granted:

```js
async function registerPeriodicSync() {
  const reg = await navigator.serviceWorker.ready;
  if ("periodicSync" in reg) {
    try {
      await reg.periodicSync.register("check-chat-messages", {
        minInterval: 60 * 60 * 1000, // 1 hour minimum
      });
    } catch (e) {
      console.warn("[Chat] periodic sync registration failed:", e);
    }
  }
}
```

Write chat state to IndexedDB on every doc change:

```js
async function writeNotificationState(chatUrl, chatTitle, lastMsg, readPosition, myName) {
  const db = await openDB("chat-notifications", 1, {
    upgrade(db) {
      db.createObjectStore("chats", { keyPath: "chatUrl" });
    },
  });
  await db.put("chats", {
    chatUrl,
    chatTitle,
    lastMessageTimestamp: lastMsg.timestamp,
    lastMessageAuthor: lastMsg.name,
    lastMessageText: lastMsg.text?.slice(0, 100) || "",
    readPosition,
    myName,
  });
}
```

### Limitations

- **Chrome/Edge only** — Firefox and Safari don't support periodic background sync
- **Minimum interval is browser-controlled** — typically 12+ hours, not configurable below that
- **Requires PWA install** — the site must be installed as a PWA for periodic sync to work
- **Browser may throttle** — based on site engagement score
- **Can't check automerge docs from SW** — the SW can only read what chat.js wrote to IndexedDB, so if a message arrives while all tabs are closed, the SW won't know about it until a tab opens and writes the state

### The real gap

The fundamental issue is that periodic sync can only re-notify about unreads that were already detected by the client. For true push (notify about messages that arrived while fully offline), you'd need either:
- A relay server that watches automerge docs and sends Web Push messages
- Or the automerge sync server itself to trigger push notifications
