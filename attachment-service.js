import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const imageTypes = new Map([['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp'],['.gif','image/gif']]);

function imageType(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0,6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0,4).toString('ascii') === 'RIFF' && bytes.subarray(8,12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function saveAttachment(request, root, originalName) {
  const name = basename(String(originalName || '').replaceAll('\\','/')).replace(/[\x00-\x1f\x7f]/g,'').trim();
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name) > 240) throw new Error('Invalid attachment filename');
  const chunks = [];
  let size = 0, tooLarge = Number(request.headers?.['content-length']) > ATTACHMENT_MAX_BYTES;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > ATTACHMENT_MAX_BYTES) tooLarge = true;
    if (!tooLarge) chunks.push(Buffer.from(chunk));
  }
  if (tooLarge) throw Object.assign(new Error('Each attachment must be 25 MiB or smaller'), { status: 413 });
  if (!size) throw new Error('Cannot upload an empty file');
  const bytes = Buffer.concat(chunks), detected = imageType(bytes), expected = imageTypes.get(extname(name).toLowerCase());
  if (expected && detected !== expected) throw new Error('Image content does not match its file type');
  const directory = join(root, randomUUID()), path = join(directory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  // Only validated, supported image extensions enter the image-input path.
  return { id: basename(directory), name, path, size, kind: expected ? 'image' : 'file', contentType: expected || 'application/octet-stream', status: 'ready' };
}
