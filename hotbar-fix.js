'use strict';

// Загружается через NODE_OPTIONS до bot.js и аккуратно оборачивает createBot.
// Некоторые Bukkit/Spigot-серверы отправляют lobby-предметы через windowId -2,
// где slot 0..8 означает номер ячейки хотбара, а не слот окна inventory.

const mineflayer = require('mineflayer');
const originalCreateBot = mineflayer.createBot.bind(mineflayer);

function normalizeWindowId(value) {
  const number = Number(value);
  if (number === 254) return -2;
  if (number === 255) return -1;
  return number;
}

function parseJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !/^[\[{]/.test(text)) return value;

  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function flattenMinecraftText(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 12) return '';

  const parsed = parseJson(value);
  if (parsed !== value) return flattenMinecraftText(parsed, depth + 1, seen);

  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(part => flattenMinecraftText(part, depth + 1, seen)).join('');
  }
  if (typeof value !== 'object' || seen.has(value)) return '';

  seen.add(value);
  let result = typeof value.text === 'string' ? value.text : '';

  for (const key of ['extra', 'with', 'siblings']) {
    if (Array.isArray(value[key])) {
      result += value[key]
        .map(part => flattenMinecraftText(part, depth + 1, seen))
        .join('');
    }
  }

  if (!result && typeof value.value === 'string') result = value.value;
  return result;
}

function plainMinecraftText(value) {
  return flattenMinecraftText(value)
    .replace(/\u00a7[0-9A-FK-OR]/gi, '')
    .replace(/[\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeItemName(item) {
  if (!item) return;

  try {
    const rawName = item.customName;
    const plainName = plainMinecraftText(rawName);

    if (plainName && plainName !== rawName) {
      item.customName = plainName;
    }
  } catch (error) {
    console.error('[item-name] Не удалось очистить название предмета:', error.message);
  }
}

function normalizeSlots(slots) {
  if (!Array.isArray(slots)) return;
  for (const item of slots) normalizeItemName(item);
}

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
      // Фикс хотбара никогда не должен ломать подключение или Telegram.
      console.error('[hotbar-fix] Ошибка применения lobby-предмета:', error.message);
    }
  });

  if (bot.inventory?.on) {
    bot.inventory.on('updateSlot', () => normalizeSlots(bot.inventory?.slots));
  }

  bot.on('windowOpen', window => {
    normalizeSlots(window?.slots);

    if (window?.on) {
      window.on('updateSlot', () => normalizeSlots(window.slots));
    }
  });

  return bot;
};
