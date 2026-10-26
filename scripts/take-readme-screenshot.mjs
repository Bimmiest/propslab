// ---------------------------------------------------------------------------
// take-readme-screenshot.mjs
//
// Takes the README's screenshot, docs/assets/demo.png, the same way each
// time: the Palo Alto Firewall example in Preview › Extractions, in the dark
// theme, at 1440x900, with the first-run banner dismissed. Take it again when
// a change alters what it shows, so the README does not show an app that no
// longer exists.
//
// It serves the build with Vite's preview server, on a free port, and stops
// the server when it is done.
//
// Usage: npm run screenshot:readme   (builds first; needs Playwright's Chromium)
// ---------------------------------------------------------------------------

import { chromium } from '@playwright/test';
import { preview } from 'vite';

const OUT = 'docs/assets/demo.png';
const EXAMPLE = /Palo Alto/;

const server = await preview({ preview: { port: 0, host: '127.0.0.1' }, logLevel: 'warn' });
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('vite preview reported no URL');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    localStorage.setItem('propslab:theme', 'dark');
    localStorage.setItem('propslab:seen-intro', 'true');
  });
  await page.goto(url);
  await page.locator('.monaco-editor').first().waitFor({ timeout: 30_000 });
  await page.getByRole('banner').getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('group', { name: 'Examples' }).getByRole('button', { name: EXAMPLE }).click();
  await page.getByText(/^[1-9]\d* events?$/).waitFor({ timeout: 30_000 });
  await page.getByRole('tab', { name: 'Extractions' }).click();

  // The two settings the picture depends on, checked rather than assumed: a
  // renamed storage key would otherwise give a light screenshot with the banner.
  if ((await page.locator('html.dark').count()) === 0) throw new Error('the page is not in the dark theme');
  if ((await page.getByRole('button', { name: 'Got it' }).count()) > 0) throw new Error('the first-run banner shows');

  // The tab fades in; and the pointer stays off every hover target.
  await page.waitForTimeout(800);
  await page.mouse.move(1439, 899);
  await page.screenshot({ path: OUT });
  console.log(`Wrote ${OUT}`);
} finally {
  await browser.close();
  await server.close();
}
