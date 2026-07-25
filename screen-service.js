'use strict';

const { mineflayer: startMineflayerViewer } = require('prismarine-viewer');
const puppeteer = require('puppeteer-core');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class ScreenService {
  constructor(options = {}) {
    this.port = Number(options.port || process.env.VIEWER_PORT || 3007);
    this.width = Number(options.width || process.env.SCREEN_WIDTH || 1280);
    this.height = Number(options.height || process.env.SCREEN_HEIGHT || 720);
    this.viewDistance = Number(options.viewDistance || process.env.VIEW_DISTANCE || 6);

    this.bot = null;
    this.viewerBot = null;
    this.browser = null;
    this.page = null;
    this.pageMode = null;
    this.viewerStarted = false;
    this.capturePromise = null;
  }

  async attach(bot) {
    await this.detachViewer();
    this.bot = bot;

    const viewerVersion = bot.version === '1.16.5' ? '1.16.4' : bot.version;
    this.viewerBot = viewerVersion === bot.version
      ? bot
      : new Proxy(bot, {
          get(target, property, receiver) {
            if (property === 'version') return viewerVersion;
            return Reflect.get(target, property, receiver);
          }
        });

    try {
      startMineflayerViewer(this.viewerBot, {
        port: this.port,
        firstPerson: true,
        viewDistance: this.viewDistance
      });
      this.viewerStarted = true;
      await sleep(800);
    } catch (error) {
      this.viewerStarted = false;
      console.error('Не удалось запустить Prismarine Viewer:', error);
    }
  }

  async detachViewer() {
    await this.closePage();

    if (this.bot?.viewer?.close) {
      try {
        this.bot.viewer.close();
      } catch {}
    }

    this.viewerStarted = false;
    this.viewerBot = null;
    this.bot = null;
    await sleep(250);
  }

  async closePage() {
    if (this.page) {
      try {
        await this.page.close();
      } catch {}
    }

    this.page = null;
    this.pageMode = null;
  }

  async close() {
    await this.detachViewer();

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }
  }

  async ensureBrowser() {
    if (this.browser?.connected) return this.browser;

    const imported = await import('@sparticuz/chromium');
    const chromium = imported.default || imported;
    const headlessMode = 'shell';
    const args = await puppeteer.defaultArgs({
      args: chromium.args,
      headless: headlessMode
    });

    this.browser = await puppeteer.launch({
      args,
      executablePath: await chromium.executablePath(),
      headless: headlessMode,
      defaultViewport: {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 1,
        isLandscape: true
      }
    });

    this.browser.on('disconnected', () => {
      this.browser = null;
      this.page = null;
      this.pageMode = null;
    });

    return this.browser;
  }

  async ensurePage() {
    const wantedMode = this.viewerStarted && this.bot?.entity ? 'viewer' : 'blank';

    if (this.page && !this.page.isClosed() && this.pageMode === wantedMode) {
      return this.page;
    }

    await this.closePage();

    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    await page.setViewport({
      width: this.width,
      height: this.height,
      deviceScaleFactor: 1
    });

    page.on('pageerror', error => {
      console.error('Ошибка страницы скриншота:', error.message);
    });

    if (wantedMode === 'viewer') {
      let lastError = null;

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          await page.goto(`http://127.0.0.1:${this.port}`, {
            waitUntil: 'domcontentloaded',
            timeout: 15000
          });
          await page.waitForSelector('canvas', { timeout: 15000 });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await sleep(1000);
        }
      }

      if (lastError) {
        await page.close().catch(() => {});
        throw new Error(`Viewer не открылся: ${lastError.message}`);
      }

      await page.addStyleTag({
        content: `
          html, body { margin: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; background: #111 !important; }
          canvas { display: block !important; width: 100vw !important; height: 100vh !important; }
        `
      });

      await sleep(1800);
    } else {
      await page.setContent(`
        <!doctype html>
        <html>
          <head><meta charset="utf-8"></head>
          <body style="margin:0;width:100vw;height:100vh;overflow:hidden;background:linear-gradient(#202a35,#0d1015);"></body>
        </html>
      `, { waitUntil: 'domcontentloaded' });
    }

    this.page = page;
    this.pageMode = wantedMode;
    return page;
  }

  async injectOverlay(page, data) {
    await page.evaluate(payload => {
      document.getElementById('mcbot-overlay')?.remove();

      const root = document.createElement('div');
      root.id = 'mcbot-overlay';
      root.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'pointer-events:none',
        'font-family:Arial,sans-serif',
        'color:#fff',
        'text-shadow:0 2px 3px #000,0 0 3px #000'
      ].join(';');

      if (payload.mapDataUrl) {
        const dimmer = document.createElement('div');
        dimmer.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,.58)';
        root.appendChild(dimmer);

        const mapFrame = document.createElement('div');
        mapFrame.style.cssText = [
          'position:absolute',
          'left:50%',
          'top:50%',
          'transform:translate(-50%,-50%)',
          'width:min(58vw,560px)',
          'height:min(58vw,560px)',
          'max-height:76vh',
          'aspect-ratio:1/1',
          'padding:12px',
          'box-sizing:border-box',
          'background:#7a5235',
          'border:8px solid #3b2518',
          'box-shadow:0 18px 60px rgba(0,0,0,.75)'
        ].join(';');

        const mapImage = document.createElement('img');
        mapImage.src = payload.mapDataUrl;
        mapImage.style.cssText = 'width:100%;height:100%;object-fit:contain;image-rendering:pixelated;background:#1e1e1e;display:block';
        mapFrame.appendChild(mapImage);
        root.appendChild(mapFrame);

        const mapTitle = document.createElement('div');
        mapTitle.style.cssText = 'position:absolute;left:50%;top:18px;transform:translateX(-50%);padding:9px 15px;border-radius:9px;background:rgba(0,0,0,.72);font-size:18px;font-weight:700';
        mapTitle.textContent = 'Карта в руке / капча';
        root.appendChild(mapTitle);
      } else {
        const crosshair = document.createElement('div');
        crosshair.style.cssText = 'position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%)';
        crosshair.innerHTML = '<div style="position:absolute;left:10px;top:0;width:2px;height:22px;background:#fff;box-shadow:0 0 2px #000"></div><div style="position:absolute;left:0;top:10px;width:22px;height:2px;background:#fff;box-shadow:0 0 2px #000"></div>';
        root.appendChild(crosshair);
      }

      const status = document.createElement('div');
      status.style.cssText = 'position:absolute;left:18px;top:18px;max-width:430px;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,.58);font-size:17px;line-height:1.4;white-space:pre-wrap';
      status.textContent = payload.status;
      root.appendChild(status);

      if (payload.windowTitle) {
        const windowTitle = document.createElement('div');
        windowTitle.style.cssText = 'position:absolute;right:18px;top:18px;max-width:360px;padding:9px 15px;border-radius:9px;background:rgba(0,0,0,.64);font-size:18px;font-weight:700';
        windowTitle.textContent = `Открыто меню: ${payload.windowTitle}`;
        root.appendChild(windowTitle);
      }

      if (payload.messages.length) {
        const chat = document.createElement('div');
        chat.style.cssText = 'position:absolute;left:18px;bottom:92px;max-width:760px;padding:10px 12px;border-radius:9px;background:rgba(0,0,0,.48);font-size:15px;line-height:1.35;white-space:pre-wrap';
        chat.textContent = payload.messages.join('\n');
        root.appendChild(chat);
      }

      const hotbar = document.createElement('div');
      hotbar.style.cssText = 'position:absolute;left:50%;bottom:20px;transform:translateX(-50%);display:flex;gap:4px;padding:5px;border-radius:7px;background:rgba(0,0,0,.62)';

      payload.hotbar.forEach((item, index) => {
        const slot = document.createElement('div');
        slot.style.cssText = [
          'width:74px',
          'height:54px',
          'box-sizing:border-box',
          'padding:5px',
          'display:flex',
          'align-items:center',
          'justify-content:center',
          'text-align:center',
          'font-size:11px',
          'line-height:1.15',
          'background:rgba(55,55,55,.82)',
          `border:${index === payload.selectedSlot ? '3px solid #fff' : '2px solid rgba(210,210,210,.45)'}`
        ].join(';');
        slot.textContent = item || String(index + 1);
        hotbar.appendChild(slot);
      });

      root.appendChild(hotbar);
      document.body.appendChild(root);
    }, data);
  }

  async capture(data) {
    if (this.capturePromise) return this.capturePromise;

    this.capturePromise = (async () => {
      const page = await this.ensurePage();
      await this.injectOverlay(page, data);
      await sleep(350);

      return page.screenshot({
        type: 'png',
        captureBeyondViewport: false
      });
    })();

    try {
      return await this.capturePromise;
    } catch (error) {
      await this.closePage();
      throw error;
    } finally {
      this.capturePromise = null;
    }
  }
}

module.exports = { ScreenService };
