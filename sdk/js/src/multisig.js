/**
 * v4 threshold route: member digests and the serialized member-signature field.
 *
 * The v3 multisig layer resolved child verifiers, built its own typed data and
 * serialized a `MultiSigVerifier` signature array. v4 has one threshold
 * mechanism: the operation names a threshold policy id in `validatorId`, each
 * member instance signs its own §5 member digest
 * (`SHA256("NeoSmartAccount/ThresholdMember" ‖ U1(4) ‖ operationDigest ‖
 * U64BE(memberModuleId) ‖ U64BE(memberCredentialGeneration))`), and field 11 of
 * the 13-field operation carries the serialized list.
 *
 * `shared/multiSigCore.mjs` owns the encoding; this module only binds it to the
 * account's live member generations.
 */

const crypto = require('node:crypto');
const {
  createThresholdTools,
  serializeMemberSignatures,
  toMultiSigRpcParameter,
  THRESHOLD_MAX_MEMBERS,
} = require('../../../shared/multiSigCore.mjs');

const sha256 = (hex) =>
  crypto.createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex');
const thresholdTools = createThresholdTools({ sha256 });

/**
 * Bind the threshold tools to one client and one account. Member ids are the
 * account's validator module ids; each member's credential generation is read
 * from the core, never supplied by the caller, because a stale generation
 * yields a digest the core will reject as SA_CREDENTIAL_STALE.
 *
 * @param {Object} options
 * @param {Object} options.client - Client exposing getModule(accountId, moduleId)
 * @returns {Object} Threshold helpers bound to that client
 */
function createThresholdClient({ client } = {}) {
  if (!client || typeof client.getModule !== 'function') {
    throw new Error('Threshold client: a SmartAccount client is required');
  }
  async function readMembers(accountId, memberIds) {
    if (!Array.isArray(memberIds) || memberIds.length < 1 || memberIds.length > THRESHOLD_MAX_MEMBERS) {
      throw new Error(`Threshold client: 1 to ${THRESHOLD_MAX_MEMBERS} member ids are required`);
    }
    return Promise.all(
      memberIds.map(async (moduleId) => {
        const descriptor = await client.getModule(accountId, moduleId);
        if (!descriptor) throw new Error(`Threshold client: member ${moduleId} is not installed`);
        if (!descriptor.thresholdMemberEligible) {
          throw new Error(`Threshold client: member ${moduleId} is not threshold-eligible`);
        }
        return {
          moduleId: descriptor.moduleId,
          credentialGeneration: descriptor.credentialGeneration,
        };
      }),
    );
  }
  return Object.freeze({
    /**
     * The digest each member must sign for one operation.
     *
     * @returns {Promise<ReadonlyArray<{moduleId: string, credentialGeneration: string, digest: string}>>}
     */
    async prepareMembers({ accountId, operationDigest, memberIds }) {
      const members = await readMembers(accountId, memberIds);
      return thresholdTools.prepareMembers({ operationDigest, members });
    },
    /** Field 11 for the operation, from members that signed their digests. */
    assembleSignature: thresholdTools.assembleSignature,
    assembleOperationSignature: thresholdTools.assembleOperationSignature,
    memberDigest: thresholdTools.memberDigest,
  });
}

module.exports = {
  createThresholdClient,
  thresholdTools,
  serializeMemberSignatures,
  toMultiSigRpcParameter,
  THRESHOLD_MAX_MEMBERS,
};
