'use strict';

const crypto = require('crypto');
const FlayerCaptcha = require('flayercaptcha');

const PUBLISH_DELAY_MS = 900;

class MapCapture {
  constructor() {
    this.bot = null;
    this.captcha = null;
    this.publishTimer = null;
    this.pendingImage = null;
    this.lastImage = null;
    this.lastUpdatedAt = 0;
    this.lastMapCount = 0;
    this.lastHash = null;
    this.lastLayout = null;
  }

  attach(bot) {
    this.detach();

    this.bot = bot;
    this.lastImage = null;
    this.lastUpdatedAt = 0;
    this.lastMapCount = 0;
    this.lastHash = null;
    this.lastLayout = null;

    this.captcha = new FlayerCaptcha(bot, {
      delay: 25,
      isStopped: false
    });

    this.captcha.on('imageReady', payload => {
      this.handleImageReady(payload).catch(error => {
        console.error('FlayerCaptcha imageReady error:', error);
      });
    });

    this.captcha.on('inventoryInfo', payload => {
      this.handleInventoryImage(payload).catch(error => {
        console.error('FlayerCaptcha inventoryInfo error:', error);
      });
    });

    this.captcha.on('error', error => {
      console.error('FlayerCaptcha error:', error);
    });
  }

  detach() {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = null;
    this.pendingImage = null;

    if (this.captcha) {
      try {
        this.captcha.stop();
      } catch {}

      try {
        this.captcha.removeAllListeners();
      } catch {}
    }

    this.captcha = null;
    this.bot = null;
  }

  async sharpToPngBuffer(image) {
    if (!image || typeof image.toBuffer !== 'function') {
      throw new Error('FlayerCaptcha вернул изображение неизвестного формата.');
    }

    if (typeof image.png === 'function') {
      return image.png().toBuffer();
    }

    return image.toBuffer();
  }

  async handleImageReady({ data, image } = {}) {
    const buffer = await this.sharpToPngBuffer(image);
    const frameCount = Array.isArray(data?.frames) ? data.frames.length : 0;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    this.pendingImage = {
      buffer,
      hash,
      frameCount,
      viewDirection: data?.viewDirection || null,
      facing: data?.facing || null,
      minDistance: data?.minDistance ?? null
    };

    this.schedulePublish();
  }

  async handleInventoryImage({ data, image } = {}) {
    if (this.pendingImage || this.lastImage) return;

    const buffer = await this.sharpToPngBuffer(image);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');

    this.pendingImage = {
      buffer,
      hash,
      frameCount: Array.isArray(data?.slots) ? data.slots.length : 1,
      viewDirection: 'inventory',
      facing: 'inventory',
      minDistance: 0
    };

    this.schedulePublish();
  }

  schedulePublish() {
    if (this.publishTimer) clearTimeout(this.publishTimer);

    this.publishTimer = setTimeout(() => {
      this.publishTimer = null;
      this.publishPendingImage();
    }, PUBLISH_DELAY_MS);
  }

  publishPendingImage() {
    const pending = this.pendingImage;
    this.pendingImage = null;
    if (!pending) return;

    if (pending.hash === this.lastHash) return;

    this.lastImage = pending.buffer;
    this.lastHash = pending.hash;
    this.lastUpdatedAt = Date.now();
    this.lastMapCount = pending.frameCount;
    this.lastLayout = {
      viewDirection: pending.viewDirection,
      facing: pending.facing,
      minDistance: pending.minDistance
    };

    console.log(
      `FlayerCaptcha собрал изображение: рамок=${pending.frameCount}, ` +
      `направление=${pending.viewDirection || '?'}, сторона=${pending.facing || '?'}`
    );
  }
}

module.exports = { MapCapture };
