import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, seedKnowledgeBase } from '../src/kb/seed.js';
import { testContext } from './helpers.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), '3cx-kb-'));
  tempDirs.push(dir);
  return dir;
}

describe('knowledge base', () => {
  it('parses frontmatter and seeds only when empty', () => {
    const ctx = testContext();
    const dir = tempDir();

    writeFileSync(
      join(dir, 'office.md'),
      [
        '---',
        'title: Office hours and locations',
        'tags: hours, contact',
        'owner: Patu',
        'review_by: 2026-12-31',
        '---',
        'We are open 09:00-17:00.',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'germany.md'),
      '# Germany Opportunity Card\n\nEligibility and fees.\n',
    );
    writeFileSync(join(dir, 'README.md'), '# ignored\n');

    try {
      expect(parseFrontmatter('---\ntitle: X\n---\nBody').fields.title).toBe('X');

      const seeded = seedKnowledgeBase(ctx.kb, dir, ctx.log);
      expect(seeded).toBe(2);
      expect(seedKnowledgeBase(ctx.kb, dir, ctx.log)).toBe(0);

      const docs = ctx.kb.list();
      const titles = docs.map((doc) => doc.title).sort();
      expect(titles).toEqual([
        'Germany Opportunity Card',
        'Office hours and locations',
      ]);
      const office = docs.find((doc) => doc.title === 'Office hours and locations');
      expect(office?.owner).toBe('Patu');
      expect(office?.review_by).toBe('2026-12-31');
      expect(office?.tags).toBe('hours, contact');
    } finally {
      ctx.db.close();
    }
  });

  it('syncs creates, updates and deletes against ElevenLabs', async () => {
    const ctx = testContext();

    try {
      const dir = tempDir();
      writeFileSync(join(dir, 'fees.md'), '# Fees\n\nFees are reviewed yearly.');
      seedKnowledgeBase(ctx.kb, dir, ctx.log);

      const first = await ctx.kbSyncer.sync();
      expect(first.created).toBe(1);
      expect(first.attached).toBe(1);
      expect(ctx.elevenlabs.remoteDocs()).toHaveLength(1);
      expect(ctx.elevenlabs.attachedDocs()).toHaveLength(1);

      const doc = ctx.kb.list()[0];
      expect(doc.el_doc_id).toBeTruthy();
      expect(doc.synced_at).toBeTruthy();

      const second = await ctx.kbSyncer.sync();
      expect(second.skipped).toBe(1);
      expect(second.created).toBe(0);

      const updated = ctx.kb.update(doc.id, { bodyMd: '# Fees\n\nNew fee table.' });
      expect(ctx.kb.needsSync(updated as never)).toBe(true);
      const third = await ctx.kbSyncer.sync();
      expect(third.updated).toBe(1);

      await ctx.kbSyncer.delete(ctx.kb.get(doc.id) as never);
      expect(ctx.elevenlabs.remoteDocs()).toHaveLength(0);
      expect(ctx.elevenlabs.attachedDocs()).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  it('lists documents past their review date', () => {
    const ctx = testContext();

    try {
      ctx.kb.create({
        title: 'Old fee list',
        bodyMd: 'Fees from last year',
        reviewBy: '2026-01-01',
      });
      ctx.kb.create({
        title: 'Current visa rules',
        bodyMd: 'Current',
        reviewBy: '2027-01-01',
      });

      const stale = ctx.kb.stale('2026-11-23');
      expect(stale.map((doc) => doc.title)).toEqual(['Old fee list']);
    } finally {
      ctx.db.close();
    }
  });
});
