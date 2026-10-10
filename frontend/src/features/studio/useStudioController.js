import { computed, onMounted, ref, watch } from 'vue';
import { MAX_REGISTRATION_ESCAPE_TIMELOCK_DAYS, MIN_REGISTRATION_ESCAPE_TIMELOCK_DAYS, createVerifyScript, deriveAccountIdHash, deriveRegistrationAccountIdHash, getAddressFromScriptHash, hash160, invokeReadFunction, reverseHex } from '@/utils/neo.js';
import { useToast } from 'vue-toastification';
import { connectedAccount } from '@/utils/wallet';
import { connectedDidProfile } from '@/utils/did';
import { walletService, getAbstractAccountHash } from '@/services/walletService';
import { buildMatrixRegistrationInvocation, isMatrixDomain } from '@/services/matrixDomainService.js';
import { loadContractSourceFiles } from './contractSources';
import { useI18n } from '@/i18n';
import { useClipboard } from '@/composables/useClipboard';
import { fetchAccountMetadata, upsertAccountMetadata } from '@/services/accountMetadataService';
import {
  STUDIO_TABS,
  DEFAULT_RECENT_TRANSACTIONS_LIMIT,
  RECENT_TRANSACTIONS_STORAGE_KEY,
  createCreateFormState,
  createManageFormState,
  createPermissionsFormState,
  createManageBusyState,
  createPermissionsBusyState,
  createManageSnapshotState,
  createMetadataFormState,
  createMetadataBusyState
} from './constants';
import {
  addListRow,
  decodeStackBoolean,
  decodeStackByteStringHex,
  decodeStackHash160,
  decodeStackInteger,
  hash160Param,
  normalizeAccountId,
  parseRecentTransactions,
  removeListRow,
  resolveRpcUrl,
  sanitizeHex
} from './helpers';
import { EC, translateError } from '../../config/errorCodes.js';
import { TX_STATUS, waitForTransactionConfirmation } from './txConfirmation.js';

export function useStudioController() {
  const toast = useToast();
  const { t } = useI18n();

  const tabs = STUDIO_TABS;
  const activePanel = ref('operations');

  const isCreating = ref(false);
  const { copiedKey, markCopied, copyText } = useClipboard();
  const activeFileIdx = ref(0);

  const recentTransactions = ref([]);
  const contractFiles = ref([]);
  const isContractFilesLoading = ref(false);

  const matrixCheckResult = ref(null);

  const createForm = ref(createCreateFormState());
  const manageForm = ref(createManageFormState());
  const permissionsForm = ref(createPermissionsFormState());

  const manageBusy = ref(createManageBusyState());
  const permissionsBusy = ref(createPermissionsBusyState());
  const manageSnapshot = ref(createManageSnapshotState());
  const metadataForm = ref(createMetadataFormState());
  const metadataBusy = ref(createMetadataBusyState());

  const autoLoadedAccounts = ref([]);

  const computedScriptHex = ref('');
  const computedAddress = ref('');
  const computedAccountIdHash = ref('');

  let contractFilesPromise = null;

  const walletConnected = computed(() => !!connectedAccount.value);

  const canCreate = computed(() => {
    if (!walletConnected.value) return false;
    if (!computedAddress.value) return false;
    if (!createForm.value.backupOwner) return false;
    const escapeTimelockDays = Number(createForm.value.escapeTimelockDays) || 0;
    if (escapeTimelockDays < MIN_REGISTRATION_ESCAPE_TIMELOCK_DAYS || escapeTimelockDays > MAX_REGISTRATION_ESCAPE_TIMELOCK_DAYS) return false;
    return true;
  });

  const canManageTarget = computed(() => !!manageForm.value.accountAddress && walletConnected.value);
  const canManagePermissions = computed(() => !!permissionsForm.value.accountAddress && walletConnected.value);

  const validCreateAdmins = computed(() => {
    const owner = createForm.value.backupOwner;
    return owner && owner.trim() ? [owner.trim()] : [];
  });

  watch(connectedAccount, async () => {
    if (walletConnected.value && !createForm.value.backupOwner) {
      createForm.value.backupOwner = walletService.address || connectedAccount.value || '';
    }
  }, { immediate: true });

  watch(
    () => [
      createForm.value.verifierContract,
      createForm.value.verifierParams,
      createForm.value.hookContract,
      createForm.value.backupOwner,
      createForm.value.escapeTimelockDays,
    ],
    computeAA
  );

  watch(activePanel, (panel) => {
    if (panel === 'source') {
      void ensureContractFilesLoaded();
    }
  }, { immediate: true });

  onMounted(() => {
    restoreRecentTransactions();
    void computeAA();
  });

  function restoreRecentTransactions() {
    const raw = localStorage.getItem(RECENT_TRANSACTIONS_STORAGE_KEY);
    recentTransactions.value = parseRecentTransactions(raw, []);
  }

  function persistRecentTransactions() {
    localStorage.setItem(RECENT_TRANSACTIONS_STORAGE_KEY, JSON.stringify(recentTransactions.value));
  }

  function addRow(listRef) {
    addListRow(listRef);
  }

  function removeRow(listRef, index) {
    removeListRow(listRef, index);
  }

  async function ensureContractFilesLoaded() {
    if (contractFiles.value.length > 0) return contractFiles.value;
    if (contractFilesPromise) return contractFilesPromise;

    isContractFilesLoading.value = true;
    contractFilesPromise = loadContractSourceFiles()
      .then((files) => {
        contractFiles.value = files;
        return files;
      })
      .finally(() => {
        isContractFilesLoading.value = false;
        contractFilesPromise = null;
      });

    return contractFilesPromise;
  }


  async function invokeReadOperation(operation, args = []) {
    const aaHash = getAbstractAccountHash();
    if (!aaHash) {
      throw new Error(EC.contractNotFound);
    }

    const response = await invokeReadFunction(resolveRpcUrl(walletService), aaHash, operation, args);
    if (response?.state === 'FAULT') {
      throw new Error(EC.operationFailed);
    }
    return response;
  }

  function pushTransaction(label, txid) {
    const entry = {
      label,
      txid,
      when: new Date().toLocaleString(),
      status: TX_STATUS.PENDING,
    };
    recentTransactions.value = [
      entry,
      ...recentTransactions.value
    ].slice(0, DEFAULT_RECENT_TRANSACTIONS_LIMIT);
    persistRecentTransactions();
    return entry;
  }

  function applyTransactionStatus(txid, status, statusDetail = '') {
    let mutated = false;
    recentTransactions.value = recentTransactions.value.map((item) => {
      if (item.txid !== txid) return item;
      mutated = true;
      const next = { ...item, status };
      if (statusDetail) next.statusDetail = statusDetail;
      else delete next.statusDetail;
      return next;
    });
    if (mutated) persistRecentTransactions();
    return mutated;
  }

  /**
   * Resolve the on-chain outcome of a submitted transaction without blocking the
   * UI: poll getapplicationlog until HALT/FAULT or a bounded timeout, then update
   * the persisted recent-transaction entry and surface a follow-up toast. A
   * timeout or unreachable node degrades to 'pending confirmation' so a relayed
   * tx that FAULTed can never be reported as a success.
   */
  async function confirmTransaction(label, txid) {
    const { status, exception } = await waitForTransactionConfirmation(
      resolveRpcUrl(walletService),
      txid,
    );

    if (status === TX_STATUS.CONFIRMED) {
      applyTransactionStatus(txid, TX_STATUS.CONFIRMED);
      toast.success(
        t('studio.toast.txConfirmed', '{label} confirmed on-chain.').replace('{label}', label),
      );
      return status;
    }

    if (status === TX_STATUS.FAILED) {
      applyTransactionStatus(txid, TX_STATUS.FAILED, exception);
      const detail = exception
        ? t('studio.toast.txFailedDetail', '{label} failed on-chain: {detail}')
            .replace('{label}', label)
            .replace('{detail}', exception)
        : t('studio.toast.txFailed', '{label} failed on-chain.').replace('{label}', label);
      toast.error(detail);
      return status;
    }

    applyTransactionStatus(txid, TX_STATUS.PENDING);
    toast.warning(
      t(
        'studio.toast.txPendingConfirmation',
        '{label} submitted but not yet confirmed. Check the explorer for the final result.',
      ).replace('{label}', label),
    );
    return status;
  }

  function trackConfirmation(label, txid) {
    if (!txid) return;
    // Fire-and-forget: confirmation runs asynchronously and updates state/toasts
    // without blocking the submit handler. waitForTransactionConfirmation never
    // throws, but guard the chain defensively so a rejected promise cannot
    // surface as an unhandled rejection.
    void confirmTransaction(label, txid).catch((err) => {
      if (import.meta.env.DEV) console.warn('[useStudioController] confirmTransaction failed:', err?.message);
    });
  }

  async function computeAA() {
    const escapeTimelockDays = Number(createForm.value.escapeTimelockDays) || 0;
    if (!createForm.value.backupOwner || escapeTimelockDays < MIN_REGISTRATION_ESCAPE_TIMELOCK_DAYS || escapeTimelockDays > MAX_REGISTRATION_ESCAPE_TIMELOCK_DAYS) {
      computedScriptHex.value = '';
      computedAddress.value = '';
      computedAccountIdHash.value = '';
      return;
    }

    try {
      const aaHash = getAbstractAccountHash();
      if (!aaHash) return;

      const verifierHash = createForm.value.verifierContract.trim()
        ? hash160Param(createForm.value.verifierContract)
        : '0000000000000000000000000000000000000000';
      const hookHash = createForm.value.hookContract.trim()
        ? hash160Param(createForm.value.hookContract)
        : '0000000000000000000000000000000000000000';
      const verifierParamsHex = sanitizeHex(createForm.value.verifierParams || '');
      const accountIdHash = deriveRegistrationAccountIdHash({
        verifierContractHash: verifierHash,
        verifierParamsHex,
        hookContractHash: hookHash,
        backupOwnerAddress: createForm.value.backupOwner,
        escapeTimelock: Math.floor(escapeTimelockDays * 24 * 60 * 60),
      });
      const script = createVerifyScript(aaHash, accountIdHash);

      computedAccountIdHash.value = accountIdHash;
      computedScriptHex.value = script;
      const scriptHash = reverseHex(hash160(script));
      computedAddress.value = getAddressFromScriptHash(scriptHash);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[useStudioController] computeAA failed:', err?.message);
      computedScriptHex.value = '';
      computedAddress.value = '';
      computedAccountIdHash.value = '';
    }
  }

  function requireWallet() {
    if (!walletConnected.value || !walletService.isConnected) {
      toast.error(t('studio.toast.connectWallet', 'Please connect your wallet first.'));
      return false;
    }
    return true;
  }

  async function checkMatrixDomain() {
    if (!createForm.value.matrixDomain) return;
    try {
      const fullDomain = `${createForm.value.matrixDomain.replace(/\.matrix$/, '')}.matrix`;
      const owner = await invokeReadFunction(walletService.matrixContractHash, 'ownerOf', [
        { type: 'String', value: fullDomain }
      ]);
      const ownerHash = decodeStackByteStringHex(owner.stack?.[0]);
      if (ownerHash) {
        matrixCheckResult.value = { available: false, error: true, message: t('studio.toast.domainTaken', 'Domain is already taken.') };
      } else {
        matrixCheckResult.value = { available: true, error: false, message: t('studio.toast.domainAvailable', 'Domain is available!') };
      }
    } catch (e) {
      if (import.meta.env.DEV) console.error('[useStudioController] checkMatrixDomain failed:', e?.message);
      matrixCheckResult.value = { available: false, error: true, message: t('studioPanels.domainCheckFailed', 'Could not verify domain availability. Please try again.') };
    }
  }

  async function invokeOperation(label, operation, args) {
    const aaHash = getAbstractAccountHash();
    if (!aaHash) {
      throw new Error(EC.contractNotFound);
    }

    const result = await walletService.invoke({
      scriptHash: aaHash,
      operation,
      args,
      signers: [{ account: connectedAccount.value, scopes: 1 }]
    });

    const txid = result?.txid || '';
    if (!txid) {
      throw new Error(EC.noTxId);
    }

    pushTransaction(label, txid);
    toast.info(
      t('studio.toast.txSubmitted', '{label} submitted. Waiting for on-chain confirmation…').replace('{label}', label),
    );
    trackConfirmation(label, txid);
  }

  async function loadAccountConfiguration() {
    if (!requireWallet() || !canManageTarget.value) return;

    manageBusy.value.load = true;
    try {
      const accountHash = deriveAccountIdHash(normalizeAccountId(manageForm.value.accountAddress));

      const [
        verifierRes,
        hookRes,
        backupOwnerRes,
        escapeTimelockRes,
        escapeTriggeredAtRes,
        escapeActiveRes
      ] = await Promise.all([
        invokeReadOperation('getVerifier', [{ type: 'Hash160', value: accountHash }]),
        invokeReadOperation('getHook', [{ type: 'Hash160', value: accountHash }]),
        invokeReadOperation('getBackupOwner', [{ type: 'Hash160', value: accountHash }]),
        invokeReadOperation('getEscapeTimelock', [{ type: 'Hash160', value: accountHash }]),
        invokeReadOperation('getEscapeTriggeredAt', [{ type: 'Hash160', value: accountHash }]),
        invokeReadOperation('isEscapeActive', [{ type: 'Hash160', value: accountHash }]),
      ]);

      const verifier = decodeStackHash160(verifierRes?.stack?.[0]);
      const hook = decodeStackHash160(hookRes?.stack?.[0]);
      const backupOwner = decodeStackHash160(backupOwnerRes?.stack?.[0]);
      const escapeTimelock = decodeStackInteger(escapeTimelockRes?.stack?.[0]);
      const escapeTriggeredAt = decodeStackInteger(escapeTriggeredAtRes?.stack?.[0]);
      const escapeActive = decodeStackBoolean(escapeActiveRes?.stack?.[0]);

      manageForm.value.verifierContract = verifier ? `0x${verifier}` : '';
      manageForm.value.hookContract = hook ? `0x${hook}` : '';
      manageForm.value.backupOwner = backupOwner ? `0x${backupOwner}` : '';
      manageForm.value.escapeTimelock = String(escapeTimelock || 0);
      manageForm.value.escapeTriggeredAt = String(escapeTriggeredAt || 0);
      manageForm.value.escapeActive = escapeActive;
      permissionsForm.value.accountAddress = manageForm.value.accountAddress;

      // Fetch off-chain metadata
      try {
        const meta = await fetchAccountMetadata(accountHash);
        metadataForm.value = {
          metadataUri: meta?.metadata_uri || '',
          description: meta?.description || '',
          logoUrl: meta?.logo_url || '',
        };
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[useStudioController] fetchAccountMetadata failed:', e?.message);
        metadataForm.value = createMetadataFormState();
      }

      manageSnapshot.value = {
        loadedAt: new Date().toLocaleString(),
        accountId: accountHash,
        verifier: manageForm.value.verifierContract,
        hook: manageForm.value.hookContract,
        backupOwner: manageForm.value.backupOwner,
        escapeTimelock,
        escapeTriggeredAt,
        escapeActive,
      };

      toast.success(t('studio.toast.accountLoaded', 'Current account configuration loaded.'));
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      manageBusy.value.load = false;
    }
  }

  async function createAccount() {
    if (!requireWallet()) return;
    if (!canCreate.value) {
      toast.error(t('studio.toast.completeFields', 'Please complete required account configuration fields.'));
      return;
    }

    isCreating.value = true;
    try {
      const verifierHash = createForm.value.verifierContract.trim()
        ? hash160Param(createForm.value.verifierContract)
        : '0000000000000000000000000000000000000000';
      const hookHash = createForm.value.hookContract.trim()
        ? hash160Param(createForm.value.hookContract)
        : '0000000000000000000000000000000000000000';
      const backupOwnerHash = hash160Param(createForm.value.backupOwner);
      const verifierParamsHex = sanitizeHex(createForm.value.verifierParams || '');
      const escapeTimelockSeconds = Math.floor((Number(createForm.value.escapeTimelockDays) || 0) * 24 * 60 * 60);
      const accountIdHash = deriveRegistrationAccountIdHash({
        verifierContractHash: verifierHash,
        verifierParamsHex,
        hookContractHash: hookHash,
        backupOwnerAddress: createForm.value.backupOwner,
        escapeTimelock: escapeTimelockSeconds,
      });
      const createInvocation = {
        scriptHash: getAbstractAccountHash(),
        operation: 'registerAccount',
        args: [
          // Display-form account id: matches the on-chain
          // ComputeRegistrationAccountId assert (the byte-reversed internal
          // form would fault here under the standard Hash160 convention).
          { type: 'Hash160', value: accountIdHash },
          { type: 'Hash160', value: verifierHash },
          { type: 'ByteArray', value: verifierParamsHex ? `0x${verifierParamsHex}` : '0x' },
          { type: 'Hash160', value: hookHash },
          { type: 'Hash160', value: backupOwnerHash },
          { type: 'Integer', value: escapeTimelockSeconds }
        ]
      };

      const baseDomain = createForm.value.matrixDomain.replace(/\.matrix$/, '');
      const matrixDomain = baseDomain ? `${baseDomain}.matrix` : '';
      if (matrixDomain) {
        if (!isMatrixDomain(matrixDomain)) {
          throw new Error(EC.matrixDomainInvalid);
        }
        const ownerAddress = connectedAccount.value;
        if (!ownerAddress) {
          throw new Error(EC.connectWalletMatrix);
        }
        const matrixInvocation = buildMatrixRegistrationInvocation(matrixDomain, ownerAddress);
        const result = await walletService.invokeMultiple({
          invokeArgs: [createInvocation, matrixInvocation],
          signers: [{ account: connectedAccount.value, scopes: 1 }]
        });
        const txid = result?.txid || result?.transaction || '';
        if (!txid) throw new Error(EC.noTxId);
        const matrixLabel = `Register V3 account + register ${matrixDomain}`;
        pushTransaction(matrixLabel, txid);
        toast.info(t('studio.toast.registerAccountMatrix', 'Register V3 account + {domain} registration submitted. Waiting for confirmation…').replace('{domain}', matrixDomain));
        trackConfirmation(matrixLabel, txid);
      } else {
        await invokeOperation('Register V3 account', 'registerAccount', createInvocation.args);
      }
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      isCreating.value = false;
    }
  }

  async function updateVerifier() {
    if (!requireWallet() || !canManageTarget.value) return;
    manageBusy.value.verifier = true;
    try {
      const accountIdHash = deriveAccountIdHash(normalizeAccountId(manageForm.value.accountAddress));
      const verifierHash = manageForm.value.verifierContract.trim()
        ? hash160Param(manageForm.value.verifierContract)
        : '0000000000000000000000000000000000000000';
      const verifierParamsHex = sanitizeHex(manageForm.value.verifierParams || '');
      await invokeOperation('Update verifier', 'updateVerifier', [
        { type: 'Hash160', value: accountIdHash },
        { type: 'Hash160', value: verifierHash },
        { type: 'ByteArray', value: verifierParamsHex ? `0x${verifierParamsHex}` : '0x' }
      ]);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      manageBusy.value.verifier = false;
    }
  }

  async function updateHook() {
    if (!requireWallet() || !canManageTarget.value) return;
    manageBusy.value.hook = true;
    try {
      const accountIdHash = deriveAccountIdHash(normalizeAccountId(manageForm.value.accountAddress));
      const hookHash = manageForm.value.hookContract.trim()
        ? hash160Param(manageForm.value.hookContract)
        : '0000000000000000000000000000000000000000';
      await invokeOperation('Update hook', 'updateHook', [
        { type: 'Hash160', value: accountIdHash },
        { type: 'Hash160', value: hookHash }
      ]);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      manageBusy.value.hook = false;
    }
  }

  async function initiateEscape() {
    if (!requireWallet() || !canManageTarget.value) return;
    manageBusy.value.initiateEscape = true;
    try {
      const accountIdHash = deriveAccountIdHash(normalizeAccountId(manageForm.value.accountAddress));
      await invokeOperation('Initiate escape', 'initiateEscape', [
        { type: 'Hash160', value: accountIdHash },
      ]);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      manageBusy.value.initiateEscape = false;
    }
  }

  async function finalizeEscape() {
    if (!requireWallet() || !canManageTarget.value) return;
    if (!manageForm.value.escapeNewVerifier) {
      toast.error(t('studio.toast.provideNewVerifier', 'Provide the new verifier hash to finalize escape.'));
      return;
    }
    manageBusy.value.finalizeEscape = true;
    try {
      const accountIdHash = deriveAccountIdHash(normalizeAccountId(manageForm.value.accountAddress));
      await invokeOperation('Finalize escape', 'finalizeEscape', [
        { type: 'Hash160', value: accountIdHash },
        { type: 'Hash160', value: hash160Param(manageForm.value.escapeNewVerifier) },
      ]);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      manageBusy.value.finalizeEscape = false;
    }
  }

  async function saveMetadata() {
    if (!requireWallet() || !canManageTarget.value) return;
    metadataBusy.value.save = true;
    try {
      const accountIdHash = deriveAccountIdHash(normalizeAccountId(manageForm.value.accountAddress));

      // On-chain: set MetadataUri
      const metadataUri = metadataForm.value.metadataUri.trim();
      await invokeOperation('Set metadata URI', 'setMetadataUri', [
        { type: 'Hash160', value: accountIdHash },
        { type: 'String', value: metadataUri },
      ]);

      // Off-chain: save description + logo. The on-chain setMetadataUri above is the
      // authoritative record; the off-chain mirror requires proof of account control
      // (Web3Auth idToken whose key is the account's backup owner). When that proof is
      // unavailable, keep the on-chain save successful and surface a soft warning rather
      // than failing the whole operation.
      try {
        await upsertAccountMetadata({
          accountIdHash,
          description: metadataForm.value.description.trim(),
          logoUrl: metadataForm.value.logoUrl.trim(),
          metadataUri,
          idToken: (connectedDidProfile.value?.idToken || '').trim() || undefined,
        });
        toast.success(t('studio.toast.metadataSaved', 'Account metadata saved.'));
      } catch (offChainErr) {
        toast.warning(
          t(
            'studio.toast.metadataOnChainOnly',
            'On-chain metadata saved. Sign in with your account identity to also sync the off-chain profile.',
          ),
        );
        if (import.meta.env.DEV) console.error('[studio] off-chain metadata sync failed:', offChainErr?.apiDetail || offChainErr?.message);
      }
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      metadataBusy.value.save = false;
    }
  }

  function parseTypedArgsJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[useStudioController] parseArgsJson failed:', err?.message);
      throw new Error(EC.invalidJsonSyntax);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(EC.invalidArgsJson);
    }
    return parsed;
  }

  async function callVerifier() {
    if (!requireWallet() || !canManagePermissions.value) return;
    if (!permissionsForm.value.verifierMethod.trim()) {
      toast.error(t('studio.toast.provideVerifierMethod', 'Provide a verifier method name.'));
      return;
    }
    permissionsBusy.value.verifierCall = true;
    try {
      const accountIdHash = deriveAccountIdHash(normalizeAccountId(permissionsForm.value.accountAddress));
      await invokeOperation('Call verifier plugin', 'callVerifier', [
        { type: 'Hash160', value: accountIdHash },
        { type: 'String', value: permissionsForm.value.verifierMethod.trim() },
        { type: 'Array', value: parseTypedArgsJson(permissionsForm.value.verifierArgsJson) },
      ]);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      permissionsBusy.value.verifierCall = false;
    }
  }

  async function callHook() {
    if (!requireWallet() || !canManagePermissions.value) return;
    if (!permissionsForm.value.hookMethod.trim()) {
      toast.error(t('studio.toast.provideHookMethod', 'Provide a hook method name.'));
      return;
    }
    permissionsBusy.value.hookCall = true;
    try {
      const accountIdHash = deriveAccountIdHash(normalizeAccountId(permissionsForm.value.accountAddress));
      await invokeOperation('Call hook plugin', 'callHook', [
        { type: 'Hash160', value: accountIdHash },
        { type: 'String', value: permissionsForm.value.hookMethod.trim() },
        { type: 'Array', value: parseTypedArgsJson(permissionsForm.value.hookArgsJson) },
      ]);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      permissionsBusy.value.hookCall = false;
    }
  }

  async function copyCode() {
    await ensureContractFilesLoaded();
    const content = contractFiles.value[activeFileIdx.value]?.content;
    if (!content) return;
    if (await copyText(content)) markCopied('code');
  }

  return {
    tabs,
    activePanel,
    isCreating,
    copiedKey,
    activeFileIdx,
    recentTransactions,
    createForm,
    manageForm,
    permissionsForm,
    manageBusy,
    permissionsBusy,
    manageSnapshot,
    metadataForm,
    metadataBusy,
    computedScriptHex,
    computedAddress,
    computedAccountIdHash,
    contractFiles,
    isContractFilesLoading,
    walletConnected,
    autoLoadedAccounts,
    canCreate,
    canManageTarget,
    canManagePermissions,
    validCreateAdmins,
    addRow,
    removeRow,
    computeAA,
    loadAccountConfiguration,
    createAccount,
    checkMatrixDomain,
    matrixCheckResult,
    updateVerifier,
    updateHook,
    initiateEscape,
    finalizeEscape,
    saveMetadata,
    callVerifier,
    callHook,
    loadContractFiles: ensureContractFilesLoaded,
    copyCode
  };
}
