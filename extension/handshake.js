/**
 * Pure handshake migration helpers. Kept separate from the service worker so
 * the retry policy can be regression-tested without a Chrome runtime.
 */

export const isMissingProtocolVersion = (version) =>
  version === undefined || version === null;

export function isRetryableLegacyProtocolFatal(info) {
  return Boolean(
    info
      && info.code === 4426
      && typeof info.reason === 'string'
      && info.reason.startsWith('Server protocol (none) does not match extension protocol '),
  );
}
