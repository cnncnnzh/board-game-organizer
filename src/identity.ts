import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Database } from './db.js';
import { validateName } from './domain/validation.js';

export interface Actor { participantId: string; sessionHash: string }
export const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');

export class IdentityService {
  constructor(private db: Database, private days = 180) {}
  async lookup(token?: string): Promise<Actor | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const sessionHash = hashSecret(token);
    const row = (await this.db.query(`SELECT s.participant_id FROM sessions s JOIN participants p ON p.id=s.participant_id
      WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND NOT p.is_test`, [sessionHash])).rows[0];
    return row ? { participantId: row.participant_id, sessionHash } : null;
  }
  async get(actor: Actor | null) {
    if (!actor) return null;
    const p = (await this.db.query('SELECT id,display_name FROM participants WHERE id=$1', [actor.participantId])).rows[0];
    return p ? { id: p.id, displayName: p.display_name } : null;
  }
  async create(displayName: unknown) {
    const name = validateName(displayName);
    const participantId = randomUUID(), token = newSecret(), sessionHash = hashSecret(token);
    await this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO participants(id,display_name) VALUES($1,$2)', [participantId, name]);
      await tx.query('INSERT INTO sessions(token_hash,participant_id,expires_at) VALUES($1,$2,$3)',
        [sessionHash, participantId, new Date(Date.now() + this.days * 86400000).toISOString()]);
    });
    return { actor: { participantId, sessionHash }, token, participant: { id: participantId, displayName: name } };
  }
  async rename(actor: Actor, displayName: unknown) {
    const name = validateName(displayName);
    await this.db.query('UPDATE participants SET display_name=$1 WHERE id=$2', [name, actor.participantId]);
    return { id: actor.participantId, displayName: name };
  }
}
