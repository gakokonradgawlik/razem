import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Argon2Params { memory: number; passes: number; parallelism: number }

// RFC 9106 §4 second recommended option (64 MiB, t=3, p=4). Measured on the target with
// `admin measure-argon2`; ~0.1 s per hash on the development host (8 vCPU), see security/access.md.
export const DEFAULT_ARGON2: Argon2Params = { memory: 65_536, passes: 3, parallelism: 4 };
// Upper bounds for parameters read from a stored hash: a tampered row must not exhaust memory.
const LIMITS = { memory: 1_048_576, passes: 10, parallelism: 16 };
const SALT_BYTES = 16;
const TAG_BYTES = 32;

export function argon2ParamsFromEnv(env: NodeJS.ProcessEnv = process.env): Argon2Params {
  const read = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Niepoprawna wartość ${name}`);
    return value;
  };
  return {
    memory: read('ARGON2_MEMORY_KIB', DEFAULT_ARGON2.memory, 19_456, LIMITS.memory),
    passes: read('ARGON2_PASSES', DEFAULT_ARGON2.passes, 2, LIMITS.passes),
    parallelism: read('ARGON2_PARALLELISM', DEFAULT_ARGON2.parallelism, 1, LIMITS.parallelism),
  };
}

const b64 = (buffer: Buffer) => buffer.toString('base64').replace(/=+$/, '');

function derive(password: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2('argon2id', {
      message: Buffer.from(password.normalize('NFC'), 'utf8'), nonce: salt, tagLength: TAG_BYTES,
      memory: params.memory, passes: params.passes, parallelism: params.parallelism,
    }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** PHC string `$argon2id$v=19$m=..,t=..,p=..$salt$hash`, compatible with libargon2. */
export async function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(key)}`;
}

function parse(phc: string): { params: Argon2Params; salt: Buffer; key: Buffer } | null {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!match) return null;
  const params = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) };
  if (params.memory > LIMITS.memory || params.passes > LIMITS.passes || params.parallelism > LIMITS.parallelism
    || params.parallelism < 1 || params.passes < 1 || params.memory < 8 * params.parallelism) return null;
  const salt = Buffer.from(match[4]!, 'base64');
  const key = Buffer.from(match[5]!, 'base64');
  if (salt.length < 8 || key.length < 16) return null;
  return { params, salt, key };
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parse(phc);
  if (!parsed) return false;
  const derived = await derive(password, parsed.salt, { ...parsed.params });
  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
}

export function needsRehash(phc: string, params: Argon2Params): boolean {
  const parsed = parse(phc);
  return !parsed || parsed.params.memory !== params.memory || parsed.params.passes !== params.passes || parsed.params.parallelism !== params.parallelism;
}
