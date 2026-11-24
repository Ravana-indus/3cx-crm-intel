import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KbRepo } from '../repo/kb.js';
import type { Logger } from '../util/logger.js';

export interface ParsedMarkdown {
  fields: Record<string, string>;
  body: string;
}

export function parseFrontmatter(content: string): ParsedMarkdown {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { fields: {}, body: content.trim() };

  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && value) fields[key] = value;
  }

  return {
    fields,
    body: content.slice(match[0].length).trim(),
  };
}

function titleFrom(filename: string, body: string): string {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return filename.replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
}

/**
 * On first start, load ./kb/*.md into kb_docs. Frontmatter is optional:
 *   ---
 *   title: ...
 *   tags: fees, germany
 *   owner: Patu
 *   review_by: 2026-12-31
 *   ---
 */
export function seedKnowledgeBase(
  kb: KbRepo,
  seedDir: string,
  log: Logger,
): number {
  if (kb.count() > 0) return 0;

  const dir = resolve(process.cwd(), seedDir);
  if (!existsSync(dir)) {
    log.warn({ dir }, 'knowledge-base seed folder not found');
    return 0;
  }

  const files = readdirSync(dir).filter(
    (name) => name.endsWith('.md') && !/^readme/i.test(name),
  );

  let inserted = 0;
  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf8');
    const { fields, body } = parseFrontmatter(content);
    if (!body.trim()) continue;

    kb.create({
      title: fields.title ?? titleFrom(file, body),
      bodyMd: body,
      tags: fields.tags ?? null,
      owner: fields.owner ?? null,
      reviewBy: fields.review_by ?? fields.reviewby ?? null,
    });
    inserted += 1;
  }

  if (inserted > 0) log.info({ inserted, dir }, 'seeded knowledge base');
  return inserted;
}
