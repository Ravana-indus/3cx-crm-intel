/**
 * Parses a recorded HAR and writes data/recon/contract.md: every /xapi request
 * with method, status, query keys and a response key skeleton. Values are
 * never printed, so the report is safe to share.
 *
 *   npm run probe -- data/recon/3cx-<stamp>.har
 *   npm run probe            # uses the newest HAR in data/recon
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface HarEntry {
  request: {
    method: string;
    url: string;
    queryString?: Array<{ name: string }>;
    postData?: { mimeType?: string; text?: string };
  };
  response: {
    status: number;
    mimeType?: string;
    content?: { text?: string; encoding?: string; mimeType?: string };
  };
}

interface HarFile {
  log: { entries: HarEntry[] };
}

function newestHar(): string {
  const dir = join(process.cwd(), 'data', 'recon');
  if (!existsSync(dir)) throw new Error('No data/recon directory');
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.har'))
    .sort();
  const latest = files[files.length - 1];
  if (!latest) throw new Error('No HAR files in data/recon');
  return join(dir, latest);
}

function skeleton(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) {
    return value.length > 0 ? [skeleton(value[0], depth + 1)] : [];
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= 2) return '{...}';
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = skeleton(entry, depth + 1);
    }
    return result;
  }
  return typeof value;
}

function decodeBody(entry: HarEntry): string | null {
  const content = entry.response.content;
  if (!content?.text) return null;
  if (content.encoding === 'base64') {
    return Buffer.from(content.text, 'base64').toString('utf8');
  }
  return content.text;
}

function pathOf(rawUrl: string): { origin: string; path: string } {
  try {
    const url = new URL(rawUrl);
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { origin: '', path: rawUrl };
  }
}

function main(): void {
  const arg = process.argv[2];
  const harPath = arg ?? newestHar();
  const har = JSON.parse(readFileSync(harPath, 'utf8')) as HarFile;

  const groups = new Map<
    string,
    {
      method: string;
      path: string;
      status: number;
      queryKeys: Set<string>;
      responseSkeleton: string;
      counts: number;
    }
  >();

  for (const entry of har.log.entries) {
    const { path } = pathOf(entry.request.url);
    const isJson =
      (entry.response.mimeType ?? '').includes('json') ||
      (entry.response.content?.mimeType ?? '').includes('json');
    const relevant =
      path.includes('/xapi/') || isJson || path.toLowerCase().includes('call');

    if (!relevant) continue;

    const key = `${entry.request.method} ${path}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        method: entry.request.method,
        path,
        status: entry.response.status,
        queryKeys: new Set(),
        responseSkeleton: '',
        counts: 0,
      };
      groups.set(key, group);
    }

    group.counts += 1;
    for (const query of entry.request.queryString ?? []) {
      group.queryKeys.add(query.name);
    }

    if (!group.responseSkeleton) {
      const body = decodeBody(entry);
      if (body) {
        try {
          const parsed: unknown = JSON.parse(body);
          group.responseSkeleton = JSON.stringify(skeleton(parsed), null, 2);
        } catch {
          group.responseSkeleton = '(non-JSON body)';
        }
      }
    }
  }

  const lines: string[] = [
    '# 3CX endpoint contract (from HAR)',
    '',
    `Source: \`${harPath}\``,
    '',
    'Values are intentionally omitted; only paths, query keys and response shapes.',
    '',
  ];

  for (const group of [...groups.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  )) {
    lines.push(`## ${group.method} ${group.path}`);
    lines.push('');
    lines.push(`- Seen: ${group.counts}`);
    lines.push(`- Last status: ${group.status}`);
    lines.push(
      `- Query keys: ${group.queryKeys.size > 0 ? [...group.queryKeys].join(', ') : '(none)'}`,
    );
    if (group.responseSkeleton) {
      lines.push('- Response skeleton:');
      lines.push('');
      lines.push('```json');
      lines.push(group.responseSkeleton);
      lines.push('```');
    }
    lines.push('');
  }

  const outPath = join(process.cwd(), 'data', 'recon', 'contract.md');
  mkdirSync(join(process.cwd(), 'data', 'recon'), { recursive: true });
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(
    `Found ${groups.size} endpoints. Use them to fill src/threecx/live/xapi.ts and session selectors.`,
  );
}

main();
