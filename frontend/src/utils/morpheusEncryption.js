import { EC } from '../config/errorCodes.js';
import { encryptConfidentialEnvelope } from './morpheusConfidentialEnvelope.generated.js';

export async function encryptJsonWithMorpheusOracleKey(publicKeyBase64, jsonText) {
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(EC.confidentialPayloadInvalid);
  }
  return encryptConfidentialEnvelope(publicKeyBase64, JSON.stringify(parsed));
}
