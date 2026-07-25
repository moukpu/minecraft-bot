'use strict';

require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { Telegraf, Markup } = require('telegraf');
const { ScreenService } = require('./screen-service');
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
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { ...defaultConfig, ...saved };
  } catch (error) {
    console.error('Не удалось прочитать config.json:', error.message);
    return { ...defaultConfig };
  }
}

let config = loadConfig();

function saveConfig() {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });

  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {}
}

const telegram = new Telegraf(TELEGRAM_TOKEN);
let minecraft = null;
let connectionState = 'Отключён';
let reconnectTimer = null;
let reconnectEnabled = false;
let pendingAction = null;
let lastMessages = [];
let screenBusy = false;

const mainKeyboard = Markup.keyboard([
  ['▶️ Подключить', '⏹ Отключить'],
  ['📊 Статус', '🔄 Перезайти'],
  ['⚙️ Сервер', '👤 Ник'],
  ['🔐 Пароль', '📝 Авторизация'],
  ['💬 Написать в чат', '📸 Экран'],
  ['🗺 Последняя карта', '📋 Логи'],
  ['❌ Отмена']
]).resize().persistent();

const authKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('🔐 /login', 'auth_login'),
    Markup.button.callback('🆕 /register', 'auth_register')
  ],
  [Markup.button.callback('✋ Вручную', 'auth_manual')]
]);

const screenService = new ScreenService();
const mapCapture = new MapCapture(async (image, mapId) => {
  try {
    await telegram.telegram.sendPhoto(
      ADMIN_ID,
      { source: image, filename: `map-${mapId}.png` },
      {
        caption: '🧩 Получена карта. Если это капча, нажми «💬 Написать в чат» и отправь цифры.',
        reply_markup: mainKeyboard.reply_markup
      }
    );
  } catch (error) {
    console.error('Не удалось отправить карту в Telegram:', error.message);
  }
});

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

function remember(message) {
  const text = cleanText(message);
  if (!text) return;
  lastMessages.push(text);
  if (lastMessages.length > 50) lastMessages.shift();
}

function authModeLabel() {
  if (config.authMode === 'login') return '/login';
  if (config.authMode === 'register') return '/register';
  return 'вручную';
}

function statusText() {
  const lines = [
    minecraft ? '🟢 Minecraft запущен' : '🔴 Minecraft отключён',
    `Состояние: ${connectionState}`,
    `Сервер: ${config.host || 'не задан'}:${config.port}`,
    `Ник: ${config.username || 'не задан'}`,
    `Версия: ${config.version || 'авто'}`,
    `Авторизация: ${authModeLabel()}`
  ];

  if (minecraft?.entity?.position) {
    const p = minecraft.entity.position;
    lines.push(`Координаты: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
    lines.push(`Здоровье: ${minecraft.health ?? '?'}`);
    lines.push(`Голод: ${minecraft.food ?? '?'}`);
  }

  return lines.join('\n');
}

function screenData() {
  const hotbar = Array.from({ length: 9 }, (_, index) => {
    const item = minecraft?.inventory?.slots?.[36 + index];
    if (!item) return '';

    const title = cleanText(item.displayName || item.name || 'предмет');
    return item.count > 1 ? `${title}\nx${item.count}` : title;
  });

  const currentWindow = minecraft?.currentWindow;
  let windowTitle = '';

  if (currentWindow?.title) {
    try {
      windowTitle = cleanText(currentWindow.title.toString());
    } catch {
      windowTitle = cleanText(currentWindow.title);
    }
  }

  const position = minecraft?.entity?.position;
  const coordinates = position
    ? `${position.x.toFixed(1)} ${position.y.toFixed(1)} ${position.z.toFixed(1)}`
    : '? ? ?';

  return {
    status: [
      `${config.host}:${config.port}`,
      `Ник: ${config.username}`,
      `HP: ${minecraft?.health ?? '?'} | Еда: ${minecraft?.food ?? '?'}`,
      `XYZ: ${coordinates}`
    ].join('\n'),
    messages: lastMessages.slice(-8),
    hotbar,
    selectedSlot: Number(minecraft?.quickBarSlot || 0),
    windowTitle
  };
}

async function sendScreen(ctx) {
  pendingAction = null;

  if (!minecraft?.entity) {
    return ctx.reply('Minecraft сейчас не находится в мире.', mainKeyboard);
  }

  if (screenBusy) {
    return ctx.reply('📸 Скрин уже создаётся. Подожди несколько секунд.', mainKeyboard);
  }

  screenBusy = true;

  try {
    await ctx.sendChatAction('upload_photo');
    const image = await screenService.capture(screenData());

    return await ctx.replyWithPhoto(
      { source: image, filename: 'minecraft-screen.png' },
      {
        caption: `📸 ${config.host}:${config.port} | ${config.username}`,
        reply_markup: mainKeyboard.reply_markup
      }
    );
  } catch (error) {
    console.error('Ошибка создания скрина:', error);
    return ctx.reply(
      `⚠️ Скрин не получился: ${cleanText(error.message)}\nБот остаётся подключён, можно попробовать ещё раз через несколько секунд.`,
      mainKeyboard
    );
  } finally {
    screenBusy = false;
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

function authCommand() {
  if (!config.password) return null;
  if (config.authMode === 'login') return `/login ${config.password}`;
  if (config.authMode === 'register') return `/register ${config.password} ${config.password}`;
  return null;
}

function connectMinecraft() {
  if (minecraft) return false;
  if (!config.host || !config.username) return false;

  reconnectEnabled = true;
  connectionState = 'Подключение';

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
    connectionState = 'Подключён, загружается мир';
    notify(`🔌 Подключился к ${config.host}:${config.port}`);
  });

  current.on('spawn', () => {
    connectionState = 'В игре';
    notify(`✅ Бот появился в мире под ником ${config.username}`);

    screenService.attach(current).catch(error => {
      console.error('Viewer attach error:', error);
    });

    const command = authCommand();
    if (command) {
      setTimeout(() => {
        if (minecraft === current) current.chat(command);
      }, 2500);
    }
  });

  current.on('messagestr', message => {
    const text = cleanText(message);
    if (!text) return;

    remember(text);
    console.log('[MC]', text);

    if (/капч|captcha|введите код|картинк|проверочн/i.test(text)) {
      notify(`🧩 Сервер просит капчу:\n${text}\nКарта придёт отдельной картинкой, если сервер прислал её боту.`);
    }
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
    screenService.detachViewer().catch(() => {});

    notify(`🔌 Minecraft отключён:\n${text}`);
    scheduleReconnect();
  });

  return true;
}

function disconnectMinecraft(manual = true) {
  if (manual) reconnectEnabled = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;

  if (!minecraft) {
    connectionState = 'Отключён';
    return;
  }

  const current = minecraft;
  minecraft = null;
  connectionState = 'Отключён вручную';
  mapCapture.detach();
  screenService.detachViewer().catch(() => {});

  try {
    current.quit('Отключение через Telegram');
  } catch {}
}

function reconnectMinecraft() {
  reconnectEnabled = true;

  if (minecraft) {
    const current = minecraft;
    minecraft = null;
    mapCapture.detach();
    screenService.detachViewer().catch(() => {});

    try {
      current.quit('Переподключение');
    } catch {}
  }

  setTimeout(connectMinecraft, 1500);
}

async function showMain(ctx, text = '🤖 Управление Minecraft-ботом') {
  await ctx.reply(text, mainKeyboard);
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
telegram.command('status', ctx => ctx.reply(statusText(), mainKeyboard));
telegram.command('screen', ctx => sendScreen(ctx));

telegram.hears('▶️ Подключить', async ctx => {
  pendingAction = null;

  if (minecraft) return ctx.reply('Бот уже подключается или находится в игре.', mainKeyboard);
  if (!config.host) return ctx.reply('Сначала нажми «⚙️ Сервер» и задай адрес.', mainKeyboard);
  if (!config.username) return ctx.reply('Сначала нажми «👤 Ник» и задай ник.', mainKeyboard);

  const started = connectMinecraft();
  return ctx.reply(started ? '🔄 Подключаюсь...' : 'Не удалось начать подключение.', mainKeyboard);
});

telegram.hears('⏹ Отключить', ctx => {
  pendingAction = null;
  disconnectMinecraft(true);
  return ctx.reply('⏹ Бот отключён. Автопереподключение выключено.', mainKeyboard);
});

telegram.hears('📊 Статус', ctx => ctx.reply(statusText(), mainKeyboard));

telegram.hears('🔄 Перезайти', ctx => {
  pendingAction = null;

  if (!config.host || !config.username) {
    return ctx.reply('Сначала задай сервер и ник.', mainKeyboard);
  }

  reconnectMinecraft();
  return ctx.reply('🔄 Переподключаюсь с текущими настройками.', mainKeyboard);
});

telegram.hears('⚙️ Сервер', ctx => {
  pendingAction = 'server';
  return ctx.reply(
    'Отправь адрес сервера. Можно так:\nplay.funtime.su\nили так:\nplay.funtime.su:25565',
    mainKeyboard
  );
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
  return ctx.reply(
    `Текущий режим: ${authModeLabel()}\nВыбери, что отправлять после входа:`,
    authKeyboard
  );
});

telegram.action('auth_login', async ctx => {
  config.authMode = 'login';
  saveConfig();
  await ctx.answerCbQuery('Выбран /login');
  await ctx.editMessageText('✅ После входа бот отправит /login пароль.');
  await showMain(ctx, 'Режим авторизации сохранён.');
});

telegram.action('auth_register', async ctx => {
  config.authMode = 'register';
  saveConfig();
  await ctx.answerCbQuery('Выбран /register');
  await ctx.editMessageText('✅ После входа бот отправит /register пароль пароль.');
  await showMain(ctx, 'Режим регистрации сохранён.');
});

telegram.action('auth_manual', async ctx => {
  config.authMode = 'manual';
  saveConfig();
  await ctx.answerCbQuery('Ручной режим');
  await ctx.editMessageText('✅ Автоматическая авторизация выключена.');
  await showMain(ctx, 'Команды входа отправляй через кнопку чата.');
});

telegram.hears('💬 Написать в чат', ctx => {
  pendingAction = 'chat';
  return ctx.reply('Отправь текст или команду для Minecraft.', mainKeyboard);
});

telegram.hears('📸 Экран', ctx => sendScreen(ctx));

telegram.hears('🗺 Последняя карта', ctx => {
  pendingAction = null;

  if (!mapCapture.lastImage) {
    return ctx.reply('Карта ещё не была получена от сервера.', mainKeyboard);
  }

  return ctx.replyWithPhoto(
    { source: mapCapture.lastImage, filename: 'last-map.png' },
    {
      caption: '🗺 Последняя карта, полученная ботом.',
      reply_markup: mainKeyboard.reply_markup
    }
  );
});

telegram.hears('📋 Логи', ctx => {
  pendingAction = null;

  if (!lastMessages.length) {
    return ctx.reply('Сообщений сервера пока нет.', mainKeyboard);
  }

  const text = lastMessages
    .slice(-20)
    .map((message, index) => `${index + 1}. ${message}`)
    .join('\n')
    .slice(0, 3900);

  return ctx.reply(`📋 Последние сообщения:\n\n${text}`, mainKeyboard);
});

telegram.hears('❌ Отмена', ctx => {
  pendingAction = null;
  return ctx.reply('Действие отменено.', mainKeyboard);
});

telegram.on('text', async ctx => {
  const text = String(ctx.message?.text || '').trim();
  if (!text || text.startsWith('/')) return;

  if (!pendingAction) {
    return ctx.reply('Используй кнопки меню.', mainKeyboard);
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

    if (!host || port < 1 || port > 65535) {
      return ctx.reply('Некорректный адрес или порт.', mainKeyboard);
    }

    config.host = host;
    config.port = port;
    saveConfig();

    return ctx.reply(
      `✅ Сервер сохранён: ${host}:${port}\nНажми «🔄 Перезайти», чтобы применить.`,
      mainKeyboard
    );
  }

  if (action === 'username') {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(text)) {
      return ctx.reply(
        'Ник должен содержать 3–16 символов: английские буквы, цифры и _.',
        mainKeyboard
      );
    }

    config.username = text;
    saveConfig();

    return ctx.reply(
      `✅ Ник сохранён: ${text}\nНажми «🔄 Перезайти», чтобы применить.`,
      mainKeyboard
    );
  }

  if (action === 'password') {
    if (text.length < 3 || text.length > 100) {
      return ctx.reply('Пароль слишком короткий или длинный.', mainKeyboard);
    }

    config.password = text;
    saveConfig();

    try {
      await ctx.deleteMessage();
    } catch {}

    return ctx.reply('✅ Пароль сохранён. Сообщение с паролем удалено.', mainKeyboard);
  }

  if (action === 'chat') {
    if (!minecraft) return ctx.reply('Minecraft сейчас не подключён.', mainKeyboard);
    minecraft.chat(text);
    return ctx.reply('📤 Отправлено в Minecraft.', mainKeyboard);
  }
});

telegram.catch(error => {
  console.error('Telegram handler error:', error);
});

async function shutdown(signal) {
  reconnectEnabled = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  mapCapture.detach();

  if (minecraft) {
    try {
      minecraft.quit('Перезапуск процесса');
    } catch {}
  }

  await screenService.close().catch(() => {});
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
