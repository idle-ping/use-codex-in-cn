import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { serveStaticAsset } from '../static-assets.js';

describe('static asset transfer cache', () => {
  test('compresses assets, revalidates them and invalidates modified files', () => {
    const root=mkdtempSync(join(tmpdir(),'codex-static-')),file=join(root,'app.js');
    const request=(headers: Record<string,string>={},method='GET')=>{
      const response: any={writeHead(status: number,headers: any){this.status=status;this.headers=headers},end(body: any){this.body=body}};
      serveStaticAsset({method,headers},response,file,'application/javascript');return response;
    };
    try{
      const source='console.log("hello");\n'.repeat(200);
      writeFileSync(file,source);
      const gzip=request({'accept-encoding':'gzip'});
      expect(gzip.status).toBe(200);
      expect(gzip.headers['cache-control']).toBe('private, no-cache');
      expect(gzip.headers.vary).toBe('Accept-Encoding');
      expect(gzip.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(gzip.body).toString()).toBe(source);
      const cached=request({'if-none-match':gzip.headers.etag});
      expect(cached.status).toBe(304);expect(cached.body).toBeUndefined();
      const plain=request({'accept-encoding':'gzip;q=0'});
      expect(plain.headers['content-encoding']).toBeUndefined();expect(plain.body.toString()).toBe(source);
      const head=request({},'HEAD');
      expect(head.body).toBeUndefined();expect(head.headers['content-length']).toBe(Buffer.byteLength(source));
      writeFileSync(file,'console.log("new deployment");');
      const changed=request({'if-none-match':gzip.headers.etag});
      expect(changed.status).toBe(200);expect(changed.headers.etag).not.toBe(gzip.headers.etag);
      expect(changed.body.toString()).toBe('console.log("new deployment");');
    }finally{rmSync(root,{recursive:true,force:true})}
  });
});
