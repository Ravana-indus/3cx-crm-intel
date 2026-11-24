/**
 * Phase 0 recon helper. Opens a visible Chromium with a persistent profile,
 * records a HAR of the 3CX web client, and dumps DOM/selector snapshots.
 *
 *   TCX_URL=https://your-3cx.example.com TCX_RECON_SECONDS=300 npm run recon
 *
 * With no TCX_RECON_SECONDS and an interactive terminal, it waits for Enter.
 * The HAR contains cookies and tokens: strip them before sharing it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { loadConfig } from '../src/config.js';

async function dumpDom(
  page: Page,
  dir: string,
  prefix: string,
): Promise<void> {
  try {
    const html = await page.content();
    await writeFile(join(dir, `${prefix}.html`), html, 'utf8');

    const elements = await page.evaluate(() => {
      const doc = (
        globalThis as unknown as { document: { querySelectorAll: (s: string) => ArrayLike<unknown> } }
      ).document;
      const nodes = Array.from(
        doc.querySelectorAll(
          'input, button, a, select, textarea, [role], [data-testid]',
        ),
      ) as unknown[];

      return nodes.slice(0, 3000).map((node) => {
        const element = node as {
          tagName: string;
          innerText?: string;
          id?: string;
          getAttribute: (name: string) => string | null;
        };
        return {
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type'),
          name: element.getAttribute('name'),
          id: element.id || null,
          placeholder: element.getAttribute('placeholder'),
          ariaLabel: element.getAttribute('aria-label'),
          role: element.getAttribute('role'),
          testId: element.getAttribute('data-testid'),
          text: (element.innerText || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 120),
        };
      });
    });

    const storage = await page.evaluate(() => {
      const scope = globalThis as unknown as {
        localStorage: Storage;
        sessionStorage: Storage;
      };
      return {
        local: Object.keys(scope.localStorage),
        session: Object.keys(scope.sessionStorage),
      };
    });

    await writeFile(
      join(dir, `${prefix}-elements.json`),
      JSON.stringify(elements, null, 2),
      'utf8',
    );
    await writeFile(
      join(dir, `${prefix}-storage-keys.json`),
      JSON.stringify(storage, null, 2),
      'utf8',
    );

    console.log(
      `DOM snapshot written: ${prefix}.html, ${prefix}-elements.json, ${prefix}-storage-keys.json`,
    );
  } catch (error) {
    console.warn('DOM snapshot failed:', error);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.tcxUrl) {
    throw new Error('Set TCX_URL in .env or the environment before running recon');
  }

  const reconDir = join(process.cwd(), 'data', 'recon');
  await mkdir(reconDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const harPath = join(reconDir, `3cx-${stamp}.har`);

  const context: BrowserContext = await chromium.launchPersistentContext(
    config.chromiumProfileDir,
    {
      headless: false,
      acceptDownloads: true,
      recordHar: { path: harPath, content: 'embed' },
      args: [
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  );

  const page = context.pages()[0] ?? (await context.newPage());
  await page
    .goto(`${config.tcxUrl.replace(/\/$/, '')}/webclient/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    .catch(() => undefined);
  await page.bringToFront().catch(() => undefined);
  console.log(`Opened ${page.url()} — title: ${await page.title().catch(() => '')}`);

  if (config.tcxServiceUser && config.tcxServicePassword) {
    const username = page
      .locator(
        '#loginInput, input[name="username"], input[name="extension"], input[name="email"], input[type="text"]',
      )
      .first();
    if ((await username.count()) > 0) {
      await username.fill(config.tcxServiceUser);
      const password = page
        .locator('#passwordInput, input[type="password"], input[name="password"]')
        .first();
      if ((await password.count()) > 0) {
        await password.fill(config.tcxServicePassword);
      }
      const submit = page
        .locator(
          '#submitBtn, button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")',
        )
        .first();
      if ((await submit.count()) > 0) {
        await submit.click().catch(() => page.keyboard.press('Enter'));
      } else {
        await page.keyboard.press('Enter');
      }
    }
  }

  let closing = false;
  let snapshotIndex = 0;
  let lastUrl = '';
  const snapshotTimer = setInterval(() => {
    if (closing) return;
    const current = page.url();
    if (!current || current === lastUrl) return;
    lastUrl = current;
    snapshotIndex += 1;
    void dumpDom(
      page,
      reconDir,
      `dom-${stamp}-${String(snapshotIndex).padStart(2, '0')}`,
    );
  }, 5_000);
  snapshotTimer.unref();

  const finish = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(snapshotTimer);
    console.log(`\nFinishing recon (${reason})...`);
    await dumpDom(page, reconDir, `dom-${stamp}-final`).catch(() => undefined);
    await context.close().catch(() => undefined);
    console.log(`HAR written to ${harPath}`);
    console.log(`Next: npm run probe -- ${harPath}`);
    process.exit(0);
  };

  process.on('SIGINT', () => void finish('SIGINT'));
  process.on('SIGTERM', () => void finish('SIGTERM'));

  const durationSec = Number(process.env.TCX_RECON_SECONDS ?? '0');
  const nonInteractive = !input.isTTY || durationSec > 0;

  if (nonInteractive) {
    const seconds = durationSec > 0 ? durationSec : 300;
    console.log(
      [
        '',
        'Chromium is open. In that window:',
        '  1. Log in as the 3CX SERVICE user (not a personal account).',
        '  2. Open Call History and let it load.',
        '  3. Open Recordings and play one.',
        '  4. Open the softphone / set DND once (for the AI extension later).',
        '',
        `Recording for ${seconds}s. Create data/recon/.finish or send SIGINT to stop early.`,
      ].join('\n'),
    );

    const sentinel = join(reconDir, '.finish');
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (existsSync(sentinel)) {
        await finish('sentinel');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await finish('timer');
    return;
  }

  const rl = createInterface({ input, output });
  await rl.question(
    [
      '',
      'In the browser window:',
      '  1. Log in as the 3CX service user.',
      '  2. Open Call History and let it load.',
      '  3. Open Recordings and play one.',
      '  4. (Optional) set Do Not Disturb once so the status endpoint is captured.',
      '',
      'Press Enter when done to close Chromium and write the HAR... ',
    ].join('\n'),
  );
  await rl.close();
  await finish('user');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
