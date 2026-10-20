import { randomBytes } from 'node:crypto';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// Store has no id allocator in the shared interface, so use dependency-free ULIDs here.
export function newId(at: string): string {
  let time = BigInt(Date.parse(at));
  let prefix = '';
  for (let i = 0; i < 10; i++) { prefix = alphabet[Number(time & 31n)]! + prefix; time >>= 5n; }
  let random = BigInt(`0x${randomBytes(10).toString('hex')}`), suffix = '';
  for (let i = 0; i < 16; i++) { suffix = alphabet[Number(random & 31n)]! + suffix; random >>= 5n; }
  return prefix + suffix;
}
