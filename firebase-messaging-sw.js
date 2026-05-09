// Firebase Cloud Messaging Service Worker
// Required for push notifications (the Push init failure in console)

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCaDPMylVE1tmNbCd-vRHRR7dh0gWFvw9Y",
  authDomain: "ac-recon.firebaseapp.com",
  projectId: "ac-recon",
  storageBucket: "ac-recon.firebasestorage.app",
  messagingSenderId: "462482737107",
  appId: "1:462482737107:web:03a2f9621396256c4a5126"
});

const messaging = firebase.messaging();

// Background message handler — fires when the app isn't focused
messaging.onBackgroundMessage(payload => {
  const title = (payload.notification && payload.notification.title) || 'AC Recon';
  const options = {
    body: (payload.notification && payload.notification.body) || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: payload.data?.tag || 'ac-recon',
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});

// Click handler — focus existing tab or open a new one
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
