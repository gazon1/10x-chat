/**
 * Verifies that the production runtime honours HTTPS_PROXY (Chromium ignores
 * the env vars on its own, so the engine turns them into a launch option).
 *
 * Run: npx tsx spike/verify-proxy.ts
 */

import { getChromium, getEngineName } from '../src/browser/engine.js';
import { createHttpProxy, listen } from './camoufox/proxies.mjs';

const proxy = createHttpProxy();
const port = await listen(proxy.server);
process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
process.env.NO_PROXY = 'localhost,127.0.0.1,::1';

const chromium = await getChromium();
console.log('engine:', getEngineName());
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const response = await page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded' });
console.log('status:', response?.status());
console.log('body:', (await page.textContent('body'))?.trim());
await browser.close();

const tunnelled = proxy.log.filter((entry) => entry.status === 200);
console.log('proxy tunnelled:', JSON.stringify(tunnelled));
if (tunnelled.length === 0) {
  console.error('FAIL: the browser did not go through the proxy');
  process.exit(1);
}
console.log('PASS: the browser went through HTTPS_PROXY');
process.exit(0);
