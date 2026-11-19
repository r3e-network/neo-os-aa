import { computed, onMounted, ref, watch } from 'vue';
import {
  MAX_RECOVERY_TIMELOCK_DAYS,
  MIN_RECOVERY_TIMELOCK_DAYS,
  invokeReadFunction,
} from '@/utils/neo.js';
import { useToast } from 'vue-toastification';
import { connectedAccount } from '@/utils/wallet';
import { connectedDidProfile } from '@/utils/did';
import { walletService, getSmartAccountHash } from '@/services/walletService';
import { buildMatrixRegistrationInvocation, isMatrixDomain } from '@/services/matrixDomainService.js';
import { RUNTIME_CONFIG } from '@/config/runtimeConfig.js';
import { loadContractSourceFiles } from './contractSources';
import {
  generateRegistrationSalt,
  planCreateAccount,
} from './createAccountPlan.js';
import {
  assertConfigurationReviewCurrent,
  captureConfigurationReview,
  custodyActionBlockers,
  custodyIssues,
  intentStatus,
  readAccountConfiguration,
  readChainClock,
} from './governance.js';
import {
  configureModuleAction,
  installModuleAction,
  planAccountAction,
  planCancelConfiguration,
  planConfirmConfiguration,
  planProposeConfiguration,
  setDefaultPolicyAction,
  setHookOrderAction,
  setRecoveryPolicyAction,
  setThresholdPolicyAction,
  uninstallModuleAction,
} from '@/services/smartAccountProtocol.js';
import { fetchModuleProfile } from '@/services/moduleProfileService.js';
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
  createMetadataBusyState,
} from './constants';
import {
  addListRow,
  decodeStackByteStringHex,
  hash160Param,
  normalizeAccountId,
  parseRecentTransactions,
  removeListRow,
  resolveRpcUrl,
} from './helpers';
import { EC, translateError } from '../../config/errorCodes.js';
import { TX_STATUS, waitForTransactionConfirmation } from './txConfirmation.js';
import { fetchWithTimeout } from '../../utils/fetchWithTimeout.js';
import { captureMetadataSaveIntent, metadataIntentMatchesCurrent, metadataMirrorPayload } from './metadataSave.js';

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

  /** The configuration the operator is reviewing, before any wallet is asked. */
  const configurationReview = ref(null);

  let contractFilesPromise = null;

  const walletConnected = computed(() => !!connectedAccount.value);

  const custodyIssue = computed(() => {
    if (!createForm.value.custody) return '';
    return custodyIssues(createForm.value.custody, connectedAccount.value);
  });
  const custodyError = computed(() => {
    const issue = custodyIssue.value;
    if (!issue) return '';
    if (issue === 'custody-mismatch') return t('custom.ownerMismatch', 'Connect the account custody wallet. This registration requests only the connected wallet witness.');
    if (issue === 'custody-invalid') return t('custom.ownerInvalid', 'Enter a valid Neo N3 address or Neo script hash, not an Ethereum address.');
    return t('custom.walletRequired', 'Connect the custody wallet first.');
  });

  const canCreate = computed(() => {
    if (!walletConnected.value) return false;
    if (!computedAddress.value) return false;
    if (custodyIssue.value) return false;
    const days = Number(createForm.value.recoveryTimelockDays) || 0;
    return days >= MIN_RECOVERY_TIMELOCK_DAYS && days <= MAX_RECOVERY_TIMELOCK_DAYS;
  });

  const canManageTarget = computed(() => !!manageForm.value.accountAddress && walletConnected.value);
  const isCustodyOwner = computed(() => !!manageSnapshot.value.loadedAt
    && !custodyIssues(manageSnapshot.value.account?.custody, connectedAccount.value));
  const managementBusy = computed(() => Object.values(manageBusy.value).some(Boolean) || metadataBusy.value.save);
  const canReadModule = computed(() => !!manageSnapshot.value.loadedAt && walletConnected.value);
  /** JSON rendering of the last module read, kept apart from configuration outcomes. */
  const moduleReadOutcome = ref('');
  const configurationOutcome = ref('');
  let contextEpoch = 0;

  watch(() => [manageForm.value.accountAddress, connectedAccount.value], () => {
    contextEpoch += 1;
    manageSnapshot.value = createManageSnapshotState();
    configurationOutcome.value = '';
    configurationReview.value = null;
  });

  watch(connectedAccount, async () => {
    if (walletConnected.value && !createForm.value.custody) {
      createForm.value.custody = walletService.address || connectedAccount.value || '';
    }
  }, { immediate: true });

  watch(
    () => [
      createForm.value.custody,
      createForm.value.salt,
      createForm.value.recoveryTimelockDays,
    ],
    computeSA
  );

  watch(activePanel, (panel) => {
    if (panel === 'source') {
      void ensureContractFilesLoaded();
    }
  }, { immediate: true });

  onMounted(() => {
    restoreRecentTransactions();
    void computeSA();
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
    const saHash = getSmartAccountHash();
    if (!saHash) {
      throw new Error(EC.contractNotFound);
    }

    const response = await invokeReadFunction(resolveRpcUrl(walletService), saHash, operation, args);
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
  async function confirmTransaction(label, txid, { rpcUrl = resolveRpcUrl(walletService) } = {}) {
    const { status, exception } = await waitForTransactionConfirmation(rpcUrl, txid);

    if (status === TX_STATUS.CONFIRMED) {
      applyTransactionStatus(txid, TX_STATUS.CONFIRMED);
      toast.success(t('studio.toast.txConfirmed', '{label} confirmed on-chain.').replace('{label}', label));
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
      t('studio.toast.txPendingConfirmation', '{label} submitted but not yet confirmed. Check the explorer for the final result.')
        .replace('{label}', label),
    );
    return status;
  }

  function trackConfirmation(label, txid, rpcUrl = resolveRpcUrl(walletService)) {
    if (!txid) return;
    void confirmTransaction(label, txid, { rpcUrl }).catch((err) => {
      if (import.meta.env.DEV) console.warn('[useStudioController] confirmTransaction failed:', err?.message);
    });
  }

  function regenerateSalt() {
    try {
      createForm.value.salt = generateRegistrationSalt();
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function computeSA() {
    const days = Number(createForm.value.recoveryTimelockDays) || 0;
    if (!createForm.value.custody || !createForm.value.salt
      || days < MIN_RECOVERY_TIMELOCK_DAYS || days > MAX_RECOVERY_TIMELOCK_DAYS) {
      computedScriptHex.value = '';
      computedAddress.value = '';
      computedAccountIdHash.value = '';
      return;
    }

    try {
      const saHash = getSmartAccountHash();
      if (!saHash) return;

      const plan = planCreateAccount(createForm.value, saHash);
      computedAccountIdHash.value = plan.accountId;
      computedScriptHex.value = plan.verificationScript;
      computedAddress.value = plan.accountAddress;
    } catch (err) {
      if (import.meta.env.DEV) console.error('[useStudioController] computeSA failed:', err?.message);
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

  async function invokeOperation(label, operation, args, { waitForConfirmation = false, context = null, signer = null } = {}) {
    const operationContext = context || {
      rpcUrl: resolveRpcUrl(walletService),
      coreHash: getSmartAccountHash(),
      wallet: connectedAccount.value,
    };
    const saHash = operationContext.coreHash;
    if (!saHash) {
      throw new Error(EC.contractNotFound);
    }

    const result = await walletService.invoke({
      scriptHash: saHash,
      operation,
      args,
      signers: [{ account: signer || operationContext.wallet, scopes: 1 }]
    });

    const txid = result?.txid || '';
    if (!txid) {
      throw new Error(EC.noTxId);
    }

    pushTransaction(label, txid);
    toast.info(
      t('studio.toast.txSubmitted', '{label} submitted. Waiting for on-chain confirmation…').replace('{label}', label),
    );
    if (waitForConfirmation) return { txid, status: await confirmTransaction(label, txid, { rpcUrl: operationContext.rpcUrl }) };
    trackConfirmation(label, txid, operationContext.rpcUrl);
    return { txid, status: TX_STATUS.PENDING };
  }

  async function createAccount() {
    if (!requireWallet()) return;
    if (!canCreate.value) {
      toast.error(t('studio.toast.completeFields', 'Please complete required account configuration fields.'));
      return;
    }

    isCreating.value = true;
    try {
      const saHash = getSmartAccountHash();
      const plan = planCreateAccount(createForm.value, saHash);
      const createInvocation = {
        scriptHash: saHash,
        ...plan.invocation,
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
          signers: [{ account: plan.custodyAddress, scopes: 1 }]
        });
        const txid = result?.txid || result?.transaction || '';
        if (!txid) throw new Error(EC.noTxId);
        const matrixLabel = `Create account + register ${matrixDomain}`;
        pushTransaction(matrixLabel, txid);
        toast.info(t('studio.toast.createAccountMatrix', 'Create account + {domain} registration submitted. Waiting for confirmation…').replace('{domain}', matrixDomain));
        trackConfirmation(matrixLabel, txid);
      } else {
        await invokeOperation('Create account', 'createAccount', createInvocation.args, { signer: plan.custodyAddress });
      }
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      isCreating.value = false;
    }
  }

  async function governanceRpc(method, params) {
    const response = await fetchWithTimeout(resolveRpcUrl(walletService), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!response.ok) throw new Error(EC.rpcRequestFailed);
    const body = await response.json();
    if (body.error || body.result == null) throw new Error(EC.rpcRequestFailed);
    return body.result;
  }

  async function fetchAccountConfiguration(accountId) {
    return readAccountConfiguration({
      accountId,
      read: invokeReadOperation,
      readClock: () => readChainClock(governanceRpc),
    });
  }

  async function loadAccountConfiguration() {
    if (!requireWallet() || managementBusy.value || !canManageTarget.value) return;

    manageBusy.value.load = true;
    try {
      const requestedAccount = normalizeAccountId(manageForm.value.accountAddress);
      const loadEpoch = contextEpoch;
      const loadWallet = connectedAccount.value;
      const loadRpcUrl = resolveRpcUrl(walletService);
      const loadCoreHash = getSmartAccountHash();
      const loadWalletContext = walletService.contextVersion;
      const isCurrentLoad = () => loadEpoch === contextEpoch
        && requestedAccount.toLowerCase() === normalizeAccountId(manageForm.value.accountAddress).toLowerCase()
        && loadWallet === connectedAccount.value
        && loadRpcUrl === resolveRpcUrl(walletService)
        && loadCoreHash === getSmartAccountHash()
        && loadWalletContext === walletService.contextVersion
        && walletService.sessionState === 'verified';

      const snapshot = await fetchAccountConfiguration(requestedAccount);
      if (!isCurrentLoad()) return;
      applySnapshot(snapshot);

      // Fetch off-chain metadata
      try {
        const meta = await fetchAccountMetadata(requestedAccount);
        if (!isCurrentLoad()) return;
        metadataForm.value = {
          metadataUri: meta?.metadata_uri || '',
          description: meta?.description || '',
          logoUrl: meta?.logo_url || '',
        };
      } catch (e) {
        if (import.meta.env.DEV) console.warn('[useStudioController] fetchAccountMetadata failed:', e?.message);
        if (isCurrentLoad()) {
          metadataForm.value = createMetadataFormState();
        }
      }

      if (!isCurrentLoad()) return;
      toast.success(t('studio.toast.accountLoaded', 'Current account configuration loaded.'));
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      manageBusy.value.load = false;
    }
  }

  function applySnapshot(snapshot) {
    const { account, modules, hookOrder, recovery, pending } = snapshot;
    manageForm.value.status = account.status;
    manageForm.value.custody = account.custody ? `0x${account.custody}` : '';
    manageForm.value.recoveryAuthority = account.recoveryAuthority ? `0x${account.recoveryAuthority}` : '';
    manageForm.value.recoveryTimelockMs = account.recoveryTimelockMs;
    manageForm.value.authorityEpoch = account.authorityEpoch;
    manageForm.value.configurationNonce = account.configurationNonce;
    manageForm.value.hookOrderRevision = account.hookOrderRevision;
    manageForm.value.defaultOperationAuthorization = account.defaultOperationAuthorization;
    manageForm.value.defaultMessageAuthorization = account.defaultMessageAuthorization;
    manageForm.value.ownerOnlyRecovery = account.ownerOnlyRecovery;
    manageForm.value.recoveryPending = account.recoveryPending;
    manageForm.value.recoveryMatureAt = recovery ? recovery.matureAt : '';
    manageForm.value.marketEscrowActive = account.marketEscrowActive;
    manageForm.value.modules = modules;
    manageForm.value.hookIds = hookOrder.hookIds;
    manageForm.value.pendingIntent = pending[0] || null;
    permissionsForm.value.accountAddress = manageForm.value.accountAddress;
    manageSnapshot.value = { ...snapshot, loadedAt: new Date().toLocaleString() };
  }

  function requireLoadedSnapshot() {
    const snapshot = manageSnapshot.value;
    if (!snapshot?.loadedAt || !snapshot.account) {
      throw new Error(t('custom.loadFirst', 'Load the account configuration first.'));
    }
    return snapshot;
  }

  /** Reads the account again right before signing; a stale review never signs. */
  async function refreshSnapshot(accountId) {
    return fetchAccountConfiguration(accountId);
  }

  async function prepareConfiguration(actions, label) {
    if (!requireWallet() || managementBusy.value) return;
    try {
      const snapshot = requireLoadedSnapshot();
      if (custodyIssues(snapshot.account?.custody, connectedAccount.value)) {
        throw new Error(t('custom.connectOwner', 'Connect the account custody wallet.'));
      }
      const review = captureConfigurationReview(snapshot, actions);
      configurationReview.value = { ...review, label };
      return configurationReview.value;
    } catch (err) {
      toast.error(translateError(err?.message, t));
      return null;
    }
  }

  function dismissConfigurationReview() {
    configurationReview.value = null;
  }

  async function submitConfiguration() {
    const review = configurationReview.value;
    if (!review || !requireWallet() || managementBusy.value) return;
    manageBusy.value.propose = true;
    configurationOutcome.value = '';
    try {
      const sameContext = () => review.snapshot.accountId === normalizeAccountId(manageForm.value.accountAddress).toLowerCase()
        && review.accountId === normalizeAccountId(manageForm.value.accountAddress).toLowerCase();

      if (!sameContext()) throw new Error(t('custom.reviewChanged', 'Account, wallet or network changed. Load and review again.'));
      const fresh = await refreshSnapshot(review.accountId);
      if (!sameContext()) throw new Error(t('custom.reviewChanged', 'Account, wallet or network changed. Load and review again.'));
      assertConfigurationReviewCurrent(review, fresh, connectedAccount.value);

      const plan = planProposeConfiguration({ accountId: review.accountId, actions: review.actions });
      const result = await invokeOperation(review.label || 'Propose configuration', plan.operation, plan.args, { waitForConfirmation: true });
      if (result.status === TX_STATUS.CONFIRMED) {
        configurationOutcome.value = t('custom.intentProposed', 'Configuration intent proposed. It matures on-chain before it can be confirmed.');
        applySnapshot(await refreshSnapshot(review.accountId));
      } else if (result.status === TX_STATUS.PENDING) {
        configurationOutcome.value = t('custom.pendingConfirmation', 'Submitted; confirmation is still unknown. Check the transaction before repeating an action.');
        manageSnapshot.value = createManageSnapshotState();
      }
    } catch (err) {
      configurationOutcome.value = translateError(err?.message, t);
      toast.error(configurationOutcome.value);
    } finally {
      manageBusy.value.propose = false;
      configurationReview.value = null;
    }
  }

  async function confirmPendingIntent() {
    if (!requireWallet() || managementBusy.value) return;
    manageBusy.value.confirm = true;
    configurationOutcome.value = '';
    try {
      const snapshot = requireLoadedSnapshot();
      if (custodyIssues(snapshot.account?.custody, connectedAccount.value)) {
        throw new Error(t('custom.connectOwner', 'Connect the account custody wallet.'));
      }
      const intent = snapshot.pending?.[0];
      if (!intent) throw new Error(t('custom.noPendingIntent', 'There is no pending configuration intent.'));
      const status = intentStatus(intent, snapshot.chain.time * 1000);
      if (status !== 'mature') {
        throw new Error(status === 'expired'
          ? t('custom.intentExpired', 'The pending configuration intent has expired. Cancel it and propose again.')
          : t('custom.intentMaturing', 'The configuration intent is not mature yet. Refresh node state after the deadline.'));
      }
      const plan = planConfirmConfiguration({
        accountId: snapshot.accountId,
        intentId: intent.intentId,
        actions: intent.actions,
      });
      const result = await invokeOperation('Confirm configuration', plan.operation, plan.args, { waitForConfirmation: true });
      if (result.status === TX_STATUS.CONFIRMED) {
        configurationOutcome.value = t('custom.confirmedRefresh', 'Confirmed on-chain. Refresh account state before the next action.');
        applySnapshot(await refreshSnapshot(snapshot.accountId));
      } else if (result.status === TX_STATUS.PENDING) {
        configurationOutcome.value = t('custom.pendingConfirmation', 'Submitted; confirmation is still unknown. Check the transaction before repeating an action.');
        manageSnapshot.value = createManageSnapshotState();
      }
    } catch (err) {
      configurationOutcome.value = translateError(err?.message, t);
      toast.error(configurationOutcome.value);
    } finally {
      manageBusy.value.confirm = false;
    }
  }

  async function cancelPendingIntent() {
    if (!requireWallet() || managementBusy.value) return;
    manageBusy.value.cancel = true;
    configurationOutcome.value = '';
    try {
      const snapshot = requireLoadedSnapshot();
      if (custodyIssues(snapshot.account?.custody, connectedAccount.value)) {
        throw new Error(t('custom.connectOwner', 'Connect the account custody wallet.'));
      }
      const intent = snapshot.pending?.[0];
      if (!intent) throw new Error(t('custom.noPendingIntent', 'There is no pending configuration intent.'));
      const plan = planCancelConfiguration({ accountId: snapshot.accountId, intentId: intent.intentId });
      const result = await invokeOperation('Cancel configuration intent', plan.operation, plan.args, { waitForConfirmation: true });
      if (result.status === TX_STATUS.CONFIRMED) {
        configurationOutcome.value = t('custom.intentCancelled', 'Configuration intent cancelled.');
        applySnapshot(await refreshSnapshot(snapshot.accountId));
      }
    } catch (err) {
      configurationOutcome.value = translateError(err?.message, t);
      toast.error(configurationOutcome.value);
    } finally {
      manageBusy.value.cancel = false;
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

  async function prepareInstallModule() {
    const moduleHash = manageForm.value.moduleContract;
    if (!hash160Param(moduleHash)) return;
    try {
      const profile = await fetchModuleProfile({
        rpcUrl: resolveRpcUrl(walletService),
        moduleHash,
      });
      manageForm.value.moduleType = profile.profile.moduleType;
      manageForm.value.moduleProfileDigest = profile.profileDigest;
      const action = installModuleAction({
        moduleType: profile.profile.moduleType,
        moduleHash,
        profileDigest: profile.profileDigest,
        initData: parseTypedArgsJson(manageForm.value.moduleInitDataJson),
      });
      await prepareConfiguration([action], `Install ${profile.profile.contractName || 'module'}`);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function prepareConfigureModule() {
    try {
      const moduleId = manageForm.value.selectedModuleId;
      if (!moduleId) throw new Error(t('custom.selectModule', 'Select an installed module first.'));
      const action = configureModuleAction(moduleId, parseTypedArgsJson(manageForm.value.moduleConfigJson));
      await prepareConfiguration([action], `Configure module ${moduleId}`);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function prepareUninstallModule() {
    try {
      const moduleId = manageForm.value.selectedModuleId;
      if (!moduleId) throw new Error(t('custom.selectModule', 'Select an installed module first.'));
      const action = uninstallModuleAction(moduleId, parseTypedArgsJson(manageForm.value.moduleDeInitDataJson));
      await prepareConfiguration([action], `Uninstall module ${moduleId}`);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function prepareHookOrder() {
    try {
      const action = setHookOrderAction(manageForm.value.hookIds);
      await prepareConfiguration([action], 'Set hook order');
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function prepareThresholdPolicy() {
    try {
      const action = setThresholdPolicyAction({
        policyId: manageForm.value.thresholdPolicyId || 0,
        threshold: manageForm.value.threshold,
        memberIds: manageForm.value.thresholdMembers,
        active: manageForm.value.thresholdActive,
      });
      await prepareConfiguration([action], 'Set threshold policy');
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function prepareRecoveryPolicy() {
    try {
      const action = setRecoveryPolicyAction({
        recoveryAuthority: manageForm.value.recoveryPolicyAuthority || '0x0000000000000000000000000000000000000000',
        timelockMs: Math.round((Number(manageForm.value.recoveryPolicyTimelockDays) || 0) * 86_400_000),
        ownerOnly: manageForm.value.ownerOnlyAcknowledged === true,
      });
      await prepareConfiguration([action], 'Set recovery policy');
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function prepareDefaultPolicy() {
    try {
      const action = setDefaultPolicyAction({
        operationAuthorization: manageForm.value.defaultOperationAuthorization,
        messageAuthorization: manageForm.value.defaultMessageAuthorization,
      });
      await prepareConfiguration([action], 'Set default authorization');
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function runCustodyAction(action, label, args = []) {
    if (!requireWallet() || managementBusy.value) return;
    manageBusy.value.recovery = true;
    configurationOutcome.value = '';
    try {
      const snapshot = requireLoadedSnapshot();
      if (custodyIssues(snapshot.account?.custody, connectedAccount.value)) {
        throw new Error(t('custom.connectOwner', 'Connect the account custody wallet.'));
      }
      const blocker = custodyActionBlockers(snapshot, action);
      if (blocker) throw new Error(blocker);
      const plan = planAccountAction(action, snapshot.accountId, args);
      const result = await invokeOperation(label, plan.operation, plan.args, { waitForConfirmation: true });
      if (result.status === TX_STATUS.CONFIRMED) {
        configurationOutcome.value = t('custom.confirmedRefresh', 'Confirmed on-chain. Refresh account state before the next action.');
        applySnapshot(await refreshSnapshot(snapshot.accountId));
      } else if (result.status === TX_STATUS.PENDING) {
        configurationOutcome.value = t('custom.pendingConfirmation', 'Submitted; confirmation is still unknown. Check the transaction before repeating an action.');
        manageSnapshot.value = createManageSnapshotState();
      }
    } catch (err) {
      configurationOutcome.value = translateError(err?.message, t);
      toast.error(configurationOutcome.value);
    } finally {
      manageBusy.value.recovery = false;
    }
  }

  const beginRecovery = () => runCustodyAction('beginRecovery', 'Begin recovery', [
    { type: 'Hash160', value: hash160Param(manageForm.value.newCustody) },
  ]);
  const cancelRecovery = () => runCustodyAction('cancelRecovery', 'Cancel recovery');
  const executeRecovery = () => runCustodyAction('executeRecovery', 'Execute recovery');

  async function freezeAccount() {
    manageBusy.value.freeze = true;
    try {
      await runCustodyAction(manageForm.value.status === 'frozen' ? 'unfreezeAccount' : 'freezeAccount',
        manageForm.value.status === 'frozen' ? 'Unfreeze account' : 'Freeze account');
    } finally {
      manageBusy.value.freeze = false;
    }
  }

  async function revokeCredentials() {
    try {
      const moduleId = manageForm.value.selectedModuleId;
      if (!moduleId) throw new Error(t('custom.selectModule', 'Select an installed module first.'));
      await runCustodyAction('revokeCredentials', `Revoke credentials for module ${moduleId}`, [
        { type: 'Integer', value: String(moduleId) },
      ]);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    }
  }

  async function saveMetadata() {
    if (!requireWallet() || managementBusy.value || !canManageTarget.value) return;

    const accountIdHash = normalizeAccountId(manageForm.value.accountAddress);
    const rpcUrl = resolveRpcUrl(walletService);
    const coreHash = getSmartAccountHash();
    const wallet = connectedAccount.value;
    const snapshotCustody = manageSnapshot.value.account?.custody;
    const idToken = (connectedDidProfile.value?.idToken || '').trim();
    const intent = captureMetadataSaveIntent({
      accountAddress: accountIdHash,
      accountIdHash,
      custody: snapshotCustody,
      wallet,
      rpcUrl,
      coreHash,
      metadataUri: metadataForm.value.metadataUri,
      description: metadataForm.value.description,
      logoUrl: metadataForm.value.logoUrl,
      idToken,
      epoch: contextEpoch,
      walletContext: walletService.contextVersion,
    });

    metadataBusy.value.save = true;
    try {
      const sameContext = () => metadataIntentMatchesCurrent(intent, {
        accountAddress: manageForm.value.accountAddress,
        accountIdHash,
        custody: snapshotCustody,
        wallet: connectedAccount.value,
        rpcUrl: resolveRpcUrl(walletService),
        coreHash: getSmartAccountHash(),
        metadataUri: metadataForm.value.metadataUri,
        description: metadataForm.value.description,
        logoUrl: metadataForm.value.logoUrl,
        idToken: (connectedDidProfile.value?.idToken || '').trim(),
        epoch: contextEpoch,
        walletContext: walletService.contextVersion,
      });

      if (!sameContext() || walletService.sessionState !== 'verified') throw new Error(t('custom.reviewChanged', 'Account, wallet or network changed. Load and review again.'));
      const fresh = await refreshSnapshot(accountIdHash);
      if (!sameContext() || walletService.sessionState !== 'verified') throw new Error(t('custom.reviewChanged', 'Account, wallet or network changed. Load and review again.'));
      if (String(fresh.account?.custody || '').toLowerCase() !== intent.custody) {
        throw new Error(t('custom.reviewChanged', 'Account, wallet or network changed. Load and review again.'));
      }
      if (custodyIssues(fresh.account?.custody, intent.wallet)) {
        throw new Error(t('custom.connectOwner', 'Connect the account custody wallet.'));
      }

      // On-chain: setMetadataUri
      const plan = planAccountAction('setMetadataUri', accountIdHash, [
        { type: 'String', value: intent.metadataUri },
      ]);
      const result = await invokeOperation('Set metadata URI', plan.operation, plan.args, {
        waitForConfirmation: true,
        context: { rpcUrl: intent.rpcUrl, coreHash: intent.coreHash, wallet: intent.wallet },
      });

      if (result.status !== TX_STATUS.CONFIRMED) {
        if (result.status === TX_STATUS.PENDING) {
          configurationOutcome.value = t('custom.metadataPending', 'Metadata transaction is awaiting confirmation. The off-chain profile was not updated. Refresh before trying again.');
        }
        return;
      }

      // If the user changed the target, wallet, network, or fields while the
      // wallet was waiting, never attach the original transaction to new data.
      const confirmedSnapshot = await refreshSnapshot(accountIdHash);
      if (!sameContext()
        || walletService.sessionState !== 'verified'
        || String(confirmedSnapshot.account?.custody || '').toLowerCase() !== intent.custody
        || custodyIssues(confirmedSnapshot.account?.custody, intent.wallet)) {
        toast.warning(t('custom.metadataChanged', 'On-chain metadata was confirmed, but the account or form changed while signing. Refresh the account before syncing the off-chain profile.'));
        return;
      }

      try {
        await upsertAccountMetadata(metadataMirrorPayload(intent));
        toast.success(t('studio.toast.metadataSaved', 'Account metadata saved.'));
      } catch (offChainErr) {
        toast.warning(
          t('studio.toast.metadataOnChainOnly', 'On-chain metadata saved. Sign in with your account identity to also sync the off-chain profile.'),
        );
        if (import.meta.env.DEV) console.error('[studio] off-chain metadata sync failed:', offChainErr?.apiDetail || offChainErr?.message);
      }
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      metadataBusy.value.save = false;
    }
  }

  /**
   * Reads one module's own safe method. v4 configuration is callback-bound
   * (the core calls configure/onInstall/onUninstall), so the only direct
   * module surface a screen may use is its safe reads.
   */
  async function callModuleRead() {
    if (!requireWallet()) return;
    if (!permissionsForm.value.method.trim()) {
      toast.error(t('studio.toast.provideModuleMethod', 'Provide the module read method name.'));
      return;
    }
    permissionsBusy.value.call = true;
    try {
      const snapshot = requireLoadedSnapshot();
      const module = snapshot.modules.find((entry) => String(entry.moduleId) === String(permissionsForm.value.moduleId));
      if (!module) throw new Error(t('custom.selectModule', 'Select an installed module first.'));
      const result = await invokeReadFunction(
        resolveRpcUrl(walletService),
        module.contractHash,
        permissionsForm.value.method.trim(),
        [
          { type: 'Hash160', value: snapshot.accountId },
          { type: 'Integer', value: String(module.moduleId) },
          ...parseTypedArgsJson(permissionsForm.value.argsJson),
        ],
      );
      if (result?.state === 'FAULT') throw new Error(EC.operationFailed);
      moduleReadOutcome.value = JSON.stringify(result?.stack ?? [], null, 2);
    } catch (err) {
      toast.error(translateError(err?.message, t));
    } finally {
      permissionsBusy.value.call = false;
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
    regenerateSalt,
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
    custodyError,
    managementBusy,
    configurationOutcome,
    configurationReview,
    isCustodyOwner,
    canManageTarget,
    canReadModule,
    moduleReadOutcome,
    addRow,
    removeRow,
    computeSA,
    loadAccountConfiguration,
    createAccount,
    checkMatrixDomain,
    matrixCheckResult,
    prepareConfiguration,
    dismissConfigurationReview,
    submitConfiguration,
    confirmPendingIntent,
    cancelPendingIntent,
    prepareInstallModule,
    prepareConfigureModule,
    prepareUninstallModule,
    prepareHookOrder,
    prepareThresholdPolicy,
    prepareRecoveryPolicy,
    prepareDefaultPolicy,
    beginRecovery,
    cancelRecovery,
    executeRecovery,
    freezeAccount,
    revokeCredentials,
    saveMetadata,
    callModuleRead,
    loadContractFiles: ensureContractFilesLoaded,
    copyCode,
  };
}
