'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { Telegraf, Markup } = require('telegraf');
const { MapCapture } = require('./map-capture');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = String(process.env.TG_ADMIN_ID || '');

if (!TELEGRAM_TOKEN || !ADMIN_ID) {
  console.error('Не заданы TELEGRAM_TOKEN или TG_ADMIN_ID в .env');
  process.exit(1);
}

const defaultConfig = {
  host: process.env.MC_HOST || '',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || '',
  version: process.env.MC_VERSION || '',
  password: process.env.MC_LOGIN_PASSWORD || '',
  authMode: 'manual'
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...defaultConfig };
    return { ...defaultConfig, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (error) {
    console.error('Не удалось прочитать config.json:', error.message);
    return { ...defaultConfig };
  }
}

let config = loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
}

const telegram = new Telegraf(TELEGRAM_TOKEN);
const mapCapture = new MapCapture();

let minecraft = null;
let connectionState = 'Отключён';
let reconnectTimer = null;
let reconnectEnabled = false;
let pendingAction = null;
let captchaActive = false;
let captchaMapSent = false;
let captchaMapSending = false;
let captchaWaitTimer = null;
let lastAuthSentAt = 0;
let currentWindowSummary = null;
let systemMessages = [];
const recentlyForwarded = new Map();

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const mainKeyboard = Markup.keyboard([
  ['▶️ Подключить', '⏹ Отключить'],
  ['📊 Что происходит', '🔄 Перезайти'],
  ['⚙️ Сервер', '👤 Ник'],
  ['🔐 Пароль', '📝 Авторизация'],
  ['💬 Написать в чат', '🗺 Капча / карта'],
  ['📋 Системные сообщения', '❌ Отмена']
]).resize().persistent();

const authKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('🔐 /login', 'auth_login'),
    Markup.button.callback('🆕 /register', 'auth_register')
  ],
  [Markup.button.callback('✋ Вручную', 'auth_manual')]
]);

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a7[0-9A-FK-OR]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeReason(reason) {
  if (!reason) return 'Причина не указана';
  if (typeof reason === 'string') return cleanText(reason);

  try {
    const rendered = reason.toString?.();
    if (rendered && rendered !== '[object Object]') return cleanText(rendered);
    return cleanText(JSON.stringify(reason));
  } catch {
    return 'Неизвестная причина';
  }
}

function componentText(component) {
  if (component == null) return '';
  if (typeof component === 'string') return cleanText(component);

  try {
    const rendered = component.toString?.();
    if (rendered && rendered !== '[object Object]') return cleanText(rendered);
  } catch {}

  try {
    return cleanText(JSON.stringify(component));
  } catch {
    return '';
  }
}

async function notify(text) {
  try {
    await telegram.telegram.sendMessage(
      ADMIN_ID,
      cleanText(text).slice(0, 4000),
      mainKeyboard
    );
  } catch (error) {
    console.error('Ошибка Telegram:', error.message);
  }
}

function rememberSystemMessage(text) {
  const value = cleanText(text);
  if (!value) return;

  systemMessages.push({ at: Date.now(), text: value });
  if (systemMessages.length > 100) systemMessages.shift();
}

async function forwardSystemMessage(text, source = 'Система') {
  const value = cleanText(text);
  if (!value) return;

  const key = `${source}:${value}`;
  const now = Date.now();
  const previous = recentlyForwarded.get(key) || 0;
  if (now - previous < 4000) return;

  recentlyForwarded.set(key, now);
  if (recentlyForwarded.size > 200) {
    for (const [oldKey, timestamp] of recentlyForwarded) {
      if (now - timestamp > 60000) recentlyForwarded.delete(oldKey);
    }
  }

  rememberSystemMessage(`${source}: ${value}`);
  await notify(`🖥 ${source}: ${value}`);
}

function playerNames() {
  if (!minecraft?.players) return [];
  return Object.values(minecraft.players)
    .map(player => cleanText(player?.username))
    .filter(Boolean);
}

function normalizeUuid(value) {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

function isPlayerChatMessage(text, messagePosition, jsonMsg, sender) {
  const value = cleanText(text);
  if (!value || !minecraft) return false;

  const senderUuid = normalizeUuid(sender);
  if (senderUuid && !/^0+$/.test(senderUuid)) {
    for (const player of Object.values(minecraft.players || {})) {
      if (normalizeUuid(player?.uuid) === senderUuid) return true;
    }
  }

  const translate = String(jsonMsg?.translate || jsonMsg?.json?.translate || '').toLowerCase();
  if (/^chat\.type\.(text|emote|announcement)$/.test(translate) && senderUuid && !/^0+$/.test(senderUuid)) {
    return true;
  }

  for (const username of playerNames()) {
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`^<${escaped}>\\s`, 'i'),
      new RegExp(`^(?:\\[[^\\]]+\\]\\s*)*${escaped}\\s*(?::|»|›|->)\\s*`, 'i'),
      new RegExp(`^${escaped}\\s+(?:говорит|пишет):`, 'i')
    ];

    if (patterns.some(pattern => pattern.test(value))) return true;
  }

  const position = String(messagePosition ?? '').toLowerCase();
  return (position === 'chat' || position === '0') && senderUuid && !/^0+$/.test(senderUuid);
}

function authModeLabel() {
  if (config.authMode === 'login') return '/login';
  if (config.authMode === 'register') return '/register';
  return 'вручную';
}

function windowTitle(window) {
  return componentText(window?.title) || cleanText(window?.type) || 'без названия';
}

function windowItems(window) {
  const items = [];
  for (let slot = 0; slot < (window?.slots?.length || 0); slot += 1) {
    const item = window.slots[slot];
    if (!item) continue;
    const name = cleanText(item.displayName || item.name || 'предмет');
    items.push(`${slot}: ${name}${item.count > 1 ? ` x${item.count}` : ''}`);
    if (items.length >= 18) break;
  }
  return items;
}

function scoreboardText() {
  const sidebar = minecraft?.scoreboard?.sidebar;
  if (!sidebar) return '';

  const title = componentText(sidebar.title || sidebar.name);
  const items = Array.isArray(sidebar.items)
    ? sidebar.items
    : Object.values(sidebar.itemsMap || {});

  const lines = items.slice(-15).map(item => {
    if (typeof item === 'string') return cleanText(item);
    return cleanText(item?.displayName || item?.name || item?.value || JSON.stringify(item));
  }).filter(Boolean);

  if (!title && !lines.length) return '';
  return [`Табло: ${title || 'без названия'}`, ...lines].join('\n');
}

function worldStateText() {
  const lines = [
    minecraft ? '🟢 Minecraft подключён' : '🔴 Minecraft отключён',
    `Состояние: ${connectionState}`,
    `Сервер: ${config.host || 'не задан'}:${config.port}`,
    `Ник: ${config.username || 'не задан'}`,
    `Версия: ${config.version || 'авто'}`,
    `Авторизация: ${authModeLabel()}`
  ];

  if (minecraft?.entity?.position) {
    const p = minecraft.entity.position;
    lines.push(`XYZ: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
    lines.push(`HP: ${minecraft.health ?? '?'} | Еда: ${minecraft.food ?? '?'}`);
  }

  if (currentWindowSummary) {
    lines.push(`Открыто меню: ${currentWindowSummary.title}`);
    if (currentWindowSummary.items.length) {
      lines.push(`Предметы: ${currentWindowSummary.items.slice(0, 8).join(', ')}`);
    }
  }

  const scoreboard = scoreboardText();
  if (scoreboard) lines.push(scoreboard);

  const latest = systemMessages.slice(-8).map(entry => entry.text);
  if (latest.length) lines.push(`Последние системные сообщения:\n${latest.join('\n')}`);

  return lines.join('\n').slice(0, 3900);
}

function resetCaptchaState() {
  captchaActive = false;
  captchaMapSent = false;
  captchaMapSending = false;

  if (captchaWaitTimer) clearTimeout(captchaWaitTimer);
  captchaWaitTimer = null;
}

async function sendCaptchaMap(target, automatic = false) {
  const image = mapCapture.lastImage;

  if (!image) {
    if (automatic) return false;
    await target.reply('Новая карта ещё не получена от сервера.', mainKeyboard);
    return false;
  }

  const photo = { source: image, filename: 'minecraft-captcha.png' };
  const options = {
    caption: automatic
      ? '🧩 Капча. Просто отправь цифры сообщением.'
      : '🗺 Последняя карта, которую реально прислал сервер.',
    reply_markup: mainKeyboard.reply_markup
  };

  if (automatic) await telegram.telegram.sendPhoto(ADMIN_ID, photo, options);
  else await target.replyWithPhoto(photo, options);
  return true;
}

async function waitAndSendCaptchaMap() {
  if (!captchaActive || captchaMapSent || captchaMapSending) return;
  captchaMapSending = true;

  try {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      if (!captchaActive || captchaMapSent) return;
      if (mapCapture.lastImage) {
        captchaMapSent = await sendCaptchaMap(null, true);
        return;
      }
      await sleep(500);
    }

    if (!captchaMapSent) {
      await forwardSystemMessage('Капча запрошена, но изображение пока не собралось.', 'Бот');
    }
  } catch (error) {
    console.error('Не удалось отправить капчу:', error);
  } finally {
    captchaMapSending = false;
  }
}

function scheduleCaptchaMap() {
  if (captchaWaitTimer || captchaMapSent || captchaMapSending) return;
  captchaWaitTimer = setTimeout(async () => {
    captchaWaitTimer = null;
    await waitAndSendCaptchaMap();
  }, 700);
}

function authCommand(mode = config.authMode) {
  if (!config.password) return null;
  if (mode === 'login') return `/login ${config.password}`;
  if (mode === 'register') return `/register ${config.password} ${config.password}`;
  return null;
}

function sendStoredAuth(mode = config.authMode) {
  if (!minecraft) return false;
  const command = authCommand(mode);
  if (!command) return false;

  const now = Date.now();
  if (now - lastAuthSentAt < 3000) return false;

  lastAuthSentAt = now;
  minecraft.chat(command);
  notify(`📤 Автоматически отправлено ${mode === 'register' ? '/register' : '/login'}.`);
  return true;
}

function inspectSystemInstruction(text) {
  if (/капч|captcha|введите код|номер с картинки|проверочн/i.test(text)) {
    connectionState = 'Ожидается ответ капчи';
    captchaActive = true;
    scheduleCaptchaMap();
    return;
  }

  if (/\/register|зарегистрируй|регистрац/i.test(text)) {
    connectionState = 'Сервер требует регистрацию';
    if (config.authMode === 'register') sendStoredAuth('register');
    return;
  }

  if (/\/login|авториз|войдите|выполните вход/i.test(text)) {
    connectionState = 'Сервер требует вход';
    if (config.authMode === 'login') sendStoredAuth('login');
    return;
  }

  if (/успешно.*(?:вош|авториз|зарегистр)|авторизац.*успеш|регистрац.*успеш|добро пожаловать|вы вошли/i.test(text)) {
    connectionState = 'Авторизован / в лобби';
  }
}

function scheduleReconnect() {
  if (!reconnectEnabled || reconnectTimer) return;
  connectionState = 'Переподключение через 10 секунд';

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectMinecraft();
  }, 10000);
}

function connectMinecraft() {
  if (minecraft) return false;
  if (!config.host || !config.username) return false;

  reconnectEnabled = true;
  connectionState = 'Подключение';
  currentWindowSummary = null;
  systemMessages = [];
  recentlyForwarded.clear();
  lastAuthSentAt = 0;
  resetCaptchaState();

  const options = {
    host: config.host,
    port: Number(config.port || 25565),
    username: config.username,
    auth: 'offline',
    hideErrors: false
  };
  if (config.version) options.version = config.version;

  const current = mineflayer.createBot(options);
  minecraft = current;
  mapCapture.attach(current);

  current.once('login', () => {
    connectionState = 'Соединение установлено, жду сервер';
    notify(`🔌 Подключился к ${config.host}:${config.port}. Жду системные сообщения.`);
  });

  current.on('spawn', () => {
    connectionState = 'Мир загружен, жду указания сервера';
    notify(`✅ Мир загружен под ником ${config.username}. Это ещё не означает, что вход или регистрация завершены.`);
  });

  current.on('messagestr', (message, messagePosition, jsonMsg, sender) => {
    const text = cleanText(message);
    if (!text) return;

    if (isPlayerChatMessage(text, messagePosition, jsonMsg, sender)) {
      console.log('[PLAYER CHAT]', text);
      return;
    }

    console.log('[SYSTEM]', text);
    forwardSystemMessage(text, 'Minecraft');
    inspectSystemInstruction(text);
  });

  current.on('title', (title, type) => {
    const text = componentText(title);
    if (text) forwardSystemMessage(text, type ? `Заголовок ${type}` : 'Заголовок');
  });

  current.on('actionBar', jsonMsg => {
    const text = componentText(jsonMsg);
    if (text) forwardSystemMessage(text, 'ActionBar');
  });

  current.on('windowOpen', window => {
    currentWindowSummary = {
      title: windowTitle(window),
      items: windowItems(window)
    };

    const details = currentWindowSummary.items.length
      ? `\n${currentWindowSummary.items.join('\n')}`
      : '\nВ меню пока нет видимых предметов.';

    forwardSystemMessage(
      `Открыто меню: ${currentWindowSummary.title}${details}`,
      'Интерфейс'
    );
  });

  current.on('windowClose', () => {
    if (currentWindowSummary) {
      forwardSystemMessage(`Закрыто меню: ${currentWindowSummary.title}`, 'Интерфейс');
    }
    currentWindowSummary = null;
  });

  current.on('death', () => {
    connectionState = 'Умер, ожидает возрождение';
    notify('☠️ Бот умер.');
  });

  current.on('kicked', reason => {
    notify(`🚫 Бота кикнуло:\n${safeReason(reason)}`);
  });

  current.on('error', error => {
    console.error('Minecraft error:', error);
    notify(`⚠️ Ошибка Minecraft:\n${cleanText(error.message)}`);
  });

  current.on('end', reason => {
    const text = safeReason(reason);
    connectionState = `Отключён: ${text}`;
    if (minecraft === current) minecraft = null;
    mapCapture.detach();
    currentWindowSummary = null;
    resetCaptchaState();
    notify(`🔌 Minecraft отключён:\n${text}`);
    scheduleReconnect();
  });

  return true;
}

function disconnectMinecraft(manual = true) {
  if (manual) reconnectEnabled = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  resetCaptchaState();

  if (!minecraft) {
    connectionState = 'Отключён';
    return;
  }

  const current = minecraft;
  minecraft = null;
  connectionState = 'Отключён вручную';
  currentWindowSummary = null;
  mapCapture.detach();
  try { current.quit('Отключение через Telegram'); } catch {}
}

function reconnectMinecraft() {
  reconnectEnabled = true;
  resetCaptchaState();

  if (minecraft) {
    const current = minecraft;
    minecraft = null;
    mapCapture.detach();
    try { current.quit('Переподключение'); } catch {}
  }

  setTimeout(connectMinecraft, 1500);
}

async function showMain(ctx, text = '🤖 Управление Minecraft-ботом') {
  await ctx.reply(text, mainKeyboard);
}

async function sendToMinecraft(ctx, text) {
  if (!minecraft) return ctx.reply('Minecraft сейчас не подключён.', mainKeyboard);
  minecraft.chat(text);
  return ctx.reply(`📤 Отправлено в Minecraft: ${text}`, mainKeyboard);
}

telegram.use(async (ctx, next) => {
  if (String(ctx.from?.id || '') !== ADMIN_ID) {
    if (ctx.chat) await ctx.reply('⛔ Нет доступа.');
    return;
  }
  return next();
});

telegram.start(ctx => showMain(ctx));
telegram.command('menu', ctx => showMain(ctx));
telegram.command('status', ctx => ctx.reply(worldStateText(), mainKeyboard));
telegram.command('screen', ctx => ctx.reply(worldStateText(), mainKeyboard));
telegram.command('connect', ctx => {
  const started = connectMinecraft();
  return ctx.reply(started ? '🔄 Подключаюсь...' : 'Бот уже подключён или не заданы сервер/ник.', mainKeyboard);
});
telegram.command('disconnect', ctx => {
  disconnectMinecraft(true);
  return ctx.reply('⏹ Бот отключён.', mainKeyboard);
});
telegram.command('reconnect', ctx => {
  reconnectMinecraft();
  return ctx.reply('🔄 Переподключаюсь...', mainKeyboard);
});

telegram.hears('▶️ Подключить', ctx => {
  pendingAction = null;
  if (minecraft) return ctx.reply('Бот уже подключается или находится в игре.', mainKeyboard);
  if (!config.host) return ctx.reply('Сначала нажми «⚙️ Сервер» и задай адрес.', mainKeyboard);
  if (!config.username) return ctx.reply('Сначала нажми «👤 Ник» и задай ник.', mainKeyboard);
  return ctx.reply(connectMinecraft() ? '🔄 Подключаюсь...' : 'Не удалось начать подключение.', mainKeyboard);
});

telegram.hears('⏹ Отключить', ctx => {
  pendingAction = null;
  disconnectMinecraft(true);
  return ctx.reply('⏹ Бот отключён. Автопереподключение выключено.', mainKeyboard);
});

telegram.hears('📊 Что происходит', ctx => ctx.reply(worldStateText(), mainKeyboard));

telegram.hears('🔄 Перезайти', ctx => {
  pendingAction = null;
  if (!config.host || !config.username) return ctx.reply('Сначала задай сервер и ник.', mainKeyboard);
  reconnectMinecraft();
  return ctx.reply('🔄 Переподключаюсь с текущими настройками.', mainKeyboard);
});

telegram.hears('⚙️ Сервер', ctx => {
  pendingAction = 'server';
  return ctx.reply('Отправь адрес сервера: play.funtime.su или play.funtime.su:25565', mainKeyboard);
});

telegram.hears('👤 Ник', ctx => {
  pendingAction = 'username';
  return ctx.reply('Отправь новый ник Minecraft.', mainKeyboard);
});

telegram.hears('🔐 Пароль', ctx => {
  pendingAction = 'password';
  return ctx.reply('Отправь новый пароль. Сообщение будет удалено после сохранения.', mainKeyboard);
});

telegram.hears('📝 Авторизация', ctx => {
  pendingAction = null;
  return ctx.reply(`Текущий режим: ${authModeLabel()}\nВыбери режим:`, authKeyboard);
});

telegram.action('auth_login', async ctx => {
  config.authMode = 'login';
  saveConfig();
  await ctx.answerCbQuery('Выбран /login');
  await ctx.editMessageText('✅ При запросе входа бот сам отправит /login пароль.');
  await showMain(ctx, 'Режим /login сохранён.');
});

telegram.action('auth_register', async ctx => {
  config.authMode = 'register';
  saveConfig();
  await ctx.answerCbQuery('Выбран /register');
  await ctx.editMessageText('✅ При запросе регистрации бот сам отправит /register пароль пароль.');
  await showMain(ctx, 'Режим /register сохранён.');
});

telegram.action('auth_manual', async ctx => {
  config.authMode = 'manual';
  saveConfig();
  await ctx.answerCbQuery('Ручной режим');
  await ctx.editMessageText('✅ Автоматическая авторизация выключена. Любую команду можно писать прямо в чат Telegram.');
  await showMain(ctx, 'Ручной режим сохранён.');
});

telegram.hears('💬 Написать в чат', ctx => {
  pendingAction = 'chat';
  return ctx.reply('Отправь текст или команду. Вообще-то теперь можно писать их сразу, без этой кнопки.', mainKeyboard);
});

telegram.hears('🗺 Капча / карта', ctx => {
  pendingAction = null;
  return sendCaptchaMap(ctx, false);
});

telegram.hears('📋 Системные сообщения', ctx => {
  pendingAction = null;
  const latest = systemMessages.slice(-30);
  if (!latest.length) return ctx.reply('Системных сообщений пока нет.', mainKeyboard);

  const text = latest.map((entry, index) => `${index + 1}. ${entry.text}`).join('\n').slice(0, 3900);
  return ctx.reply(`📋 Последние системные сообщения:\n\n${text}`, mainKeyboard);
});

telegram.hears('❌ Отмена', ctx => {
  pendingAction = null;
  return ctx.reply('Действие отменено.', mainKeyboard);
});

telegram.on('text', async ctx => {
  const text = String(ctx.message?.text || '').trim();
  if (!text) return;

  if (!pendingAction && captchaActive && /^\d{1,12}$/.test(text)) {
    if (!minecraft) return ctx.reply('Minecraft сейчас не подключён.', mainKeyboard);
    minecraft.chat(text);
    captchaActive = false;
    connectionState = 'Ответ капчи отправлен, жду сервер';
    return ctx.reply('📤 Ответ капчи отправлен. Теперь системные сообщения сервера придут сюда.', mainKeyboard);
  }

  if (!pendingAction) {
    return sendToMinecraft(ctx, text);
  }

  const action = pendingAction;
  pendingAction = null;

  if (action === 'server') {
    const value = text.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    const lastColon = value.lastIndexOf(':');
    let host = value;
    let port = 25565;

    if (lastColon > 0 && /^\d+$/.test(value.slice(lastColon + 1))) {
      host = value.slice(0, lastColon);
      port = Number(value.slice(lastColon + 1));
    }

    if (!host || port < 1 || port > 65535) return ctx.reply('Некорректный адрес или порт.', mainKeyboard);
    config.host = host;
    config.port = port;
    saveConfig();
    return ctx.reply(`✅ Сервер сохранён: ${host}:${port}\nНажми «🔄 Перезайти», чтобы применить.`, mainKeyboard);
  }

  if (action === 'username') {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(text)) {
      return ctx.reply('Ник должен содержать 3–16 символов: английские буквы, цифры и _.', mainKeyboard);
    }
    config.username = text;
    saveConfig();
    return ctx.reply(`✅ Ник сохранён: ${text}\nНажми «🔄 Перезайти», чтобы применить.`, mainKeyboard);
  }

  if (action === 'password') {
    if (text.length < 3 || text.length > 100) return ctx.reply('Пароль слишком короткий или длинный.', mainKeyboard);
    config.password = text;
    saveConfig();
    try { await ctx.deleteMessage(); } catch {}
    return ctx.reply('✅ Пароль сохранён. Сообщение с паролем удалено.', mainKeyboard);
  }

  if (action === 'chat') return sendToMinecraft(ctx, text);
});

telegram.catch(error => {
  console.error('Telegram handler error:', error);
});

async function shutdown(signal) {
  reconnectEnabled = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  resetCaptchaState();
  mapCapture.detach();

  if (minecraft) {
    try { minecraft.quit('Перезапуск процесса'); } catch {}
  }

  telegram.stop(signal);
  setTimeout(() => process.exit(0), 500);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

telegram.launch().catch(error => {
  console.error('Не удалось запустить Telegram:', error);
  process.exit(1);
});

console.log('Telegram-бот запущен. Minecraft ждёт команды из Telegram.');
