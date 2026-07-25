'use strict';

const mineflayer = require('mineflayer');
const originalCreateBot = mineflayer.createBot.bind(mineflayer);

function normalizeWindowId(value) {
  const number = Number(value);
  if (number === 254) return -2;
  if (number === 255) return -1;
  return number;
}

function cleanText(value) {
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
  try { return JSON.parse(text); } catch { return null; }
}

function textFieldsOnly(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 16) return '';
  if (typeof value === 'string') {
    const parsed = parseJsonString(value);
    return parsed == null ? cleanText(value) : textFieldsOnly(parsed, depth + 1, seen);
  }
  if (Array.isArray(value)) {
    return cleanText(value.map(part => textFieldsOnly(part, depth + 1, seen)).join(''));
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  try {
    if (typeof value.toJSON === 'function') {
      const json = value.toJSON();
      if (json && json !== value) {
        const rendered = textFieldsOnly(json, depth + 1, seen);
        if (rendered) return rendered;
      }
    }
  } catch {}

  let result = typeof value.text === 'string' ? value.text : '';
  for (const [key, child] of Object.entries(value)) {
    if (key === 'text') continue;
    if (child && (Array.isArray(child) || typeof child === 'object')) {
      result += textFieldsOnly(child, depth + 1, seen);
    }
  }
  return cleanText(result);
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

function funtimeVersion(version) {
  return /^1\.21\.(?:4|5|6|7|8|9|10|11)$/.test(String(version || ''));
}

mineflayer.createBot = function createBotWithFunTimeFixes(options = {}) {
  const effectiveOptions = { ...options };
  const host = String(effectiveOptions.host || '');

  if (/funtime/i.test(host) && !funtimeVersion(effectiveOptions.version)) {
    effectiveOptions.version = '1.21.4';
    console.log(`[version-fix] FunTime: ${options.version || 'auto'} -> ${effectiveOptions.version}`);
  }

  const bot = originalCreateBot(effectiveOptions);
  bot.__effectiveVersion = effectiveOptions.version || 'auto';

  let Item = null;
  try {
    Item = require('prismarine-item')(bot.registry || effectiveOptions.version || bot.version);
  } catch (error) {
    console.error('[hotbar-fix] Не удалось загрузить prismarine-item:', error.message);
  }

  function applyInventorySlot(slot, rawItem) {
    if (!Item || !bot.inventory || !Number.isInteger(slot) || slot < 0) return;

    try {
      const item = Item.fromNotch(rawItem);
      normalizeItemName(item);

      if (typeof bot._setSlot === 'function') bot._setSlot(slot, item, bot.inventory);
      else {
        bot.inventory.updateSlot(slot, item);
        bot.updateHeldItem?.();
      }
    } catch (error) {
      console.error(`[inventory-fix] Не удалось применить слот ${slot}:`, error.message);
    }
  }

  bot._client.on('set_slot', packet => {
    try {
      const windowId = normalizeWindowId(packet.windowId);
      const lobbySlot = Number(packet.slot);
      if (windowId !== -2 || !Number.isInteger(lobbySlot) || lobbySlot < 0 || lobbySlot > 8) return;

      const hotbarStart = Number(bot.QUICK_BAR_START ?? bot.inventory?.hotbarStart ?? 36);
      const targetSlot = hotbarStart + lobbySlot;
      applyInventorySlot(targetSlot, packet.item);
      console.log(`[hotbar-fix] set_slot -2:${lobbySlot} -> inventory:${targetSlot}`);
    } catch (error) {
      console.error('[hotbar-fix] Ошибка применения lobby-предмета:', error.message);
    }
  });

  // На 1.21.4 FunTime присылает весь инвентарь одним window_items для окна 0.
  // В массиве из 46 элементов хотбар находится в слотах 36..44.
  bot._client.on('window_items', packet => {
    try {
      const windowId = normalizeWindowId(packet.windowId);
      const items = Array.isArray(packet.items) ? packet.items : [];
      if (windowId !== 0 || items.length < 45) return;

      const limit = Math.min(items.length, bot.inventory?.slots?.length || items.length);
      for (let slot = 0; slot < limit; slot += 1) {
        applyInventorySlot(slot, items[slot]);
      }

      bot.updateHeldItem?.();
      console.log(`[inventory-fix] window_items 0: применено ${limit} слотов`);
    } catch (error) {
      console.error('[inventory-fix] Ошибка применения window_items:', error.message);
    }
  });

  bot.on('messagestr', message => {
    try {
      const text = cleanText(message);
      const match = text.match(/вы были кикнуты при подключении к серверу\s+([^:]+):\s*(.+)$/i);
      if (!match) return;
      bot.emit('serverJoinRejected', {
        server: cleanText(match[1]),
        reason: cleanText(match[2])
      });
    } catch (error) {
      console.error('[server-state] Не удалось разобрать отказ сервера:', error.message);
    }
  });

  if (bot.inventory?.on) bot.inventory.on('updateSlot', () => normalizeSlots(bot.inventory?.slots));
  bot.on('windowOpen', window => {
    normalizeSlots(window?.slots);
    if (window?.on) window.on('updateSlot', () => normalizeSlots(window.slots));
  });

  return bot;
};
