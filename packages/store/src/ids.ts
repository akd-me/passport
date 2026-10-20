import { randomBytes } from "node:crypto";

const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomMask = (1n << 80n) - 1n;
let lastTime = -1;
let lastRandom = 0n;

/** Generate a ULID, strictly increasing within this process even if its clock moves backward. */
export function newId(): string {
  const time = Date.now();
  if (time > lastTime) {
    lastTime = time;
    lastRandom = BigInt(`0x${randomBytes(10).toString("hex")}`);
  } else if (lastRandom === randomMask) {
    lastTime += 1;
    lastRandom = 0n;
  } else {
    lastRandom += 1n;
  }
  let value = (BigInt(lastTime) << 80n) | lastRandom;
  let result = "";
  for (let i = 0; i < 26; i += 1) {
    result = alphabet[Number(value & 31n)]! + result;
    value >>= 5n;
  }
  return result;
}
