// api/kalshi.js — Vercel serverless function
// Kalshi API proxy — signs requests server-side using env vars

const crypto = require('crypto');
const KALSHI_BASE = 'https://trading-api.kalshi.com/trade-api/v2';

function normalizePEM(raw) {
  let pem = raw.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
  const headerMatch = pem.match(/(-----BEGIN [^-]+-----)/);
  const footerMatch = pem.match(/(-----END [^-]+-----)/);
  if (headerMatch && footerMatch) {
    const header = headerMatch[1];
    const footer = footerMatch[1];
    const body = pem
      .substring(pem.indexOf(header) + header.length, pem.indexOf(footer))
      .replace(/\s+/g, '');
    const chunked = body.match(/.{1,64}/g).join('\n');
    pem = `${header}\n${chunked}\n${footer}`;
  }
  return pem;
}

function buildSignature(privateKeyPem, message) {
  const pem = normalizePEM(privateKeyPem);
  const keyObj = crypto.createPrivateKey({ key: pem, format: 'pem', type: 'pkcs1' });
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(message);
  sign.end();
  return sign.sign({
    key: keyObj,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString('base64');
}

function buildHeaders(keyId, privateKeyPem, method, kalshiPath) {
  const ts = Date.now().toString();
  const pathNoQuery = '/trade-api/v2' + kalshiPath.split('?')[0];
  const signature = buildSignature(privateKeyPem, ts + method.toUpperCase() + pathNoQuery);
  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'KALSHI-ACCESS-TIMESTAMP': ts,
    'Content-Type': 'application/json',
  };
}

const ALLOWED = [
  '/portfolio/balance',
  '/portfolio/positions',
  '/portfolio/fills',
  '/portfolio/orders',
  '/markets',
  // /portfolio/orders/:id for DELETE (cancel order)
];
// Allow /portfolio/orders and /portfolio/orders/:id
function isAllowed(path) {
  if (ALLOWED.some(a => path.startsWith(a))) return true;
  // Also allow DELETE on specific order IDs: /portfolio/orders/ord_xxx
  if (/^\/portfolio\/orders\/[a-zA-Z0-9_-]+$/.test(path)) return true;
  return false;
}

// Explicitly enable body parsing for JSON POST requests
module.exports.config = { api: { bodyParser: true } };

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const keyId = process.env.KALSHI_KEY_ID;
  const privateKeyPem = process.env.KALSHI_PRIVATE_KEY;
  if (!keyId || !privateKeyPem) {
    res.status(500).json({ error: 'Missing env vars KALSHI_KEY_ID or KALSHI_PRIVATE_KEY' });
    return;
  }

  const params = req.query;
  const kalshiPath = params.path;
  const method = (params.method || 'GET').toUpperCase();

  if (!kalshiPath) { res.status(400).json({ error: 'Missing path param' }); return; }
  if (!isAllowed(kalshiPath)) {
    res.status(403).json({ error: `Path not allowed: ${kalshiPath}` }); return;
  }

  // Pass through extra query params
  const passthroughParams = Object.entries(params)
    .filter(([k]) => !['path', 'method'].includes(k))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = KALSHI_BASE + kalshiPath + (passthroughParams ? `?${passthroughParams}` : '');

  try {
    const headers = buildHeaders(keyId, privateKeyPem, method, kalshiPath);
    const fetchOpts = { method, headers };
    if (method !== 'GET') {
      // Primary: use Vercel's parsed body (works when bodyParser:true)
      // Fallback: manually read raw body stream (for edge cases)
      let bodyData = req.body;
      if (bodyData === undefined) {
        // Body parser didn't run — read stream manually
        bodyData = await new Promise((resolve) => {
          let raw = '';
          req.on('data', chunk => { raw += chunk; });
          req.on('end', () => {
            try { resolve(JSON.parse(raw)); }
            catch { resolve(raw); }
          });
        });
      }
      if (bodyData) {
        fetchOpts.body = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);
        console.log('[proxy] forwarding body:', JSON.stringify(bodyData)?.slice(0,200));
      }
    }

    console.log('[proxy] →', method, url);
    const response = await fetch(url, fetchOpts);
    const data = await response.json();
    console.log('[proxy] ←', response.status, JSON.stringify(data)?.slice(0,300));
    if (!response.ok) console.log('[proxy] Kalshi error detail:', response.status, JSON.stringify(data));

    res.status(response.status).json(data);
  } catch (err) {
    console.log('Handler error:', err.message);
    res.status(502).json({ error: `Proxy error: ${err.message}` });
  }
};
