/* =========================================================================
   ProjectOS — service worker
   Cache-first στρατηγική για τα core assets, ώστε η εφαρμογή να ανοίγει
   και να λειτουργεί πλήρως χωρίς internet μετά την πρώτη φόρτωση, και να
   είναι "installable" ως PWA. Καθαρά static assets (χωρίς server) — δεν
   κάνει cache κανένα API/backend call, γιατί δεν υπάρχει.
   ========================================================================= */

// Αύξησε το version prefix (π.χ. 'projectos-cache-v2') κάθε φορά που
// αλλάζουν τα core assets, ώστε ο παλιός cache να καθαρίζεται στο activate.
const CACHE_NAME = 'projectos-cache-v1';

const CORE_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (event)=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event)=>{
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first: αν το request υπάρχει ήδη στην cache, το σερβίρουμε αμέσως
// (γρήγορο + λειτουργεί offline). Αλλιώς πάμε στο δίκτυο, και αν πετύχει
// αποθηκεύουμε το αποτέλεσμα για την επόμενη φορά (π.χ. Google Fonts CSS
// που φορτώνεται από το styles.css). Σε πλήρη αποτυχία δικτύου χωρίς cache
// hit, αποτυγχάνει σιωπηλά — αναμενόμενο μόνο στο ΠΡΩΤΟ, offline άνοιγμα.
self.addEventListener('fetch', (event)=>{
  if(event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if(cached) return cached;
      return fetch(event.request)
        .then(response => {
          if(response && response.status === 200){
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(()=>{});
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
