/* Dev-only: boot the local dev server, render the redesigned pages to shots/,
   report computed layout facts, then shut the server down. */
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';

const NODE = process.execPath;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 8942;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const server = spawn(NODE, ['dev-server.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

const waitPort = (tries = 60) => new Promise((resolve, reject) => {
  const attempt = (n) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(); });
    s.on('error', () => {
      s.destroy();
      if (n <= 0) reject(new Error('server never came up'));
      else setTimeout(() => attempt(n - 1), 200);
    });
  };
  attempt(tries);
});

let browser;
try {
  await waitPort();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });

  const targets = [
    { name: 'index-desktop', url: '/index.html', w: 1280, h: 900, full: false },
    { name: 'index-full', url: '/index.html', w: 1280, h: 900, full: true },
    { name: 'index-mobile', url: '/index.html', w: 390, h: 844, full: true },
    { name: 'index-api', url: '/index.html', w: 1280, h: 900, full: false, scrollTo: '.api-band' },
    { name: 'login-desktop', url: '/login.html', w: 1280, h: 800, full: false },
    { name: 'restricted-desktop', url: '/access-restricted.html?reason=not_listed', w: 1280, h: 800, full: false },
  ];

  for (const t of targets) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    await page.setViewport({ width: t.w, height: t.h, deviceScaleFactor: 1 });
    await page.goto(BASE + t.url, { waitUntil: 'networkidle0' });
    // Headless Chrome only runs IntersectionObserver callbacks once it starts
    // producing frames; force a couple of frames before probing.
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    await new Promise(r => setTimeout(r, 900));

    if (t.scrollTo) {
      await page.evaluate((sel) => {
        document.querySelector(sel).scrollIntoView({ block: 'center' });
      }, t.scrollTo);
      await new Promise(r => setTimeout(r, 800));
    } else if (t.full) {
      // Walk the page so every reveal-on-scroll section has fired before the
      // full-page capture, then return to the top.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 300) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
      });
      await new Promise(r => setTimeout(r, 700));
    }

    const probe = await page.evaluate(() => {
      const r = (s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
      };
      const t = document.querySelector('.hero-title');
      return {
        reveals: document.querySelectorAll('.reveal').length,
        visible: document.querySelectorAll('.reveal.is-visible').length,
        heroTitleOpacity: t ? getComputedStyle(t).opacity : 'n/a',
        hero: r('.hero'), title: r('.hero-title'), preview: r('.preview-card'),
      };
    });
    console.log(`[${t.name}]`, JSON.stringify(probe), errs.length ? 'ERRORS ' + errs.join('|') : '');

    await page.screenshot({ path: path.join(OUT, `${t.name}.png`), fullPage: t.full });
    await page.close();
  }

  // Header state over the hero vs. after it.
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 600));
  const read = () => page.evaluate(() => {
    const h = document.querySelector('[data-header]');
    const b = h.getBoundingClientRect();
    return {
      scrolled: h.classList.contains('is-scrolled'),
      bg: getComputedStyle(h).backgroundColor,
      pos: getComputedStyle(h).position,
      top: Math.round(b.top),
    };
  });
  console.log('header@top    ', JSON.stringify(await read()));
  await page.evaluate(() => window.scrollTo(0, 1500));
  await new Promise(r => setTimeout(r, 500));
  console.log('header@scroll ', JSON.stringify(await read()));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise(r => setTimeout(r, 400));
  console.log('header@back   ', JSON.stringify(await read()));
  await page.close();
} finally {
  if (browser) await browser.close();
  server.kill();
}
