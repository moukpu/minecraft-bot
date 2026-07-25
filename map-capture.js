'use strict';

const { PNG } = require('pngjs');

const MAP_SIZE = 128;
const QUIET_RENDER_DELAY_MS = 1800;
const MAX_LAYOUT_WAIT_MS = 6500;

function unsignedByte(value) {
  const number = Number(value || 0);
  return number < 0 ? number + 256 : number;
}

function unwrapNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;

  if (typeof value.value === 'number' && Number.isFinite(value.value)) {
    return value.value;
  }

  return null;
}

function extractMapId(value, depth = 0, keyHint = '') {
  if (depth > 10 || value == null) return null;

  if (/^(map|mapid|itemdamage)$/i.test(keyHint)) {
    const direct = unwrapNumber(value);
    if (direct != null) return direct;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const result = extractMapId(entry, depth + 1, keyHint);
      if (result != null) return result;
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  const itemName = String(value.name || value.displayName || '').toLowerCase();
  if (itemName.includes('filled_map') || itemName === 'map') {
    for (const key of ['mapId', 'itemDamage', 'metadata', 'damage']) {
      const result = unwrapNumber(value[key]);
      if (result != null) return result;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    if (/^(map|mapid|itemdamage)$/i.test(key)) {
      const result = unwrapNumber(child);
      if (result != null) return result;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const result = extractMapId(child, depth + 1, key);
    if (result != null) return result;
  }

  return null;
}

function roundedCoordinate(value) {
  return Math.round(Number(value) * 4) / 4;
}

function uniqueSorted(values, direction = 1) {
  return Array.from(new Set(values.map(roundedCoordinate)))
    .sort((a, b) => (a - b) * direction);
}

class MapCapture {
  constructor() {
    this.bot = null;
    this.listeners = [];
    this.maps = new Map();
    this.frames = new Map();
    this.mapPositions = new Map();
    this.mapArrivalOrder = [];
    this.renderTimer = null;
    this.colorsPromise = null;
    this.lastImage = null;
    this.lastPacketAt = 0;
    this.firstMapAt = 0;
    this.lastUpdatedAt = 0;
    this.lastMapCount = 0;
    this.lastGrid = null;
    this.itemFrameTypeIds = new Set();
  }

  attach(bot) {
    this.detach();
    this.lastImage = null;
    this.lastPacketAt = 0;
    this.firstMapAt = 0;
    this.lastUpdatedAt = 0;
    this.lastMapCount = 0;
    this.lastGrid = null;
    this.bot = bot;

    const registry = bot.registry || require('minecraft-data')(bot.version);
    for (const name of ['item_frame', 'glow_item_frame']) {
      const entity = registry?.entitiesByName?.[name];
      if (entity?.id != null) this.itemFrameTypeIds.add(Number(entity.id));
    }

    this.listen('map', packet => this.handleMapPacket(packet));
    this.listen('spawn_entity', packet => this.handleSpawnEntity(packet));
    this.listen('entity_metadata', packet => this.handleEntityMetadata(packet));
    this.listen('entity_destroy', packet => this.handleEntityDestroy(packet));
  }

  listen(eventName, handler) {
    this.bot._client.on(eventName, handler);
    this.listeners.push([eventName, handler]);
  }

  detach() {
    if (this.bot) {
      for (const [eventName, handler] of this.listeners) {
        this.bot._client.removeListener(eventName, handler);
      }
    }

    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.listeners = [];
    this.maps.clear();
    this.frames.clear();
    this.mapPositions.clear();
    this.mapArrivalOrder = [];
    this.itemFrameTypeIds.clear();
    this.bot = null;
  }

  async getColors() {
    if (!this.colorsPromise) {
      this.colorsPromise = import('@aresrpg/aresrpg-map-colors')
        .then(module => module.default || module);
    }

    return this.colorsPromise;
  }

  handleMapPacket(packet) {
    try {
      const mapId = Number(packet.itemDamage ?? packet.mapId ?? packet.id ?? 0);
      const raw = packet.data ?? packet.mapColors;
      if (!raw) return;

      const data = Buffer.from(raw);
      if (!data.length) return;

      let columns = unsignedByte(packet.columns ?? packet.width ?? 0);
      let rows = unsignedByte(packet.rows ?? packet.height ?? 0);
      let startX = unsignedByte(packet.x ?? packet.startX ?? 0);
      let startY = unsignedByte(packet.y ?? packet.startY ?? 0);

      if ((!columns || !rows) && data.length === MAP_SIZE * MAP_SIZE) {
        columns = MAP_SIZE;
        rows = MAP_SIZE;
        startX = 0;
        startY = 0;
      }

      if (!columns || !rows) return;

      if (!this.maps.has(mapId)) {
        this.mapArrivalOrder.push(mapId);
      }

      const pixels = this.maps.get(mapId) || Buffer.alloc(MAP_SIZE * MAP_SIZE, 0);
      const expected = Math.min(data.length, columns * rows);

      for (let index = 0; index < expected; index += 1) {
        const x = startX + (index % columns);
        const y = startY + Math.floor(index / columns);

        if (x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE) {
          pixels[y * MAP_SIZE + x] = data[index];
        }
      }

      this.maps.set(mapId, pixels);
      const now = Date.now();
      if (!this.firstMapAt) this.firstMapAt = now;
      this.lastPacketAt = now;
      this.scheduleRender();
    } catch (error) {
      console.error('Ошибка чтения map-пакета:', error);
    }
  }

  handleSpawnEntity(packet) {
    const entityId = Number(packet.entityId ?? packet.id);
    const type = Number(packet.type ?? packet.entityType);
    if (!Number.isFinite(entityId) || !this.itemFrameTypeIds.has(type)) return;

    this.frames.set(entityId, {
      entityId,
      x: Number(packet.x),
      y: Number(packet.y),
      z: Number(packet.z),
      mapId: null
    });

    setTimeout(() => this.readFrameFromMineflayer(entityId), 50);
  }

  handleEntityMetadata(packet) {
    const entityId = Number(packet.entityId ?? packet.id);
    if (!Number.isFinite(entityId)) return;

    if (!this.frames.has(entityId)) {
      const entity = this.bot?.entities?.[entityId];
      if (!this.isItemFrameEntity(entity)) return;

      this.frames.set(entityId, {
        entityId,
        x: Number(entity.position.x),
        y: Number(entity.position.y),
        z: Number(entity.position.z),
        mapId: null
      });
    }

    const mapId = extractMapId(packet.metadata);
    if (mapId != null) {
      this.assignMapToFrame(entityId, mapId);
    } else {
      setTimeout(() => this.readFrameFromMineflayer(entityId), 20);
    }
  }

  handleEntityDestroy(packet) {
    const ids = packet.entityIds || packet.entities || packet.entityId || [];
    const list = Array.isArray(ids) ? ids : [ids];

    for (const rawId of list) {
      const entityId = Number(rawId);
      const frame = this.frames.get(entityId);
      if (frame?.mapId != null) this.mapPositions.delete(frame.mapId);
      this.frames.delete(entityId);
    }
  }

  isItemFrameEntity(entity) {
    if (!entity) return false;
    const name = String(entity.name || entity.displayName || entity.mobType || '').toLowerCase();
    return name.includes('item_frame') || name.includes('item frame');
  }

  readFrameFromMineflayer(entityId) {
    const entity = this.bot?.entities?.[entityId];
    if (!this.isItemFrameEntity(entity)) return;

    let frame = this.frames.get(entityId);
    if (!frame) {
      frame = {
        entityId,
        x: Number(entity.position.x),
        y: Number(entity.position.y),
        z: Number(entity.position.z),
        mapId: null
      };
      this.frames.set(entityId, frame);
    } else if (entity.position) {
      frame.x = Number(entity.position.x);
      frame.y = Number(entity.position.y);
      frame.z = Number(entity.position.z);
    }

    const mapId = extractMapId(entity.metadata) ?? extractMapId(entity.equipment);
    if (mapId != null) this.assignMapToFrame(entityId, mapId);
  }

  assignMapToFrame(entityId, mapId) {
    const frame = this.frames.get(entityId);
    if (!frame) return;

    if (frame.mapId != null && frame.mapId !== mapId) {
      this.mapPositions.delete(frame.mapId);
    }

    frame.mapId = Number(mapId);
    this.mapPositions.set(Number(mapId), {
      x: Number(frame.x),
      y: Number(frame.y),
      z: Number(frame.z)
    });

    this.scheduleRender(250);
  }

  scheduleRender(delay = QUIET_RENDER_DELAY_MS) {
    if (this.renderTimer) clearTimeout(this.renderTimer);

    this.renderTimer = setTimeout(async () => {
      this.renderTimer = null;

      try {
        const result = await this.renderAllMaps();
        if (!result) return;

        this.lastImage = result.image;
        this.lastMapCount = result.mapCount;
        this.lastGrid = { columns: result.columns, rows: result.rows };
        this.lastUpdatedAt = Date.now();

        console.log(
          `Собрана карта-капча: ${result.mapCount} плиток, сетка ${result.columns}x${result.rows}, ` +
          `раскладка=${result.layoutMode}`
        );
      } catch (error) {
        console.error('Ошибка сборки карты:', error);
      }
    }, delay);
  }

  getPositionLayout(ids) {
    const entries = ids
      .map(mapId => ({ mapId, position: this.mapPositions.get(mapId) }))
      .filter(entry => entry.position);

    if (entries.length !== ids.length || entries.length < 2) return null;

    const xValues = uniqueSorted(entries.map(entry => entry.position.x));
    const yValues = uniqueSorted(entries.map(entry => entry.position.y), -1);
    const zValues = uniqueSorted(entries.map(entry => entry.position.z));

    const horizontalAxis = xValues.length >= zValues.length ? 'x' : 'z';
    const botPosition = this.bot?.entity?.position;
    let horizontalDirection = 1;

    if (horizontalAxis === 'x') {
      const planeZ = entries.reduce((sum, entry) => sum + entry.position.z, 0) / entries.length;
      if (botPosition) horizontalDirection = botPosition.z >= planeZ ? 1 : -1;
    } else {
      const planeX = entries.reduce((sum, entry) => sum + entry.position.x, 0) / entries.length;
      if (botPosition) horizontalDirection = botPosition.x >= planeX ? -1 : 1;
    }

    const columnValues = uniqueSorted(
      entries.map(entry => entry.position[horizontalAxis]),
      horizontalDirection
    );

    if (columnValues.length * yValues.length < ids.length) return null;

    const placements = new Map();
    for (const entry of entries) {
      const columnValue = roundedCoordinate(entry.position[horizontalAxis]);
      const rowValue = roundedCoordinate(entry.position.y);
      const column = columnValues.indexOf(columnValue);
      const row = yValues.indexOf(rowValue);
      if (column < 0 || row < 0) return null;
      placements.set(entry.mapId, { column, row });
    }

    return {
      columns: columnValues.length,
      rows: yValues.length,
      placements,
      mode: `frames:${horizontalAxis}${horizontalDirection > 0 ? '+' : '-'}`
    };
  }

  getFallbackLayout(ids) {
    const mapCount = ids.length;
    const exactSquare = Math.sqrt(mapCount);
    let columns;
    let rows;

    if (Number.isInteger(exactSquare)) {
      columns = exactSquare;
      rows = exactSquare;
    } else {
      columns = Math.ceil(Math.sqrt(mapCount));
      rows = Math.ceil(mapCount / columns);
    }

    const ordered = [...ids].sort((a, b) => a - b);
    const placements = new Map();
    ordered.forEach((mapId, index) => {
      placements.set(mapId, {
        column: index % columns,
        row: Math.floor(index / columns)
      });
    });

    return { columns, rows, placements, mode: 'fallback-map-id' };
  }

  async renderAllMaps() {
    const ids = Array.from(this.maps.keys());
    if (!ids.length) return null;

    let layout = this.getPositionLayout(ids);

    if (!layout && ids.length > 1 && Date.now() - this.firstMapAt < MAX_LAYOUT_WAIT_MS) {
      console.log(
        `Жду координаты рамок: карты=${ids.length}, привязано=${this.mapPositions.size}`
      );
      this.scheduleRender(600);
      return null;
    }

    if (!layout) {
      console.warn(
        `Не удалось получить координаты всех рамок: карты=${ids.length}, ` +
        `привязано=${this.mapPositions.size}. Использую запасной порядок.`
      );
      layout = this.getFallbackLayout(ids);
    }

    const baseWidth = layout.columns * MAP_SIZE;
    const baseHeight = layout.rows * MAP_SIZE;
    const scale = Math.max(1, Math.min(4, Math.floor(1280 / Math.max(baseWidth, baseHeight))));
    const png = new PNG({
      width: baseWidth * scale,
      height: baseHeight * scale
    });

    png.data.fill(255);
    const colors = await this.getColors();

    for (const mapId of ids) {
      const pixels = this.maps.get(mapId);
      const placement = layout.placements.get(mapId);
      if (!pixels || !placement) continue;

      this.drawTile(png, pixels, placement.column, placement.row, scale, colors);
    }

    return {
      image: PNG.sync.write(png),
      mapCount: ids.length,
      columns: layout.columns,
      rows: layout.rows,
      layoutMode: layout.mode
    };
  }

  drawTile(png, pixels, tileColumn, tileRow, scale, colors) {
    for (let y = 0; y < MAP_SIZE; y += 1) {
      for (let x = 0; x < MAP_SIZE; x += 1) {
        const colorId = pixels[y * MAP_SIZE + x];
        let r = 32;
        let g = 32;
        let b = 32;

        if (colorId >= 4) {
          try {
            const value = colors.color(colorId);
            r = value.r;
            g = value.g;
            b = value.b;
          } catch {}
        }

        const baseX = (tileColumn * MAP_SIZE + x) * scale;
        const baseY = (tileRow * MAP_SIZE + y) * scale;

        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const offset = ((baseY + sy) * png.width + baseX + sx) * 4;
            png.data[offset] = r;
            png.data[offset + 1] = g;
            png.data[offset + 2] = b;
            png.data[offset + 3] = 255;
          }
        }
      }
    }
  }
}

module.exports = { MapCapture };
