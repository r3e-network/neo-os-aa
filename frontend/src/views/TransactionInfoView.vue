<template>
  <div
    class="relative min-h-screen bg-aa-dark overflow-hidden font-sans text-aa-text"
  >
    <div
      class="absolute inset-0 z-0 pointer-events-none bg-[linear-gradient(rgba(123,97,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(123,97,255,0.035)_1px,transparent_1px)] bg-[size:48px_48px]"
    ></div>
    <div
      class="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12 animate-fade-in-up"
    >
      <div class="glass-panel p-6 sm:p-10 relative">
        <template v-if="draftId">
          <h1 class="text-2xl font-bold text-aa-text mb-2">
            {{ t("sharedDraft.title", "Shared Transaction Draft") }}
          </h1>
          <p class="text-sm text-aa-muted mb-8 max-w-2xl">
            {{
              t(
                "sharedDraft.subtitle",
                "Load an immutable transaction draft, review collected approvals, append a new signature, and choose the final client-side or relay broadcast path.",
              )
            }}
          </p>
          <DraftSummaryStrip
            class="mb-8"
            :title="
              t('sharedDraft.sharedDraftOverview', 'Shared Draft Overview')
            "
            :draft="draft"
            :action-context="activityActionContext"
            @summary-action="handleSummaryAction"
          />

          <DraftStatusBanner
            class="mb-8"
            :status="draft?.status || 'draft'"
            :activity="activityEvents"
          />

          <PaymasterValidationBanner
            :explorer-base-url="runtime.explorerBaseUrl"
            i18n-key-prefix="sharedDraft"
          />
          <span class="sr-only">{{
            t(
              "sharedDraft.srPaymasterDescription",
              "Paymaster Readiness. Open Validation Ledger. Open Explorer Tx.",
            )
          }}</span>
          <!-- paymasterValidation route referenced via PaymasterValidationBanner -->

          <div class="grid gap-4 mb-8 sm:grid-cols-2 lg:grid-cols-4">
            <CopyableField
              :label="t('sharedDraft.draftIdLabel', 'Draft ID')"
              :value="draftId"
              copy-key="draftId"
              :active-copied-key="copiedKey"
              :copy-aria-label="t('didPanel.copyDraftId', 'Copy draft ID')"
              :show-copy-button="true"
              @copy="
                copyText(draftId);
                markCopied('draftId');
              "
            />
            <CopyableField
              :label="t('sharedDraft.shareUrlLabel', 'Share URL')"
              :value="shareUrl || t('sharedDraft.loadingUrl', 'Loading…')"
              copy-key="shareUrl"
              :active-copied-key="copiedKey"
              :copy-aria-label="t('didPanel.copyShareUrl', 'Copy share URL')"
              :show-copy-button="Boolean(shareUrl)"
              @copy="
                copyText(shareUrl);
                markCopied('shareUrl');
              "
            />
            <CopyableField
              :label="
                t('sharedDraft.collaboratorLinkLabel', 'Collaborator Link')
              "
              :value="
                collaborationUrl ||
                t('sharedDraft.readOnlyAccess', 'Read-only access')
              "
              copy-key="collaboratorUrl"
              :active-copied-key="copiedKey"
              :copy-aria-label="
                t('operations.copyCollaboratorLink', 'Copy collaborator link')
              "
              :show-copy-button="Boolean(collaborationUrl)"
              @copy="
                copyText(collaborationUrl);
                markCopied('collaboratorUrl');
              "
            />
            <CopyableField
              :label="t('sharedDraft.operatorLinkLabel', 'Operator Link')"
              :value="
                operatorUrl ||
                t(
                  'sharedDraft.operatorAccessRequired',
                  'Operator access required',
                )
              "
              copy-key="operatorUrl"
              :active-copied-key="copiedKey"
              :copy-aria-label="
                t('operations.copyOperatorLink', 'Copy operator link')
              "
              :show-copy-button="Boolean(operatorUrl)"
              @copy="
                copyText(operatorUrl);
                markCopied('operatorUrl');
              "
            />
            <div class="rounded-lg border border-aa-border bg-aa-dark p-4">
              <p class="text-xs font-semibold text-aa-muted uppercase mb-1">
                {{ t("sharedDraft.statusLabel", "Status") }}
              </p>
              <div class="text-sm font-medium text-aa-text">
                {{ draft?.status || t("sharedDraft.loadingStatus", "loading") }}
              </div>
            </div>
          </div>
          <AccessScopeNotice
            :access-scope="accessScope"
            :has-draft="Boolean(draft)"
          />
          <OperatorKeyBackupPanel
            v-if="runtime.collaborationEnabled && hasOperatorAccess && draft?.share_slug"
            :share-slug="draft.share_slug"
            :access-slug="draft.operator_slug"
          />
          <div v-if="loading" class="space-y-3">
            <div class="skeleton h-6 w-48 rounded"></div>
            <div class="skeleton h-20 rounded-xl"></div>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="skeleton h-24 rounded-lg"></div>
              <div class="skeleton h-24 rounded-lg"></div>
            </div>
          </div>
          <div
            v-else-if="loadError"
            role="alert"
            class="flex items-center gap-3 text-sm text-aa-error font-medium"
          >
            <span>{{ loadError }}</span>
            <button
              class="btn-ghost btn-sm"
              :class="{ 'btn-loading': loading }"
              :disabled="loading"
              @click="loadDraft"
            >
              {{
                loading
                  ? t("sharedDraft.loading", "Loading...")
                  : t("sharedDraft.retry", "Retry")
              }}
            </button>
          </div>
          <div v-else-if="draft" class="space-y-6">
            <div class="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <OperationSnapshotSection :items="operationSnapshotItems" />
              <SignerChecklistSection
                :items="signerChecklistItems"
                :progress-text="signerProgressText"
              />
            </div>

            <div class="grid gap-6 lg:grid-cols-2">
              <section class="glass-panel p-5">
                <div class="mb-4">
                  <h2 class="text-base font-bold font-outfit text-aa-text">
                    {{ t("sharedDraft.signatureActions", "Signature Actions") }}
                  </h2>
                  <p class="text-sm text-aa-muted">
                    {{
                      t(
                        "sharedDraft.signatureActionsDesc",
                        "Connect wallets, paste external approvals, or append a contract-aligned EVM signature to the shared draft.",
                      )
                    }}
                  </p>
                </div>
                <div class="mb-4 flex flex-wrap gap-2">
                  <button
                    class="btn-ghost"
                    :class="{ 'btn-loading': isConnectingNeo }"
                    :disabled="isConnectingNeo"
                    @click="connectNeoWallet"
                  >
                    {{ t("operations.connectNeoWallet", "Connect Neo Wallet") }}
                  </button>
                  <button
                    class="btn-ghost"
                    :class="{ 'btn-loading': isConnectingEvm }"
                    :disabled="isConnectingEvm"
                    @click="connectEvmWallet"
                  >
                    {{ t("operations.connectEvmWallet", "Connect EVM Wallet") }}
                  </button>
                  <button class="btn-ghost" @click="copyShareUrl">
                    {{
                      copiedKey === "shareUrl"
                        ? t("sharedDraft.copied", "Copied!")
                        : t("operations.copyShareLink", "Copy Share Link")
                    }}
                  </button>
                  <button
                    class="btn-ghost"
                    :disabled="!collaborationUrl"
                    @click="copyCollaboratorUrl"
                  >
                    {{
                      copiedKey === "collaboratorUrl"
                        ? t("sharedDraft.copied", "Copied!")
                        : t(
                            "operations.copyCollaboratorLink",
                            "Copy Collaborator Link",
                          )
                    }}
                  </button>
                  <button
                    class="btn-ghost"
                    :disabled="!operatorUrl"
                    @click="copyOperatorUrl"
                  >
                    {{
                      copiedKey === "operatorUrl"
                        ? t("sharedDraft.copied", "Copied!")
                        : t("operations.copyOperatorLink", "Copy Operator Link")
                    }}
                  </button>
                  <button
                    class="btn-ghost"
                    :class="{ 'btn-loading': isSubmissionPending }"
                    :disabled="!hasOperatorAccess || isSubmissionPending"
                    @click="rotateCollaboratorLink"
                  >
                    {{
                      t(
                        "operations.rotateCollaboratorLink",
                        "Rotate Collaborator Link",
                      )
                    }}
                  </button>
                  <button
                    class="btn-ghost"
                    :class="{ 'btn-loading': isSubmissionPending }"
                    :disabled="!hasOperatorAccess || isSubmissionPending"
                    @click="rotateOperatorLink"
                  >
                    {{
                      t("operations.rotateOperatorLink", "Rotate Operator Link")
                    }}
                  </button>
                </div>
                <div class="grid gap-4 md:grid-cols-3">
                  <label class="space-y-1 text-sm" for="shared-draft-signer-id">
                    <span class="font-medium text-aa-text">{{
                      t("sharedDraft.signerIdLabel", "Signer ID")
                    }}</span>
                    <input
                      id="shared-draft-signer-id"
                      v-model="signerId"
                      class="input-field"
                    />
                  </label>
                  <label
                    class="space-y-1 text-sm"
                    for="shared-draft-signer-kind"
                  >
                    <span class="font-medium text-aa-text">{{
                      t("sharedDraft.signerKindLabel", "Signer Kind")
                    }}</span>
                    <select
                      id="shared-draft-signer-kind"
                      v-model="signerKind"
                      class="input-field"
                    >
                      <option value="neo">
                        {{ t("sharedDraft.neoLabel", "Neo") }}
                      </option>
                      <option value="evm">
                        {{ t("sharedDraft.evmLabel", "EVM") }}
                      </option>
                    </select>
                  </label>
                  <label
                    class="space-y-1 text-sm"
                    for="shared-draft-signature-hex"
                  >
                    <span class="font-medium text-aa-text">{{
                      t("sharedDraft.signatureHexLabel", "Signature Hex")
                    }}</span>
                    <input
                      id="shared-draft-signature-hex"
                      v-model="signatureHex"
                      class="input-field font-mono text-xs"
                    />
                  </label>
                </div>
                <div class="mt-4 flex flex-wrap gap-2">
                  <button
                    class="btn-primary"
                    :class="{ 'btn-loading': isSubmissionPending }"
                    :disabled="!hasSignatureAccess || isSubmissionPending"
                    @click="appendManualSignature"
                  >
                    {{
                      t(
                        "operations.appendManualSignature",
                        "Append Manual Signature",
                      )
                    }}
                  </button>
                  <button
                    class="btn-ghost"
                    :class="{ 'btn-loading': isSubmissionPending }"
                    :disabled="!hasSignatureAccess || isSubmissionPending"
                    @click="signWithEvmWallet"
                  >
                    {{ t("operations.connectEvmWallet", "Connect EVM Wallet") }}
                  </button>
                </div>
                <p class="mt-4 text-xs text-aa-muted">
                  {{
                    t(
                      "sharedDraft.manualSignatureHint",
                      "Use manual entry for external multisig collection, or collect an EVM typed-data approval here and keep the relay-ready invocation attached to the draft.",
                    )
                  }}
                </p>
              </section>

              <section class="glass-panel p-5">
                <div class="mb-4">
                  <h2 class="text-base font-bold font-outfit text-aa-text">
                    {{ t("sharedDraft.broadcastRelay", "Broadcast & Relay") }}
                  </h2>
                  <p class="text-sm text-aa-muted">
                    {{
                      t(
                        "sharedDraft.broadcastRelayDesc",
                        "Choose the final submission path after signatures are attached and relay readiness looks healthy.",
                      )
                    }}
                  </p>
                </div>
                <div class="grid gap-3 sm:grid-cols-2">
                  <div
                    class="rounded-lg border border-aa-border/40 bg-aa-dark/40 p-4"
                  >
                    <p class="text-xs font-semibold uppercase text-aa-muted">
                      {{ t("sharedDraft.clientBroadcast", "Client Broadcast") }}
                    </p>
                    <div class="mt-1 text-sm font-medium text-aa-text">
                      {{
                        clientBroadcastReady
                          ? t(
                              "sharedDraft.clientBroadcastReady",
                              "Invocation Ready",
                            )
                          : t(
                              "sharedDraft.clientBroadcastMissing",
                              "Invocation Missing",
                            )
                      }}
                    </div>
                    <p class="mt-1 text-xs text-aa-muted">
                      {{
                        walletConnection.isConnected.value
                          ? t(
                              "sharedDraft.neoWalletReady",
                              "Neo wallet connected and ready to sign.",
                            )
                          : t(
                              "sharedDraft.neoWalletMissing",
                              "Connect a Neo wallet before broadcasting client-side.",
                            )
                      }}
                    </p>
                  </div>
                  <div
                    class="rounded-lg border border-aa-border/40 bg-aa-dark/40 p-4"
                  >
                    <p class="text-xs font-semibold uppercase text-aa-muted">
                      {{ t("sharedDraft.relaySubmission", "Relay Submission") }}
                    </p>
                    <div class="mt-1 text-sm font-medium text-aa-text">
                      {{ relayReadiness.label }}
                    </div>
                    <p class="mt-1 text-xs text-aa-muted">
                      {{ relayReadiness.detail }}
                    </p>
                  </div>
                </div>
                <div class="mt-4 flex flex-wrap gap-2">
                  <button
                    class="btn-primary"
                    :class="{
                      'btn-loading':
                        pendingSubmissionAction === 'client-broadcast',
                    }"
                    :disabled="
                      !hasOperatorAccess ||
                      !clientBroadcastReady ||
                      !walletConnection.isConnected.value ||
                      isSubmissionPending
                    "
                    :title="
                      getSubmissionButtonLabel(
                        'client-broadcast',
                        pendingSubmissionAction,
                        t,
                      )
                    "
                    @click="broadcastWithNeoWallet"
                  >
                    {{
                      pendingSubmissionAction === "client-broadcast"
                        ? t("sharedDraft.broadcasting", "Broadcasting…")
                        : t(
                            "sharedDraft.broadcastWithNeoWallet",
                            "Broadcast with Neo Wallet",
                          )
                    }}
                  </button>
                  <button
                    class="btn-secondary"
                    :class="{
                      'btn-loading': pendingSubmissionAction === 'relay-check',
                    }"
                    :disabled="
                      !hasOperatorAccess ||
                      relayPayloadOptions.length === 0 ||
                      isSubmissionPending
                    "
                    :title="
                      getSubmissionButtonLabel(
                        'relay-check',
                        pendingSubmissionAction,
                        t,
                      )
                    "
                    @click="checkRelay"
                  >
                    {{
                      pendingSubmissionAction === "relay-check"
                        ? t("sharedDraft.checkingRelay", "Checking Relay…")
                        : t("sharedDraft.checkRelay", "Check Relay")
                    }}
                  </button>
                  <button
                    class="btn-success"
                    :class="{
                      'btn-loading': pendingSubmissionAction === 'relay-submit',
                    }"
                    :disabled="
                      !hasOperatorAccess ||
                      !canRelayBroadcast ||
                      isSubmissionPending
                    "
                    :title="
                      getSubmissionButtonLabel(
                        'relay-submit',
                        pendingSubmissionAction,
                        t,
                      )
                    "
                    @click="submitViaRelay"
                  >
                    {{
                      pendingSubmissionAction === "relay-submit"
                        ? t("sharedDraft.submitting", "Submitting…")
                        : t("sharedDraft.submitViaRelay", "Submit via Relay")
                    }}
                  </button>
                  <select
                    v-if="relayPayloadOptions.length > 1"
                    v-model="relayPayloadMode"
                    :aria-label="
                      t('sharedDraft.relayPayloadMode', 'Relay payload mode')
                    "
                    class="input-field w-auto"
                  >
                    <option value="best">
                      {{ t("sharedDraft.bestAvailable", "Best Available") }}
                    </option>
                    <option value="raw">
                      {{ t("sharedDraft.signedRawTx", "Signed Raw Tx") }}
                    </option>
                    <option value="meta">
                      {{ t("sharedDraft.relayInvocation", "Relay Invocation") }}
                    </option>
                  </select>
                </div>
                <p class="mt-4 text-xs text-aa-muted">
                  {{
                    t(
                      "sharedDraft.selectedRelayPayload",
                      "Selected relay payload:",
                    )
                  }}
                  <span class="font-semibold text-aa-text">{{
                    selectedRelayPayloadLabel
                  }}</span>
                </p>
                <SubmissionReceiptCard
                  :receipt="activeSubmissionReceipt"
                  :history-items="submissionReceiptHistoryItems"
                />
                <LatestSubmissionCard
                  :txid="latestBroadcastTxid"
                  :explorer-url="latestBroadcastExplorerUrl"
                  :copied-key="copiedKey"
                  @copy="
                    copyText(latestBroadcastTxid);
                    markCopied('latestTxid');
                  "
                />
              </section>
            </div>

            <RelayPreflightPanel
              id="relay-preflight-panel"
              :level="relayCheck.level"
              :status-label="relayCheck.label"
              :detail="relayCheck.detail"
              :payload-mode="relayCheck.payloadMode"
              :vm-state="relayCheck.vmState"
              :gas-consumed="relayCheck.gasConsumed"
              :operation="relayCheck.operation"
              :exception="relayCheck.exception"
            />

            <section class="glass-panel p-5">
              <h2 class="text-base font-bold font-outfit text-aa-text mb-3">
                {{ t("sharedDraft.recentActivityTitle", "Recent Activity") }}
              </h2>
              <ActivityTimeline
                :items="activityEvents"
                :action-context="activityActionContext"
                preference-key="shared-draft"
                @activity-action="handleActivityAction"
              />
            </section>

            <CollectedSignaturesSection :signatures="collectedSignatureCards" />
          </div>
          <p
            v-if="statusMessage"
            role="status"
            aria-live="polite"
            class="mt-6 rounded-lg border border-aa-border bg-aa-panel px-4 py-3 text-sm text-aa-text font-medium"
          >
            {{ statusMessage }}
          </p>
          <div class="mt-8">
            <RouterLink to="/" class="btn-secondary">{{
              t("sharedDraft.returnHome", "Return Home")
            }}</RouterLink>
          </div>
        </template>
        <template v-else>
          <TransactionSubmittedPanel
            :txid="txid"
            :explorer-url="submittedTxExplorerUrl"
            :copied-key="copiedKey"
            @copy="
              copyText(txid);
              markCopied('txid');
            "
          />
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "@/i18n";
import { useToast } from "vue-toastification";
import { useRoute } from "vue-router";
import { useWalletConnection } from "@/composables/useWalletConnection.js";
import { useClipboard } from "@/composables/useClipboard";
import { OPERATIONS_RUNTIME } from "@/config/operationsRuntime.js";
import { createDraftStore } from "@/features/operations/drafts.js";
import { createOperatorMutationTransport } from "@/features/operations/operatorMutationTransport.js";
import OperatorKeyBackupPanel from "@/features/operations/components/OperatorKeyBackupPanel.vue";
import {
  buildRelayPayloadOptions,
  executeBroadcast,
  resolveRelayPayloadMode,
} from "@/features/operations/execution.js";
import { signUserOpWithEvm } from "@/features/operations/useUserOpSigning.js";
import { summarizeSignerProgress } from "@/features/operations/signatures.js";
import { createActivityEvent } from "@/features/operations/activity.js";
import { createOperationsPreferences } from "@/features/operations/preferences.js";
import { evaluateRelayReadiness } from "@/features/operations/relayReadiness.js";
import {
  runRelayPreflight,
  buildRelayPreflightRequest,
} from "@/features/operations/relayPreflight.js";
import { createDraftInteractionHandlers } from "@/features/operations/viewActions.js";
import {
  buildCollectedSignatureCards,
  buildOperationSnapshotItems,
  buildSignerChecklistItems,
} from "@/features/operations/sharedDraftView.js";
import {
  buildTransactionExplorerUrl,
  extractLatestTransactionId,
} from "@/features/operations/explorer.js";
import {
  getSubmissionButtonLabel,
} from "@/features/operations/submissionFeedback.js";
import { useBroadcastReceipts } from "@/features/operations/useBroadcastReceipts.js";
import { EC, translateError } from "@/config/errorCodes.js";
import RelayPreflightPanel from "@/features/operations/components/RelayPreflightPanel.vue";
import DraftStatusBanner from "@/features/operations/components/DraftStatusBanner.vue";
import DraftSummaryStrip from "@/features/operations/components/DraftSummaryStrip.vue";
import ActivityTimeline from "@/features/operations/components/ActivityTimeline.vue";
import PaymasterValidationBanner from "@/components/common/PaymasterValidationBanner.vue";
import CopyableField from "@/views/TransactionInfoView/CopyableField.vue";
import AccessScopeNotice from "@/views/TransactionInfoView/AccessScopeNotice.vue";
import OperationSnapshotSection from "@/views/TransactionInfoView/OperationSnapshotSection.vue";
import SignerChecklistSection from "@/views/TransactionInfoView/SignerChecklistSection.vue";
import CollectedSignaturesSection from "@/views/TransactionInfoView/CollectedSignaturesSection.vue";
import SubmissionReceiptCard from "@/views/TransactionInfoView/SubmissionReceiptCard.vue";
import LatestSubmissionCard from "@/views/TransactionInfoView/LatestSubmissionCard.vue";
import TransactionSubmittedPanel from "@/views/TransactionInfoView/TransactionSubmittedPanel.vue";
import {
  buildDraftCollaborationUrl,
  buildDraftShareUrl,
} from "@/features/operations/shareLinks.js";
import {
  getAbstractAccountHash,
  walletService,
} from "@/services/walletService.js";

const props = defineProps({
  txid: { type: String, default: "" },
  draftId: { type: String, default: "" },
});

const runtime = OPERATIONS_RUNTIME;
const { t } = useI18n();
const toast = useToast();
const draftStore = createDraftStore({
  operatorMutationTransport: createOperatorMutationTransport(),
});
const walletConnection = useWalletConnection();
const route = useRoute();
const preferences = createOperationsPreferences();

const { copiedKey, markCopied, copyText } = useClipboard();
const draft = ref(null);
const loadError = ref("");
const loading = ref(false);
const isConnectingNeo = ref(false);
const isConnectingEvm = ref(false);
const statusMessage = ref("");
const signerId = ref("");
const signerKind = ref("neo");
const signatureHex = ref("");
const evmAddress = ref("");
const relayPayloadMode = ref(preferences.getRelayPayloadMode("shared-draft"));
const relayCheck = ref({
  level: "idle",
  label: t("sharedDraft.notChecked", "Not Checked"),
  detail: t(
    "sharedDraft.relayCheckIdleDetail",
    "Run a relay preflight before submitting.",
  ),
  payloadMode: "best",
  vmState: "",
  gasConsumed: "",
  operation: "",
  exception: "",
  stack: [],
});
const relayCheckRequest = ref(null);

const signerProgress = computed(() =>
  summarizeSignerProgress(
    draft.value?.signer_requirements || [],
    draft.value?.signatures || [],
  ),
);
const signerProgressText = computed(() => {
  const sp = signerProgress.value;
  const base = t(
    "sharedDraft.signerProgressRequired",
    "{collected}/{required} required approvals collected",
  )
    .replace("{collected}", String(sp.signatureCount))
    .replace("{required}", String(sp.requiredCount));
  if (sp.pending.length) {
    return `${base} · ${t("sharedDraft.signerProgressPending", "{count} still pending").replace("{count}", String(sp.pending.length))}`;
  }
  if (sp.requiredCount) {
    return `${base} · ${t("sharedDraft.approvalRecordsComplete", "required records collected; on-chain authorization unverified")}`;
  }
  return `${base} · ${t("sharedDraft.signerProgressNoRoster", "no required signer roster recorded")}`;
});
const operationSnapshotItems = computed(() =>
  buildOperationSnapshotItems({
    draft: draft.value || {},
    relayReadiness: relayReadiness.value,
    t,
  }),
);
const signerChecklistItems = computed(() =>
  buildSignerChecklistItems({
    signerRequirements: draft.value?.signer_requirements || [],
    signatures: draft.value?.signatures || [],
    t,
  }),
);
const collectedSignatureCards = computed(() =>
  buildCollectedSignatureCards(draft.value?.signatures || [], t),
);
const relayPayloadOptions = computed(() =>
  buildRelayPayloadOptions({
    runtime,
    transactionBody: draft.value?.transaction_body || {},
    signatures: draft.value?.signatures || [],
  }),
);
const selectedRelayPayloadMode = computed(() =>
  resolveRelayPayloadMode({
    relayPayloadMode: relayPayloadMode.value,
    availableModes: relayPayloadOptions.value,
  }),
);
const relayReadiness = computed(() =>
  evaluateRelayReadiness({
    runtime,
    transactionBody: draft.value?.transaction_body || {},
    signatures: draft.value?.signatures || [],
    t,
  }),
);
const currentRelayPreflightRequest = computed(() => {
  try {
    return buildRelayPreflightRequest({
      relayEndpoint: runtime.relayEndpoint,
      relayPayloadMode: relayPayloadMode.value,
      relayRawEnabled: runtime.relayRawEnabled,
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      transactionBody: draft.value?.transaction_body || {},
      signatures: draft.value?.signatures || [],
    });
  } catch (_error) {
    return null;
  }
});
const relayCheckMatchesCurrentPayload = computed(
  () =>
    Boolean(currentRelayPreflightRequest.value && relayCheckRequest.value) &&
    JSON.stringify(currentRelayPreflightRequest.value) ===
      JSON.stringify(relayCheckRequest.value),
);
const canRelayBroadcast = computed(() =>
  Boolean(
    relayReadiness.value.payloadReady &&
      relayCheck.value?.ok === true &&
      relayCheckMatchesCurrentPayload.value,
  ),
);
const clientBroadcastReady = computed(() =>
  Boolean(draft.value?.transaction_body?.clientInvocation),
);
const selectedRelayPayloadLabel = computed(
  () =>
    ({
      none: t("sharedDraft.unavailable", "Unavailable"),
      raw: t("sharedDraft.signedRawTx", "Signed Raw Tx"),
      meta: t("sharedDraft.relayInvocation", "Relay Invocation"),
      best: t("sharedDraft.bestAvailable", "Best Available"),
    })[selectedRelayPayloadMode.value] ||
    selectedRelayPayloadMode.value ||
    t("sharedDraft.unavailable", "Unavailable"),
);
const activityEvents = computed(
  () =>
    (draft.value && draft.value.metadata && draft.value.metadata.activity) ||
    [],
);
const persistedSubmissionReceiptEntries = computed(
  () => draft.value?.metadata?.submissionReceipts || [],
);
const {
  pendingSubmissionAction,
  isSubmissionPending,
  submissionReceiptHistoryItems,
  activeSubmissionReceipt,
  setSubmissionPending,
  setSubmissionResult,
} = useBroadcastReceipts({
  submissionReceiptEntries: persistedSubmissionReceiptEntries,
  explorerBaseUrl: runtime.explorerBaseUrl,
  t,
});
const latestBroadcastTxid = computed(() =>
  extractLatestTransactionId(activityEvents.value),
);
const latestBroadcastExplorerUrl = computed(() =>
  buildTransactionExplorerUrl(
    runtime.explorerBaseUrl,
    latestBroadcastTxid.value,
  ),
);
const submittedTxExplorerUrl = computed(() =>
  buildTransactionExplorerUrl(runtime.explorerBaseUrl, props.txid),
);
const collaborationAccess = computed(() =>
  String(route.query.access || "").trim(),
);
const hasCollaboratorAccess = computed(() =>
  Boolean(draft.value?.can_write && draft.value?.collaboration_slug),
);
const accessScope = computed(() => {
  if (
    draft.value?.operator_slug &&
    route.query.access === draft.value.operator_slug
  )
    return "operator";
  if (
    draft.value?.collaboration_slug &&
    route.query.access === draft.value.collaboration_slug
  )
    return "sign";
  return "read";
});
const hasOperatorAccess = computed(() => accessScope.value === "operator");
const hasSignatureAccess = computed(() => accessScope.value !== "read");
const operatorUrl = computed(() => {
  if (!draft.value?.share_slug || !draft.value?.operator_slug) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return origin
    ? buildDraftShareUrl(origin, draft.value.share_slug) +
        `?access=${draft.value.operator_slug}`
    : "";
});
watch(relayPayloadMode, (value) => {
  preferences.setRelayPayloadMode("shared-draft", value);
});

const collaborationUrl = computed(() => {
  if (!draft.value?.share_slug || !hasCollaboratorAccess.value) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const accessSlug =
    draft.value?.collaboration_slug || collaborationAccess.value;
  return origin
    ? buildDraftCollaborationUrl(origin, draft.value.share_slug, accessSlug)
    : draft.value.collaboration_path || "";
});
const activityActionContext = computed(() => ({
  shareUrl: shareUrl.value,
  collaboratorUrl: collaborationUrl.value,
  relayTargetId: "relay-preflight-panel",
  explorerBaseUrl: runtime.explorerBaseUrl,
}));

const shareUrl = computed(() => {
  if (!draft.value?.share_slug) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return origin
    ? buildDraftShareUrl(origin, draft.value.share_slug)
    : draft.value.share_path || "";
});
const {
  copyRelayPayload,
  copyRelayStack,
  exportRelayPreflight,
  handleSummaryAction,
  handleActivityAction,
} = createDraftInteractionHandlers({
  getRelayCheck: () => relayCheck.value,
  getRelayRequest: () => relayCheckRequest.value,
  setStatus: (message) => {
    statusMessage.value = message;
  },
  t,
});

async function loadDraft() {
  if (!props.draftId) return;
  loading.value = true;
  try {
    draft.value = await draftStore.loadDraft(props.draftId, {
      accessSlug: String(route.query.access || ""),
    });
    signerId.value = draft.value?.account?.accountAddressScriptHash || "";
    if (draft.value?.metadata?.relayPreflight) {
      relayCheck.value = {
        ...relayCheck.value,
        ...draft.value.metadata.relayPreflight,
      };
    }
  } catch (error) {
    loadError.value =
      translateError(error?.message, t) ||
      t(
        "sharedDraft.loadFailed",
        "Failed to load draft. Please check the link and try again.",
      );
  } finally {
    loading.value = false;
  }
}

// Connect success/error toasts are owned by useWalletConnection so users see
// exactly one toast per connect action; these wrappers only track button state
// and update the inline status line.
async function connectNeoWallet() {
  isConnectingNeo.value = true;
  try {
    await walletConnection.connect();
    signerId.value = walletService.address;
    statusMessage.value = t(
      "sharedDraft.neoWalletConnected",
      "Neo wallet connected: {address}",
    ).replace("{address}", walletService.address);
  } catch (_error) {
    /* useWalletConnection.connect already toasted the failure */
  } finally {
    isConnectingNeo.value = false;
  }
}

async function connectEvmWallet() {
  isConnectingEvm.value = true;
  try {
    const { address } = await walletConnection.connectEvm();
    evmAddress.value = address.toLowerCase();
    signerId.value = evmAddress.value;
    signerKind.value = "evm";
    statusMessage.value = t(
      "sharedDraft.evmWalletConnected",
      "EVM wallet connected: {address}",
    ).replace("{address}", evmAddress.value);
  } catch (_error) {
    /* useWalletConnection.connectEvm already toasted the failure */
  } finally {
    isConnectingEvm.value = false;
  }
}

async function persistSubmissionReceipt(entry) {
  if (!draft.value?.share_slug) return;
  try {
    draft.value = await draftStore.appendSubmissionReceipt(
      draft.value.share_slug,
      entry,
      operatorMutationOptions(),
    );
  } catch (_) {
    if (import.meta.env.DEV)
      console.warn(
        "[TransactionInfoView] persistSubmissionReceipt sync failed",
      ); /* best-effort remote sync */
  }
}

async function appendActivity(event) {
  if (!draft.value?.share_slug) return;
  try {
    draft.value = await draftStore.appendActivity(
      draft.value.share_slug,
      event,
      accessMutationOptions(),
    );
  } catch (_) {
    if (import.meta.env.DEV)
      console.warn(
        "[TransactionInfoView] appendActivity sync failed",
      ); /* best-effort remote sync */
  }
}

async function refreshDraftStatus(status) {
  if (!runtime.collaborationEnabled || !draft.value?.share_slug) return;
  try {
    draft.value = await draftStore.updateStatus(
      draft.value.share_slug,
      status,
      operatorMutationOptions(),
    );
  } catch (_) {
    if (import.meta.env.DEV)
      console.warn(
        "[TransactionInfoView] refreshDraftStatus sync failed",
      ); /* best-effort remote sync; the broadcast itself already succeeded */
  }
}

async function appendManualSignature() {
  if (!draft.value?.share_slug) return;
  try {
    assertSignatureAccess();
    draft.value = await draftStore.appendSignature(
      draft.value.share_slug,
      {
        signerId:
          signerId.value.trim() ||
          walletService.address ||
          evmAddress.value ||
          "pending-signer",
        kind: signerKind.value,
        signatureHex: signatureHex.value,
        createdAt: new Date().toISOString(),
      },
      accessMutationOptions(),
    );
    signatureHex.value = "";
    await appendActivity(
      createActivityEvent({
        type: "signature_added",
        actor: signerKind.value,
        detail: t("sharedDraft.signatureAppended", "Signature appended"),
      }),
    );
    statusMessage.value = t(
      "sharedDraft.signatureAppendedToDraft",
      "Signature appended to the shared draft.",
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  }
}

async function signWithEvmWallet() {
  if (!draft.value) return;
  try {
    if (!evmAddress.value) {
      const { address } = await walletConnection.connectEvm();
      evmAddress.value = address.toLowerCase();
    }

    const { signatureRecord } = await signUserOpWithEvm({
      rpcUrl: walletService.rpcUrl,
      aaContractHash: getAbstractAccountHash(),
      accountIdHash: draft.value.account?.accountIdHash,
      operationBody: draft.value.operation_body,
      signerId: evmAddress.value,
      chainId: runtime.networkMagic,
      signTypedData: (typedData) => walletService.signTypedDataWithEvm(typedData),
      missingAccountError: EC.v3AccountRequired,
      missingVerifierError: EC.noVerifierPlugin,
    });
    assertSignatureAccess();
    draft.value = await draftStore.appendSignature(
      draft.value.share_slug,
      signatureRecord,
      accessMutationOptions(),
    );
    signerKind.value = "evm";
    signerId.value = evmAddress.value;
    await appendActivity(
      createActivityEvent({
        type: "signature_added",
        actor: "evm",
        detail: t(
          "sharedDraft.userOpSignatureCollected",
          "UserOperation signature collected",
        ),
      }),
    );
    statusMessage.value = t(
      "sharedDraft.userOpSignatureCollectedDetail",
      "Contract-aligned EVM UserOperation signature collected and attached to the shared draft.",
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  }
}

async function persistRelayCheckMetadata(snapshot) {
  if (!draft.value?.share_slug) return;
  try {
    draft.value = await draftStore.setRelayPreflight(
      draft.value.share_slug,
      { relayPreflight: snapshot },
      operatorMutationOptions(),
    );
  } catch (_) {
    if (import.meta.env.DEV)
      console.warn(
        "[TransactionInfoView] persistRelayCheckMetadata sync failed",
      ); /* best-effort remote sync */
  }
}

async function checkRelay() {
  setSubmissionPending("relay-check");
  try {
    relayCheckRequest.value = buildRelayPreflightRequest({
      relayEndpoint: runtime.relayEndpoint,
      relayPayloadMode: relayPayloadMode.value,
      relayRawEnabled: runtime.relayRawEnabled,
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      transactionBody: draft.value?.transaction_body || {},
      signatures: draft.value?.signatures || [],
    });
    relayCheck.value = await runRelayPreflight({
      walletService,
      relayEndpoint: runtime.relayEndpoint,
      relayPayloadMode: relayPayloadMode.value,
      relayRawEnabled: runtime.relayRawEnabled,
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      transactionBody: draft.value?.transaction_body || {},
      signatures: draft.value?.signatures || [],
      t,
    });
    await persistRelayCheckMetadata(relayCheck.value);
    await appendActivity(
      createActivityEvent({
        type: "relay_preflight",
        actor: "relay",
        detail: relayCheck.value.label,
      }),
    );
    statusMessage.value = `${relayCheck.value.label}: ${relayCheck.value.detail}`;
    await persistSubmissionReceipt(
      setSubmissionResult("relay-check", {
        phase: "success",
        detail: relayCheck.value.detail,
      }),
    );
  } catch (error) {
    relayCheck.value = {
      level: "blocked",
      label: t("sharedDraft.relayCheckFailed", "Relay Check Failed"),
      detail: t(
        "sharedDraft.relayCheckErrorDetail",
        "Relay preflight check could not complete. Please verify your configuration and try again.",
      ),
      payloadMode: relayPayloadMode.value,
      vmState: "",
      gasConsumed: "",
      operation: "",
      exception: translateError(error?.message, t) || String(error),
      stack: [],
    };
    await persistRelayCheckMetadata(relayCheck.value);
    toast.error(relayCheck.value.detail);
    await persistSubmissionReceipt(
      setSubmissionResult("relay-check", {
        phase: "error",
        detail: relayCheck.value.detail,
      }),
    );
  }
}

async function broadcastWithNeoWallet() {
  if (!draft.value?.transaction_body) return;
  setSubmissionPending("client-broadcast");
  try {
    const result = await executeBroadcast({
      mode: "client",
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      signerAddress: walletService.address,
      transactionBody: draft.value.transaction_body,
      relayPayloadMode: relayPayloadMode.value,
      signatures: draft.value.signatures || [],
      walletService,
      relayEndpoint: runtime.relayEndpoint,
    });
    await refreshDraftStatus("broadcasted");
    await appendActivity(
      createActivityEvent({
        type: "broadcast_client",
        actor: "neo",
        detail:
          result?.txid ||
          t(
            "sharedDraft.clientBroadcastSubmitted",
            "Client broadcast submitted",
          ),
      }),
    );
    statusMessage.value = `${t("sharedDraft.clientBroadcastSubmittedDetail", "Client-side Neo broadcast submitted.")}${result?.txid ? `: ${result.txid}` : ""}`;
    await persistSubmissionReceipt(
      setSubmissionResult("client-broadcast", {
        phase: "success",
        detail: t(
          "sharedDraft.clientBroadcastSubmittedDetail",
          "Client-side Neo broadcast submitted.",
        ),
        txid: result?.txid || result?.result?.hash || "",
      }),
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
    await persistSubmissionReceipt(
      setSubmissionResult("client-broadcast", {
        phase: "error",
        detail:
          translateError(error?.message, t) ||
          t(
            "sharedDraft.clientBroadcastFailed",
            "Client broadcast failed. Please check your wallet connection and try again.",
          ),
      }),
    );
  }
}

async function submitViaRelay() {
  if (!canRelayBroadcast.value) {
    const errorMessage = t(
      "sharedDraft.relayPreflightRequired",
      "Run a successful relay preflight before submitting through the relay.",
    );
    toast.error(errorMessage);
    await persistSubmissionReceipt(
      setSubmissionResult("relay-submit", {
        phase: "error",
        detail: errorMessage,
      }),
    );
    return;
  }

  setSubmissionPending("relay-submit");
  try {
    const result = await executeBroadcast({
      mode: "relay",
      relayPayloadMode: relayPayloadMode.value,
      relayRawEnabled: runtime.relayRawEnabled,
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      transactionBody: draft.value.transaction_body,
      signatures: draft.value.signatures || [],
      walletService,
      relayEndpoint: runtime.relayEndpoint,
    });
    await refreshDraftStatus("relayed");
    await appendActivity(
      createActivityEvent({
        type: "broadcast_relay",
        actor: "relay",
        detail:
          result?.txid ||
          t(
            "sharedDraft.relaySubmissionCompleted",
            "Relay submission completed",
          ),
      }),
    );
    statusMessage.value = `${t("sharedDraft.relaySubmissionCompleted", "Relay submission completed")}${result?.txid ? `: ${result.txid}` : "."}`;
    await persistSubmissionReceipt(
      setSubmissionResult("relay-submit", {
        phase: "success",
        detail: t(
          "sharedDraft.relaySubmissionCompleted",
          "Relay submission completed.",
        ),
        txid: result?.txid || result?.result?.hash || "",
      }),
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
    await persistSubmissionReceipt(
      setSubmissionResult("relay-submit", {
        phase: "error",
        detail:
          translateError(error?.message, t) ||
          t(
            "sharedDraft.relaySubmitFailed",
            "Relay submission failed. Please try again.",
          ),
      }),
    );
  }
}

function accessMutationOptions() {
  return {
    accessSlug:
      draft.value?.operator_slug ||
      draft.value?.collaboration_slug ||
      collaborationAccess.value ||
      "",
  };
}

function operatorMutationOptions() {
  return {
    accessSlug: draft.value?.operator_slug || collaborationAccess.value || "",
  };
}

function assertSignatureAccess() {
  if (hasSignatureAccess.value) return;
  throw new Error(EC.readOnlyDraftError);
}

function assertOperatorAccess() {
  if (hasOperatorAccess.value) return;
  throw new Error(EC.operatorAccessRequired);
}

async function copyShareUrl() {
  if (!shareUrl.value) return;
  if (await copyText(shareUrl.value)) markCopied("shareUrl");
}

async function copyCollaboratorUrl() {
  if (!collaborationUrl.value) return;
  if (await copyText(collaborationUrl.value)) markCopied("collaboratorUrl");
}

async function copyOperatorUrl() {
  if (!operatorUrl.value) return;
  if (await copyText(operatorUrl.value)) markCopied("operatorUrl");
}

async function rotateCollaboratorLink() {
  if (!draft.value?.share_slug) return;
  try {
    assertOperatorAccess();
    draft.value = await draftStore.rotateCollaboratorLink(
      draft.value.share_slug,
      operatorMutationOptions(),
    );
    await appendActivity(
      createActivityEvent({
        type: "collaborator_link_rotated",
        actor: "operator",
        detail: t(
          "sharedDraft.collaboratorLinkRotated",
          "Collaborator link rotated",
        ),
      }),
    );
    statusMessage.value = t(
      "sharedDraft.collaboratorLinkRotatedDetail",
      "Collaborator link rotated. The previous signer link no longer works.",
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  }
}

async function rotateOperatorLink() {
  if (!draft.value?.share_slug) return;
  try {
    assertOperatorAccess();
    draft.value = await draftStore.rotateOperatorLink(
      draft.value.share_slug,
      operatorMutationOptions(),
    );
    await appendActivity(
      createActivityEvent({
        type: "operator_link_rotated",
        actor: "operator",
        detail: t("sharedDraft.operatorLinkRotated", "Operator link rotated"),
      }),
    );
    statusMessage.value = t(
      "sharedDraft.operatorLinkRotatedDetail",
      "Operator link rotated. The previous operator link no longer works.",
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  }
}

onMounted(loadDraft);
</script>
