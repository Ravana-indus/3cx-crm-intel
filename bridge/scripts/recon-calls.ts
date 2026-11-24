/**
 * Second-phase recon: reuse the logged-in Chromium profile from `npm run recon`,
 * open the Calls and Recording tabs, and record a HAR of those requests.
 *
 *   npx tsx scripts/recon-calls.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { loadConfig } from '../src/config.js';

async function dumpDom(page: Page, dir: string, prefix: string): Promise<void> {
  try {
    await writeFile(
      join(dir, `${prefix}.html`),
      await page.content(),
      'utf8',
    );
    const elements = await page.evaluate(() => {
      const doc = (
        globalThis as unknown as {
          document: { querySelectorAll: (s: string) => ArrayLike<unknown> };
        }
      ).document;
      const nodes = Array.from(
        doc.querySelectorAll('a, button, input, [role], [data-testid], tr'),
      ) as unknown[];
      return nodes.slice(0, 4000).map((node) => {
        const element = node as {
          tagName: string;
          innerText?: string;
          id?: string;
          getAttribute: (name: string) => string | null;
        };
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          role: element.getAttribute('role'),
          testId: element.getAttribute('data-testid'),
          ariaLabel: element.getAttribute('aria-label'),
          title: element.getAttribute('title'),
          href: element.getAttribute('href'),
          text: (element.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
        };
      });
    });
    await writeFile(
      join(dir, `${prefix}-elements.json`),
      JSON.stringify(elements, null, 2),
      'utf8',
    );
    console.log(`DOM snapshot: ${prefix}.html / ${prefix}-elements.json`);
  } catch (error) {
    console.warn('DOM dump failed:', error);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.tcxUrl) throw new Error('Set TCX_URL');

  const dir = join(process.cwd(), 'data', 'recon');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const harPath = join(dir, `calls-${stamp}.har`);

  const context = await chromium.launchPersistentContext(
    config.chromiumProfileDir,
    {
      headless: true,
      acceptDownloads: true,
      recordHar: { path: harPath, content: 'embed' },
      args: [
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  );
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(`${config.tcxUrl.replace(/\/$/, '')}/webclient/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(5_000);
    await dumpDom(page, dir, `${stamp}-after-load`);

    if ((await page.locator('#loginInput').count()) > 0) {
      console.log('LOGIN_REQUIRED: profile session expired');
      return;
    }

    const links = await page.locator('a').allTextContents();
    console.log('links:', links.filter(Boolean).slice(0, 30));

    const calls = page.locator('a').filter({ hasText: 'Calls' }).first();
    if ((await calls.count()) > 0) {
      await calls.click({ timeout: 10_000 });
      console.log('clicked Calls');
      await page.waitForTimeout(8_000);
      await dumpDom(page, dir, `${stamp}-calls`);
    } else {
      console.log('Calls link not found');
    }

    const recordings = page
      .locator('a')
      .filter({ hasText: 'Recording' })
      .first();
    if ((await recordings.count()) > 0) {
      await recordings.click({ timeout: 10_000 });
      console.log('clicked Recording');
      await page.waitForTimeout(8_000);
      await dumpDom(page, dir, `${stamp}-recordings`);
    } else {
      console.log('Recording link not found');
    }

    console.log('taking screenshot');
    await page
      .screenshot({ path: join(dir, `${stamp}-screen.png`), timeout: 15_000 })
      .catch((error) => console.warn('screenshot failed:', error));
  } finally {
    await context.close();
    console.log(`HAR written to ${harPath}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
