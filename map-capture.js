'use strict';

const { PNG } = require('pngjs');

function unsignedByte(value) {
  const number = Number(value || 0);
  return number < 0 ? number + 256 : number;
}

class MapCapture {
  constructor() {
    this.bot = null;
    this.listener = null;
    this.maps = new Map();
    this.renderTimer = null;
    this.colorsPromise = null;
    this.lastImage = null;
    this.lastMapId = null;
    this.lastPacketAt = 0;
    this.lastUpdatedAt = 0;
  }

  attach(bot) {
    this.detach();
    this.lastImage = null;
    this.lastMapId = null;
    this.lastPacketAt = 0;
    this.lastUpdatedAt = 0;
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

      if ((!columns || !rows) && data.length === 128 * 128) {
        columns = 128;
        rows = 128;
        startX = 0;
        startY = 0;
      }

      if (!columns || !rows) return;

      const pixels = this.maps.get(mapId) || Buffer.alloc(128 * 128, 0);
      const expected = Math.min(data.length, columns * rows);

      for (let index = 0; index < expected; index += 1) {
        const x = startX + (index % columns);
        const y = startY + Math.floor(index / columns);

        if (x >= 0 && x < 128 && y >= 0 && y < 128) {
          pixels[y * 128 + x] = data[index];
        }
      }

      this.maps.set(mapId, pixels);
      this.lastMapId = mapId;
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
      const pixels = this.maps.get(this.lastMapId);
      if (!pixels) return;

      try {
        this.lastImage = await this.render(Buffer.from(pixels));
        this.lastUpdatedAt = Date.now();
      } catch (error) {
        console.error('Ошибка рендера карты:', error);
      }
    }, 900);
  }

  async render(pixels) {
    const colors = await this.getColors();
    const scale = 4;
    const png = new PNG({ width: 128 * scale, height: 128 * scale });

    for (let y = 0; y < 128; y += 1) {
      for (let x = 0; x < 128; x += 1) {
        const colorId = pixels[y * 128 + x];
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

        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) {
            const offset = ((y * scale + sy) * png.width + (x * scale + sx)) * 4;
            png.data[offset] = r;
            png.data[offset + 1] = g;
            png.data[offset + 2] = b;
            png.data[offset + 3] = 255;
          }
        }
      }
    }

    return PNG.sync.write(png);
  }
}

module.exports = { MapCapture };
