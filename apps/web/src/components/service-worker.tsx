"use client";

import { useEffect } from "react";

/** Registers /sw.js (Web Push + notification clicks). No offline caching of app data. */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      // e.g. http on a non-localhost origin: push is unavailable, everything else works
    });
  }, []);
  return null;
}

/** Subscribes this device to Web Push with the API's VAPID key; returns the subscription JSON. */
export async function subscribePush(vapidPublicKey: string): Promise<PushSubscriptionJSON> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("this browser has no Web Push. On iPhone, add IGNITRA to the home screen and open it from there (iOS 16.4+).");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notifications are blocked for this site; allow them in the browser settings");
  const registration = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(vapidPublicKey.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  const existing = await registration.pushManager.getSubscription();
  const sub = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  return sub.toJSON();
}
