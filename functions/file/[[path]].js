const BUCKET_NAME = 'Indoxvx-cdn';
const ENDPOINT    = 's3.us-west-004.backblazeb2.com';
const REGION      = 'us-west-004';
const SERVICE     = 's3';

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256hex(message) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    typeof message === 'string' ? new TextEncoder().encode(message) : message
  );
  return hex(buf);
}

async function hmacSha256(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    typeof message === 'string' ? new TextEncoder().encode(message) : message
  );
}

async function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate    = await hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion  = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  return kSigning;
}

async function signedFetch(filePath, keyId, secretKey, rangeHeader) {
  const now = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const host       = `${BUCKET_NAME}.${ENDPOINT}`;
  const objectKey  = filePath.split('/').map(encodeURIComponent).join('/');
  const canonUri   = '/' + objectKey;
  const canonQuery = '';

  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const headers = {
    'host':                   host,
    'x-amz-content-sha256':   payloadHash,
    'x-amz-date':             amzDate,
  };
  if (rangeHeader) headers['range'] = rangeHeader;

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonHeaders     = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders    = sortedHeaderKeys.join(';');

  const canonRequest = [
    'GET',
    canonUri,
    canonQuery,
    canonHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign    = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256hex(canonRequest),
  ].join('\n');

  const signingKey = await getSigningKey(secretKey, dateStamp, REGION, SERVICE);
  const signature  = hex(await hmacSha256(signingKey, stringToSign));

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const fetchHeaders = {
    'Authorization':          authHeader,
    'x-amz-date':             amzDate,
    'x-amz-content-sha256':   payloadHash,
    'Host':                   host,
  };
  if (rangeHeader) fetchHeaders['Range'] = rangeHeader;

  return {
    url: `https://${host}${canonUri}`,
    headers: fetchHeaders,
  };
}

const CONTENT_TYPES = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf',
};

export async function onRequest(context) {
  const { request, params, env } = context;

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

  const keyId     = env.B2_KEY_ID;
  const secretKey = env.B2_APP_KEY;

  if (!keyId || !secretKey) {
    return new Response('Missing B2 credentials', { status: 500 });
  }

  const rangeHeader = request.headers.get('Range') || '';

  try {
    const { url, headers: fetchHeaders } = await signedFetch(
      filePath, keyId, secretKey, rangeHeader
    );

    const b2Res = await fetch(url, {
      method: request.method,
      headers: fetchHeaders,
    });

    if (b2Res.status === 404) return new Response('Not Found', { status: 404 });
    if (b2Res.status === 403) {
      const errText = await b2Res.text();
      return new Response(`B2 Forbidden: ${errText}`, { status: 403 });
    }

    const ext = filePath.split('.').pop().toLowerCase();
    const contentType = CONTENT_TYPES[ext]
      || b2Res.headers.get('Content-Type')
      || 'application/octet-stream';

    const respHeaders = new Headers();
    respHeaders.set('Content-Type', contentType);
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Cache-Control', 'public, max-age=31536000, immutable');
    respHeaders.set('Accept-Ranges', 'bytes');

    for (const h of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
      const v = b2Res.headers.get(h);
      if (v) respHeaders.set(h, v);
    }

    return new Response(b2Res.body, {
      status: b2Res.status,
      headers: respHeaders,
    });

  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
}
