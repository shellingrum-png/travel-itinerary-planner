import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// 隔离 supabase:只关心请求构造与状态码处理
vi.mock('../auth', () => ({ getAccessToken: async () => 'test-token' }));

import { createShare, revokeShare, fetchSharedTrip } from '../share';

function jsonRes(ok: boolean, status: number, body: any = {}) {
  return { ok, status, json: async () => body } as any;
}

describe('分享服务', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('createShare 带鉴权头,成功返回 token', async () => {
    const fetchMock = vi.fn(async (_url: string, _opts?: any) => jsonRes(true, 200, { ok: true, token: 'abc123' }));
    vi.stubGlobal('fetch', fetchMock);

    const token = await createShare('trip-1');
    expect(token).toBe('abc123');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/share/trip-1');
    expect(opts.method).toBe('POST');
    expect((opts.headers as any).Authorization).toBe('Bearer test-token');
  });

  it('createShare 失败(401/404)抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _opts?: any) => jsonRes(false, 404, {})));
    await expect(createShare('trip-1')).rejects.toThrow(/404/);
  });

  it('createShare 响应缺 token 时抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _opts?: any) => jsonRes(true, 200, { ok: true })));
    await expect(createShare('trip-1')).rejects.toThrow(/token/);
  });

  it('revokeShare 必须检查状态码:500 不能当成功(回归)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _opts?: any) => jsonRes(false, 500, {})));
    await expect(revokeShare('trip-1')).rejects.toThrow(/500/);
  });

  it('revokeShare 成功不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _opts?: any) => jsonRes(true, 200, { ok: true })));
    await expect(revokeShare('trip-1')).resolves.toBeUndefined();
  });

  it('fetchSharedTrip 免鉴权,无效 token 返回 null', async () => {
    const fetchMock = vi.fn(async (_url: string, _opts?: any) => jsonRes(false, 404, {}));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchSharedTrip('bad');
    expect(r).toBeNull();
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts?.headers).toBeUndefined();
  });

  it('fetchSharedTrip 成功返回快照', async () => {
    const snap = { trip: { id: 't1' } };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, _opts?: any) => jsonRes(true, 200, snap)));
    await expect(fetchSharedTrip('good')).resolves.toEqual(snap);
  });
});
