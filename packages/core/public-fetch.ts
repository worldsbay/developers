import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { HttpError } from './http.js';

export function publicIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
/** Public HTTPS only, pin DNS to vetted IPv4, reject redirects, bound bytes/time. */
export async function publicJson(url: string): Promise<unknown> {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    (target.port && target.port !== '443')
  )
    throw new HttpError(400, 'Use a public HTTPS origin on port 443.');
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const addresses = isIP(target.hostname) ? [target.hostname] : await resolver.resolve4(target.hostname);
  if (!addresses.length || addresses.some((a) => !publicIPv4(a)))
    throw new HttpError(400, 'The world must resolve to a public IPv4 address.');
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'GET',
        agent: false,
        headers: { accept: 'application/json', 'user-agent': 'WorldsBay-WorldVerifier/1' },
        lookup: (_hostname, options, callback) => {
          if ((options as { all?: boolean }).all)
            (callback as Function)(null, [{ address: addresses[0], family: 4 }]);
          else callback(null, addresses[0], 4);
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new HttpError(400, 'World verification needs an HTTP 200 JSON response without redirects.'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16_384) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new HttpError(400, 'The verification file must contain valid JSON.'));
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('Verification timed out')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () =>
      reject(new HttpError(400, 'The public HTTPS verification endpoint could not be read.')),
    );
    req.end();
  });
}
