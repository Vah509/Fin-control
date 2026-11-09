// Шифрование полей в коде (WebCrypto). Ключи приходят снаружи; откуда они берутся
// (пароль владельца или иное) — открытый вопрос, ядро этого не решает.
import { fail } from './errors'

export interface FieldCrypto {
  /** HMAC-SHA256, hex. Для поиска по признаку без раскрытия значения. */
  hmacHex(data: string): Promise<string>
  /** AES-GCM; результат base64 (iv 12 байт + шифртекст). */
  encrypt(plain: string): Promise<string>
  decrypt(b64: string): Promise<string>
}

const toB64 = (u: Uint8Array) => {
  let s = ''
  for (const b of u) s += String.fromCharCode(b)
  return btoa(s)
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

export async function createWebCrypto(keys: { hmacKey: Uint8Array; encKey: Uint8Array }): Promise<FieldCrypto> {
  if (keys.encKey.length !== 32) fail('CRYPTO_UNAVAILABLE', 'ключ шифрования должен быть 32 байта')
  if (keys.hmacKey.length < 16) fail('CRYPTO_UNAVAILABLE', 'ключ HMAC слишком короткий')
  const subtle = globalThis.crypto.subtle
  const enc = new TextEncoder()
  const hmacKey = await subtle.importKey('raw', keys.hmacKey as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const aesKey = await subtle.importKey('raw', keys.encKey as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return {
    async hmacHex(data) {
      return toHex(new Uint8Array(await subtle.sign('HMAC', hmacKey, enc.encode(data))))
    },
    async encrypt(plain) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plain)))
      const out = new Uint8Array(iv.length + ct.length)
      out.set(iv); out.set(ct, iv.length)
      return toB64(out)
    },
    async decrypt(b64) {
      const all = fromB64(b64)
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, aesKey, all.slice(12))
      return new TextDecoder().decode(pt)
    },
  }
}
