const CACHE = 'henry-v1';
const ASSETS = ['/', '/call.html', '/audio-capture-processor.js', '/audio-playback-processor.js', '/porcupine-web.js', '/web-voice-processor.js', '/porcupine_params.pv', '/Hey-Henry_en_wasm_v4_0_0.ppn'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));
