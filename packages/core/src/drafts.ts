import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { within } from './security';
import { z } from 'zod';

export class Drafts {
  constructor(readonly root: string) {}
  private file(key: string) {
    if (typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(key))
      throw new Error('Invalid draft key');
    return within(this.root, `.aiide/drafts/${key}.json`, true);
  }
  get(key: string) {
    const file = this.file(key);
    if (!fs.existsSync(file)) return null;
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 256000)
      throw new Error('Draft must be a regular JSON file below 256 KB');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return z
      .object({ version: z.literal(1), data: z.record(z.unknown()) })
      .parse(value).data;
  }
  save(key: string, input: unknown) {
    const file = this.file(key);
    const data = z.record(z.unknown()).parse(input);
    const text = JSON.stringify({ version: 1, data });
    if (Buffer.byteLength(text) > 256000)
      throw new Error('Draft exceeds 256 KB');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = within(
      this.root,
      `.aiide/drafts/${crypto.randomUUID()}.tmp`,
      true,
    );
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return { saved: key };
  }
}
