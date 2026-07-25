'use strict';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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

function baseItemName(item) {
  if (!item) return '';
  const custom = textFieldsOnly(item.customName);
  if (custom) return custom;
  return cleanText(item.displayName || item.name || 'предмет');
}

function itemName(item) {
  if (!item) return 'пусто';
  return baseItemName(item) || 'предмет';
}

function isDecorativeItem(item, name) {
  const normalized = cleanText(name).toLowerCase();
  const technical = String(item?.name || '').toLowerCase();
  if (!normalized) return true;
  if (/^funtime(?:\.su)?[.!]*$/i.test(normalized)) return true;
  if (/glass_pane/.test(technical)) return true;
  return false;
}

function isUnavailableItem(item, name) {
  const normalized = cleanText(name).toLowerCase();
  const technical = String(item?.name || '').toLowerCase();
  return /ой\.*\s*к\s+сожалению|недоступ|закрыт|не работает/i.test(normalized)
    || (technical === 'barrier' && !/назад|вернуться/i.test(normalized));
}

function isTransactionTimeout(error) {
  return /didn'?t respond to transaction|transaction.*timeout/i.test(String(error?.message || ''));
}

class InventoryController {
  constructor({ notify, onState }) {
    this.notify = notify;
    this.onState = onState;
    this.bot = null;
    this.Item = null;
    this.listeners = [];
    this.clientListeners = [];
    this.inventoryListener = null;
    this.currentWindow = null;
    this.lastGuiClickAt = 0;
    this.lastJoinRejectedAt = 0;
    this.pendingCloseTimer = null;
    this.loadingTimer = null;
    this.loadingFallbackTimer = null;
    this.hotbarNotifyTimer = null;
    this.loading = false;
    this.hotbarAnnounced = false;
    this.inventoryPackets = 0;
    this.appliedLobbyPackets = 0;
    this.inventoryErrors = 0;
    this.packetSamples = [];
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.currentWindow = bot.currentWindow || null;
    this.hotbarAnnounced = false;
    this.inventoryPackets = 0;
    this.appliedLobbyPackets = 0;
    this.inventoryErrors = 0;
    this.packetSamples = [];
    this.lastJoinRejectedAt = 0;

    try {
      this.Item = require('prismarine-item')(bot.registry || bot.version);
    } catch (error) {
      this.Item = null;
      this.inventoryErrors += 1;
      console.error('Не удалось загрузить парсер предметов:', error.message);
    }

    this.listen('windowOpen', window => this.handleWindowOpen(window));
    this.listen('windowClose', window => this.handleWindowClose(window));
    this.listen('respawn', () => this.handleWorldSignal('respawn'));
    this.listen('game', () => this.handleWorldSignal('смена мира'));
    this.listen('spawn', () => this.handleWorldSignal('spawn'));
    this.listen('forcedMove', () => this.handleWorldSignal('телепортация'));
    this.listen('serverJoinRejected', info => this.handleServerJoinRejected(info));

    this.listenClient('set_slot', packet => this.handleRawSetSlot(packet));
    this.listenClient('window_items', packet => this.handleRawWindowItems(packet));

    this.inventoryListener = () => this.scheduleHotbarNotification();
    if (bot.inventory?.on) bot.inventory.on('updateSlot', this.inventoryListener);
  }

  detach() {
    if (this.bot) {
      for (const [event, listener] of this.listeners) this.bot.removeListener(event, listener);
      for (const [event, listener] of this.clientListeners) this.bot._client?.removeListener(event, listener);
      if (this.inventoryListener && this.bot.inventory?.removeListener) {
        this.bot.inventory.removeListener('updateSlot', this.inventoryListener);
      }
    }

    this.listeners = [];
    this.clientListeners = [];
    this.inventoryListener = null;
    this.bot = null;
    this.Item = null;
    this.currentWindow = null;
    this.loading = false;
    this.clearLoadingTimers();
    if (this.hotbarNotifyTimer) clearTimeout(this.hotbarNotifyTimer);
    this.hotbarNotifyTimer = null;
  }

  clearLoadingTimers() {
    for (const timer of [this.pendingCloseTimer, this.loadingTimer, this.loadingFallbackTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.pendingCloseTimer = null;
    this.loadingTimer = null;
    this.loadingFallbackTimer = null;
  }

  listen(event, listener) {
    this.bot.on(event, listener);
    this.listeners.push([event, listener]);
  }

  listenClient(event, listener) {
    this.bot._client.on(event, listener);
    this.clientListeners.push([event, listener]);
  }

  normalizeWindowId(value) {
    const number = Number(value);
    if (number === 254) return -2;
    if (number === 255) return -1;
    return number;
  }

  rememberPacket(text) {
    this.packetSamples.push(text);
    if (this.packetSamples.length > 12) this.packetSamples.shift();
  }

  parseItem(rawItem) {
    if (!this.Item) return null;
    return this.Item.fromNotch(rawItem);
  }

  hotbarStart() {
    return Number(this.bot?.QUICK_BAR_START ?? this.bot?.inventory?.hotbarStart ?? 36);
  }

  applyPlayerInventorySlot(slot, rawItem) {
    if (!this.bot?.inventory || !Number.isInteger(slot) || slot < 0) return;

    try {
      const item = this.parseItem(rawItem);
      const targetSlot = slot >= 0 && slot <= 8 ? this.hotbarStart() + slot : slot;
      if (typeof this.bot._setSlot === 'function') this.bot._setSlot(targetSlot, item, this.bot.inventory);
      else {
        this.bot.inventory.updateSlot(targetSlot, item);
        this.bot.updateHeldItem?.();
      }
      this.appliedLobbyPackets += 1;
    } catch (error) {
      this.inventoryErrors += 1;
      console.error(`Не удалось применить предмет в слот ${slot}:`, error.message);
    }
  }

  handleRawSetSlot(packet) {
    try {
      this.inventoryPackets += 1;
      const windowId = this.normalizeWindowId(packet.windowId);
      const slot = Number(packet.slot);
      this.rememberPacket(`set_slot: окно=${windowId}, слот=${slot}`);
      if (windowId === -2) this.applyPlayerInventorySlot(slot, packet.item);
      this.scheduleHotbarNotification();
    } catch (error) {
      this.inventoryErrors += 1;
      console.error('Ошибка обработки set_slot:', error.message);
    }
  }

  handleRawWindowItems(packet) {
    try {
      this.inventoryPackets += 1;
      const windowId = this.normalizeWindowId(packet.windowId);
      const items = Array.isArray(packet.items) ? packet.items : [];
      this.rememberPacket(`window_items: окно=${windowId}, предметов=${items.length}`);
      if (windowId === -2) {
        for (let slot = 0; slot < items.length; slot += 1) this.applyPlayerInventorySlot(slot, items[slot]);
      }
      this.scheduleHotbarNotification();
    } catch (error) {
      this.inventoryErrors += 1;
      console.error('Ошибка обработки window_items:', error.message);
    }
  }

  hotbarItems() {
    const start = this.hotbarStart();
    return Array.from({ length: 9 }, (_, index) => this.bot?.inventory?.slots?.[start + index] || null);
  }

  scheduleHotbarNotification() {
    if (!this.bot || this.hotbarAnnounced) return;
    if (this.hotbarNotifyTimer) clearTimeout(this.hotbarNotifyTimer);
    this.hotbarNotifyTimer = setTimeout(() => {
      this.hotbarNotifyTimer = null;
      if (!this.bot || this.hotbarAnnounced || !this.hotbarItems().some(Boolean)) return;
      this.hotbarAnnounced = true;
      this.notify(`🎒 Хотбар загружен.\n${this.describeHotbar()}`).catch(console.error);
    }, 400);
  }

  async waitForInventorySync(timeoutMs = 2200) {
    if (this.hotbarItems().some(Boolean)) return true;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(150);
      if (this.hotbarItems().some(Boolean)) return true;
    }
    return false;
  }

  async handleWindowOpen(window) {
    if (this.pendingCloseTimer) {
      clearTimeout(this.pendingCloseTimer);
      this.pendingCloseTimer = null;
    }
    this.currentWindow = window;
    if (this.loading) this.finishLoading('открылось серверное меню', false);
    await this.notify(this.describeWindow(window));
  }

  handleWindowClose(window) {
    if (!window || this.currentWindow === window || this.bot?.currentWindow == null) this.currentWindow = null;
    if (Date.now() - this.lastGuiClickAt >= 3000) return;
    if (this.pendingCloseTimer) clearTimeout(this.pendingCloseTimer);
    this.pendingCloseTimer = setTimeout(() => {
      this.pendingCloseTimer = null;
      if (Date.now() - this.lastJoinRejectedAt < 3500) return;
      if (!this.bot?.currentWindow) this.startLoading();
    }, 500);
  }

  startLoading() {
    if (this.loading) return;
    this.loading = true;
    this.onState('Выбор отправлен, жду переход на сервер');
    if (this.loadingFallbackTimer) clearTimeout(this.loadingFallbackTimer);
    this.loadingFallbackTimer = setTimeout(() => {
      if (!this.loading) return;
      this.loading = false;
      this.onState('Переход не подтверждён, вероятно бот остался в лобби');
      this.notify('⚠️ Переход на выбранный сервер не подтвердился. Скорее всего, бот остался в лобби.').catch(console.error);
    }, 10000);
  }

  handleWorldSignal(signal) {
    if (!this.loading) return;
    if (this.loadingTimer) clearTimeout(this.loadingTimer);
    this.loadingTimer = setTimeout(() => {
      this.loadingTimer = null;
      this.finishLoading(signal, true);
    }, 1200);
  }

  finishLoading(signal, notifyUser = true) {
    if (!this.loading) return;
    this.loading = false;
    if (this.loadingFallbackTimer) clearTimeout(this.loadingFallbackTimer);
    this.loadingFallbackTimer = null;
    this.onState('Переход выполнен, мир загружен');
    if (notifyUser) {
      this.notify(`✅ Переход выполнен. Мир загружен.\nСигнал: ${signal}\n${this.describePosition()}`).catch(console.error);
    }
  }

  handleServerJoinRejected(info = {}) {
    this.lastJoinRejectedAt = Date.now();
    this.loading = false;
    this.clearLoadingTimers();
    const server = cleanText(info.server || 'выбранный сервер');
    const reason = cleanText(info.reason || 'сервер отклонил подключение');
    this.onState(`Не вошёл на ${server}. Остался в лобби. Причина: ${reason}`);
  }

  windowTitle(window) {
    const title = textFieldsOnly(window?.title);
    return title || cleanText(window?.type) || 'Меню';
  }

  describePosition() {
    const position = this.bot?.entity?.position;
    if (!position) return 'Координаты пока неизвестны.';
    return `XYZ: ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`;
  }

  describeWindow(window = this.bot?.currentWindow || this.currentWindow) {
    if (!window) return this.describeHotbar();
    const slotLimit = Number.isInteger(window.inventoryStart)
      ? window.inventoryStart
      : Math.min(window.slots?.length || 0, 54);
    const rows = new Map();
    let usefulCount = 0;
    let unavailableCount = 0;

    for (let slot = 0; slot < slotLimit; slot += 1) {
      const item = window.slots?.[slot];
      if (!item) continue;
      const name = baseItemName(item);
      if (isDecorativeItem(item, name)) continue;
      if (isUnavailableItem(item, name)) {
        unavailableCount += 1;
        continue;
      }
      usefulCount += 1;
      const row = Math.floor(slot / 9) + 1;
      if (!rows.has(row)) rows.set(row, []);
      rows.get(row).push(`[${slot}] ${name}`);
    }

    const lines = [`🎒 ${this.windowTitle(window)}`];
    if (!usefulCount) lines.push('', 'Доступных пунктов нет.');
    else {
      for (const [row, entries] of rows) lines.push('', `Ряд ${row}:`, ...entries);
    }
    if (unavailableCount) lines.push('', `Недоступных пунктов скрыто: ${unavailableCount}`);
    lines.push('', 'Команда: пкм слот 14  или  слот 14 пкм');
    return lines.join('\n').slice(0, 3900);
  }

  describeHotbar() {
    const items = this.hotbarItems();
    const lines = ['🎒 Хотбар:'];
    let usefulCount = 0;
    for (let index = 0; index < 9; index += 1) {
      const item = items[index];
      if (!item) continue;
      const name = baseItemName(item);
      if (isDecorativeItem(item, name)) continue;
      usefulCount += 1;
      const selected = Number(this.bot?.quickBarSlot) === index ? ' ← выбран' : '';
      lines.push(`[${index + 1}] ${name}${selected}`);
    }
    if (!usefulCount) {
      lines.push('Пусто.');
      lines.push('', `Диагностика: пакетов=${this.inventoryPackets}, применено=${this.appliedLobbyPackets}, ошибок=${this.inventoryErrors}.`);
      if (this.packetSamples.length) lines.push(...this.packetSamples.map(value => `• ${value}`));
    }
    lines.push('', 'Команды: слот 5 | пкм | лкм | меню');
    return lines.join('\n').slice(0, 3900);
  }

  helpText() {
    return [
      '🎮 Управление:',
      '• слот 5: выбрать 5-й слот хотбара',
      '• пкм: использовать предмет в руке',
      '• пкм слот 14 / слот 14 пкм: нажать GUI-слот №14',
      '• лкм слот 14 / слот 14 лкм: левый клик по GUI-слоту №14',
      '• меню: показать только полезные пункты',
      '• закрыть меню: закрыть интерфейс',
      '',
      'GUI-слоты считаются с 0, хотбар с 1.'
    ].join('\n');
  }

  async handleCommand(rawText) {
    const normalized = cleanText(rawText).toLowerCase().replace(/ё/g, 'е');
    if (/^(?:меню|слоты|инвентарь|inventory|gui)$/i.test(normalized)) {
      if (!this.bot?.currentWindow) await this.waitForInventorySync();
      return { handled: true, message: this.describeWindow() };
    }
    if (/^(?:управление|помощь по слотам|слоты помощь)$/i.test(normalized)) {
      return { handled: true, message: this.helpText() };
    }
    if (/^(?:закрыть|закрой)\s+(?:меню|инвентарь|окно)$/i.test(normalized)) return this.closeWindow();

    let match = normalized.match(/^(лкм|пкм)\s+(?:по\s+)?(?:слот(?:у)?\s*)#?(\d+)$/i);
    if (!match) match = normalized.match(/^(лкм|пкм)\s+#?(\d+)$/i);
    if (match) return this.clickSlot(Number(match[2]), match[1] === 'пкм' ? 1 : 0);

    match = normalized.match(/^(?:слот|slot)\s*#?(\d+)\s*(лкм|пкм)$/i);
    if (match) return this.clickSlot(Number(match[1]), match[2] === 'пкм' ? 1 : 0);

    match = normalized.match(/^(?:слот|slot)\s*#?(\d+)$/i);
    if (match) return this.selectOrClickSlot(Number(match[1]));
    if (/^(?:пкм|правый клик|использовать)$/i.test(normalized)) return this.rightClick();
    if (/^(?:лкм|левый клик|удар)$/i.test(normalized)) return this.leftClick();
    return { handled: false };
  }

  ensureBot() {
    if (!this.bot) return 'Minecraft сейчас не подключён.';
    if (!this.bot.entity) return 'Бот ещё не появился в мире.';
    return null;
  }

  async selectOrClickSlot(slot) {
    const error = this.ensureBot();
    if (error) return { handled: true, message: error };
    if (this.bot.currentWindow) return this.clickGuiSlot(slot, 0);
    await this.waitForInventorySync(1200);
    if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
      return { handled: true, message: 'Без открытого меню номер хотбара должен быть от 1 до 9.' };
    }
    this.bot.setQuickBarSlot(slot - 1);
    await sleep(120);
    return { handled: true, message: `✅ Выбран хотбар ${slot}: ${itemName(this.hotbarItems()[slot - 1])}` };
  }

  async clickSlot(slot, button) {
    const error = this.ensureBot();
    if (error) return { handled: true, message: error };
    if (this.bot.currentWindow) return this.clickGuiSlot(slot, button);
    if (!Number.isInteger(slot) || slot < 1 || slot > 9) {
      return { handled: true, message: 'Без открытого меню номер хотбара должен быть от 1 до 9.' };
    }
    this.bot.setQuickBarSlot(slot - 1);
    await sleep(120);
    return button === 1 ? this.rightClick() : this.leftClick();
  }

  async clickGuiSlot(slot, button) {
    const window = this.bot.currentWindow;
    if (!window) return { handled: true, message: 'Меню уже закрылось.' };
    const slotLimit = Number.isInteger(window.inventoryStart) ? window.inventoryStart : (window.slots?.length || 0);
    if (!Number.isInteger(slot) || slot < 0 || slot >= slotLimit) {
      return { handled: true, message: `Такого GUI-слота нет. Диапазон: 0–${Math.max(0, slotLimit - 1)}.` };
    }

    const item = itemName(window.slots?.[slot]);
    const clickName = button === 1 ? 'ПКМ' : 'ЛКМ';
    this.lastGuiClickAt = Date.now();

    try {
      await this.bot.clickWindow(slot, button, 0);
      await sleep(250);
    } catch (error) {
      await sleep(80);
      const nextWindow = this.bot.currentWindow;
      if (isTransactionTimeout(error) && nextWindow !== window) {
        if (nextWindow) return { handled: true, message: `✅ Выбрано: ${item}. Открыто следующее меню.` };
        return { handled: true, message: `⏳ Выбрано: ${item}. Жду ответ сервера.` };
      }
      return { handled: true, message: `⚠️ Не удалось нажать слот ${slot}: ${cleanText(error.message)}` };
    }

    const nextWindow = this.bot.currentWindow;
    if (!nextWindow) return { handled: true, message: `⏳ Выбрано: ${item} (${clickName}). Жду ответ сервера.` };
    if (nextWindow !== window) return { handled: true, message: `✅ Выбрано: ${item}. Открыто следующее меню.` };
    return { handled: true, message: `✅ Нажат слот ${slot}: ${item}. Меню осталось открытым.` };
  }

  async rightClick() {
    const error = this.ensureBot();
    if (error) return { handled: true, message: error };
    if (this.bot.currentWindow) return { handled: true, message: 'Меню открыто. Напиши «пкм слот 14».' };
    await this.waitForInventorySync(1200);
    const held = itemName(this.hotbarItems()[Number(this.bot.quickBarSlot || 0)]);
    this.bot.activateItem(false);
    setTimeout(() => {
      try { this.bot?.deactivateItem(); } catch {}
    }, 250);
    return { handled: true, message: `🖱 ПКМ: ${held}.` };
  }

  async leftClick() {
    const error = this.ensureBot();
    if (error) return { handled: true, message: error };
    if (this.bot.currentWindow) return { handled: true, message: 'Меню открыто. Напиши «лкм слот 14».' };
    try { this.bot.swingArm('right'); } catch {}
    return { handled: true, message: '🖱 Выполнен левый клик.' };
  }

  async closeWindow() {
    const error = this.ensureBot();
    if (error) return { handled: true, message: error };
    const window = this.bot.currentWindow;
    if (!window) return { handled: true, message: 'Открытого меню нет.' };
    const title = this.windowTitle(window);
    try {
      this.bot.closeWindow(window);
    } catch (error) {
      return { handled: true, message: `⚠️ Не удалось закрыть меню: ${cleanText(error.message)}` };
    }
    return { handled: true, message: `✅ Меню «${title}» закрыто.` };
  }
}

module.exports = { InventoryController };
