/**
 * UUID 生成(兼容非安全上下文)
 *
 * crypto.randomUUID 是 SecureContext-only:HTTPS 或 localhost 才有。
 * 公网 http://<纯IP> 下它是 undefined,调用即抛 TypeError。
 * 这里降级到 crypto.getRandomValues(不受 SecureContext 限制),
 * 再退到 Math.random,保证 http 部署也能用。
 */

export function uuid(): string {
  const c = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c?.randomUUID) return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 v4
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
