'use strict';

// Загружается через NODE_OPTIONS до bot.js.
// Исправляет lobby-hotbar FunTime и делает Telegram-меню читаемым.

const mineflayer = require('mineflayer');
const originalCreateBot = mineflayer.createBot.bind(mineflayer);

function normalizeWindowId(value) {
  const number = Number(value);
  if (number === 254) return -2;
  if (number === 255) return -1;
  return number;
}

function cleanPlainText(value) {
  return String(value ?? '')
    .replace(/\u00a7[0-9A-FK-OR]/gi, '')
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJsonString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || !/^[\[{]/.test(text)) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Для JSON-компонентов берём ТОЛЬКО поля text, рекурсивно.
// color, bold, translate, value и любая другая обвязка игнорируются.
function textFieldsOnly(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 16) return '';

  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    return parsed == null ? cleanPlainText(value) : textFieldsOnly(parsed, depth + 1, seen);
  }

  if (Array.isArray(value)) {
    return cleanPlainText(value.map(part => textFieldsOnly(part, depth + 1, seen)).join(''));
  }

  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  let result = '';
  if (typeof value.text === 'string') result += value.text;

  for (const [key, child] of Object.entries(value)) {
    if (key === 'text') continue;
    if (child && (typeof child === 'object' || Array.isArray(child))) {
      result += textFieldsOnly(child, depth + 1, seen);
    }
  }

  return cleanPlainText(result);
}

function readableItemName(item) {
  if (!item) return '';

  const custom = textFieldsOnly(item.customName);
  if (custom) return custom;

  // Обычные названия Mineflayer не являются JSON-компонентами.
  return cleanPlainText(item.displayName || item.name || 'предмет');
}

function normalizeItemName(item) {
  if (!item) return;

  try {
    const plainName = textFieldsOnly(item.customName);
    if (plainName && plainName !== item.customName) item.customName = plainName;
  } catch (error) {
    console.error('[item-name] Не удалось очистить название предмета:', error.message);
  }
}

function normalizeSlots(slots) {
  if (!Array.isArray(slots)) return;
  for (const item of slots) normalizeItemName(item);
}

function isDecorativeItem(item, name) {
  const normalized = cleanPlainText(name).toLowerCase();
  const technicalName = String(item?.name || '').toLowerCase();

  if (!normalized) return true;
  if (/^funtime(?:\.su)?[.!]*$/i.test(normalized)) return true;
  if (/^(?:пусто|empty)$/i.test(normalized)) return true;
  if (/stained_glass_pane|glass_pane/.test(technicalName) && /funtime|пуст/i.test(normalized)) return true;
  return false;
}

function patchInventoryController() {
  try {
    const { InventoryController } = require('./inventory-controller');
    const prototype = InventoryController?.prototype;
    if (!prototype || prototype.__compactTelegramMenus) return;
    prototype.__compactTelegramMenus = true;

    prototype.windowTitle = function windowTitle(window) {
      const title = textFieldsOnly(window?.title);
      if (title) return title;
      return cleanPlainText(window?.type) || 'Меню';
    };

    prototype.describeWindow = function describeWindow(window = this.bot?.currentWindow || this.currentWindow) {
      if (!window) return this.describeHotbar();

      const title = this.windowTitle(window);
      const slotLimit = Number.isInteger(window.inventoryStart)
        ? window.inventoryStart
        : Math.min(window.slots?.length || 0, 54);

      const rows = new Map();
      let usefulCount = 0;

      for (let slot = 0; slot < slotLimit; slot += 1) {
        const item = window.slots?.[slot];
        if (!item) continue;

        const name = readableItemName(item);
        if (isDecorativeItem(item, name)) continue;

        usefulCount += 1;
        const row = Math.floor(slot / 9) + 1;
        const count = Number(item.count || 0) > 1 ? ` ×${item.count}` : '';
        const line = `[${slot}] ${name}${count}`;

        if (!rows.has(row)) rows.set(row, []);
        rows.get(row).push(line);
      }

      const lines = [
        `🎒 ${title}`,
        `Окно: ${window.id ?? '?'} | доступных пунктов: ${usefulCount}`
      ];

      if (!usefulCount) {
        lines.push('', 'Полезных пунктов в меню не найдено.');
      } else {
        for (const [row, entries] of rows) {
          lines.push('', `Ряд ${row}:`, ...entries);
        }
      }

      lines.push('', 'Нажатие: слот 14 | пкм слот 20 | закрыть меню');
      return lines.join('\n').slice(0, 3900);
    };

    prototype.describeHotbar = function describeHotbar() {
      const items = this.hotbarItems();
      const lines = ['🎒 Хотбар:'];
      let usefulCount = 0;

      for (let index = 0; index < 9; index += 1) {
        const item = items[index];
        if (!item) continue;

        const name = readableItemName(item);
        if (isDecorativeItem(item, name)) continue;

        usefulCount += 1;
        const selected = Number(this.bot?.quickBarSlot) === index ? ' ← выбран' : '';
        const count = Number(item.count || 0) > 1 ? ` ×${item.count}` : '';
        lines.push(`[${index + 1}] ${name}${count}${selected}`);
      }

      if (!usefulCount) {
        lines.push('Пусто.');
        lines.push(
          '',
          `Диагностика: пакетов=${this.inventoryPackets}, применено=${this.appliedLobbyPackets}, ошибок=${this.inventoryErrors}.`
        );
        if (this.packetSamples?.length) lines.push(...this.packetSamples.map(value => `• ${value}`));
      }

      lines.push('', 'Команды: слот 5 | пкм | лкм | меню');
      return lines.join('\n').slice(0, 3900);
    };
  } catch (error) {
    console.error('[menu-format] Не удалось включить компактное меню:', error.message);
  }
}

patchInventoryController();

mineflayer.createBot = function createBotWithLobbyHotbarFix(options) {
  const bot = originalCreateBot(options);

  let Item = null;
  try {
    Item = require('prismarine-item')(bot.registry || options?.version || bot.version);
  } catch (error) {
    console.error('[hotbar-fix] Не удалось загрузить prismarine-item:', error.message);
  }

  bot._client.on('set_slot', packet => {
    try {
      const windowId = normalizeWindowId(packet.windowId);
      const lobbySlot = Number(packet.slot);

      if (windowId !== -2 || !Number.isInteger(lobbySlot) || lobbySlot < 0 || lobbySlot > 8) return;
      if (!Item || !bot.inventory) return;

      const item = Item.fromNotch(packet.item);
      normalizeItemName(item);

      const hotbarStart = Number(bot.QUICK_BAR_START ?? bot.inventory.hotbarStart ?? 36);
      const targetSlot = hotbarStart + lobbySlot;

      if (typeof bot._setSlot === 'function') {
        bot._setSlot(targetSlot, item, bot.inventory);
      } else {
        bot.inventory.updateSlot(targetSlot, item);
        bot.updateHeldItem?.();
      }

      console.log(`[hotbar-fix] set_slot -2:${lobbySlot} -> inventory:${targetSlot}`);
    } catch (error) {
      console.error('[hotbar-fix] Ошибка применения lobby-предмета:', error.message);
    }
  });

  // Сервер часто открывает следующее меню, но не подтверждает старую транзакцию.
  // Если окно уже сменилось или закрылось, считаем клик успешным и не пугаем пользователя.
  const originalClickWindow = bot.clickWindow.bind(bot);
  bot.clickWindow = async function clickWindowWithoutFalseTimeout(slot, mouseButton, mode) {
    const previousWindow = bot.currentWindow;

    try {
      return await originalClickWindow(slot, mouseButton, mode);
    } catch (error) {
      const windowChanged = bot.currentWindow !== previousWindow || !bot.currentWindow;
      const transactionTimeout = /didn'?t respond to transaction|transaction.*timeout/i.test(String(error?.message || ''));

      if (windowChanged && transactionTimeout) {
        console.log('[menu-click] Сервер сменил окно без подтверждения старой транзакции.');
        return undefined;
      }

      throw error;
    }
  };

  if (bot.inventory?.on) {
    bot.inventory.on('updateSlot', () => normalizeSlots(bot.inventory?.slots));
  }

  bot.on('windowOpen', window => {
    normalizeSlots(window?.slots);

    try {
      const plainTitle = textFieldsOnly(window?.title);
      if (plainTitle) window.title = plainTitle;
    } catch {}

    if (window?.on) {
      window.on('updateSlot', () => normalizeSlots(window.slots));
    }
  });

  return bot;
};
