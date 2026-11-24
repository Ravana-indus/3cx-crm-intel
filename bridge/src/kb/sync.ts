import type { ElevenLabsClient } from '../elevenlabs/types.js';
import type { KbDocRow, KbRepo } from '../repo/kb.js';
import type { Logger } from '../util/logger.js';

export interface KbSyncResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  attached: number;
}

export class KbSyncer {
  constructor(
    private readonly kb: KbRepo,
    private readonly elevenlabs: ElevenLabsClient,
    private readonly log: Logger,
  ) {}

  async sync(now = new Date()): Promise<KbSyncResult> {
    const result: KbSyncResult = {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      attached: 0,
    };

    for (const doc of this.kb.list()) {
      if (!this.kb.needsSync(doc)) {
        result.skipped += 1;
        continue;
      }

      const payload = { name: doc.title, text: doc.body_md };

      if (doc.el_doc_id) {
        await this.elevenlabs.updateKnowledgeDoc(doc.el_doc_id, payload);
        this.kb.markSynced(doc.id, doc.el_doc_id, now);
        result.updated += 1;
      } else {
        const remote = await this.elevenlabs.createKnowledgeDoc(payload);
        this.kb.markSynced(doc.id, remote.id, now);
        result.created += 1;
      }
    }

    const synced = this.kb
      .list()
      .filter((doc): doc is KbDocRow & { el_doc_id: string } => Boolean(doc.el_doc_id));

    await this.elevenlabs.attachKnowledgeBase(
      synced.map((doc) => ({ id: doc.el_doc_id, name: doc.title })),
    );
    result.attached = synced.length;

    this.log.info(result, 'knowledge base synced');
    return result;
  }

  /** Removing a document locally also removes it from ElevenLabs. */
  async delete(doc: KbDocRow): Promise<void> {
    if (!doc.el_doc_id) return;
    await this.elevenlabs.deleteKnowledgeDoc(doc.el_doc_id);

    const remaining = this.kb
      .list()
      .filter((entry) => entry.id !== doc.id && Boolean(entry.el_doc_id))
      .map((entry) => ({ id: entry.el_doc_id as string, name: entry.title }));

    await this.elevenlabs.attachKnowledgeBase(remaining);
  }
}
