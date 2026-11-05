import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { createReadStream, createWriteStream, appendFileSync, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { CONFIG_FILE, DATABASE_FILE, MANIFEST_FILE, inspectBackup, manifestSchema, privatePath, readConfiguration, restoreBackup, writePrivate, syncDirectory } from './storage.js';


const MAGIC = Buffer.from('RAZEMB01');
const HEADER_SIZE = 8 + 16 + 12;
const MAX_PAYLOAD = 4 * 1024 ** 3; // Bounded disk use on malformed/bomb input; no whole-database buffers.
async function keyFor(passwordFile: string, salt: Buffer) {
  const password = readConfiguration(passwordFile);
  try {
    if (password.length < 16 || password.length > 4096) throw new Error('Plik hasła musi zawierać 16–4096 bajtów');
    return await new Promise<Buffer>((accept, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, key) => error ? reject(error) : accept(key)));
  } finally { password.fill(0); }
}
function readAt(path: string, size: number, position: number) {
  const fd = openSync(path, 'r');
  try {
    const data = Buffer.alloc(size);
    if (readSync(fd, data, 0, size, position) !== size) throw new Error('Niepełne archiwum');
    return data;
  } finally { closeSync(fd); }
}

/** gzip + authenticated AES-256-GCM. No shell, cloud, plaintext staging or password arguments. */
export async function encryptBackup(backup: string, output: string, passwordFile: string): Promise<void> {
  const manifest = inspectBackup(backup);
  privatePath(dirname(output), true);
  const metadata = Buffer.from(JSON.stringify(manifest));
  const size = Buffer.alloc(4); size.writeUInt32BE(metadata.length);
  if (manifest.database.bytes + (manifest.configuration?.bytes ?? 0) + metadata.length + 4 > MAX_PAYLOAD) throw new Error('Archiwum przenośne przekracza 4 GiB');
  const salt = randomBytes(16), iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const key = await keyFor(passwordFile, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(header);
    const fd = openSync(output, 'wx', 0o600); // Never remove/overwrite a foreign output on EEXIST.
    try {
      appendFileSync(fd, header);
      async function* payload() {
        yield size; yield metadata;
        yield* createReadStream(join(backup, DATABASE_FILE));
        if (manifest.configuration) yield* createReadStream(join(backup, CONFIG_FILE));
      }
      await pipeline(Readable.from(payload()), createGzip(), cipher, createWriteStream(output, { fd, autoClose: false }));
      appendFileSync(fd, cipher.getAuthTag()); fsyncSync(fd);
    } catch (error) { rmSync(output, { force: true }); throw error; } finally { closeSync(fd); }
    syncDirectory(dirname(output));
  } finally { key.fill(0); }
}

/** Decryption is authenticated in a private staging directory before anything is restored. */
export async function restoreEncrypted(input: string, target: string, passwordFile: string): Promise<void> {
  privatePath(input, false);
  privatePath(dirname(target), true);
  const length = statSync(input).size;
  if (length < HEADER_SIZE + 16 || length > MAX_PAYLOAD + 16 * 1024 * 1024) throw new Error('Niepoprawny rozmiar archiwum');
  const header = readAt(input, HEADER_SIZE, 0);
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error('Nieznany format archiwum');
  const key = await keyFor(passwordFile, header.subarray(8, 24));
  const stage = mkdtempSync(join(dirname(target), '.razem-restore-'));
  try {
    const payload = join(stage, 'payload');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(24));
    decipher.setAAD(header); decipher.setAuthTag(readAt(input, 16, length - 16));
    let count = 0;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      callback(count > MAX_PAYLOAD ? new Error('Przekroczony rozmiar archiwum') : null, chunk);
    } });
    await pipeline(createReadStream(input, { start: HEADER_SIZE, end: length - 17 }), decipher, createGunzip(), limit,
      createWriteStream(payload, { flags: 'wx', mode: 0o600 }));
    const metadataSize = readAt(payload, 4, 0).readUInt32BE();
    if (metadataSize > 16384) throw new Error('Niepoprawny manifest');
    const metadata = readAt(payload, metadataSize, 4);
    const manifest = manifestSchema.parse(JSON.parse(metadata.toString('utf8')));
    const start = 4 + metadataSize;
    if (statSync(payload).size !== start + manifest.database.bytes + (manifest.configuration?.bytes ?? 0)) throw new Error('Niepełne archiwum');
    const bundle = join(stage, 'bundle');
    mkdirSync(bundle, { mode: 0o700 });
    writePrivate(join(bundle, MANIFEST_FILE), metadata);
    for (const [name, offset, bytes] of [
      [DATABASE_FILE, start, manifest.database.bytes],
      ...(manifest.configuration ? [[CONFIG_FILE, start + manifest.database.bytes, manifest.configuration.bytes] as const] : []),
    ] as const) {
      if (bytes === 0) writePrivate(join(bundle, name), Buffer.alloc(0));
      else await pipeline(createReadStream(payload, { start: offset, end: offset + bytes - 1 }), createWriteStream(join(bundle, name), { flags: 'wx', mode: 0o600 }));
    }
    restoreBackup(bundle, target);
  } finally { key.fill(0); rmSync(stage, { recursive: true, force: true }); }
}
