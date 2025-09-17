import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { access, readFile, writeFile } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'CHECK_URL',
  'POLL_INTERVAL_MIN',
  'STATE_FILE'
];

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Eksik ortam değişkenleri: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_URL = process.env.CHECK_URL;
const STATE_FILE = process.env.STATE_FILE;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INITIAL_BACKOFF_MS = 20_000;
const MAX_BACKOFF_MS = 300_000;
const JITTER_MAX_MS = 30_000;
const MIN_POLL_INTERVAL_SECONDS = 30;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
const ISTANBUL_OFFSET = '+03:00';

const rawPollIntervalMinutes = Number(process.env.POLL_INTERVAL_MIN);
const pollIntervalMinutes = Number.isFinite(rawPollIntervalMinutes) && rawPollIntervalMinutes > 0
  ? rawPollIntervalMinutes
  : 1;
const pollIntervalMs = Math.max(pollIntervalMinutes * 60_000, MIN_POLL_INTERVAL_SECONDS * 1000);

const stateFilePath = path.resolve(__dirname, STATE_FILE);

const istanbulFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

const istanbulDetailedFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

function pad(value) {
  return value.toString().padStart(2, '0');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  const minCeil = Math.ceil(min);
  const maxFloor = Math.floor(max);
  return Math.floor(Math.random() * (maxFloor - minCeil + 1)) + minCeil;
}

function formatDateTime(date) {
  const parts = Object.fromEntries(
    istanbulFormatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function getIstanbulParts(date = new Date()) {
  const parts = Object.fromEntries(
    istanbulDetailedFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function createIstanbulDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${ISTANBUL_OFFSET}`;
  return new Date(iso);
}

function parseRelativeText(text) {
  const lower = text.toLowerCase();
  const now = Date.now();
  const relativeMatch = lower.match(/(\d+)\s+(saniye|dakika|saat|gün|hafta|ay|yıl)\s+önce/);
  if (relativeMatch) {
    const amount = Number(relativeMatch[1]);
    const unit = relativeMatch[2];
    const unitMsMap = {
      saniye: 1000,
      dakika: 60_000,
      saat: 3_600_000,
      gün: 86_400_000,
      hafta: 604_800_000,
      ay: 2_592_000_000,
      yıl: 31_536_000_000
    };
    const unitKey = Object.keys(unitMsMap).find((key) => unit.startsWith(key));
    if (unitKey) {
      const ms = unitMsMap[unitKey] * amount;
      return new Date(now - ms);
    }
  }

  const todayMatch = lower.match(/bugün\s*(?:saat)?\s*(\d{1,2})[:.](\d{2})/i);
  if (todayMatch) {
    const [hour, minute] = todayMatch.slice(1).map(Number);
    const { year, month, day } = getIstanbulParts();
    return createIstanbulDate(year, month, day, hour, minute);
  }

  const yesterdayMatch = lower.match(/dün\s*(?:saat)?\s*(\d{1,2})[:.](\d{2})/i);
  if (yesterdayMatch) {
    const [hour, minute] = yesterdayMatch.slice(1).map(Number);
    const current = createIstanbulDate(...Object.values(getIstanbulParts()));
    const yesterday = new Date(current.getTime() - 86_400_000);
    const { year, month, day } = getIstanbulParts(yesterday);
    return createIstanbulDate(year, month, day, hour, minute);
  }

  return null;
}

function parsePostedAtValue(value, depth = 0, seen) {
  if (value == null || depth > 6) {
    return null;
  }

  if (!seen) {
    seen = new WeakSet();
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parsePostedAtValue(entry, depth + 1, seen);
      if (parsed) {
        return parsed;
      }
    }
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 9_999_999_999 ? value : value * 1000;
    return new Date(ms);
  }

  if (typeof value === 'object') {
    const objectKeys = [
      'timestamp',
      'timestampMs',
      'timestampMilliseconds',
      'time',
      'value',
      'date',
      'datetime',
      'dateTime',
      'iso',
      'iso8601',
      'string',
      'text',
      'formatted',
      'pretty',
      'label',
      'display',
      'seconds',
      'secs',
      'ms',
      'milliseconds',
      'millis',
      'unix',
      'unixTime',
      'unixTimestamp'
    ];
    for (const key of objectKeys) {
      if (key in value) {
        const parsed = parsePostedAtValue(value[key], depth + 1, seen);
        if (parsed) {
          return parsed;
        }
      }
    }
    return null;
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    const ms = text.length >= 13 ? numeric : numeric * 1000;
    return new Date(ms);
  }

  const relativeDate = parseRelativeText(text);
  if (relativeDate) {
    return relativeDate;
  }

  const isoParsed = Date.parse(text);
  if (!Number.isNaN(isoParsed)) {
    return new Date(isoParsed);
  }

  const spacedIsoCandidate = text.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(spacedIsoCandidate)) {
    const enriched = spacedIsoCandidate.length === 16 ? `${spacedIsoCandidate}:00` : spacedIsoCandidate;
    return new Date(`${enriched}${ISTANBUL_OFFSET}`);
  }

  const dmyMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2})[:.](\d{2}))?/);
  if (dmyMatch) {
    const [, d, m, y, hour = '0', minute = '0'] = dmyMatch;
    const year = y.length === 2 ? `20${y}` : y.padStart(4, '0');
    return new Date(
      `${year}-${pad(Number(m))}-${pad(Number(d))}T${pad(Number(hour))}:${pad(Number(minute))}:00${ISTANBUL_OFFSET}`
    );
  }

  return null;
}

function normalizePostedAt(raw) {
  const parsed = parsePostedAtValue(raw);
  if (!parsed || Number.isNaN(parsed.getTime())) {
    console.warn('postedAt çözümlenemedi, şimdiye ayarlandı. Raw:', raw);
    return formatDateTime(new Date());
  }
  return formatDateTime(parsed);
}

function resolveListingUrl(href) {
  if (!href) {
    return null;
  }
  const trimmed = String(href).trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d+$/.test(trimmed)) {
    return `https://lzt.market/market/${trimmed}/`;
  }
  try {
    return new URL(trimmed, CHECK_URL).href;
  } catch {
    try {
      return new URL(trimmed, 'https://lzt.market').href;
    } catch {
      return null;
    }
  }
}

async function ensureStateFile() {
  try {
    await access(stateFilePath, fsConstants.F_OK);
  } catch {
    await saveState({ knownIds: [] });
  }
}

async function loadState() {
  try {
    await ensureStateFile();
    const content = await readFile(stateFilePath, 'utf8');
    const data = JSON.parse(content);
    if (!Array.isArray(data.knownIds)) {
      return { knownIds: [] };
    }
    return { knownIds: data.knownIds.map(String) };
  } catch (error) {
    console.warn('State yüklenirken hata, sıfırlanıyor:', error.message);
    return { knownIds: [] };
  }
}

async function saveState(state) {
  const payload = JSON.stringify(state, null, 2);
  await writeFile(stateFilePath, payload, 'utf8');
}

class HttpStatusError extends Error {
  constructor(status, statusText, url) {
    super(`HTTP ${status} ${statusText ?? ''} — ${url}`.trim());
    this.status = status;
    this.url = url;
  }
}

async function sendTelegramMessage(text) {
  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;
  while (attempt < 3) {
    attempt += 1;
    try {
      const response = await fetch(TELEGRAM_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true
        })
      });

      if (!response.ok) {
        const body = await response.text();
        if (response.status === 429 || response.status >= 500) {
          throw new HttpStatusError(response.status, body, 'Telegram API');
        }
        console.error('Telegram bildirimi başarısız:', response.status, body);
        return;
      }

      if (attempt > 1) {
        console.info('Telegram bildirimi başarıyla tekrarlandı.');
      }
      return;
    } catch (error) {
      if (error instanceof HttpStatusError && (error.status === 429 || error.status >= 500)) {
        console.warn(`Telegram oran/hata (${error.status}). ${backoff / 1000}s bekleniyor.`);
        await wait(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      console.error('Telegram bildirimi gönderilemedi:', error);
      return;
    }
  }
  console.error('Telegram bildirimi tekrar denemeleri tükendi.');
}

async function extractListings(page) {
  const rawListings = await page.evaluate(() => {
    const cleanText = (value) => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.replace(/\s+/g, ' ').trim();
      return trimmed || null;
    };

    const TEXT_KEYS = ['text', 'formatted', 'pretty', 'display', 'string', 'value', 'label', 'raw'];
    const TEMPORAL_KEYS = [
      'timestamp',
      'timestampMs',
      'timestampMilliseconds',
      'timestamp_ms',
      'unix',
      'unixTime',
      'unixTimestamp',
      'time',
      'date',
      'datetime',
      'dateTime',
      'created',
      'createdAt',
      'created_at',
      'updated',
      'updatedAt',
      'updated_at',
      'published',
      'publishedAt',
      'published_at',
      'value',
      'seconds',
      'secs',
      'ms',
      'milliseconds',
      'millis',
      'text',
      'formatted',
      'pretty',
      'string'
    ];
    const ID_KEYS = [
      'id',
      'lot_id',
      'lotId',
      'lotID',
      'item_id',
      'itemId',
      'itemID',
      'market_item_id',
      'marketItemId',
      'marketItemID',
      'market_lot_id',
      'marketLotId',
      'listing_id',
      'listingId',
      'product_id',
      'productId',
      'offer_id',
      'offerId',
      'entity_id',
      'entityId',
      'thread_id',
      'threadId',
      'external_id',
      'externalId'
    ];
    const NESTED_ID_SOURCES = ['lot', 'item', 'marketItem', 'thread', 'product', 'entity', 'asset'];

    const getText = (value, depth = 0) => {
      if (value == null) {
        return null;
      }
      if (typeof value === 'string') {
        return cleanText(value);
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
      }
      if (Array.isArray(value) && depth < 3) {
        for (const entry of value) {
          const nested = getText(entry, depth + 1);
          if (nested) {
            return nested;
          }
        }
        return null;
      }
      if (typeof value === 'object' && depth < 3) {
        for (const key of TEXT_KEYS) {
          if (key in value) {
            const nested = getText(value[key], depth + 1);
            if (nested) {
              return nested;
            }
          }
        }
      }
      return null;
    };

    const getTemporal = (value, depth = 0) => {
      if (value == null) {
        return null;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
      }
      if (Array.isArray(value) && depth < 3) {
        for (const entry of value) {
          const nested = getTemporal(entry, depth + 1);
          if (nested) {
            return nested;
          }
        }
        return null;
      }
      if (typeof value === 'object' && depth < 3) {
        for (const key of TEMPORAL_KEYS) {
          if (key in value) {
            const nested = getTemporal(value[key], depth + 1);
            if (nested) {
              return nested;
            }
          }
        }
      }
      return null;
    };

    const getIdFromValue = (value, depth = 0) => {
      if (value == null || depth > 4) {
        return null;
      }
      if (typeof value === 'string' || typeof value === 'number') {
        const text = String(value).trim();
        if (!text) {
          return null;
        }
        const match = text.match(/\d+/);
        return match ? match[0] : text;
      }
      if (Array.isArray(value) && depth < 4) {
        for (const entry of value) {
          const nested = getIdFromValue(entry, depth + 1);
          if (nested) {
            return nested;
          }
        }
        return null;
      }
      if (typeof value === 'object' && depth < 4) {
        for (const key of ID_KEYS) {
          if (key in value) {
            const nested = getIdFromValue(value[key], depth + 1);
            if (nested) {
              return nested;
            }
          }
        }
      }
      return null;
    };

    const toListing = (candidate) => {
      if (!candidate || typeof candidate !== 'object') {
        return null;
      }

      const idSources = [];
      for (const key of ID_KEYS) {
        if (candidate[key] != null) {
          idSources.push(candidate[key]);
        }
      }
      for (const sourceKey of NESTED_ID_SOURCES) {
        if (candidate[sourceKey] && typeof candidate[sourceKey] === 'object') {
          idSources.push(candidate[sourceKey]);
        }
      }

      let id = null;
      for (const source of idSources) {
        const maybeId = getIdFromValue(source);
        if (maybeId) {
          id = maybeId;
          break;
        }
      }

      if (!id) {
        const urlKeys = [
          'url',
          'href',
          'link',
          'thread_url',
          'threadUrl',
          'lot_url',
          'lotUrl',
          'permalink',
          'seo_url',
          'seoUrl',
          'page_url',
          'pageUrl',
          'market_url',
          'marketUrl',
          'slug'
        ];
        for (const key of urlKeys) {
          if (candidate[key]) {
            const text = getText(candidate[key]);
            if (text) {
              const match = text.match(/(\d+)/);
              if (match) {
                id = match[1];
                break;
              }
            }
          }
        }
      }

      if (!id) {
        return null;
      }

      const priceKeys = [
        'price',
        'price_text',
        'priceText',
        'price_formatted',
        'priceFormatted',
        'pricePretty',
        'price_str',
        'priceStr',
        'priceValue',
        'price_value',
        'cost',
        'cost_text',
        'costText',
        'amount',
        'sum',
        'full_price',
        'fullPrice',
        'buy_price',
        'buyPrice'
      ];
      let price = null;
      for (const key of priceKeys) {
        if (candidate[key] != null) {
          const text = getText(candidate[key]);
          if (text) {
            price = text;
            break;
          }
        }
      }
      if (!price && candidate.price) {
        const text = getText(candidate.price);
        if (text) {
          price = text;
        }
      }
      if (!price && candidate.cost) {
        const text = getText(candidate.cost);
        if (text) {
          price = text;
        }
      }
      if (!price && candidate.currency) {
        const amount = getText(candidate.amount ?? candidate.priceValue ?? candidate.price_value ?? candidate.sum);
        const currency = getText(candidate.currency);
        if (amount) {
          price = currency ? `${amount} ${currency}` : amount;
        }
      }
      if (!price) {
        for (const key of Object.keys(candidate)) {
          if (/price/i.test(key)) {
            const text = getText(candidate[key]);
            if (text) {
              price = text;
              break;
            }
          }
        }
      }

      const postedKeys = [
        'postedAt',
        'posted_at',
        'createdAt',
        'created_at',
        'publishTime',
        'publish_time',
        'publishedAt',
        'published_at',
        'updatedAt',
        'updated_at',
        'time',
        'date',
        'pdate',
        'pdate_at',
        'date_create',
        'dateCreate',
        'created',
        'created_time',
        'create_time',
        'added_at',
        'addedAt',
        'last_update',
        'lastUpdate'
      ];
      let postedAt = null;
      for (const key of postedKeys) {
        if (candidate[key] != null) {
          const temporal = getTemporal(candidate[key]);
          if (temporal) {
            postedAt = temporal;
            break;
          }
        }
      }
      if (!postedAt && candidate.timestamps) {
        const temporal = getTemporal(candidate.timestamps);
        if (temporal) {
          postedAt = temporal;
        }
      }

      const hrefKeys = [
        'url',
        'href',
        'link',
        'thread_url',
        'threadUrl',
        'lot_url',
        'lotUrl',
        'page_url',
        'pageUrl',
        'permalink',
        'seo_url',
        'seoUrl',
        'market_url',
        'marketUrl'
      ];
      let href = null;
      for (const key of hrefKeys) {
        if (candidate[key] != null) {
          const text = getText(candidate[key]);
          if (text) {
            href = text;
            break;
          }
        }
      }

      return {
        id,
        price: price ?? null,
        postedAt: postedAt ?? null,
        href: href ?? null
      };
    };

    const domListings = [];
    const seenElements = new Set();

    const elementSelectors = [
      '[data-lot-id]',
      '[data-id]',
      '[data-item-id]',
      '[data-entity-id]',
      'a.market-lot-card',
      '.market-lot-card',
      '.market-lot',
      '.marketLots-listItem',
      '.market-lots-item',
      '.market-card'
    ];

    const readElementListing = (element) => {
      if (!element) {
        return null;
      }
      const dataset = element.dataset ? { ...element.dataset } : {};
      let id =
        element.getAttribute('data-lot-id') ||
        element.getAttribute('data-id') ||
        element.getAttribute('data-item-id') ||
        element.getAttribute('data-entity-id') ||
        dataset.lotId ||
        dataset.id ||
        dataset.itemId ||
        dataset.entityId ||
        dataset.lotid ||
        dataset.itemid ||
        dataset.entityid;
      if (!id) {
        const attrId = element.getAttribute('data-key') || element.getAttribute('data-lot');
        if (attrId) {
          id = attrId;
        }
      }
      const anchor = element.matches('a[href]') ? element : element.querySelector('a[href]');
      if (!id && anchor) {
        const hrefValue = anchor.getAttribute('href') || anchor.href || '';
        const match = hrefValue.match(/(\d+)/);
        if (match) {
          id = match[1];
        }
      }
      if (!id && dataset.url) {
        const match = String(dataset.url).match(/(\d+)/);
        if (match) {
          id = match[1];
        }
      }
      if (!id) {
        return null;
      }

      const priceDatasetKeys = [
        'price',
        'priceText',
        'price_text',
        'priceFormatted',
        'price_formatted',
        'priceValue',
        'price_value',
        'amount',
        'cost',
        'sum',
        'lotPrice'
      ];
      let price = null;
      for (const key of priceDatasetKeys) {
        if (dataset[key]) {
          price = dataset[key];
          break;
        }
      }
      if (!price) {
        const priceEl = element.querySelector(
          '[data-lot-price], [data-price], [data-amount], [data-cost], [data-sum], [class*="price"], .price, .Price, .market-lot-card__price, .market-lot-card-price'
        );
        if (priceEl && priceEl.textContent) {
          price = priceEl.textContent.replace(/\s+/g, ' ').trim();
        }
      }

      const postedDatasetKeys = [
        'postedAt',
        'posted_at',
        'createdAt',
        'created_at',
        'date',
        'time',
        'timestamp',
        'publishedAt',
        'published_at',
        'dateCreate',
        'date_create',
        'addedAt',
        'added_at'
      ];
      let postedAt = null;
      for (const key of postedDatasetKeys) {
        if (dataset[key]) {
          postedAt = dataset[key];
          break;
        }
      }
      if (!postedAt) {
        const timeEl = element.querySelector(
          'time[data-time], time[datetime], time, [data-date], [data-datetime], [data-created], [data-published], [class*="date"], [class*="time"], .date, .time'
        );
        if (timeEl) {
          postedAt =
            timeEl.getAttribute('data-time') ||
            timeEl.getAttribute('datetime') ||
            timeEl.getAttribute('data-date') ||
            timeEl.getAttribute('data-datetime') ||
            timeEl.getAttribute('data-created') ||
            timeEl.getAttribute('data-published') ||
            timeEl.textContent;
          if (postedAt) {
            postedAt = postedAt.replace(/\s+/g, ' ').trim();
          }
        }
      }

      let href = null;
      if (anchor) {
        href = anchor.href || anchor.getAttribute('href') || null;
      } else if (dataset.url || dataset.href) {
        href = dataset.url || dataset.href;
      }

      return {
        id: String(id).trim(),
        price: price ? price : null,
        postedAt: postedAt || null,
        href: href || null
      };
    };

    for (const selector of elementSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seenElements.has(element)) {
          continue;
        }
        seenElements.add(element);
        const listing = readElementListing(element);
        if (listing) {
          domListings.push(listing);
        }
      }
    }

    if (!domListings.length) {
      const anchors = Array.from(document.querySelectorAll('a[href*="/market/"]'));
      for (const anchor of anchors) {
        const listing = readElementListing(anchor);
        if (listing) {
          domListings.push(listing);
        }
      }
    }

    const stateListings = [];
    const visited = new WeakSet();

    const inspect = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 6) {
        return;
      }
      if (visited.has(value)) {
        return;
      }
      visited.add(value);

      const listing = toListing(value);
      if (listing) {
        stateListings.push(listing);
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          inspect(entry, depth + 1);
        }
        return;
      }

      for (const key of Object.keys(value)) {
        inspect(value[key], depth + 1);
      }
    };

    const globalCandidates = [
      globalThis.__NUXT__,
      globalThis.__NUXT__?.data,
      globalThis.__NUXT__?.state,
      globalThis.__NUXT_DATA__,
      globalThis.__NUXT_DATA__?.state,
      globalThis.__NUXT_DATA__?.data,
      globalThis.__DEFAULT_STATE__,
      globalThis.__PREFETCHED_STATE__,
      globalThis.__INITIAL_STATE__
    ];

    for (const candidate of globalCandidates) {
      inspect(candidate);
    }

    const scriptNodes = Array.from(
      document.querySelectorAll('script[type="application/json"], script#__NUXT_DATA__')
    );
    for (const node of scriptNodes) {
      if (!node.textContent) {
        continue;
      }
      try {
        const parsed = JSON.parse(node.textContent);
        inspect(parsed);
      } catch {
        // ignore malformed JSON
      }
    }

    return { domListings, stateListings };
  });

  const domListings = Array.isArray(rawListings?.domListings) ? rawListings.domListings : [];
  const stateListings = Array.isArray(rawListings?.stateListings) ? rawListings.stateListings : [];
  const combined = [...domListings, ...stateListings];
  const uniqueMap = new Map();
  for (const listing of combined) {
    if (!listing || !listing.id) {
      continue;
    }
    const id = String(listing.id).trim();
    if (!id || uniqueMap.has(id)) {
      continue;
    }
    const priceText =
      typeof listing.price === 'string' ? listing.price.replace(/\s+/g, ' ').trim() : listing.price;
    uniqueMap.set(id, {
      id,
      price:
        priceText && String(priceText).trim() ? String(priceText).trim() : 'Fiyat belirtilmemiş',
      postedAtRaw: listing.postedAt ?? null,
      postedAt: normalizePostedAt(listing.postedAt),
      href: resolveListingUrl(listing.href)
    });
  }

  const finalListings = Array.from(uniqueMap.values());
  if (!finalListings.length) {
    console.warn('Sayfada ilan bulunamadı. DOM veya veri yapısı değişmiş olabilir.');
  }
  return finalListings;
}

async function scrapeListings(page) {
  const response = await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded' });
  if (response) {
    const status = response.status();
    if (status === 429 || status >= 500) {
      throw new HttpStatusError(status, response.statusText(), CHECK_URL);
    }
  }

  try {
    await page.waitForLoadState('networkidle', { timeout: 15_000 });
  } catch {
    console.warn('networkidle durumuna ulaşılamadı, DOM taraması devam ediyor.');
  }

  const candidateSelectors = [
    '[data-lot-id]',
    '[data-id]',
    '[data-item-id]',
    '[data-entity-id]',
    'a.market-lot-card',
    '.market-lot-card',
    '.market-lot',
    '.marketLots-listItem',
    '.market-lots-item',
    '.market-card',
    'a[href*="/market/"]'
  ];

  try {
    await page.waitForFunction(
      (selectors) => selectors.some((selector) => document.querySelector(selector)),
      candidateSelectors,
      { timeout: 15_000 }
    );
  } catch {
    console.warn('İlan seçicileri 15 saniye içinde bulunamadı.');
  }

  await wait(randomInt(500, 1500));
  await page.waitForTimeout(500);
  return extractListings(page);
}

function isRetriableError(error) {
  if (error instanceof HttpStatusError) {
    return error.status === 429 || error.status >= 500;
  }
  if (error && typeof error.message === 'string') {
    return error.message.includes('Timeout') || error.message.includes('ERR_CONNECTION');
  }
  return false;
}

async function runScrapeWithBackoff(page) {
  let attempt = 0;
  let backoff = INITIAL_BACKOFF_MS;
  while (attempt < 2) {
    attempt += 1;
    try {
      const listings = await scrapeListings(page);
      if (attempt > 1) {
        console.info('Sayfa alma işlemi tekrar denemede başarılı oldu.');
      }
      return listings;
    } catch (error) {
      if (isRetriableError(error)) {
        console.warn(`Sayfa alma hatası (${error.message}). ${backoff / 1000}s bekleniyor.`);
        await wait(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        continue;
      }
      console.error('Sayfa alma başarısız:', error);
      return null;
    }
  }
  console.error('Sayfa alma tekrar denemeleri başarısız oldu.');
  return null;
}

function buildListingLine(listing) {
  const link = listing.href && listing.href.startsWith('http')
    ? listing.href
    : `https://lzt.market/market/${listing.id}/`;
  return `${link} — 💰 ${listing.price} — 📅 ${listing.postedAt}`;
}

async function main() {
  const state = await loadState();
  console.info('Bilinen ilan sayısı:', state.knownIds.length);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    extraHTTPHeaders: {
      'Accept-Language': 'tr-TR,en;q=0.9'
    }
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(60_000);

  let isClosing = false;
  const gracefulClose = async () => {
    if (isClosing) {
      return;
    }
    isClosing = true;
    console.info('Kapanış işlemi başlatıldı.');
    try {
      await context.close();
      await browser.close();
    } catch (error) {
      console.error('Kapanış sırasında hata:', error);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', gracefulClose);
  process.on('SIGTERM', gracefulClose);
  process.on('unhandledRejection', (reason) => {
    console.error('Yakalanmamış red:', reason);
  });

  const effectiveMinutes = pollIntervalMs / 60_000;
  const lastKnownTotal = state.knownIds.length;
  await sendTelegramMessage(
    `✅ İzleyici başlatıldı! Her ${effectiveMinutes.toFixed(2)} dakikada bir kontrol yapılıyor. 📊 Son bilinen toplam: ${lastKnownTotal}`
  );

  const initialListings = await runScrapeWithBackoff(page);
  if (!initialListings) {
    console.warn('İlk tarama başarısız oldu, birkaç dakika sonra tekrar denenecek.');
    await sendTelegramMessage(`⚠️ İlk tarama başarısız oldu, tekrar denenecek. 📊 Son bilinen toplam: ${lastKnownTotal}`);
  } else {
    const totalCount = initialListings.length;
    console.info(`İlk taramada ${totalCount} ilan bulundu.`);
    const lines = initialListings.slice(0, 10).map(buildListingLine);
    if (initialListings.length > 10) {
      lines.push(`… ve +${initialListings.length - 10} ilan`);
    }
    const message = [`📊 Toplam: ${totalCount}`, 'Son ilanlar:', ...lines];
    await sendTelegramMessage(message.join('\n'));
    state.knownIds = initialListings.map((item) => item.id);
    await saveState(state);
  }

  let cycle = 0;
  while (true) {
    cycle += 1;
    const jitter = randomInt(0, JITTER_MAX_MS);
    console.info(`Yeni döngü #${cycle}. ${((pollIntervalMs + jitter) / 1000).toFixed(1)} saniye sonra kontrol.`);
    await wait(pollIntervalMs + jitter);

    const listings = await runScrapeWithBackoff(page);
    if (!listings) {
      console.warn('Bu döngüde veriler alınamadı.');
      continue;
    }

    const totalCount = listings.length;
    const knownSet = new Set(state.knownIds);
    const newListings = listings.filter((item) => !knownSet.has(item.id));

    if (newListings.length) {
      console.info(`Yeni ${newListings.length} ilan bulundu.`);
      const lines = newListings.slice(0, 10).map(buildListingLine);
      if (newListings.length > 10) {
        lines.push(`… ve +${newListings.length - 10} ilan`);
      }
      const message = [
        `🆕 ${newListings.length} yeni ilan bulundu! 📊 Şu an toplam: ${totalCount} ilan var.`,
        ...lines
      ];
      await sendTelegramMessage(message.join('\n'));
    } else {
      console.info('Yeni ilan yok.');
      await sendTelegramMessage(`🔁 Yeni ilan yok. 📊 Toplam: ${totalCount}`);
    }

    state.knownIds = listings.map((item) => item.id);
    await saveState(state);
  }
}

main().catch((error) => {
  console.error('Beklenmeyen hata:', error);
  process.exit(1);
});
