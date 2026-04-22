const BUCKET_NAME    = 'indoxvx-cdn';
const ENDPOINT       = 's3.us-west-004.backblazeb2.com';
const REGION         = 'us-west-004';
const SERVICE        = 's3';

// ⚠️ Ganti dengan domain website kamu
const ALLOWED_DOMAINS = [
  'vidoway.click',
  'www.vidoway.click',
  'indoxvx.cam',
  'www.indoxvx.cam',
  'xjilbab.cam',
  'www.xjilbab.cam',
];

function hex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256hex(message) {
  const data = typeof message === 'string'
    ? new TextEncoder().encode(message) : message;
  return hex(await crypto.subtle.digest('SHA-256', data));
}

async function hmacSha256(key, message) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const m = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, m);
}

function uriEncodePath(path) {
  return path.split('/').map(segment =>
    encodeURIComponent(segment).replace(/[!'()*]/g, c =>
      '%' + c.charCodeAt(0).toString(16).toUpperCase()
    )
  ).join('/');
}

function isAllowedReferer(referer) {
  // Kalau tidak ada referer = akses langsung via browser = izinkan
  if (!referer) return true;
  try {
    const url = new URL(referer);
    // Izinkan kalau dari domain sendiri
    return ALLOWED_DOMAINS.includes(url.hostname);
  } catch {
    return false;
  }
}

async function buildSignedRequest(method, filePath, keyId, secretKey, rangeHeader) {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  const host     = `${BUCKET_NAME}.${ENDPOINT}`;
  const canonUri = '/' + uriEncodePath(filePath);

  const payloadHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const canonHeadersMap = {
    'host':                 host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date':           amzDate,
  };
  if (rangeHeader) canonHeadersMap['range'] = rangeHeader;

  const sortedKeys    = Object.keys(canonHeadersMap).sort();
  const canonHeaders  = sortedKeys.map(k => `${k}:${canonHeadersMap[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonRequest = [
    method, canonUri, '',
    canonHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    await sha256hex(canonRequest),
  ].join('\n');

  const kDate    = await hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion  = await hmacSha256(kDate, REGION);
  const kService = await hmacSha256(kRegion, SERVICE);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = hex(await hmacSha256(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}${canonUri}`,
    headers: {
      'Authorization':          authorization,
      'x-amz-date':             amzDate,
      'x-amz-content-sha256':   payloadHash,
      'Host':                   host,
      ...(rangeHeader ? { 'Range': rangeHeader } : {}),
    },
  };
}

const CONTENT_TYPES = {
  mp4:  'video/mp4',  webm: 'video/webm', mov:  'video/quicktime',
  avi:  'video/x-msvideo', mkv: 'video/x-matroska',
  gif:  'image/gif',  jpg:  'image/jpeg', jpeg: 'image/jpeg',
  png:  'image/png',  webp: 'image/webp',
  mp3:  'audio/mpeg', wav:  'audio/wav',  ogg:  'audio/ogg',
  pdf:  'application/pdf',
};

export async function onRequest(context) {
  const { request, params, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Max-Age':       '86400',
      },
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const filePath = params.path ? params.path.join('/') : '';
  if (!filePath) return new Response('Not Found', { status: 404 });

  // Cek referer — tolak kalau ada referer tapi bukan dari domain kita
  const referer = request.headers.get('Referer') || '';
  if (!isAllowedReferer(referer)) {
    return new Response('Forbidden: embed not allowed from this domain', { status: 403 });
  }

  const keyId     = env.B2_KEY_ID;
  const secretKey = env.B2_APP_KEY;
  if (!keyId || !secretKey) {
    return new Response('Missing B2 credentials', { status: 500 });
  }

  const rangeHeader = request.headers.get('Range') || '';

  try {
    const { url, headers: fetchHeaders } = await buildSignedRequest(
      request.method, filePath, keyId, secretKey, rangeHeader
    );

    const b2Res = await fetch(url, { method: request.method, headers: fetchHeaders });

    if (b2Res.status === 404) return new Response('Not Found', { status: 404 });
    if (!b2Res.ok && b2Res.status !== 206) {
      const errText = await b2Res.text();
      return new Response(`B2 Error ${b2Res.status}: ${errText}`, { status: b2Res.status });
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
