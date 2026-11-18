import { RUNTIME_CONFIG } from '@/config/runtimeConfig';
import { connectedDidProfile } from '@/utils/did';
import { EC } from '../config/errorCodes.js';
import { fetchWithTimeout } from '@/utils/fetchWithTimeout.js';
import { resolveSameOriginApiEndpoint } from '@/utils/sameOriginEndpoint.js';

function trim(value) {
  return String(value || '').trim();
}

async function postNotification(body) {
  const endpoint = trim(RUNTIME_CONFIG.didNotificationEndpoint);
  if (!endpoint) {
    throw new Error(EC.didEndpointMissing);
  }

  const idToken = trim(connectedDidProfile.value?.idToken);
  if (!idToken) {
    throw new Error(EC.web3AuthTokenRequired);
  }

  // F-15 (re-verified from code): the notification POST carries the idToken
  // bearer credential, so the endpoint must be provably same-origin before it
  // is sent. Fail closed before any fetch.
  if (!resolveSameOriginApiEndpoint(endpoint).ok) {
    throw new Error(EC.credentialEndpointNotSameOrigin);
  }

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body,
      did: trim(body?.did || connectedDidProfile.value?.did || ''),
      idToken,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const err = new Error(EC.notificationRequestFailed);
    err.rpcDetail = payload?.error || payload?.message || null;
    throw err;
  }
  return payload;
}

class NotificationService {
  get canEmail() {
    return Boolean(RUNTIME_CONFIG.didNotificationEmailEnabled && trim(RUNTIME_CONFIG.didNotificationEndpoint));
  }

  get canSms() {
    return Boolean(RUNTIME_CONFIG.didNotificationSmsEnabled && trim(RUNTIME_CONFIG.didNotificationEndpoint));
  }

  async sendRecoveryEmail({ did, email, template = 'sa_recovery', payload = {} } = {}) {
    if (!this.canEmail) throw new Error(EC.emailNotificationsDisabled);
    if (!trim(email)) throw new Error(EC.emailTargetRequired);
    return postNotification({
      channel: 'email',
      did,
      to: trim(email),
      template,
      payload,
    });
  }

  async sendRecoverySms({ did, phone, template = 'sa_recovery', payload = {} } = {}) {
    if (!this.canSms) throw new Error(EC.smsNotificationsDisabled);
    if (!trim(phone)) throw new Error(EC.phoneTargetRequired);
    return postNotification({
      channel: 'sms',
      did,
      to: trim(phone),
      template,
      payload,
    });
  }
}

export const notificationService = new NotificationService();
