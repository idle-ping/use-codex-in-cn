import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

// Only resolved application assets enter this cache; API and session data do not.
const assets = new Map();
export function serveStaticAsset(req, res, file, contentType) {
  const stat = statSync(file);
  const signature = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  let asset = assets.get(file);
  if (!asset || asset.signature !== signature) {
    const body = readFileSync(file);
    asset = { signature, body, etag: `W/"${createHash('sha256').update(body).digest('hex')}"` };
    assets.set(file, asset);
  }
  const headers = {
    'content-type': contentType,
    'cache-control': 'private, no-cache',
    etag: asset.etag,
    vary: 'Accept-Encoding',
  };
  const matches = String(req.headers['if-none-match'] || '').split(',').map(value => value.trim());
  if (['GET', 'HEAD'].includes(req.method) && (matches.includes('*') || matches.some(value => value.replace(/^W\//, '') === asset.etag.replace(/^W\//, '')))) {
    res.writeHead(304, headers);res.end();return;
  }
  let body = asset.body;
  const gzip = String(req.headers['accept-encoding'] || '').split(',').some(value => {
    const [encoding, ...parameters] = value.trim().split(';');
    const quality = parameters.find(parameter => parameter.trim().startsWith('q='));
    return encoding === 'gzip' && (!quality || Number(quality.trim().slice(2)) > 0);
  });
  if (gzip && body.length > 1024 && /^(?:text\/|application\/(?:javascript|json)|image\/svg\+xml)/.test(contentType)) {
    asset.gzip ||= gzipSync(body);
    body = asset.gzip;headers['content-encoding'] = 'gzip';
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);res.end(req.method === 'HEAD' ? undefined : body);
}
