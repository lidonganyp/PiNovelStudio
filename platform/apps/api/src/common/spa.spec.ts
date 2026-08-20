/**
 * 生产静态站点解析：非生产且未显式指定时不托管。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWebDist } from './spa';

describe('resolveWebDist', () => {
  it('ignores missing dist in development', () => {
    expect(resolveWebDist('test', '', process.cwd())).toBeNull();
  });

  it('uses an explicit directory that contains index.html', () => {
    const dir = join(tmpdir(), `platform-web-dist-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    expect(resolveWebDist('test', dir)).toBe(dir);
  });
});
