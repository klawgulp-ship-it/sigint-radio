// ═══════════════════════════════════════════════════════════════
// STREAM FINDER — Dynamic radio stream discovery + health checks
// Uses RadioBrowser API + multi-URL fallbacks + liveness testing
// ═══════════════════════════════════════════════════════════════

// RadioBrowser API servers (round-robin)
const RB_SERVERS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
];
let rbIdx = 0;
const rb = () => RB_SERVERS[rbIdx++ % RB_SERVERS.length];

// Cache: stationId -> { urls: [], lastChecked, workingUrl }
const streamCache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 min

// Search queries per station to find streams on RadioBrowser
const SEARCH_QUERIES = {
  // Iran
  'ir-irib':       { name: 'IRIB', country: 'Iran', tags: 'iran,irib' },
  'ir-irib-news':  { name: 'Iran news', country: 'Iran', tags: 'news,iran' },
  'ir-irib-quran': { name: 'Quran', country: 'Iran', tags: 'quran,iran' },
  'ir-goftogoo':   { name: 'goftogoo', country: 'Iran', tags: 'iran,talk' },
  'ir-payam':      { name: 'payam', country: 'Iran', tags: 'iran' },
  'ir-farhang':    { name: 'farhang', country: 'Iran', tags: 'iran,culture' },
  // Israel
  'il-galatz':     { name: 'Galei Zahal', country: 'Israel', tags: 'military,israel' },
  'il-kan':        { name: 'Kan', country: 'Israel', tags: 'kan,israel' },
  // Ukraine
  'ua-hromadske':  { name: 'Hromadske', country: 'Ukraine', tags: 'ukraine,news' },
  'ua-nrcu':       { name: 'Ukrainian Radio', country: 'Ukraine', tags: 'ukraine,suspilne' },
  // Russia
  'ru-mayak':      { name: 'Mayak', country: 'Russia', tags: 'mayak,russia' },
  'ru-echo':       { name: 'Echo Moscow', country: 'Russia', tags: 'echo' },
  // Others
  'kp-kcbs':       { name: 'KCBS', country: 'Korea', tags: 'pyongyang,korea' },
  'qa-aljazeera':  { name: 'Al Jazeera', country: 'Qatar', tags: 'aljazeera' },
  'tr-trt':        { name: 'TRT', country: 'Turkey', tags: 'trt' },
  'eg-nile':       { name: 'Nile FM', country: 'Egypt', tags: 'nile,egypt' },
  'de-dlf':        { name: 'Deutschlandfunk', country: 'Germany', tags: 'dlf' },
  'fr-fip':        { name: 'FIP', country: 'France', tags: 'fip,radio france' },
  'us-npr':        { name: 'NPR', country: 'United States', tags: 'npr,news' },
};

// Search RadioBrowser for streams matching a query
async function searchRadioBrowser(query) {
  const params = new URLSearchParams({
    limit: '10',
    order: 'votes',
    reverse: 'true',
    hidebroken: 'true',
  });
  if (query.name) params.set('name', query.name);
  if (query.country) params.set('country', query.country);
  if (query.tags) params.set('tag', query.tags.split(',')[0]);

  try {
    const res = await fetch(`${rb()}/json/stations/search?${params}`, {
      headers: { 'User-Agent': 'SIGINT-Radio/2.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const stations = await res.json();
    return stations
      .filter(s => s.url_resolved && s.lastcheckok === 1)
      .map(s => s.url_resolved);
  } catch (e) {
    return [];
  }
}

// Test if a stream URL is actually reachable (quick HEAD/GET check)
async function testStream(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Range': 'bytes=0-1024',
      },
    });
    clearTimeout(timeout);

    if (!res.ok && res.status !== 206) return false;

    // Read a small chunk to verify it's actually streaming
    const reader = res.body.getReader();
    const { done, value } = await reader.read();
    reader.cancel().catch(() => {});
    return !done && value && value.length > 0;
  } catch (e) {
    return false;
  }
}

// Get the best working URL for a station, with fallbacks
export async function getWorkingUrl(stationId, fallbackUrls = []) {
  const cached = streamCache.get(stationId);
  if (cached && cached.workingUrl && Date.now() - cached.lastChecked < CACHE_TTL) {
    return cached.workingUrl;
  }

  // Build candidate list: fallback URLs + RadioBrowser results
  const candidates = [...fallbackUrls];

  // Search RadioBrowser
  const query = SEARCH_QUERIES[stationId];
  if (query) {
    const rbUrls = await searchRadioBrowser(query);
    candidates.push(...rbUrls);
  }

  // Deduplicate
  const unique = [...new Set(candidates)];

  // Test each URL
  for (const url of unique) {
    const ok = await testStream(url);
    if (ok) {
      console.log(`[STREAM] ${stationId}: found working URL — ${url.slice(0, 60)}...`);
      streamCache.set(stationId, { urls: unique, workingUrl: url, lastChecked: Date.now() });
      return url;
    }
  }

  console.log(`[STREAM] ${stationId}: no working URL found (tried ${unique.length})`);
  streamCache.set(stationId, { urls: unique, workingUrl: null, lastChecked: Date.now() });
  return fallbackUrls[0] || null; // return first fallback even if untested
}

// Refresh all priority station URLs in background
export async function refreshAllStreams(stations) {
  console.log(`[STREAM] Refreshing ${stations.length} station URLs...`);
  let working = 0;
  for (const s of stations) {
    const url = await getWorkingUrl(s.id, [s.url]);
    if (url) working++;
  }
  console.log(`[STREAM] ${working}/${stations.length} stations have working URLs`);
}

// Get stream status for API
export function getStreamStatus() {
  const status = {};
  for (const [id, data] of streamCache) {
    status[id] = {
      working: !!data.workingUrl,
      url: data.workingUrl?.slice(0, 60),
      candidates: data.urls?.length || 0,
      lastChecked: data.lastChecked ? new Date(data.lastChecked).toISOString() : null,
    };
  }
  return status;
}
