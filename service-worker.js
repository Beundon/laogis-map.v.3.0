/**
 * Laos GIS Mapper Pro - Service Worker
 * Strategy: Cache-First for static assets, Stale-While-Revalidate for map tiles & dynamic data
 * Version: 1.0.0
 */

const CACHE_NAME = 'laos-gis-v1';
const STATIC_CACHE = `${CACHE_NAME}-static`;
const DYNAMIC_CACHE = `${CACHE_NAME}-dynamic`;
const TILE_CACHE = `${CACHE_NAME}-tiles`;

// App Shell & Critical Static Assets - Cache-First strategy
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  // Leaflet Core
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  // Leaflet Plugins
  'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css',
  'https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js',
  'https://cdn.jsdelivr.net/npm/leaflet.locatecontrol@0.81.1/dist/L.Control.Locate.min.css',
  'https://cdn.jsdelivr.net/npm/leaflet.locatecontrol@0.81.1/dist/L.Control.Locate.min.js',
  'https://cdn.jsdelivr.net/gh/mutsuyuki/Leaflet.SmoothWheelZoom@master/SmoothWheelZoom.js',
  // File Parsing Libraries
  'https://unpkg.com/togeojson@0.16.0/togeojson.js',
  'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  'https://unpkg.com/shpjs@4.0.4/dist/shp.js',
  'https://unpkg.com/@tmcw/togeojson@5.8.1/dist/togeojson.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://unpkg.com/@turf/turf@6.5.0/turf.min.js',
  'https://unpkg.com/papaparse@5.4.1/papaparse.min.js'
];

// Map tile URL patterns - Stale-While-Revalidate
const TILE_PATTERNS = [
  /^https:\/\/[a-c]\.tile\.openstreetmap\.org\//,
  /^https:\/\/server\.arcgisonline\.com\//,
  /^https:\/\/[a-c]\.tile\.opentopomap\.org\//
];

// API / Elevation / Dynamic data patterns - Network-First
const API_PATTERNS = [
  /^https:\/\/api\.open-elevation\.com\//,
  /^https:\/\/elevation-api\.io\//,
  /^https:\/\/api\.mapbox\.com\//,
  /^https:\/\/nominatim\.openstreetmap\.org\//
];

// ============================================
// INSTALL: Cache static assets (App Shell)
// ============================================
self.addEventListener('install', (event) => {
  console.log('[SW] Install event - caching static assets');
  
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        // Use addAll with individual catch to prevent total failure if one resource fails
        return Promise.all(
          STATIC_ASSETS.map((url) => 
            cache.add(url).catch((err) => {
              console.warn(`[SW] Failed to cache: ${url}`, err);
              // Continue despite individual failures - app can still work
              return Promise.resolve();
            })
          )
        );
      })
      .then(() => {
        console.log('[SW] Static assets cached successfully');
        // Skip waiting so the new service worker activates immediately
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] Install failed:', err);
      })
  );
});

// ============================================
// ACTIVATE: Clean up old caches
// ============================================
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate event - cleaning old caches');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => {
              // Delete caches that start with our prefix but aren't current
              return name.startsWith(CACHE_NAME) && 
                     name !== STATIC_CACHE && 
                     name !== DYNAMIC_CACHE &&
                     name !== TILE_CACHE;
            })
            .map((name) => {
              console.log(`[SW] Deleting old cache: ${name}`);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] Old caches cleaned');
        // Claim clients immediately so the SW controls all pages
        return self.clients.claim();
      })
      .catch((err) => {
        console.error('[SW] Activation failed:', err);
      })
  );
});

// ============================================
// FETCH: Route requests to appropriate strategy
// ============================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests and browser extensions
  if (request.method !== 'GET' || url.protocol === 'chrome-extension:') {
    return;
  }

  // Strategy 1: Map Tiles → Stale-While-Revalidate (fast display, background update)
  if (isTileRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, TILE_CACHE));
    return;
  }

  // Strategy 2: API / Dynamic Data → Network-First (fresh data preferred, fallback to cache)
  if (isApiRequest(url)) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE));
    return;
  }

  // Strategy 3: Static Assets (App Shell, CDN libs) → Cache-First (instant loading)
  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Strategy 4: Everything else → Network with cache fallback
  event.respondWith(networkWithCacheFallback(request, DYNAMIC_CACHE));
});

// ============================================
// CACHING STRATEGIES
// ============================================

/**
 * Cache-First: Serve from cache immediately. 
 * If miss, fetch from network and cache the result.
 * Best for: App Shell, CSS, JS, static assets
 */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    // Return cached version immediately
    return cached;
  }

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
      // Clone before putting in cache (response can only be consumed once)
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    console.warn(`[SW] Cache-First failed for ${request.url}:`, err);
    // Return a fallback or error response
    return new Response('Offline - Resource unavailable', { 
      status: 503, 
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

/**
 * Stale-While-Revalidate: Return cached version immediately for speed,
 * then fetch from network in background to update cache.
 * Best for: Map tiles, images that can be slightly outdated
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Always try to fetch fresh version in background
  const fetchPromise = fetch(request)
    .then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        cache.put(request, networkResponse.clone());
      }
      return networkResponse;
    })
    .catch((err) => {
      console.warn(`[SW] Tile fetch failed (using cache): ${request.url}`);
      // Silently fail - we already returned cached version
      return cached;
    });

  // Return cached version immediately, or wait for network if no cache
  return cached || fetchPromise;
}

/**
 * Network-First: Try network first for fresh data.
 * If network fails, return cached version.
 * Best for: API calls, elevation data, dynamic content
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      // Update cache with fresh data
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    console.warn(`[SW] Network failed, trying cache for: ${request.url}`);
    const cached = await cache.match(request);
    if (cached) {
      // Return stale data with header indicating it's from cache
      const headers = new Headers(cached.headers);
      headers.set('X-SW-Cache', 'stale');
      return new Response(cached.body, {
        status: 200,
        statusText: 'OK (from cache)',
        headers
      });
    }
    // No cache available
    return new Response(JSON.stringify({ 
      error: 'Offline', 
      message: 'No network connection and no cached data available.' 
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Network with Cache Fallback: Try network, fall back to cache.
 * Best for: General navigation, HTML pages
 */
async function networkWithCacheFallback(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    
    // Ultimate fallback for HTML pages
    if (request.headers.get('accept')?.includes('text/html')) {
      return cache.match('./index.html');
    }
    
    return new Response('Offline', { status: 503 });
  }
}

// ============================================
// URL CLASSIFICATION HELPERS
// ============================================

function isTileRequest(url) {
  return TILE_PATTERNS.some((pattern) => pattern.test(url.href));
}

function isApiRequest(url) {
  return API_PATTERNS.some((pattern) => pattern.test(url.href));
}

function isStaticAsset(url) {
  // Check if URL matches our static assets list
  const isInStaticList = STATIC_ASSETS.some((asset) => {
    // Handle both relative and absolute URLs
    const assetUrl = new URL(asset, self.location.origin).href;
    return url.href === assetUrl;
  });

  // Also match common static file extensions
  const staticExtensions = /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/i;
  
  return isInStaticList || staticExtensions.test(url.pathname);
}

// ============================================
// BACKGROUND SYNC & PUSH (Future-ready)
// ============================================

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-measurements') {
    event.waitUntil(syncPendingMeasurements());
  }
});

async function syncPendingMeasurements() {
  // Placeholder for background sync of saved measurements
  console.log('[SW] Background sync triggered for measurements');
}

// Handle messages from the main app
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CACHE_TILES') {
    // Pre-cache tiles for a specific region
    preCacheTiles(event.data.bounds, event.data.zoomLevels);
  }
});

/**
 * Pre-cache map tiles for offline use in a specific area
 * @param {Object} bounds - {north, south, east, west}
 * @param {Array} zoomLevels - Array of zoom levels to cache
 */
async function preCacheTiles(bounds, zoomLevels) {
  // Implementation would generate tile URLs and cache them
  console.log('[SW] Pre-caching tiles for bounds:', bounds);
}
