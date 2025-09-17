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

function parsePostedAtValue(value) {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 9_999_999_999 ? value : value * 1000;
    return new Date(ms);
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
  const listings = await page.evaluate(() => {
    const selectors = [
      '[data-lot-id]',
      '[data-id]',
      '[data-item-id]',
      '[data-entity-id]'
    ];
    const elements = [];
    const seen = new Set();

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) {
          continue;
        }
        const id =
          element.getAttribute('data-lot-id') ||
          element.getAttribute('data-id') ||
          element.getAttribute('data-item-id') ||
          element.getAttribute('data-entity-id') ||
          (element.dataset ? element.dataset.lotId || element.dataset.id || element.dataset.itemId || element.dataset.entityId : null);
        if (!id) {
          continue;
        }
        seen.add(element);
        elements.push({ element, id: String(id).trim() });
      }
    }

    if (!elements.length) {
      const anchors = Array.from(document.querySelectorAll('a[href*="/market/"]'));
      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const match = href.match(/\/(\d+)(?:\D|$)/);
        if (!match) {
          continue;
        }
        const id = match[1];
        if (id && !elements.some((item) => item.id === id)) {
          elements.push({ element: anchor, id });
        }
      }
    }

    return elements.map(({ element, id }) => {
      const dataset = element.dataset ? { ...element.dataset } : {};

      const priceDatasetKeys = ['price', 'amount', 'cost', 'lotPrice'];
      let price = null;
      for (const key of priceDatasetKeys) {
        if (dataset[key]) {
          price = dataset[key];
          break;
        }
      }
      if (!price) {
        const priceEl =
          element.querySelector('[data-lot-price]') ||
          element.querySelector('[data-price]') ||
          element.querySelector('[data-amount]') ||
          element.querySelector('[data-cost]') ||
          element.querySelector('[class*="price"]');
        if (priceEl && priceEl.textContent) {
          price = priceEl.textContent.replace(/\s+/g, ' ').trim();
        }
      }

      const timeDatasetKeys = ['postedAt', 'createdAt', 'date', 'time', 'timestamp', 'publishedAt'];
      let postedAt = null;
      for (const key of timeDatasetKeys) {
        if (dataset[key]) {
          postedAt = dataset[key];
          break;
        }
      }
      if (!postedAt) {
        const timeEl =
          element.querySelector('time[data-time]') ||
          element.querySelector('time[datetime]') ||
          element.querySelector('time') ||
          element.querySelector('[data-date]') ||
          element.querySelector('[data-datetime]') ||
          element.querySelector('[data-created]') ||
          element.querySelector('[class*="date"]') ||
          element.querySelector('[class*="time"]');
        if (timeEl) {
          postedAt =
            timeEl.getAttribute('data-time') ||
            timeEl.getAttribute('datetime') ||
            timeEl.getAttribute('data-date') ||
            timeEl.getAttribute('data-datetime') ||
            timeEl.textContent;
          if (postedAt) {
            postedAt = postedAt.replace(/\s+/g, ' ').trim();
          }
        }
      }

      const linkElement = element.closest('a[href]') || element.querySelector('a[href]');
      const href = linkElement ? linkElement.href : null;

      return {
        id,
        price: price ? price.replace(/\s+/g, ' ').trim() : null,
        postedAt: postedAt || null,
        href: href || null
      };
    });
  });

  const uniqueMap = new Map();
  for (const listing of listings) {
    if (!listing.id) {
      continue;
    }
    if (!uniqueMap.has(listing.id)) {
      uniqueMap.set(listing.id, listing);
    }
  }

  return Array.from(uniqueMap.values()).map((listing) => ({
    id: listing.id,
    price: listing.price || 'Fiyat belirtilmemiş',
    postedAtRaw: listing.postedAt,
    postedAt: normalizePostedAt(listing.postedAt),
    href: listing.href
  }));
}

async function scrapeListings(page) {
  const response = await page.goto(CHECK_URL, { waitUntil: 'domcontentloaded' });
  if (response) {
    const status = response.status();
    if (status === 429 || status >= 500) {
      throw new HttpStatusError(status, response.statusText(), CHECK_URL);
    }
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
