/* IGNITRA service worker: Web Push notifications and their clicks. App data is never cached. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "IGNITRA", body: event.data ? event.data.text() : "" };
  }
  const url = typeof data.url === "string" && /^https:\/\//.test(data.url) ? data.url : "/app";
  event.waitUntil(
    self.registration.showNotification(data.title || "IGNITRA", {
      body: data.body || "",
      tag: data.tag || undefined,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/app";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (w.url.startsWith(self.location.origin) && "focus" in w) {
          if (url.startsWith("/")) w.navigate(url);
          else self.clients.openWindow(url);
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
