import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { uuid } from '../uuid';

describe('uuid 非安全上下文降级', () => {
  const orig = globalThis.crypto;
  afterEach(() => { Object.defineProperty(globalThis, 'crypto', { value: orig, configurable: true }); });

  it('安全上下文：用原生 randomUUID', () => {
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('非安全上下文（randomUUID 为 undefined）：降级到 getRandomValues', () => {
    // 模拟 http://纯IP：crypto 存在但没有 randomUUID
    const fake: any = { getRandomValues: (a: Uint8Array) => orig.getRandomValues(a) };
    Object.defineProperty(globalThis, 'crypto', { value: fake, configurable: true });
    expect(globalThis.crypto.randomUUID).toBeUndefined();

    const id = uuid(); // 不能抛错
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe(uuid()); // 应当唯一
  });

  it('完全无 crypto：退到 Math.random', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const id = uuid();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
