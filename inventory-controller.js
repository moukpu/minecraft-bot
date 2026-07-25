'use strict';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a7[0-9A-FK-OR]/gi, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function itemName(item) {
  if (!item) return 'пусто';
  const name = cleanText(item.displayName || item.name || 'предмет');
  return `${name}${item.count > 1 ? ` x${item.count}` : ''}`;
}

class InventoryController {
  constructor({ notify, onState }) {
    this.notify = notify;
    this.onState = onState;
    this.bot = null;
    this.listeners = [];
    this.clientListeners = [];
    this.nativeSetSlotListeners = [];
    this.inventoryListener = null;
    this.currentWindow = null;
    this.inventoryPackets = 0;
    this.hotbarAnnounced = false;
    this.hotbarNotifyTimer = null;
    this.lastGuiClickAt = 0;
    this.pendingCloseTimer = null;
    this.loadingTimer = null;
    this.loadingFallbackTimer = null;
    this.loading = false;
  }

  attach(bot) {
    this.detach();
    this.bot = bot;
    this.currentWindow = bot.currentWindow || null;
    this.inventoryPackets = 0;
    this.hotbarAnnounced = false;

    this.listen('windowOpen', window => this.handleWindowOpen(window));
    this.listen('windowClose', window => this.handleWindowClose(window));
    this.listen('respawn', () => this.handleWorldSignal('respawn'));
    this.listen('game', () => this.handleWorldSignal('смена режима/мира'));
    this.listen('spawn', () => this.handleWorldSignal('spawn'));
    this.listen('forcedMove', () => this.handleWorldSignal('телепортация'));

    // Сохраняем родные обработчики Mineflayer до добавления нашего.
    this.nativeSetSlotListeners = bot._client.listeners('set_slot').slice();
    this.listenClient('set_slot', packet => this.handleSetSlot(packet));

    this.inventoryListener = () => this.scheduleHotbarNotification();
    bot.inventory.on('updateSlot', this.inventoryListener);
    setTimeout(() => this.scheduleHotbarNotification(), 1000);
  }

  detach() {
    if (this.bot) {
      for (const [event, listener] of this.listeners) {
        this.bot.removeListener(event, listener);
      }

      for (const [event, listener] of this.clientListeners) {
        this.bot._client.removeListener(event, listener);
      }

      if (this.inventoryListener && this.bot.inventory) {
        this.bot.inventory.removeListener('updateSlot', this.inventoryListener);
      }
    }

    this.listeners = [];
    this.clientListeners = [];
    this.nativeSetSlotListeners = [];
    this.inventoryListener = null;
    this.bot = null;
    this.currentWindow = null;
    this.inventoryPackets = 0;
    this.hotbarAnnounced = false;
    this.loading = false;

    for (const timer of [
      this.hotbarNotifyTimer,
      this.pendingCloseTimer,
      this.loadingTimer,
      this.loadingFallbackTimer
    ]) {
      if (timer) clearTimeout(timer);
    }

    this.hotbarNotifyTimer = null;
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

  handleSetSlot(packet) {
    this.inventoryPackets += 1;
    const windowId = this.normalizeWindowId(packet.windowId);

    // Bukkit/Spigot иногда шлёт прямое обновление инвентаря через окно -2.
    // Mineflayer игнорирует его. Передаём тот же пакет его родному обработчику
    // как окно 0, чтобы предмет был разобран совместимой версией prismarine-item.
    if (windowId === -2) {
      const patched = { ...packet, windowId: 0 };

      for (const listener of this.nativeSetSlotListeners) {
        try {
          listener.call(this.bot._client, patched);
        } catch (error) {
          console.error('Ошибка применения lobby set_slot:', error.message);
        }
      }
    }

    this.scheduleHotbarNotification();
  }

  hotbarStart() {
    return Number(this.bot?.QUICK_BAR_START ?? this.bot?.inventory?.hotbarStart ?? 36);
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
      if (!this.bot || this.hotbarAnnounced) return;
      if (!this.hotbarItems().some(Boolean)) return;

      this.hotbarAnnounced = true;
      this.notify(`🎒 Хотбар загружен.\n${this.describeHotbar()}`).catch(console.error);
    }, 350);
  }

  async waitForInventorySync(timeoutMs = 2500) {
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
    if (this.loading) this.finishLoading('открылось серверное меню');
    await this.notify(this.describeWindow(window));
  }

  handleWindowClose(window) {
    if (!window || this.currentWindow === window || this.bot?.currentWindow == null) {
      this.currentWindow = null;
    }

    if (Date.now() - this.lastGuiClickAt >= 3000) return;

    if (this.pendingCloseTimer) clearTimeout(this.pendingCloseTimer);
    this.pendingCloseTimer = setTimeout(() => {
      this.pendingCloseTimer = null;
      if (!this.bot?.currentWindow) this.startLoading('меню закрылось после выбора');
    }, 450);
  }

  startLoading(reason) {
    if (this.loading) return;
    this.loading = true;
    this.onState('Идёт загрузка мира');
    this.notify(`⏳ Идёт загрузка мира…\nПричина: ${reason}`).catch(console.error);

    if (this.loadingFallbackTimer) clearTimeout(this.loadingFallbackTimer);
    this.loadingFallbackTimer = setTimeout(() => {
      if (!this.loading) return;
      this.loading = false;
      this.onState('Сервер не подтвердил завершение загрузки');
      this.notify(`⚠️ Сервер не прислал явный сигнал завершения загрузки.\n${this.describePosition()}`).catch(console.error);
    }, 12000);
  }

  handleWorldSignal(signal) {
    if (!this.loading) return;
    if (this.loadingTimer) clearTimeout(this.loadingTimer);

    this.loadingTimer = setTimeout(() => {
      this.loadingTimer = null;
      this.finishLoading(signal);
    }, 1200);
  }

  finishLoading(signal) {
    if (!this.loading) return;
    this.loading = false;

    if (this.loadingFallbackTimer) clearTimeout(this.loadingFallbackTimer);
    this.loadingFallbackTimer = null;
    this.onState('Мир загружен');

    const menu = this.bot?.currentWindow
      ? `\nОткрыто меню: ${this.windowTitle(this.bot.currentWindow)}`
      : '\nМеню закрыто.';

    this.notify(`✅ Мир загружен.\nСигнал: ${signal}\n${this.describePosition()}${menu}`).catch(console.error);
  }

  windowTitle(window) {
    const title = window?.title;
    if (typeof title === 'string') return cleanText(title);

    try {
      const rendered = title?.toString?.();
      if (rendered && rendered !== '[object Object]') return cleanText(rendered);
    } catch {}

    return cleanText(window?.type) || 'без названия';
  }

  describePosition() {
    const position = this.bot?.entity?.position;
    if (!position) return 'Координаты пока неизвестны.';
    return `XYZ: ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`;
  }

  describeWindow(window = this.bot?.currentWindow || this.currentWindow) {
    if (!window) return this.describeHotbar();

    const lines = [
      `🎒 Открыто меню: ${this.windowTitle(window)}`,
      `ID окна: ${window.id ?? '?'} | слотов: ${window.slots?.length ?? 0}`,
      'Занятые слоты:'
    ];

    let occupied = 0;
    for (let slot = 0; slot < (window.slots?.length || 0); slot += 1) {
      const item = window.slots[slot];
      if (!item) continue;
      occupied += 1;
      lines.push(`${slot}: ${itemName(item)}`);
      if (lines.join('\n').length > 3300) {
        lines.push('…список обрезан');
        break;
      }
    }

    if (!occupied) lines.push('пусто');
    lines.push('', 'Команды: слот 4 | пкм слот 15 | лкм слот 2 | закрыть меню');
    return lines.join('\n').slice(0, 3900);
  }

  describeHotbar() {
    const items = this.hotbarItems();
    const lines = ['🎒 Меню закрыто. Хотбар:'];

    for (let index = 0; index < 9; index += 1) {
      const selected = Number(this.bot?.quickBarSlot) === index ? ' ← выбран' : '';
      lines.push(`${index + 1}: ${itemName(items[index])}${selected}`);
    }

    if (!items.some(Boolean)) {
      lines.push('', `⚠️ Хотбар пока не синхронизирован. Пакетов set_slot получено: ${this.inventoryPackets}.`);
    }

    lines.push('', 'Команды: слот 4 | пкм | лкм | меню');
    return lines.join('\n');
  }

  helpText() {
    return [
      '🎮 Управление:',
      '• слот 4: без меню выбирает 4-й слот хотбара; в меню нажимает GUI-слот №4',
      '• пкм: использует предмет в руке',
      '• пкм слот 15: правый клик по GUI-слоту №15',
      '• лкм слот 15: левый клик по GUI-слоту №15',
      '• меню / слоты: показать интерфейс или хотбар',
      '• закрыть меню: закрыть текущий интерфейс',
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

    if (/^(?:закрыть|закрой)\s+(?:меню|инвентарь|окно)$/i.test(normalized)) {
      return this.closeWindow();
    }

    let match = normalized.match(/^(лкм|пкм)\s+(?:по\s+)?(?:слот(?:у)?\s*)#?(\d+)$/i);
    if (!match) match = normalized.match(/^(лкм|пкм)\s+#?(\d+)$/i);
    if (match) return this.clickSlot(Number(match[2]), match[1] === 'пкм' ? 1 : 0);

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

    if (!Number.isInteger(slot) || slot < 0 || slot >= (window.slots?.length || 0)) {
      return { handled: true, message: `Такого GUI-слота нет. Диапазон: 0–${Math.max(0, (window.slots?.length || 1) - 1)}.` };
    }

    const title = this.windowTitle(window);
    const item = itemName(window.slots[slot]);
    this.lastGuiClickAt = Date.now();

    try {
      await this.bot.clickWindow(slot, button, 0);
      await sleep(350);
    } catch (error) {
      return { handled: true, message: `⚠️ Не удалось нажать слот ${slot}: ${cleanText(error.message)}` };
    }

    const clickName = button === 1 ? 'ПКМ' : 'ЛКМ';
    const nextWindow = this.bot.currentWindow;

    if (!nextWindow) {
      return { handled: true, message: `🖱 ${clickName} по слоту ${slot} (${item}) в «${title}». Меню закрылось, проверяю загрузку.` };
    }

    if (nextWindow !== window) {
      return { handled: true, message: `🖱 ${clickName} по слоту ${slot} (${item}). Открылось другое меню.` };
    }

    return { handled: true, message: `🖱 ${clickName} по слоту ${slot}: ${item}. Меню осталось открытым.` };
  }

  async rightClick() {
    const error = this.ensureBot();
    if (error) return { handled: true, message: error };
    if (this.bot.currentWindow) return { handled: true, message: 'Меню открыто. Напиши «пкм слот 15».' };

    await this.waitForInventorySync(1200);
    const held = itemName(this.hotbarItems()[Number(this.bot.quickBarSlot || 0)]);
    this.bot.activateItem(false);
    setTimeout(() => {
      try { this.bot?.deactivateItem(); } catch {}
    }, 250);

    return { handled: true, message: `🖱 ПКМ предметом: ${held}. Жду реакцию сервера.` };
  }

  async leftClick() {
    const error = this.ensureBot();
    if (error) return { handled: true, message: error };
    if (this.bot.currentWindow) return { handled: true, message: 'Меню открыто. Напиши «лкм слот 15».' };

    try { this.bot.swingArm('right'); } catch {}
    return { handled: true, message: '🖱 Выполнен левый клик/взмах рукой.' };
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
