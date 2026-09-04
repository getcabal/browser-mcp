/** Pure accessibility-snapshot redaction helpers. */

function attributeMap(attributes = []) {
  const result = {};
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    result[String(attributes[index]).toLowerCase()] = String(attributes[index + 1]);
  }
  return result;
}

export function isSensitiveInputNode(role, attributes = []) {
  const normalizedRole = String(role || '').toLowerCase();
  if (!['textbox', 'searchbox', 'spinbutton', 'textfield', 'textfieldwithcombobox'].includes(normalizedRole)) {
    return false;
  }
  const attrs = attributeMap(attributes);
  if (String(attrs.type || '').toLowerCase() === 'password') return true;
  const autocomplete = String(attrs.autocomplete || '').toLowerCase();
  if (/\b(one-time-code|current-password|new-password)\b/.test(autocomplete)) return true;
  const identity = [attrs.name, attrs.id, attrs['aria-label'], attrs.placeholder]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/\b(otp|one[ -]?time|verification|passcode|password|sms[ -]?code|security[ -]?code|auth(?:entication)?[ -]?code)\b|verificationcode|smscode|securitycode|authcode/.test(identity)) {
    return true;
  }
  const maxLength = Number(attrs.maxlength);
  return attrs.inputmode === 'numeric' && Number.isInteger(maxLength) && maxLength >= 4 && maxLength <= 8;
}

export function redactSensitiveAccessibleName(name, insideSensitiveInput, authenticationContext = false) {
  let text = String(name || '');
  if (authenticationContext && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())) {
    return '[REDACTED EMAIL]';
  }
  // Accessibility names can contain the full body of an SMS message even when
  // the code is not inside an input. Redact only explicit code assignments so
  // unrelated dates, counts, and masked phone suffixes remain usable.
  text = text.replace(
    /\b((?:your\s+)?(?:service[\s_-]*titan\s+)?(?:verification|security|authentication|sms|one[- ]time)\s+(?:code|passcode)\s*(?:is|was|[:=-])\s*:?\s*)([0-9]{4,8})\b/gi,
    '$1[REDACTED CODE]',
  );
  text = text.replace(
    /\b((?:your\s+)?service[\s_-]*titan\s+(?:verification\s+)?(?:code|passcode)\s*(?:is|was|[:=-])\s*:?\s*)([0-9]{4,8})\b/gi,
    '$1[REDACTED CODE]',
  );
  text = text.replace(
    /\b([0-9]{4,8})(\s+(?:is|was)\s+(?:your\s+)?(?:service[\s_-]*titan\s+)?(?:verification|security|authentication|sms|one[- ]time)\s+(?:code|passcode))\b/gi,
    '[REDACTED CODE]$2',
  );
  if (!insideSensitiveInput) return text;
  if (!text || /^\s*\d{4,8}\s*$/.test(text) || /^\s*[•●*]{3,}\s*$/.test(text)) {
    return text ? '[REDACTED]' : text;
  }
  return text;
}

const SENSITIVE_QUERY_KEY = /^(?:code|state|nonce|token|access_token|id_token|refresh_token|session_state|samlresponse|cid)$/i;

export function redactSensitiveUrl(raw) {
  const text = String(raw || '');
  let url;
  try { url = new URL(text); } catch { return text; }
  if (!['http:', 'https:'].includes(url.protocol)) return text;
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, '[REDACTED]');
  }
  if (url.hash.startsWith('#') && url.hash.includes('=')) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    let changed = false;
    for (const key of [...fragment.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) {
        fragment.set(key, '[REDACTED]');
        changed = true;
      }
    }
    if (changed) url.hash = fragment.toString();
  }
  return url.toString();
}
