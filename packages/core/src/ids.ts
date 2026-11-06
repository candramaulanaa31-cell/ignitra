/**
 * Prefixed, time-sortable ids: `<prefix>_<ulid>` (ULID in lowercase Crockford
 * base32). Sortable ids keep run history ordered by insertion without an extra
 * index, and the prefix makes every id self-describing in logs and URLs.
 */

export const ID_PREFIXES = {
  user: "usr",
  flow: "fl",
  connection: "conn",
  run: "run",
  apiKey: "key",
  watch: "wat",
  pushSubscription: "psub",
  notification: "ntf",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 2 ** 48 - 1;
const ULID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;

type RandomSource = (bytes: Uint8Array) => Uint8Array;
const defaultRandom: RandomSource = (bytes) => crypto.getRandomValues(bytes);

export function ulid(now: number = Date.now(), random: RandomSource = defaultRandom): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ulid: timestamp out of range: ${now}`);
  }
  let time = "";
  let t = now;
  for (let i = 0; i < TIME_LEN; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  // 256 is a multiple of 32, so `byte & 31` is unbiased.
  const bytes = random(new Uint8Array(RANDOM_LEN));
  let rand = "";
  for (const byte of bytes) rand += ALPHABET.charAt(byte & 31);
  return time + rand;
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const prefix = `${ID_PREFIXES[kind]}_`;
  return value.startsWith(prefix) && ULID_RE.test(value.slice(prefix.length));
}

/** Millisecond timestamp encoded in a prefixed id, or null if malformed. */
export function idTimestamp(value: string): number | null {
  const sep = value.lastIndexOf("_");
  const body = value.slice(sep + 1);
  if (!ULID_RE.test(body)) return null;
  let time = 0;
  for (const char of body.slice(0, TIME_LEN)) time = time * 32 + ALPHABET.indexOf(char);
  return time;
}
