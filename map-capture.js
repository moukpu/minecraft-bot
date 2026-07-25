'use strict';

const { PNG } = require('pngjs');

const MAP_SIZE = 128;
const QUIET_RENDER_DELAY_MS = 1800;

function unsignedByte(value) {
  const number = Number(value || 0);
  return number < 0 ? number + 256 : number;
}

class MapCapture {
  constructor() {
    this.bot = null;
    this.listener = null;
    this.maps = new Map();
    this.mapArrivalOrder = [];
    this.renderTimer = null;
    this.colorsPromise = null;
    this.lastImage = null;
    this.lastPacketAt = 0;
    this.lastUpdatedAt = 0;
    this.lastMapCount = 0;
    this.lastGrid = null;
  }

  attach(bot) {
    this.detach();
    this.lastImage = null;
    this.lastPacketAt = 0;
    this.lastUpdatedAt = 0;
    this.lastMapCount = 0;
    this.lastGrid = null;
    this.bot = bot;
    this.listener = packet => this.handlePacket(packet);
    bot._client.on('map', this.listener);
  }

  detach() {
    if (this.bot && this.listener) {
      this.bot._client.removeListener('map', this.listener);
    }

    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.maps.clear();
    this.mapArrivalOrder = [];
    this.bot = null;
    this.listener = null;
  }

  async getColors() {
    if (!this.colorsPromise) {
      this.colorsPromise = import('@aresrpg/aresrpg-map-colors')
        .then(module => module.default || module);
    }

    return this.colorsPromise;
  }

  handlePacket(packet) {
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
      this.lastPacketAt = Date.now();
      this.scheduleRender();
    } catch (error) {
      console.error('Ошибка чтения map-пакета:', error);
    }
  }

  scheduleRender() {
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
          `Собрана карта-капча: ${result.mapCount} плиток, сетка ${result.columns}x${result.rows}`
        );
      } catch (error) {
        console.error('Ошибка сборки карты:', error);
      }
    }, QUIET_RENDER_DELAY_MS);
  }

  getOrderedMapIds() {
    const ids = Array.from(this.maps.keys());
    if (ids.length <= 1) return ids;

    const sorted = [...ids].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const contiguous = max - min + 1 === sorted.length;

    // Плагины капчи обычно создают последовательные map ID по строкам.
    // Если ID не последовательные, сохраняем реальный порядок прихода пакетов.
    return contiguous ? sorted : this.mapArrivalOrder.filter(id => this.maps.has(id));
  }

  chooseGrid(mapCount) {
    if (mapCount <= 1) return { columns: 1, rows: 1 };

    const exactSquare = Math.sqrt(mapCount);
    if (Number.isInteger(exactSquare)) {
      return { columns: exactSquare, rows: exactSquare };
    }

    let bestColumns = mapCount;
    let bestRows = 1;
    let bestDifference = mapCount - 1;

    for (let rows = 1; rows <= Math.sqrt(mapCount); rows += 1) {
      if (mapCount % rows !== 0) continue;
      const columns = mapCount / rows;
      const difference = Math.abs(columns - rows);

      if (difference < bestDifference) {
        bestColumns = columns;
        bestRows = rows;
        bestDifference = difference;
      }
    }

    // Неполный набор всё равно раскладываем максимально близко к квадрату.
    if (bestRows === 1 && mapCount > 6) {
      bestColumns = Math.ceil(Math.sqrt(mapCount));
      bestRows = Math.ceil(mapCount / bestColumns);
    }

    return { columns: bestColumns, rows: bestRows };
  }

  async renderAllMaps() {
    const ids = this.getOrderedMapIds();
    if (!ids.length) return null;

    const { columns, rows } = this.chooseGrid(ids.length);
    const baseWidth = columns * MAP_SIZE;
    const baseHeight = rows * MAP_SIZE;

    // Для 5x5 получается 1280x1280: читаемо и Telegram не превращает цифры в кашу.
    const scale = Math.max(1, Math.min(4, Math.floor(1280 / Math.max(baseWidth, baseHeight))));
    const png = new PNG({
      width: baseWidth * scale,
      height: baseHeight * scale
    });

    png.data.fill(255);
    const colors = await this.getColors();

    for (let tileIndex = 0; tileIndex < ids.length; tileIndex += 1) {
      const mapId = ids[tileIndex];
      const pixels = this.maps.get(mapId);
      if (!pixels) continue;

      const tileColumn = tileIndex % columns;
      const tileRow = Math.floor(tileIndex / columns);
      this.drawTile(png, pixels, tileColumn, tileRow, scale, colors);
    }

    return {
      image: PNG.sync.write(png),
      mapCount: ids.length,
      columns,
      rows
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
