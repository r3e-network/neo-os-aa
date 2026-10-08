// Machine-readable error codes for service-layer errors.
// Components translate these via i18n; service files have no i18n dependency.
export const EC = {
  draftStorageUnavailable: 'EC_draft_storage_unavailable',
  draftNotFound: 'EC_draft_not_found',
  collaboratorAccessRequired: 'EC_collaborator_access_required',
  operatorAccessRequired: 'EC_operator_access_required',
  activityScopeDenied: 'EC_activity_scope_denied',
  operatorMutationsUnavailable: 'EC_operator_mutations_unavailable',
  draftRequestFailed: 'EC_draft_request_failed',

  v3AccountRequired: 'EC_v3_account_required',
  clientInvocationMissing: 'EC_client_invocation_missing',
  signerRequired: 'EC_signer_required',
  relayEndpointMissing: 'EC_relay_endpoint_missing',
  rawRelayDisabled: 'EC_raw_relay_disabled',
  signedTxMissing: 'EC_signed_tx_missing',
  walletServiceMissing: 'EC_wallet_service_missing',

  walletProviderMissing: 'EC_wallet_provider_missing',
  walletAddressMissing: 'EC_wallet_address_missing',
  evmProviderMissing: 'EC_evm_provider_missing',
  walletNotConnected: 'EC_wallet_not_connected',
  invokeMultipleUnsupported: 'EC_invoke_multiple_unsupported',
  walletRequestFailed: 'EC_wallet_request_failed',

  didEndpointMissing: 'EC_did_endpoint_missing',
  didRequestFailed: 'EC_did_request_failed',
  morpheusDidRequestFailed: 'EC_morpheus_did_request_failed',
  notificationRequestFailed: 'EC_notification_request_failed',
  mutationTransportFailed: 'EC_mutation_transport_failed',
  emailNotificationsDisabled: 'EC_email_notifications_disabled',
  emailTargetRequired: 'EC_email_target_required',
  smsNotificationsDisabled: 'EC_sms_notifications_disabled',
  phoneTargetRequired: 'EC_phone_target_required',
  web3AuthDidNotConfigured: 'EC_web3auth_did_not_configured',
  web3AuthNoDidDerived: 'EC_web3auth_no_did_derived',
  web3AuthTokenRequired: 'EC_web3auth_token_required',

  accountSeedRequired: 'EC_account_seed_required',
  invalidAddressChecksum: 'EC_invalid_address_checksum',

  confidentialPayloadInvalid: 'EC_confidential_payload_invalid',
  neofsNotConfigured: 'EC_neofs_not_configured',
  neofsUploadFailed: 'EC_neofs_upload_failed',
  neofsNoFileProvided: 'EC_neofs_no_file_provided',

  addressMarketNotConfigured: 'EC_address_market_not_configured',
  accountSeedOrHashRequired: 'EC_account_seed_or_hash_required',
  accountSeedRequiredForListing: 'EC_account_seed_required_for_listing',
  invalidPrice: 'EC_invalid_price',
  listingNotFound: 'EC_listing_not_found',
  listingNotActive: 'EC_listing_not_active',
  walletRequiredForListing: 'EC_wallet_required_for_listing',

  immutableDraftBody: 'EC_immutable_draft_body',
  operatorMutationMissingParams: 'EC_operator_mutation_missing_params',
  metaTxArgsHashFailed: 'EC_meta_tx_args_hash_failed',
  metaTxNonceFailed: 'EC_meta_tx_nonce_failed',
  metaTxVerifierFailed: 'EC_meta_tx_verifier_failed',
  metaTxBackupOwnerFailed: 'EC_meta_tx_backup_owner_failed',
  contractLookupFailed: 'EC_contract_lookup_failed',
  rpcFault: 'EC_rpc_fault',
  rpcRequestFailed: 'EC_rpc_request_failed',
  requestTimedOut: 'EC_request_timed_out',
  addressValidationFailed: 'EC_address_validation_failed',
  broadcastModeUnsupported: 'EC_broadcast_mode_unsupported',
  vanityWorkerCrashed: 'EC_vanity_worker_crashed',
  oracleKeyLoadFailed: 'EC_oracle_key_load_failed',
  nnsResolveFault: 'EC_nns_resolve_fault',
  metadataRequestFailed: 'EC_metadata_request_failed',

  contractNotFound: 'EC_contract_not_found',
  operationFailed: 'EC_operation_failed',
  noTxId: 'EC_no_tx_id',
  matrixDomainInvalid: 'EC_matrix_domain_invalid',
  connectWalletMatrix: 'EC_connect_wallet_matrix',
  invalidJsonSyntax: 'EC_invalid_json_syntax',
  invalidArgsJson: 'EC_invalid_args_json',

  invalidHexLength: 'EC_invalid_hex_length',
  invalidBase58Char: 'EC_invalid_base58_char',
  dataTooLargeToPush: 'EC_data_too_large_to_push',
  unsupportedSmallInteger: 'EC_unsupported_small_integer',
  invalidNeoAddressLength: 'EC_invalid_neo_address_length',

  stageBeforeCreatingDraft: 'EC_stage_before_creating_draft',
  enterSignatureBeforeAppending: 'EC_enter_signature_before_appending',
  stageBeforeEvmApproval: 'EC_stage_before_evm_approval',
  v3AccountIdHashMissing: 'EC_v3_account_id_hash_missing',
  noVerifierConfigured: 'EC_no_verifier_configured',
  noVerifierPlugin: 'EC_no_verifier_plugin',
  readOnlyDraftError: 'EC_read_only_draft_error',
  presetProxyTransferRefused: 'EC_preset_proxy_transfer_refused',
};

/**
 * Check if an error message is a machine-readable error code.
 */
export function isErrorCode(message) {
  return typeof message === 'string' && message.startsWith('EC_');
}

export function extractErrorCode(message) {
  if (typeof message !== 'string') return '';
  const code = message.split(':', 1)[0].trim();
  return isErrorCode(code) ? code : '';
}

const EC_I18N_KEY = {
  EC_operator_key_storage_unavailable: 'operatorBackup.storageUnavailable',
  EC_operator_key_storage_corrupt: 'operatorBackup.storageCorrupt',
  EC_operator_key_recovery_required: 'operatorBackup.recoveryRequired',
  EC_operator_backup_invalid: 'operatorBackup.invalidBackup',
  EC_operator_backup_wrong_draft: 'operatorBackup.wrongDraft',
  EC_operator_backup_password_weak: 'operatorBackup.weakPassword',
  EC_draft_storage_unavailable: 'errors.draftStorageUnavailable',
  EC_draft_not_found: 'errors.draftNotFound',
  EC_collaborator_access_required: 'errors.collaboratorAccessRequired',
  EC_operator_access_required: 'errors.operatorAccessRequired',
  EC_activity_scope_denied: 'errors.activityScopeDenied',
  EC_operator_mutations_unavailable: 'errors.operatorMutationsUnavailable',
  EC_draft_request_failed: 'errors.draftRequestFailed',
  EC_v3_account_required: 'errors.v3AccountRequired',
  EC_client_invocation_missing: 'errors.clientInvocationMissing',
  EC_signer_required: 'errors.signerRequired',
  EC_relay_endpoint_missing: 'errors.relayEndpointMissing',
  EC_raw_relay_disabled: 'errors.rawRelayDisabled',
  EC_signed_tx_missing: 'errors.signedTxMissing',
  EC_wallet_service_missing: 'errors.walletServiceMissing',
  EC_wallet_provider_missing: 'errors.walletProviderMissing',
  EC_wallet_address_missing: 'errors.walletAddressMissing',
  EC_evm_provider_missing: 'errors.evmProviderMissing',
  EC_wallet_not_connected: 'errors.walletNotConnected',
  EC_invoke_multiple_unsupported: 'errors.invokeMultipleUnsupported',
  EC_wallet_request_failed: 'errors.walletRequestFailed',
  EC_did_endpoint_missing: 'errors.didEndpointMissing',
  EC_did_request_failed: 'errors.didRequestFailed',
  EC_morpheus_did_request_failed: 'errors.morpheusDidRequestFailed',
  EC_notification_request_failed: 'errors.notificationRequestFailed',
  EC_mutation_transport_failed: 'errors.mutationTransportFailed',
  EC_email_notifications_disabled: 'errors.emailNotificationsDisabled',
  EC_email_target_required: 'errors.emailTargetRequired',
  EC_sms_notifications_disabled: 'errors.smsNotificationsDisabled',
  EC_phone_target_required: 'errors.phoneTargetRequired',
  EC_web3auth_did_not_configured: 'errors.web3AuthDidNotConfigured',
  EC_web3auth_no_did_derived: 'errors.web3AuthNoDidDerived',
  EC_web3auth_token_required: 'errors.web3AuthTokenRequired',
  EC_account_seed_required: 'errors.accountSeedRequired',
  EC_invalid_address_checksum: 'errors.invalidAddressChecksum',
  EC_confidential_payload_invalid: 'errors.confidentialPayloadInvalid',
  EC_neofs_not_configured: 'errors.neofsNotConfigured',
  EC_neofs_upload_failed: 'errors.neofsUploadFailed',
  EC_neofs_no_file_provided: 'errors.neofsNoFileProvided',
  EC_address_market_not_configured: 'errors.addressMarketNotConfigured',
  EC_account_seed_or_hash_required: 'errors.accountSeedOrHashRequired',
  EC_account_seed_required_for_listing: 'errors.accountSeedRequiredForListing',
  EC_invalid_price: 'errors.invalidPrice',
  EC_listing_not_found: 'errors.listingNotFound',
  EC_listing_not_active: 'errors.listingNotActive',
  EC_wallet_required_for_listing: 'errors.walletRequiredForListing',
  EC_immutable_draft_body: 'errors.immutableDraftBody',
  EC_operator_mutation_missing_params: 'errors.operatorMutationMissingParams',
  EC_meta_tx_args_hash_failed: 'errors.metaTxArgsHashFailed',
  EC_meta_tx_nonce_failed: 'errors.metaTxNonceFailed',
  EC_meta_tx_verifier_failed: 'errors.metaTxVerifierFailed',
  EC_meta_tx_backup_owner_failed: 'errors.metaTxBackupOwnerFailed',
  EC_contract_lookup_failed: 'errors.contractLookupFailed',
  EC_rpc_fault: 'errors.rpcFault',
  EC_rpc_request_failed: 'errors.rpcRequestFailed',
  EC_request_timed_out: 'errors.requestTimedOut',
  EC_address_validation_failed: 'errors.addressValidationFailed',
  EC_broadcast_mode_unsupported: 'errors.broadcastModeUnsupported',
  EC_vanity_worker_crashed: 'errors.vanityWorkerCrashed',
  EC_oracle_key_load_failed: 'errors.oracleKeyLoadFailed',
  EC_nns_resolve_fault: 'errors.nnsResolveFault',
  EC_metadata_request_failed: 'errors.metadataRequestFailed',

  EC_contract_not_found: 'studio.toast.contractNotFound',
  EC_operation_failed: 'studio.toast.operationFailed',
  EC_no_tx_id: 'studio.toast.noTxId',
  EC_matrix_domain_invalid: 'studio.toast.matrixDomainInvalid',
  EC_connect_wallet_matrix: 'studio.toast.connectWalletMatrix',
  EC_invalid_json_syntax: 'studio.toast.invalidJsonSyntax',
  EC_invalid_args_json: 'studio.toast.invalidArgsJson',

  EC_invalid_hex_length: 'errors.invalidHexLength',
  EC_invalid_base58_char: 'errors.invalidBase58Char',
  EC_data_too_large_to_push: 'errors.dataTooLargeToPush',
  EC_unsupported_small_integer: 'errors.unsupportedSmallInteger',
  EC_invalid_neo_address_length: 'errors.invalidNeoAddressLength',

  EC_stage_before_creating_draft: 'operations.stageBeforeCreatingDraft',
  EC_enter_signature_before_appending: 'operations.enterSignatureBeforeAppending',
  EC_stage_before_evm_approval: 'operations.stageBeforeEvmApproval',
  EC_v3_account_id_hash_missing: 'operations.v3AccountIdHashMissing',
  EC_no_verifier_configured: 'operations.noVerifierConfigured',
  EC_no_verifier_plugin: 'sharedDraft.noVerifierPlugin',
  EC_read_only_draft_error: 'operations.readOnlyDraftError',
  EC_preset_proxy_transfer_refused: 'operations.presetProxyTransferRefused',
};

/**
 * Translate an error message. If it's an EC error code, use t() with the
 * mapped i18n key. Otherwise return the raw message.
 */
export function translateError(message, t) {
  if (!message) return '';
  const code = typeof message === 'string' ? message : String(message);
  const normalizedCode = extractErrorCode(code) || code;
  const i18nKey = EC_I18N_KEY[normalizedCode];
  if (i18nKey) {
    return t(i18nKey, normalizedCode);
  }
  return code;
}
