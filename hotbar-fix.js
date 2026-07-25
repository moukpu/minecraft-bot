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

  return bot;
};
