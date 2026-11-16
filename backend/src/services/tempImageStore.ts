import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 분석용 이미지 임시 저장소
 *
 *  - 이미지마다 랜덤 AES-256-GCM 키를 만들어 암호화한 뒤 디스크(임시 디렉터리)에 저장한다.
 *  - 키는 이 프로세스의 메모리에만 있다. 파일이 남더라도 키 없이는 복호화할 수 없다.
 *  - 파기(purge): 파일을 0으로 덮어쓰고 삭제 + 키를 0으로 지우고 버린다 (crypto-shredding).
 *    SSD/저널링 파일시스템에서 덮어쓰기가 보장되지 않아도, 키가 사라지면 남은 암호문은 쓸모가 없다.
 *  - 프로세스가 죽으면 키가 사라지므로, 재시작 시 남은 파일은 오래된 것부터 정리한다.
 */

interface Entry {
  file: string;
  key: Buffer;
  iv: Buffer;
  tag: Buffer;
  size: number;
  storedAt: number;
}

export class TempImageStore {
  private readonly entries = new Map<string, Entry>();
  private readonly dir: string;
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(os.tmpdir(), 'diet-analysis');
    // 프로세스마다 별도 하위 디렉터리 (같은 서버에서 여러 프로세스가 돌 때 서로 지우지 않도록)
    this.dir = path.join(this.baseDir, `${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  }

  get directory(): string {
    return this.dir;
  }

  get count(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  private fileFor(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid id');
    return path.join(this.dir, `${id}.bin`);
  }

  async put(id: string, image: Buffer): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(image), cipher.final()]);
    const tag = cipher.getAuthTag();
    const file = this.fileFor(id);
    await fs.writeFile(file, encrypted, { mode: 0o600, flag: 'wx' });
    this.entries.set(id, { file, key, iv, tag, size: encrypted.length, storedAt: Date.now() });
  }

  /** 보관 시간(TTL)을 넘긴 이미지를 DB 상태와 무관하게 강제로 파기 (절대 TTL 보장) */
  async purgeOlderThan(maxAgeMs: number): Promise<string[]> {
    const now = Date.now();
    const old = [...this.entries.entries()].filter(([, e]) => now - e.storedAt > maxAgeMs).map(([id]) => id);
    await Promise.all(old.map((id) => this.purge(id)));
    return old;
  }

  /** 복호화한 이미지 (사용 후 호출자가 fill(0) 으로 지운다) */
  async read(id: string): Promise<Buffer | null> {
    const e = this.entries.get(id);
    if (!e) return null;
    const encrypted = await fs.readFile(e.file);
    const decipher = crypto.createDecipheriv('aes-256-gcm', e.key, e.iv);
    decipher.setAuthTag(e.tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /** 파기: 키 폐기 + 파일 덮어쓰기 후 삭제. 여러 번 호출해도 안전하다. */
  async purge(id: string): Promise<void> {
    const e = this.entries.get(id);
    this.entries.delete(id);
    if (!e) return;
    e.key.fill(0);
    e.iv.fill(0);
    try {
      const fh = await fs.open(e.file, 'r+');
      try {
        await fh.write(Buffer.alloc(e.size), 0, e.size, 0);
        await fh.sync();
      } finally {
        await fh.close();
      }
    } catch {
      // 파일이 이미 없으면 무시
    }
    await fs.rm(e.file, { force: true });
  }

  async purgeAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.purge(id)));
  }

  /**
   * 시작 시 정리: 다른(죽은) 프로세스가 남긴 임시 파일 중 maxAgeMs 보다 오래된 것을 삭제.
   * (키가 없어 복호화할 수 없는 파일들이다)
   */
  async sweepOrphans(maxAgeMs: number): Promise<number> {
    let removed = 0;
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(this.baseDir);
    } catch {
      return 0;
    }
    const now = Date.now();
    for (const d of dirs) {
      const full = path.join(this.baseDir, d);
      if (full === this.dir) continue;
      let files: string[] = [];
      try {
        files = await fs.readdir(full);
      } catch {
        continue;
      }
      for (const f of files) {
        const fp = path.join(full, f);
        try {
          const st = await fs.stat(fp);
          if (now - st.mtimeMs > maxAgeMs) {
            await fs.rm(fp, { force: true });
            removed += 1;
          }
        } catch {
          // ignore
        }
      }
      try {
        if ((await fs.readdir(full)).length === 0) await fs.rmdir(full);
      } catch {
        // ignore
      }
    }
    return removed;
  }
}
