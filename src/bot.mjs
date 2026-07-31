import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';

const DEFAULT_API_URL =
  'https://rent.skdirect.co.kr/skr/common/comm-dotcom-bff/api/v2/proxy/commontunnel';

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});

async function main() {
  loadDotEnv('.env');

  const isDiscordTest = process.argv.includes('--test-discord');
  const isTelegramTest = process.argv.includes('--test-telegram');
  const isNotificationTest = isDiscordTest || isTelegramTest;
  const config = await readConfig({ requireSkrRequestBody: !isNotificationTest });
  if (isDiscordTest) {
    await testDiscord(config);
    return;
  }
  if (isTelegramTest) {
    await testTelegram(config);
    return;
  }

  console.log(
    `[start] watching ${config.targetName || config.targetShtpCrnfId} at branch ${config.targetBrnhId}`,
  );
  console.log(`[start] interval=${config.pollIntervalMs}ms dryRun=${config.dryRun}`);

  let state = await readState(config.stateFile);
  let firstRun = true;

  await checkOnce(config, state, firstRun);
  firstRun = false;

  setInterval(async () => {
    try {
      state = await readState(config.stateFile);
      await checkOnce(config, state, firstRun);
    } catch (error) {
      console.error(`[poll] ${error.stack || error.message}`);
    }
  }, config.pollIntervalMs);
}

async function checkOnce(config, state, firstRun) {
  const checkedAt = new Date();
  const response = await fetchAvailability(config);
  if (config.debugResponseFile) {
    await writeFile(config.debugResponseFile, `${JSON.stringify(response, null, 2)}\n`);
  }
  const target = findTargetVehicle(response, config);

  if (!target) {
    const nextState = {
      ...state,
      lastCheckedAt: checkedAt.toISOString(),
      lastFound: false,
      lastAvailable: false,
      lastAvailableCount: null,
    };
    await writeState(config.stateFile, nextState);
    console.warn(`[${checkedAt.toISOString()}] target vehicle was not found in response`);
    return;
  }

  const availableCount = toNumber(target.avblCrnfCnt);
  const available = availableCount >= config.minAvailableCount;
  const wasAvailable = Boolean(state.lastAvailable);
  const shouldNotify =
    available && (!wasAvailable || (firstRun && config.notifyOnStartIfAvailable));

  console.log(
    `[${checkedAt.toISOString()}] ${target.shtpCrnfNm || config.targetName}: avblCrnfCnt=${availableCount}`,
  );

  if (shouldNotify) {
    await notifyAvailability(config, target, checkedAt);
  }

  await writeState(config.stateFile, {
    lastCheckedAt: checkedAt.toISOString(),
    lastFound: true,
    lastAvailable: available,
    lastAvailableCount: availableCount,
    lastVehicleName: target.shtpCrnfNm || config.targetName,
  });
}

async function fetchAvailability(config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.fetchTimeoutMs);

  try {
    const requestBody = config.refreshRequestTimestamps
      ? refreshRequestTimestamps(config.requestBody)
      : config.requestBody;
    const response = await fetch(config.apiUrl, {
      method: config.method,
      headers: config.headers,
      body: config.method === 'GET' ? undefined : JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`SKR API returned HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    return parseJsonLenient(text);
  } finally {
    clearTimeout(timeout);
  }
}

function findTargetVehicle(payload, config) {
  for (const item of walkObjects(payload)) {
    if (!isPlainObject(item)) continue;

    const sameVehicle =
      String(item.shtpCrnfId ?? '') === config.targetShtpCrnfId ||
      (config.targetName && String(item.shtpCrnfNm ?? '').includes(config.targetName));
    const sameBranch = !config.targetBrnhId || String(item.brnhId ?? '') === config.targetBrnhId;

    if (sameVehicle && sameBranch && Object.hasOwn(item, 'avblCrnfCnt')) {
      return item;
    }
  }

  return null;
}

async function notifyAvailability(config, vehicle, checkedAt) {
  const availableCount = toNumber(vehicle.avblCrnfCnt);
  const totalCount = toNumber(vehicle.totCrnfCnt);
  const title = 'SK렌터카 예약 가능 차량 감지';
  const lines = [
    `**${vehicle.shtpCrnfNm || config.targetName || config.targetShtpCrnfId}**`,
    `지점: ${vehicle.brnhNm || config.targetBrnhId}`,
    `가능 대수: ${availableCount}${Number.isFinite(totalCount) ? ` / ${totalCount}` : ''}`,
    vehicle.lastRntlAmt != null ? `예상 금액: ${formatKrw(vehicle.lastRntlAmt)}` : null,
    `확인 시각: ${formatKst(checkedAt)}`,
    `예약 페이지: https://rent.skdirect.co.kr/short-rent/car-list`,
  ].filter(Boolean);

  const message = {
    content: `@here ${title}`,
    embeds: [
      {
        title,
        description: lines.join('\n'),
        color: 0x1f8b4c,
      },
    ],
  };
  const telegramText = [
    title,
    '',
    vehicle.shtpCrnfNm || config.targetName || config.targetShtpCrnfId,
    `지점: ${vehicle.brnhNm || config.targetBrnhId}`,
    `가능 대수: ${availableCount}${Number.isFinite(totalCount) ? ` / ${totalCount}` : ''}`,
    vehicle.lastRntlAmt != null ? `예상 금액: ${formatKrw(vehicle.lastRntlAmt)}` : null,
    `확인 시각: ${formatKst(checkedAt)}`,
    '예약 페이지: https://rent.skdirect.co.kr/short-rent/car-list',
  ]
    .filter(Boolean)
    .join('\n');

  if (config.dryRun) {
    console.log(`[notification:dry-run] ${JSON.stringify({ discord: message, telegramText }, null, 2)}`);
    return;
  }

  if (config.telegramBotToken && config.telegramChatId) {
    await sendTelegramMessage(config, telegramText);
    return;
  }

  if (config.discordBotToken && config.discordChannelId) {
    await sendDiscordBotMessage(config, message);
    return;
  }

  await sendDiscordWebhookMessage(config, message);
}

async function testDiscord(config) {
  const checkedAt = new Date();
  const message = {
    content: 'SK렌터카 알림 봇 테스트',
    embeds: [
      {
        title: 'Discord 알림 테스트',
        description: [
          `대상 차량: ${config.targetName || config.targetShtpCrnfId}`,
          `지점 ID: ${config.targetBrnhId}`,
          `테스트 시각: ${formatKst(checkedAt)}`,
        ].join('\n'),
        color: 0x3b82f6,
      },
    ],
  };

  if (config.dryRun) {
    console.log(`[discord:dry-run] ${JSON.stringify(message, null, 2)}`);
    return;
  }

  if (config.discordBotToken && config.discordChannelId) {
    await sendDiscordBotMessage(config, message);
  } else {
    await sendDiscordWebhookMessage(config, message);
  }

  console.log('[discord] test message sent');
}

async function testTelegram(config) {
  const checkedAt = new Date();
  const text = [
    'SK렌터카 알림 봇 테스트',
    `대상 차량: ${config.targetName || config.targetShtpCrnfId}`,
    `지점 ID: ${config.targetBrnhId}`,
    `테스트 시각: ${formatKst(checkedAt)}`,
  ].join('\n');

  if (config.dryRun) {
    console.log(`[telegram:dry-run] ${text}`);
    return;
  }

  await sendTelegramMessage(config, text);
  console.log('[telegram] test message sent');
}

async function sendTelegramMessage(config, text) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
}

async function sendDiscordWebhookMessage(config, message) {
  const response = await fetch(config.discordWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function sendDiscordBotMessage(config, message) {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${config.discordChannelId}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bot ${config.discordBotToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        content: message.content,
        embeds: message.embeds,
        allowed_mentions: { parse: ['everyone'] },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord bot API returned HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
}

async function readConfig({ requireSkrRequestBody = true } = {}) {
  const requestBody = requireSkrRequestBody ? await readRequestBody() : null;
  const headers = parseJsonEnv('SKR_HEADERS_JSON', {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    origin: 'https://rent.skdirect.co.kr',
    referer: 'https://rent.skdirect.co.kr/short-rent/car-list',
  });
  const dryRun = parseBoolean(process.env.DRY_RUN, false);
  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const discordChannelId = process.env.DISCORD_CHANNEL_ID;
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;

  if (
    !dryRun &&
    !discordWebhookUrl &&
    !(discordBotToken && discordChannelId) &&
    !(telegramBotToken && telegramChatId)
  ) {
    throw new Error(
      'Configure DISCORD_WEBHOOK_URL, DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID, or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID unless DRY_RUN=true',
    );
  }

  return {
    apiUrl: process.env.SKR_API_URL || DEFAULT_API_URL,
    method: (process.env.SKR_METHOD || 'POST').toUpperCase(),
    headers,
    requestBody,
    discordWebhookUrl,
    discordBotToken,
    discordChannelId,
    telegramBotToken,
    telegramChatId,
    dryRun,
    targetShtpCrnfId: process.env.TARGET_SHTP_CRNF_ID || '2600000001091',
    targetBrnhId: process.env.TARGET_BRNH_ID || '000012',
    targetName: process.env.TARGET_NAME || '2027 그랜저(GN7)가솔린 캘리그래피',
    minAvailableCount: parsePositiveNumber(process.env.MIN_AVAILABLE_COUNT, 1),
    pollIntervalMs: parsePositiveNumber(process.env.POLL_INTERVAL_MS, 60_000),
    fetchTimeoutMs: parsePositiveNumber(process.env.FETCH_TIMEOUT_MS, 20_000),
    stateFile: process.env.STATE_FILE || '.skr-bot-state.json',
    notifyOnStartIfAvailable: parseBoolean(process.env.NOTIFY_ON_START_IF_AVAILABLE, true),
    refreshRequestTimestamps: parseBoolean(process.env.REFRESH_REQUEST_TIMESTAMPS, true),
    debugResponseFile: process.env.DEBUG_RESPONSE_FILE || '',
  };
}

async function readRequestBody() {
  let requestBody;

  if (process.env.SKR_REQUEST_BODY_FILE) {
    requestBody = parseJsonLenient(await readFile(process.env.SKR_REQUEST_BODY_FILE, 'utf8'));
  } else if (process.env.SKR_REQUEST_BODY_JSON) {
    requestBody = parseJsonLenient(process.env.SKR_REQUEST_BODY_JSON);
  } else {
    throw new Error('SKR_REQUEST_BODY_JSON or SKR_REQUEST_BODY_FILE is required');
  }

  if (!isPlainObject(requestBody) || !requestBody.prxyId) {
    throw new Error(
      'SKR request body must be the full commontunnel payload and include top-level prxyId. Copy the Request Payload from the commontunnel Network request.',
    );
  }

  return requestBody;
}

function parseJsonEnv(name, fallback) {
  if (!process.env[name]) return fallback;
  return parseJsonLenient(process.env[name]);
}

function parseJsonLenient(value) {
  const parsed = JSON.parse(value);
  if (typeof parsed === 'string') {
    return JSON.parse(parsed);
  }
  return parsed;
}

function* walkObjects(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        yield* walkObjects(JSON.parse(trimmed));
      } catch {
        // Some response fields are ordinary strings; ignore JSON parse failures.
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      yield* walkObjects(item);
    }
    return;
  }

  if (!isPlainObject(value)) return;

  yield value;
  for (const child of Object.values(value)) {
    yield* walkObjects(child);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value) {
  if (value == null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parsePositiveNumber(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Expected a positive number, got: ${value}`);
  }
  return number;
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function refreshRequestTimestamps(requestBody) {
  const nextBody = { ...requestBody };
  const now = new Date();

  if (typeof nextBody.param === 'string') {
    nextBody.param = setRawQueryParam(nextBody.param, 'rsvReqsDtm', formatSkrDateTime(now));
  }

  if (Object.hasOwn(nextBody, 'updateCallback')) {
    nextBody.updateCallback = now.toISOString();
  }

  return nextBody;
}

function setRawQueryParam(query, key, value) {
  const pairs = query.split('&');
  let found = false;
  const nextPairs = pairs.map((pair) => {
    const index = pair.indexOf('=');
    const pairKey = index === -1 ? pair : pair.slice(0, index);

    if (pairKey !== key) return pair;

    found = true;
    return `${pairKey}=${value}`;
  });

  if (!found) {
    nextPairs.push(`${key}=${value}`);
  }

  return nextPairs.join('&');
}

function formatSkrDateTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

async function readState(path) {
  if (!existsSync(path)) return {};
  return parseJsonLenient(await readFile(path, 'utf8'));
}

async function writeState(path, state) {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const index = line.indexOf('=');
    if (index === -1) continue;

    const key = line.slice(0, index).trim();
    const rawValue = line.slice(index + 1).trim();
    if (!key || process.env[key] != null) continue;

    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function formatKrw(value) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(Number(value));
}

function formatKst(date) {
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Seoul',
  }).format(date);
}
