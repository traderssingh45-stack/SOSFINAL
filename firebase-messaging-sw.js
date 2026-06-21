// firebase-messaging-sw.js
// This file MUST live at the site root (not in a subfolder) so it can
// control push notifications for the whole origin.
//
// It runs in the background — separate from any open tab — which is the
// only reason a phone can alarm/vibrate even when the dashboard isn't open.

importScripts('https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.1/firebase-messaging-compat.js');

// Same config as the admin page — safe to duplicate, these values are public.
firebase.initializeApp({
  apiKey: "AIzaSyB50atVibwLBtGiz7trwS-Il4SePwKPjtk",
  authDomain: "sos-service-65f36.firebaseapp.com",
  projectId: "sos-service-65f36",
  storageBucket: "sos-service-65f36.firebasestorage.app",
  messagingSenderId: "654724325662",
  appId: "1:654724325662:web:d15f770b3179082cc4290f"
});

const messaging = firebase.messaging();

// Fires when a push arrives while the dashboard is NOT in the foreground
// (tab closed, phone locked, browser backgrounded, etc).
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || '🚨 SOS Alert';
  const body = (payload.notification && payload.notification.body) || 'A student needs help.';

  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [300, 100, 300, 100, 300, 100, 300],
    requireInteraction: true,
    tag: 'campus-sos', // replaces older SOS notifications instead of stacking endlessly
    renotify: true,
    data: payload.data || {},
  });
});

// Tapping the notification opens (or focuses) the admin dashboard.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/admin.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow('/admin.html');
    })
  );
});
