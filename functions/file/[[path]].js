// Cloudflare Pages Function
// Mengambil file dari private Backblaze B2 bucket menggunakan AWS Signature V4
// Variabel B2_KEY_ID dan B2_APP_KEY disimpan di Cloudflare Environment Variables

const BUCKET_NAME = 'Indoxvx-cdn';
const ENDPOINT    = 's3.us-west-004.backblazeb2.com';
const REGION      = 'us-west-004';

// ── AWS Signature V4 helpers ──────────────────────────────────────────────────

function hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmac(key, data) {
  const k = typeof key === 'string'
    ? new TextEncoder().encode(key)
    : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256(data) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data)));
}

async function signRequest(method, filePath, keyId, appKey, rangeHeader) {
  const now        = new Date();
  const datestamp  = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timestamp  = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  const host        = `${BUCKET_NAME}.${ENDPOINT}`;
  const canonPath   = `/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
  const payloadHash = await sha256('');

  // Canonical headers (harus sorted alphabetically)
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };
  if (rangeHeader) headers['range'] = rangeHeader;

  const sortedKeys      = Object.keys(headers).sort();
  const canonHeaders    = sortedKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders   = sortedKeys.join(';');

  const canonRequest = [
    method,
    canonPath,
    '',               // query string
    canonHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${datestamp}/${REGION}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    credentialScope,
    await sha256(canonRequest),
  ].join('\n');

  const dateKey      = await hmac(`AWS4${appKey}`, datestamp);
  const regionKey    = await hmac(dateKey, REGION);
  const serviceKey   = await hmac(regionKey, 's3');
  const signingKey   = await hmac(serviceKey, 'aws4_request');
  const signature    = hex(await hmac(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, timestamp, payloadHash, host, canonPath };
}

// ── Content-Type map ──────────────────────────────────────────────────────────

const CONTENT_TYPES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf',
};

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest(context) {
  const { request, params, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const filePath = params.path ? params.path.join('/') : '';
  if (!filePath) return new Response('Not Found', { status: 404 });

  // Ambil credentials dari Environment Variables Cloudflare
  const keyId  = env.B2_KEY_ID;
  const appKey = env.B2_APP_KEY;

  if (!keyId || !appKey) {
    return new Response('Server misconfigured: missing B2 credentials', { status: 500 });
  }

  const rangeHeader = request.headers.get('Range') || '';

  try {
    const { authorization, timestamp, payloadHash, host, canonPath } =
      await signRequest(request.method, filePath, keyId, appKey, rangeHeader);

    const b2Url = `https://${host}${canonPath}`;

    const fetchHeaders = {
      'Authorization': authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
      'Host': host,
    };
    if (rangeHeader) fetchHeaders['Range'] = rangeHeader;

    const b2Response = await fetch(b2Url, {
      method: request.method,
      headers: fetchHeaders,
    });

    if (b2Response.status === 404) return new Response('Not Found', { status: 404 });
    if (b2Response.status === 403) return new Response('Forbidden', { status: 403 });

    const ext = filePath.split('.').pop().toLowerCase();
    const contentType = CONTENT_TYPES[ext]
      || b2Response.headers.get('Content-Type')
      || 'application/octet-stream';

    const respHeaders = new Headers();
    respHeaders.set('Content-Type', contentType);
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
    respHeaders.set('Accept-Ranges', 'bytes');

    for (const h of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
      const v = b2Response.headers.get(h);
      if (v) respHeaders.set(h, v);
    }

    return new Response(b2Response.body, {
      status: b2Response.status,
      headers: respHeaders,
    });

  } catch (err) {
    return new Response(`Internal Error: ${err.message}`, { status: 500 });
  }
}
