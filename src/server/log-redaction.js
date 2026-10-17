const REDACTED = '[REDACTED]';

// Match credential names, not generic business fields such as key/keyframe/id.
const secretNames = new Set([
  'cookie', 'setcookie', 'authorization', 'proxyauthorization', 'password', 'passwd',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken',
  'apikey', 'secret', 'clientsecret', 'apisecret', 'secretkey', 'privatekey',
  'accesskeyid', 'secretaccesskey', 'signature', 'sign', 'authkey', 'auth',
  'sessdata', 'bilijct', 'wrid', 'wssecret', 'upsig', 'hdnts', 'hdnea',
]);

function secretName(name) {
  const normalized = name.toLowerCase().replace(/[-_\s]/g, '');
  return secretNames.has(normalized) ||
    /(?:token|cookie|password|secret|signature|apikey)$/.test(normalized) ||
    /^(?:xamz|xgoog)(?:credential|signature|securitytoken)$/.test(normalized) ||
    /^(?:xapi|xauth)(?:key|token)$/.test(normalized);
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = REDACTED;
      url.password = '';
    }
    for (const key of new Set(url.searchParams.keys())) {
      if (secretName(key)) url.searchParams.set(key, REDACTED);
    }
    // Fragments may contain OAuth response parameters.
    if (url.hash.includes('=')) {
      const fragment = new URLSearchParams(url.hash.slice(1));
      for (const key of new Set(fragment.keys())) {
        if (secretName(key)) fragment.set(key, REDACTED);
      }
      url.hash = fragment.toString();
    }
    return url.href;
  } catch {
    return raw;
  }
}

export function redactText(value) {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, redactUrl)
    // Whole cookie/auth header lines may contain several space-separated values.
    .replace(/\b((?:set-cookie|cookie|proxy-authorization|authorization)\s*[:=])\s*[^\r\n]*/gi, (_, prefix) => `${prefix} ${REDACTED}`)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    // Covers recognizable key=value and quoted JSON-like fields embedded in errors.
    .replace(/(["']?)([A-Za-z][A-Za-z0-9_-]*)\1\s*([=:])\s*(\[REDACTED\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/g,
      (match, quote, key, separator) => secretName(key) ? `${quote}${key}${quote}${separator}${REDACTED}` : match);
}

export function redactContext(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactContext);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, secretName(key) ? REDACTED : redactContext(item)]));
  }
  return value;
}
