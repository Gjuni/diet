import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TempImageStore } from '../src/services/tempImageStore.js';

const dirs: string[] = [];
async function tmpBase() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'diet-test-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const IMAGE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('FOOD-PHOTO-PIXELS-'.repeat(200))]);

describe('분석용 이미지 임시 저장 (암호화) → 파기', () => {
  it('디스크에는 암호문만 저장되고, 복호화하면 원본과 같다', async () => {
    const store = new TempImageStore(await tmpBase());
    const id = crypto.randomUUID();
    await store.put(id, IMAGE);
    const files = await fs.readdir(store.directory);
    expect(files).toEqual([`${id}.bin`]);
    const onDisk = await fs.readFile(path.join(store.directory, files[0]!));
    expect(onDisk.includes(Buffer.from('FOOD-PHOTO-PIXELS'))).toBe(false);
    expect(onDisk.equals(IMAGE)).toBe(false);
    expect((await store.read(id))!.equals(IMAGE)).toBe(true);
  });

  it('파기하면 파일이 지워지고 다시 읽을 수 없다 (여러 번 호출해도 안전)', async () => {
    const store = new TempImageStore(await tmpBase());
    const id = crypto.randomUUID();
    await store.put(id, IMAGE);
    await store.purge(id);
    await store.purge(id);
    expect(store.has(id)).toBe(false);
    expect(await store.read(id)).toBeNull();
    expect(await fs.readdir(store.directory)).toEqual([]);
  });

  it('TTL 을 넘긴 이미지는 강제 파기', async () => {
    const store = new TempImageStore(await tmpBase());
    const a = crypto.randomUUID();
    await store.put(a, IMAGE);
    await new Promise((r) => setTimeout(r, 30));
    const b = crypto.randomUUID();
    await store.put(b, IMAGE);
    expect(await store.purgeOlderThan(20)).toEqual([a]);
    expect(store.has(a)).toBe(false);
    expect(store.has(b)).toBe(true);
  });

  it('다른(죽은) 프로세스가 남긴 오래된 임시 파일을 정리한다', async () => {
    const base = await tmpBase();
    const orphanDir = path.join(base, '999-deadbeef');
    await fs.mkdir(orphanDir);
    const orphan = path.join(orphanDir, `${crypto.randomUUID()}.bin`);
    await fs.writeFile(orphan, 'x');
    const old = new Date(Date.now() - 10 * 60_000);
    await fs.utimes(orphan, old, old);

    const store = new TempImageStore(base);
    const mine = crypto.randomUUID();
    await store.put(mine, IMAGE);
    expect(await store.sweepOrphans(5 * 60_000)).toBe(1);
    await expect(fs.stat(orphanDir)).rejects.toThrow(); // 빈 디렉터리도 삭제
    expect(store.has(mine)).toBe(true);
  });

  it('잘못된 ID 로 경로 조작 불가', async () => {
    const store = new TempImageStore(await tmpBase());
    await expect(store.put('../../etc/passwd', IMAGE)).rejects.toThrow();
  });
});
