import { randomBytes } from 'node:crypto';
import { TEXT } from './text.mjs';

const LANGUAGES = ['en', 'uz', 'ru'];
const RADII = [1, 3, 5];
const MAX_RECENT = 5;
const PAGE_SIZE = 10;
const OVERPASS_URLS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];
function defaultOverpassUrls(lat, lon) {
  // Use the independently operated Asia extract for Uzbekistan only. Never
  // interpret an empty regional response as global coverage elsewhere.
  const nearUzbekistan = lat >= 37 && lat <= 46 && lon >= 55 && lon <= 74;
  return nearUzbekistan
    ? ['https://ovp.dresel.systems/api-as/interpreter', ...OVERPASS_URLS.slice(0, 2)]
    : OVERPASS_URLS;
}
const MAP_ENDPOINT_TIMEOUT_MS = 45000;
const MAP_QUERY_TIMEOUT_SECONDS = 25;
const QUERY_CACHE_TTL_MS = 5 * 60 * 1000;
const RECENT_LABELS = {
  en: { search: 'Nearby pharmacy search', empty: 'No pharmacies found' },
  uz: { search: 'Yaqin dorixonalar qidiruvi', empty: 'Dorixona topilmadi' },
  ru: { search: 'Поиск аптек поблизости', empty: 'Аптеки не найдены' }
};
const MAP_STATUS = {
  en: {
    cached: '⚠️ Live map search is unavailable. These are previously saved pharmacies nearby; this list may be incomplete or outdated.',
    slow: '⏳ The map service is responding slowly. Trying another server...',
    unavailable: '⚠️ The map servers could not be reached and no saved pharmacies were found nearby. You can search directly in a map below, or try again later.'
  },
  uz: {
    cached: '⚠️ Jonli xarita qidiruvi ishlamayapti. Yaqin atrofdagi avval saqlangan dorixonalar ko‘rsatilmoqda; ro‘yxat to‘liq bo‘lmasligi yoki eskirgan bo‘lishi mumkin.',
    slow: '⏳ Xarita xizmati sekin javob bermoqda. Boshqa server sinab ko‘rilmoqda...',
    unavailable: '⚠️ Xarita serverlariga ulanib bo‘lmadi va yaqin atrofda saqlangan dorixona topilmadi. Quyidagi xaritada bevosita qidiring yoki keyinroq qayta urinib ko‘ring.'
  },
  ru: {
    cached: '⚠️ Поиск по карте недоступен. Показаны ранее сохранённые аптеки поблизости; список может быть неполным или устаревшим.',
    slow: '⏳ Картографический сервис отвечает медленно. Пробуем другой сервер...',
    unavailable: '⚠️ Не удалось связаться с серверами карт. Сохранённых аптек поблизости нет. Можно искать прямо на карте ниже или попробовать позже.'
  }
};
const validKey = key => /^(node|way|relation)\/[1-9]\d{0,15}$/.test(key);
const validRecentId = id => /^[a-f0-9]{16}$/.test(id);
const newRecentId = () => randomBytes(8).toString('hex');
const shorten = (value, length) => Array.from(String(value ?? '')).slice(0, length).join('');

export function errorMessage(error) {
  return String(error?.message ?? error).replace(/\d{5,}:[A-Za-z0-9_-]{20,}/g, '[BOT_TOKEN]');
}

export function mapErrorMessage(error) {
  // Native fetch wraps useful DNS/TLS/socket errors in cause (or AggregateError).
  // Log codes only: raw request URLs could contain private search coordinates.
  const codes = new Set();
  function collect(value, depth = 0) {
    if (!value || depth > 4) return;
    if (typeof value.code === 'string') codes.add(value.code);
    collect(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const nested of value.errors) collect(nested, depth + 1);
  }
  collect(error);
  return `${errorMessage(error)}${codes.size ? ` [${[...codes].join(', ')}]` : ''}`;
}

export function validCoordinates(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const radians = n => n * Math.PI / 180;
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) *
    Math.sin(radians(lon2 - lon1) / 2) ** 2;
  const clamped = Math.min(1, Math.max(0, a));
  return 6371 * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

export function extractPharmacy(element) {
  if (!element || !validKey(`${element.type}/${element.id}`)) return null;
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (!validCoordinates(lat, lon)) return null;
  const tags = element.tags ?? {};
  return {
    key: `${element.type}/${element.id}`, id: element.id, type: element.type, lat, lon,
    name: shorten(tags.name || tags['name:en'], 160),
    address: shorten(tags['addr:full'] || [
      tags['addr:street'], tags['addr:housenumber'], tags['addr:suburb'],
      tags['addr:city'], tags['addr:postcode']
    ].filter(Boolean).join(', '), 800),
    phone: shorten(tags['contact:phone'] || tags.phone || tags['contact:mobile'], 200),
    openingHours: shorten(tags.opening_hours, 500),
    tags: Object.fromEntries(LANGUAGES.map(lang => [`name:${lang}`, shorten(tags[`name:${lang}`], 160)]))
  };
}

export async function searchOverpass(lat, lon, radiusKm, {
  fetchImpl = globalThis.fetch, signal, logger = console,
  endpointTimeoutMs = MAP_ENDPOINT_TIMEOUT_MS, endpoints = defaultOverpassUrls(lat, lon),
  userAgent = 'PharmacyFinderBot/1.1', onRetry, cooldowns = new Map(), now = Date.now
} = {}) {
  if (!validCoordinates(lat, lon) || !RADII.includes(radiusKm)) throw new Error('Invalid search parameters.');
  const query = `[out:json][timeout:${MAP_QUERY_TIMEOUT_SECONDS}];
    nwr["amenity"="pharmacy"](around:${radiusKm * 1000},${lat},${lon});
    out body center;`;
  for (let i = 0; i < endpoints.length; i++) {
    signal?.throwIfAborted();
    const endpoint = endpoints[i];
    if ((cooldowns.get(endpoint) ?? 0) > now()) continue;
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(endpointTimeoutMs)])
        : AbortSignal.timeout(endpointTimeoutMs);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': userAgent
        },
        body: new URLSearchParams({ data: query }).toString(), signal: requestSignal
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers?.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.max(30, retryAfter) * 1000 : 30000;
        cooldowns.set(endpoint, now() + delay);
        throw new Error(`Overpass HTTP ${response.status}`);
      }
      const result = await response.json();
      // Overpass can return HTTP 200 with a runtime error and partial elements.
      if (result.remark || !Array.isArray(result.elements)) throw new Error('Incomplete map response.');
      return result.elements;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      cooldowns.set(endpoint, Math.max(cooldowns.get(endpoint) ?? 0, now() + 30000));
      logger.warn(`Map server ${i + 1}/${endpoints.length} (${new URL(endpoint).hostname}) failed: ${mapErrorMessage(error)}`);
      if (i + 1 < endpoints.length) await onRetry?.();
    }
  }
  throw new Error('All map servers are unavailable.');
}

export function createPharmacyBot({
  bot, store, fetchImpl = globalThis.fetch, logger = console,
  now = Date.now, username = '', endpointTimeoutMs = MAP_ENDPOINT_TIMEOUT_MS, maxConcurrentSearches = 4
}) {
  if (!store.data) throw new Error('Load the database before creating the bot.');
  const data = store.data;
  const searches = new Map();
  const cooldowns = new Map();
  const tasks = new Set();
  const mapCooldowns = new Map();
  const queryCache = new Map();
  let closing = false;

  function getUser(id, languageCode = 'en') {
    const key = String(id);
    if (!/^\d+$/.test(key)) throw new Error('Invalid user identifier.');
    if (!Object.hasOwn(data.users, key)) {
      data.users[key] = { language: LANGUAGES.includes(languageCode) ? languageCode : 'en', radius: 3, favorites: [], recent: [] };
    }
    const user = data.users[key];
    if (!LANGUAGES.includes(user.language)) user.language = 'en';
    if (!RADII.includes(user.radius)) user.radius = 3;
    user.favorites = [...new Set(Array.isArray(user.favorites) ? user.favorites.filter(key => typeof key === 'string' && validKey(key)) : [])];
    user.recent = (Array.isArray(user.recent) ? user.recent : [])
      .filter(item => item && validCoordinates(item.lat, item.lon) && RADII.includes(item.radius))
      .slice(0, MAX_RECENT);
    const seen = new Set();
    for (const recent of user.recent) {
      if (!validRecentId(recent.id) || seen.has(recent.id)) recent.id = newRecentId();
      seen.add(recent.id);
      if (!Number.isFinite(recent.at)) recent.at = now();
    }
    return user;
  }

  function t(user, key, vars = {}) {
    let result = TEXT[user.language]?.[key] ?? TEXT.en[key] ?? key;
    for (const [name, value] of Object.entries(vars)) result = result.replaceAll(`{${name}}`, String(value));
    return result;
  }

  function nameOf(user, pharmacy) {
    return shorten(pharmacy.tags?.[`name:${user.language}`] ||
      (pharmacy.name === TEXT.en.unknown ? '' : pharmacy.name) || t(user, 'unknown'), 160);
  }

  function mainInlineKeyboard(user) {
    return { inline_keyboard: [
      [{ text: `${t(user, 'radius')} (${user.radius} km)`, callback_data: 'radius' }],
      [{ text: t(user, 'favorites'), callback_data: 'favorites' }, { text: t(user, 'recent'), callback_data: 'recent' }],
      [{ text: t(user, 'language'), callback_data: 'language' }, { text: t(user, 'help'), callback_data: 'help' }]
    ] };
  }

  function replyKeyboard(user) {
    return { keyboard: [
      [{ text: t(user, 'locationButton'), request_location: true }],
      [{ text: t(user, 'menuButton') }]
    ], resize_keyboard: true };
  }

  async function sendMenu(chatId, user, welcome = false) {
    if (welcome) await bot.sendMessage(chatId, t(user, 'welcome'), { reply_markup: replyKeyboard(user) });
    await bot.sendMessage(chatId, t(user, 'menu'), { reply_markup: mainInlineKeyboard(user) });
  }

  async function showRadiusMenu(chatId, user) {
    await bot.sendMessage(chatId, t(user, 'chooseRadius'), { reply_markup: { inline_keyboard: [
      RADII.map(radius => ({ text: `${radius} km${user.radius === radius ? ' ✓' : ''}`, callback_data: `radius:${radius}` }))
    ] } });
  }

  async function showLanguageMenu(chatId, user) {
    await bot.sendMessage(chatId, t(user, 'chooseLanguage'), { reply_markup: { inline_keyboard: [[
      { text: '🇬🇧 English', callback_data: 'lang:en' },
      { text: '🇺🇿 O‘zbekcha', callback_data: 'lang:uz' },
      { text: '🇷🇺 Русский', callback_data: 'lang:ru' }
    ]] } });
  }

  const directionsUrl = p => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
  const yandexDirectionsUrl = p => `https://yandex.com/maps/?rtext=~${p.lat},${p.lon}&rtt=auto`;
  const appleDirectionsUrl = p => `https://maps.apple.com/directions?destination=${p.lat},${p.lon}`;
  const twoGisDirectionsUrl = p => `https://2gis.ru/directions/points/%7C${p.lon},${p.lat}`;
  function yandexGoUrl(user, pharmacy) {
    // Yandex's published redirect ID opens Go (or its store page). Pass only
    // the destination: the rider chooses the current pickup point in Go.
    const params = new URLSearchParams({
      'end-lat': String(pharmacy.lat),
      'end-lon': String(pharmacy.lon),
      appmetrica_tracking_id: '1178268795219780156',
      ref: 'pharmacyfinderbot',
      lang: user.language
    });
    return `https://3.redirect.appmetrica.yandex.com/route?${params}`;
  }
  const osmUrl = p => `https://www.openstreetmap.org/${p.type}/${p.id}`;
  const formatDistance = km => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
  function mapSearchKeyboard(user, lat, lon) {
    return { inline_keyboard: [
      [{ text: 'Google Maps', url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`pharmacy near ${lat},${lon}`)}` }],
      [{ text: 'Yandex Maps', url: `https://yandex.com/maps/?ll=${lon},${lat}&z=15&text=${encodeURIComponent('аптека')}` }],
      [{ text: ' Apple Maps', url: `https://maps.apple.com/search?query=pharmacy&center=${lat},${lon}` }],
      ...mainInlineKeyboard(user).inline_keyboard
    ] };
  }
  function detailsKeyboard(user, pharmacy, recentId = '') {
    const saved = user.favorites.includes(pharmacy.key);
    const shareText = [nameOf(user, pharmacy), shorten(pharmacy.address, 800), directionsUrl(pharmacy)].filter(Boolean).join('\n');
    const suffix = recentId ? `|${recentId}` : '';
    return { inline_keyboard: [
      [{ text: t(user, saved ? 'remove' : 'save'), callback_data: `${saved ? 'fr' : 'fa'}|${pharmacy.key}${suffix}` }],
      [{ text: '🚕 Yandex Go', url: yandexGoUrl(user, pharmacy) }],
      [{ text: '📍 2GIS', url: twoGisDirectionsUrl(pharmacy) }],
      [{ text: t(user, 'directions'), url: directionsUrl(pharmacy) }],
      [{ text: '🗺️ Yandex Maps', url: yandexDirectionsUrl(pharmacy) }],
      [{ text: ' Apple Maps', url: appleDirectionsUrl(pharmacy) }],
      [{ text: t(user, 'share'), url: `https://t.me/share/url?url=${encodeURIComponent(osmUrl(pharmacy))}&text=${encodeURIComponent(shareText)}` },
        { text: t(user, 'osm'), url: osmUrl(pharmacy) }]
    ] };
  }

  async function showDetails(chatId, user, key, recentId = '') {
    const pharmacy = data.pharmacies[key];
    if (!pharmacy || !validCoordinates(pharmacy.lat, pharmacy.lon)) {
      await bot.sendMessage(chatId, t(user, 'generalError'));
      return;
    }
    // Search results retain their origin instead of silently using a newer location.
    const recent = recentId ? user.recent.find(item => item.id === recentId) : user.recent[0];
    if (recentId && recent && distanceKm(recent.lat, recent.lon, pharmacy.lat, pharmacy.lon) <= recent.radius && recent.pharmacyKey !== key) {
      recent.pharmacyKey = key;
      await store.save();
    }
    const lines = [
      `💊 ${nameOf(user, pharmacy)}`, '',
      `${t(user, 'address')}: ${shorten(pharmacy.address, 800) || t(user, 'notAvailable')}`,
      `${t(user, 'phone')}: ${shorten(pharmacy.phone, 200) || t(user, 'notAvailable')}`,
      `${t(user, 'hours')}: ${shorten(pharmacy.openingHours, 500) || t(user, 'notAvailable')}`
    ];
    if (recent) lines.push(`${t(user, 'distance')}: ${formatDistance(distanceKm(recent.lat, recent.lon, pharmacy.lat, pharmacy.lon))}`);
    await bot.sendMessage(chatId, lines.join('\n'), { reply_markup: detailsKeyboard(user, pharmacy, recentId) });
  }

  async function showFavorites(chatId, user, page = 0) {
    const favorites = user.favorites.map(key => data.pharmacies[key]).filter(Boolean);
    if (!favorites.length) return bot.sendMessage(chatId, t(user, 'noFavorites'));
    page = Math.max(0, Math.min(page, Math.ceil(favorites.length / PAGE_SIZE) - 1));
    const rows = favorites.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(p => [{
      text: shorten(`💊 ${nameOf(user, p)}`, 60), callback_data: `d|${p.key}`
    }]);
    const navigation = [];
    if (page > 0) navigation.push({ text: '◀️', callback_data: `favorites|${page - 1}` });
    if ((page + 1) * PAGE_SIZE < favorites.length) navigation.push({ text: '▶️', callback_data: `favorites|${page + 1}` });
    if (navigation.length) rows.push(navigation);
    await bot.sendMessage(chatId, t(user, 'yourFavorites'), { reply_markup: { inline_keyboard: rows } });
  }

  async function showRecent(chatId, user) {
    if (!user.recent.length) return bot.sendMessage(chatId, t(user, 'noRecent'));
    const rows = user.recent.map((item, index) => {
      let pharmacy;
      if (Object.hasOwn(item, 'pharmacyKey')) {
        pharmacy = validKey(item.pharmacyKey) ? data.pharmacies[item.pharmacyKey] : undefined;
      } else {
        // Older histories stored only search coordinates. Label them with the
        // nearest saved pharmacy inside their original radius, without a new API request.
        let closest = Infinity;
        for (const candidate of Object.values(data.pharmacies)) {
          if (!candidate || !validKey(candidate.key) || !validCoordinates(candidate.lat, candidate.lon)) continue;
          const distance = distanceKm(item.lat, item.lon, candidate.lat, candidate.lon);
          if (distance <= item.radius && distance < closest) {
            closest = distance;
            pharmacy = candidate;
          }
        }
        if (pharmacy) item.pharmacyKey = pharmacy.key;
      }
      const label = pharmacy ? nameOf(user, pharmacy) : RECENT_LABELS[user.language][item.pharmacyKey === null ? 'empty' : 'search'];
      return [{
        text: `${pharmacy ? '💊' : '🔎'} ${index + 1}. ${shorten(label, 40)} · ${item.radius} km`,
        callback_data: `r|${item.id}`
      }];
    });
    await store.save(); // Persist stable IDs and names' pharmacy references migrated above.
    await bot.sendMessage(chatId, t(user, 'yourRecent'), { reply_markup: { inline_keyboard: rows } });
  }

  async function searchAndSend(chatId, userId, lat, lon, radiusKm) {
    const user = getUser(userId);
    if (!validCoordinates(lat, lon) || !RADII.includes(radiusKm)) {
      await bot.sendMessage(chatId, t(user, 'invalidLocation'));
      return;
    }
    const key = String(userId);
    const previous = cooldowns.get(key);
    if (searches.has(key) || (previous !== undefined && now() - previous < 3000)) {
      await bot.sendMessage(chatId, t(user, 'rateLimit'));
      return;
    }
    if (searches.size >= maxConcurrentSearches) {
      await bot.sendMessage(chatId, t(user, 'busy'));
      return;
    }
    // Remove expired cooldowns so this map does not grow forever.
    for (const [id, time] of cooldowns) if (now() - time >= 3000) cooldowns.delete(id);
    cooldowns.set(key, now());
    const controller = new AbortController();
    searches.set(key, controller);
    try {
      await bot.sendMessage(chatId, t(user, 'searching'));
      const cacheKey = `${lat},${lon},${radiusKm}`;
      for (const [id, item] of queryCache) if (now() - item.at >= QUERY_CACHE_TTL_MS) queryCache.delete(id);
      let candidates;
      let fromSaved = false;
      let retryNoticeSent = false;
      const cached = queryCache.get(cacheKey);
      if (cached) {
        candidates = cached.pharmacies;
      } else {
        try {
          const elements = await searchOverpass(lat, lon, radiusKm, {
            fetchImpl, signal: controller.signal, logger, endpointTimeoutMs,
            cooldowns: mapCooldowns, now,
            userAgent: `PharmacyFinderBot/1.1${username ? ` (+https://t.me/${username})` : ''}`,
            onRetry: async () => {
              if (retryNoticeSent || closing || controller.signal.aborted) return;
              retryNoticeSent = true;
              await bot.sendMessage(chatId, MAP_STATUS[user.language].slow).catch(() => {});
            }
          });
          candidates = elements.map(extractPharmacy).filter(Boolean);
          queryCache.set(cacheKey, { at: now(), pharmacies: candidates });
          if (queryCache.size > 100) queryCache.delete(queryCache.keys().next().value);
        } catch (error) {
          if (closing || controller.signal.aborted) return;
          logger.error(`Live map search failed: ${mapErrorMessage(error)}`);
          candidates = Object.values(data.pharmacies).filter(p =>
            p && validKey(p.key) && validCoordinates(p.lat, p.lon));
          fromSaved = true;
        }
      }
      if (closing || controller.signal.aborted) return;
      const unique = new Map();
      for (const pharmacy of candidates) {
        const distance = distanceKm(lat, lon, pharmacy.lat, pharmacy.lon);
        if (distance <= radiusKm) unique.set(pharmacy.key, { ...pharmacy, distance });
      }
      const results = [...unique.values()].sort((a, b) => a.distance - b.distance).slice(0, 5);
      if (fromSaved && !results.length) {
        await bot.sendMessage(chatId, MAP_STATUS[user.language].unavailable, { reply_markup: mapSearchKeyboard(user, lat, lon) });
        return;
      }
      const existing = user.recent.find(item => item.lat === lat && item.lon === lon && item.radius === radiusKm);
      const recent = { id: existing?.id ?? newRecentId(), lat, lon, radius: radiusKm, at: now(), pharmacyKey: results[0]?.key ?? null };
      user.recent = [recent, ...user.recent.filter(item => item.id !== recent.id)].slice(0, MAX_RECENT);
      for (const { distance, ...pharmacy } of results) data.pharmacies[pharmacy.key] = pharmacy;
      await store.save();
      if (!results.length) {
        await bot.sendMessage(chatId, t(user, 'noResults', { radius: radiusKm }), { reply_markup: mainInlineKeyboard(user) });
        return;
      }
      const items = results.map((p, i) => `${i + 1}. ${nameOf(user, p)}\n   ${t(user, 'distance')}: ${formatDistance(p.distance)}`).join('\n\n');
      const rows = results.map((p, i) => [{ text: shorten(`${i + 1}. ${nameOf(user, p)}`, 60), callback_data: `d|${p.key}|${recent.id}` }]);
      rows.push([{ text: t(user, 'favorites'), callback_data: 'favorites' }, { text: t(user, 'recent'), callback_data: 'recent' }]);
      const notice = fromSaved ? `${MAP_STATUS[user.language].cached}\n\n` : '';
      await bot.sendMessage(chatId, notice + t(user, 'results', { radius: radiusKm, items }), { reply_markup: { inline_keyboard: rows } });
    } catch (error) {
      if (!closing && !controller.signal.aborted) {
        logger.error(`Search failed: ${errorMessage(error)}`);
        await bot.sendMessage(chatId, t(user, 'searchError'));
      }
    } finally {
      searches.delete(key);
    }
  }

  function publicUser(from) {
    return { language: LANGUAGES.includes(from?.language_code) ? from.language_code : 'en' };
  }

  async function onMessage(message) {
    if (!message.from || message.from.is_bot) return;
    const chatId = message.chat?.id;
    if (chatId == null) return;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const command = text.match(/^\/([a-z_]+)(?:@(\w+))?(?:\s|$)/i);
    if (command?.[2] && username && command[2].toLowerCase() !== username.toLowerCase()) return;
    if (message.chat.type !== 'private') {
      if (message.location || command) await bot.sendMessage(chatId, t(publicUser(message.from), 'locationUnavailable'));
      return;
    }
    if (String(chatId) !== String(message.from.id)) return;
    const user = getUser(message.from.id, message.from.language_code);
    if (message.location) return searchAndSend(chatId, message.from.id, message.location.latitude, message.location.longitude, user.radius);
    // Recognize reply buttons from every language, including keyboards sent before a language change.
    if (Object.values(TEXT).some(lang => text === lang.menuButton)) return sendMenu(chatId, user);
    if (Object.values(TEXT).some(lang => text === lang.locationButton)) {
      return bot.sendMessage(chatId, t(user, 'shareLocation'), { reply_markup: replyKeyboard(user) });
    }
    switch (command?.[1].toLowerCase()) {
      case 'start':
        await store.save();
        return sendMenu(chatId, user, true);
      case 'menu': return sendMenu(chatId, user);
      case 'language': return showLanguageMenu(chatId, user);
      case 'radius': return showRadiusMenu(chatId, user);
      case 'favorites': return showFavorites(chatId, user);
      case 'recent': return showRecent(chatId, user);
      case 'help': return bot.sendMessage(chatId, t(user, 'helpText'));
      case 'privacy': return bot.sendMessage(chatId, t(user, 'privacyText'));
      case 'clearhistory':
        // Cancel an outstanding search so it cannot repopulate cleared history.
        searches.get(String(message.from.id))?.abort(new Error('History cleared.'));
        user.recent = [];
        await store.save();
        return bot.sendMessage(chatId, t(user, 'historyCleared'));
      case 'search': return bot.sendMessage(chatId, t(user, 'shareLocation'), { reply_markup: replyKeyboard(user) });
      default:
        if (text) return bot.sendMessage(chatId, t(user, 'shareLocation'), { reply_markup: replyKeyboard(user) });
    }
  }

  async function acknowledge(query, text) {
    try {
      await bot.answerCallbackQuery(query.id, text ? { text } : {});
    } catch (error) {
      // An expired acknowledgement must not prevent the actual action.
      logger.warn(`Could not acknowledge a button: ${errorMessage(error)}`);
    }
  }

  async function onCallback(query) {
    const chat = query.message?.chat;
    if (!query.from || query.from.is_bot) return;
    // Guard every callback before loading preferences, favorites, or private locations.
    if (chat?.type !== 'private' || String(chat.id) !== String(query.from.id)) {
      await acknowledge(query, t(publicUser(query.from), 'locationUnavailable'));
      return;
    }
    await acknowledge(query);
    const user = getUser(query.from.id, query.from.language_code);
    const action = typeof query.data === 'string' ? query.data : '';
    if (action === 'radius') return showRadiusMenu(chat.id, user);
    if (/^radius:[135]$/.test(action)) {
      user.radius = Number(action.split(':')[1]);
      await store.save();
      return bot.sendMessage(chat.id, t(user, 'radiusSaved', { radius: user.radius }), { reply_markup: mainInlineKeyboard(user) });
    }
    if (action === 'language') return showLanguageMenu(chat.id, user);
    if (/^lang:(en|uz|ru)$/.test(action)) {
      user.language = action.split(':')[1];
      await store.save();
      await bot.sendMessage(chat.id, t(user, 'languageSaved'), { reply_markup: replyKeyboard(user) });
      return sendMenu(chat.id, user);
    }
    if (action === 'help') return bot.sendMessage(chat.id, t(user, 'helpText'));
    if (action === 'favorites' || /^favorites\|\d{1,6}$/.test(action)) return showFavorites(chat.id, user, Number(action.split('|')[1] || 0));
    if (action === 'recent') return showRecent(chat.id, user);
    const [kind, key, recentId = ''] = action.split('|');
    if (kind === 'r') {
      const recent = user.recent.find(item => item.id === key);
      if (!validRecentId(key) || !recent) return bot.sendMessage(chat.id, t(user, 'expiredMenu'));
      return searchAndSend(chat.id, query.from.id, recent.lat, recent.lon, recent.radius);
    }
    if (['d', 'fa', 'fr', 'f'].includes(kind) && validKey(key)) {
      if (recentId && !validRecentId(recentId)) return bot.sendMessage(chat.id, t(user, 'expiredMenu'));
      const pharmacy = data.pharmacies[key];
      if (!pharmacy) return bot.sendMessage(chat.id, t(user, 'generalError'));
      // Original f| buttons had ambiguous toggle semantics: refresh them safely.
      if (kind === 'd' || kind === 'f') return showDetails(chat.id, user, key, recentId);
      const alreadySaved = user.favorites.includes(key);
      if (kind === 'fa' && !alreadySaved) user.favorites.push(key);
      if (kind === 'fr') user.favorites = user.favorites.filter(item => item !== key);
      await store.save();
      if (query.message.message_id != null) {
        try {
          await bot.editMessageReplyMarkup(detailsKeyboard(user, pharmacy, recentId), { chat_id: chat.id, message_id: query.message.message_id });
        } catch (error) {
          if (!errorMessage(error).includes('message is not modified')) {
            logger.warn(`Could not refresh a favorite button: ${errorMessage(error)}`);
          }
        }
      }
      return bot.sendMessage(chat.id, t(user, kind === 'fa' ? 'saved' : 'removed'));
    }
    return bot.sendMessage(chat.id, t(user, 'expiredMenu'));
  }

  function track(handler) {
    return update => {
      if (closing) return Promise.resolve();
      const task = Promise.resolve().then(() => handler(update)).catch(async error => {
        logger.error(`Update failed: ${errorMessage(error)}`);
        const chat = update.chat ?? update.message?.chat;
        const from = update.from;
        if (chat?.type === 'private' && String(chat.id) === String(from?.id)) {
          await bot.sendMessage(chat.id, t(publicUser(from), 'generalError')).catch(() => {});
        }
      });
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return task;
    };
  }

  const messageHandler = track(onMessage);
  const callbackHandler = track(onCallback);
  bot.on('message', messageHandler);
  bot.on('callback_query', callbackHandler);
  return {
    async idle() {
      while (tasks.size) await Promise.allSettled([...tasks]);
    },
    async close() {
      closing = true;
      for (const controller of searches.values()) controller.abort(new Error('Bot is shutting down.'));
      await Promise.allSettled([...tasks]);
      await store.flush();
    }
  };
}
