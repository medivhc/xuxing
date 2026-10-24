// client_submit_id 生成（契约 §0.5：ULID；重试必须复用同一个值）。
// 用 Web Crypto 生成，不引第三方依赖。

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomChars(count: number): string {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += CROCKFORD[bytes[i] % 32];
  }
  return out;
}

/** 26 字符 Crockford base32 ULID（48bit 时间 + 80bit 随机）。 */
export function ulid(): string {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  return timePart + randomChars(16);
}
