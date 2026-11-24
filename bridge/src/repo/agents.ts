import type { Db } from '../db/index.js';

export interface AgentRow {
  ext: string;
  name: string | null;
  email: string | null;
  team: string | null;
  active: number;
  user_id: string | null;
}

export interface UpsertAgentInput {
  ext: string;
  name?: string | null;
  email?: string | null;
  team?: string | null;
  active?: boolean;
  userId?: string | null;
}

export class AgentsRepo {
  constructor(private readonly db: Db) {}

  get(ext: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agents WHERE ext = ?').get(ext) as
      | AgentRow
      | undefined;
  }

  list(includeInactive = true): AgentRow[] {
    const clause = includeInactive ? '' : 'WHERE active = 1';
    return this.db
      .prepare(`SELECT * FROM agents ${clause} ORDER BY ext ASC`)
      .all() as AgentRow[];
  }

  upsert(input: UpsertAgentInput): AgentRow {
    const existing = this.get(input.ext);

    const merged = {
      ext: input.ext,
      name: input.name !== undefined ? input.name : (existing?.name ?? null),
      email: input.email !== undefined ? input.email : (existing?.email ?? null),
      team: input.team !== undefined ? input.team : (existing?.team ?? null),
      active:
        input.active !== undefined
          ? input.active
            ? 1
            : 0
          : (existing?.active ?? 1),
      user_id:
        input.userId !== undefined
          ? input.userId
          : (existing?.user_id ?? null),
    };

    this.db
      .prepare(
        `INSERT INTO agents (ext, name, email, team, active, user_id)
         VALUES (@ext, @name, @email, @team, @active, @user_id)
         ON CONFLICT(ext) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           team = excluded.team,
           active = excluded.active,
           user_id = excluded.user_id`,
      )
      .run(merged);

    return this.get(input.ext) as AgentRow;
  }
}
