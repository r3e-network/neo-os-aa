<template>
  <section class="aa-focus-shell">
    <div
      class="absolute inset-0 bg-gradient-to-br from-neo-500/5 to-transparent pointer-events-none"
    ></div>
    <div class="relative z-10">
      <div class="aa-focus-header">
        <div>
          <p class="mb-2 text-xs font-bold uppercase text-emerald-700">
            {{ t("operations.workspaceTitle", "Abstract Account Workspace") }} · Focus workflow
          </p>
          <h2 class="text-2xl md:text-3xl font-semibold text-aa-text">
            {{
              t(
                "operations.workspaceHero",
                "Load, compose, sign, share, and broadcast",
              )
            }}
          </h2>
          <p class="mt-3 text-sm text-aa-muted max-w-2xl">
            {{
              t(
                "operations.subtitle",
                "Load your account, compose an operation, collect signatures, and broadcast to the network.",
              )
            }}
          </p>
        </div>
        <div class="aa-focus-wallet-actions">
          <router-link
            v-if="didConnection.isConfigured.value"
            class="btn-secondary"
            :to="identityWorkspaceLink"
          >
            <svg
              aria-hidden="true"
              class="w-4 h-4 mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14m-6 4h6a2 2 0 002-2V8a2 2 0 00-2-2H9a2 2 0 00-2 2v8a2 2 0 002 2z"
              ></path>
            </svg>
            {{
              t("operations.openIdentityWorkspace", "Open Identity Workspace")
            }}
          </router-link>
          <button
            class="btn-secondary"
            :class="{ 'btn-loading': connectingNeo }"
            :disabled="connectingNeo"
            @click="connectNeoWallet"
          >
            <svg
              aria-hidden="true"
              class="w-4 h-4 mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
              ></path>
            </svg>
            {{ t("operations.connectNeoWallet", "Connect Neo Wallet") }}
          </button>
          <button
            class="btn-secondary"
            :class="{ 'btn-loading': connectingEvm }"
            :disabled="connectingEvm"
            @click="connectEvmWalletAction"
          >
            <svg
              aria-hidden="true"
              class="w-4 h-4 mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
              ></path>
            </svg>
            {{ t("operations.connectEvmWallet", "Connect EVM Wallet") }}
          </button>
          <div ref="actionsMenuRef" class="relative">
            <button
              class="btn-primary"
              :aria-expanded="showActionsMenu"
              aria-controls="actions-menu-content"
              @click="showActionsMenu = !showActionsMenu"
            >
              {{ t("operations.actions", "Actions") }}
              <svg
                aria-hidden="true"
                class="w-4 h-4 ml-2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                ></path>
              </svg>
            </button>
            <transition name="fade-in-up">
              <div
                id="actions-menu-content"
                v-if="showActionsMenu"
                class="absolute right-0 mt-3 w-64 rounded-xl bg-aa-panel shadow-2xl border border-aa-border py-2 z-50 overflow-hidden backdrop-blur-lg"
              >
                <button
                  class="w-full px-5 py-2.5 text-left text-sm text-aa-text hover:bg-aa-dark/50 hover:text-aa-text transition-colors duration-200 disabled:opacity-50"
                  :disabled="!shareUrl"
                  @click="copyShareLink"
                >
                  {{ t("operations.copyShareLink", "Copy Share Link") }}
                </button>
                <button
                  class="w-full px-5 py-2.5 text-left text-sm text-aa-text hover:bg-aa-dark/50 hover:text-aa-text transition-colors duration-200 disabled:opacity-50"
                  :disabled="!collaborationUrl"
                  @click="copyCollaboratorLink"
                >
                  {{
                    t(
                      "operations.copyCollaboratorLink",
                      "Copy Collaborator Link",
                    )
                  }}
                </button>
                <button
                  class="w-full px-5 py-2.5 text-left text-sm text-aa-text hover:bg-aa-dark/50 hover:text-aa-text transition-colors duration-200 disabled:opacity-50"
                  :disabled="!operatorUrl"
                  @click="copyOperatorLink"
                >
                  {{ t("operations.copyOperatorLink", "Copy Operator Link") }}
                </button>
                <div class="border-t border-aa-border my-1"></div>
                <button
                  class="w-full px-5 py-2.5 text-left text-sm text-aa-text hover:bg-aa-dark/50 hover:text-aa-text transition-colors duration-200 disabled:opacity-50"
                  :disabled="!collaborationUrl || isSubmissionPending"
                  @click="requestConfirmation('rotate-collaborator')"
                >
                  {{
                    t(
                      "operations.rotateCollaboratorLink",
                      "Rotate Collaborator Link",
                    )
                  }}
                </button>
                <button
                  class="w-full px-5 py-2.5 text-left text-sm text-aa-text hover:bg-aa-dark/50 hover:text-aa-text transition-colors duration-200 disabled:opacity-50"
                  :disabled="!operatorUrl || isSubmissionPending"
                  @click="requestConfirmation('rotate-operator')"
                >
                  {{
                    t("operations.rotateOperatorLink", "Rotate Operator Link")
                  }}
                </button>
                <button
                  class="w-full px-5 py-2.5 text-left text-sm text-aa-text hover:bg-aa-dark/50 hover:text-aa-text transition-colors duration-200 disabled:opacity-50"
                  :disabled="!workspace.transactionBody.value"
                  @click="exportDraftJson"
                >
                  {{ t("operations.exportDraftJson", "Export Draft JSON") }}
                </button>
              </div>
            </transition>
          </div>
        </div>
      </div>

      <DraftStatusBanner
        v-if="
          workspace.operationBody.value ||
          workspace.share.value.draftId ||
          activityItems.length > 0
        "
        class="mb-8 shadow-lg"
        :status="workspace.share.value.status"
        :activity="activityItems"
      />

      <WorkflowProgressStepper
        :steps="steps"
        :current-step-label="currentStepLabel"
        @jump-to-step="jumpToStep"
        @reset-workflow="resetWorkflow"
        @toggle-shortcuts="showShortcuts = !showShortcuts"
      />

      <details class="aa-focus-reference">
        <summary>
          <span>{{ t("operations.activitySidebarTitle", "Draft Activity") }}</span>
          <strong>Connection details</strong>
        </summary>
        <div class="mt-5 space-y-5">
          <WorkflowStatusCards
            :is-did-connected="didConnection.isConnected.value"
            :did-label="didLabel"
            :is-neo-connected="walletConnection.isConnected.value"
            :neo-wallet-label="neoWalletLabel"
            :evm-address="evmAddress"
            :evm-wallet-label="evmWalletLabel"
            :signature-count="signerProgress.signatureCount"
            :required-signer-count="signerProgress.requiredCount"
            :collaboration-enabled="runtime.collaborationEnabled"
          />

          <WorkspaceIdentityBanner
            :is-did-connected="didConnection.isConnected.value"
            :identity-workspace-link="identityWorkspaceLink"
          />
        </div>
      </details>

      <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div class="space-y-6">
          <div
            class="rounded-[20px] border border-aa-border bg-aa-panel/60 overflow-hidden shadow-glow-panel backdrop-blur-lg transition-all duration-200"
          >
            <button
              @click="step1Expanded = !step1Expanded"
              :aria-expanded="step1Expanded"
              aria-controls="step1-content"
              class="w-full bg-aa-panel/40 px-6 py-5 border-b border-aa-border flex items-center justify-between hover:bg-aa-dark/40 transition-colors duration-200"
            >
              <div class="flex items-center gap-4">
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm"
                  :class="
                    steps[0].state === 'completed'
                      ? 'bg-aa-success/20 border border-aa-success/50 text-aa-success shadow-glow-green-sm'
                      : 'bg-neo-500/20 border border-neo-500/50 text-neo-400 shadow-glow-green-sm'
                  "
                >
                  <svg
                    aria-hidden="true"
                    v-if="steps[0].state === 'completed'"
                    class="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2.5"
                      d="M5 13l4 4L19 7"
                    ></path>
                  </svg>
                  <span v-else>1</span>
                </div>
                <div>
                  <h2 class="text-lg font-bold text-aa-text font-outfit">
                    {{ t("operations.stepLoadTitle", "Load Account") }}
                  </h2>
                  <p
                    v-if="steps[0].state === 'completed'"
                    class="text-xs text-aa-success mt-0.5"
                  >
                    {{ t("operations.accountLoadedLabel", "Account loaded") }}
                  </p>
                </div>
              </div>
              <svg
                aria-hidden="true"
                class="w-4 h-4 text-aa-muted transition-transform duration-200"
                :class="step1Expanded ? 'rotate-180' : ''"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                ></path>
              </svg>
            </button>
            <div
              id="step1-content"
              v-show="step1Expanded"
              class="p-6 md:p-8 animate-fade-in space-y-6"
            >
              <LoadAccountPanel
                class=""
                :account-address-script-hash="accountAddressScriptHash"
                :loading="loadingAccount"
                @update:account-address-script-hash="
                  accountAddressScriptHash = $event
                "
                @load="loadAccount"
              />
              <AccountDiscoveryPanel
                :wallet-address="walletService.address"
                @select="loadAccount"
              />
            </div>
          </div>

          <div
            class="rounded-[20px] border border-aa-border bg-aa-panel/60 overflow-hidden shadow-glow-panel backdrop-blur-lg transition-all duration-200"
          >
            <button
              @click="step2Expanded = !step2Expanded"
              :aria-expanded="step2Expanded"
              aria-controls="step2-content"
              class="w-full bg-aa-panel/40 px-6 py-5 border-b border-aa-border flex items-center justify-between hover:bg-aa-dark/40 transition-colors duration-200"
            >
              <div class="flex items-center gap-4">
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm"
                  :class="
                    steps[1].state === 'completed'
                      ? 'bg-aa-success/20 border border-aa-success/50 text-aa-success shadow-glow-green-sm'
                      : 'bg-neo-500/20 border border-neo-500/50 text-neo-400 shadow-glow-green-sm'
                  "
                >
                  <svg
                    aria-hidden="true"
                    v-if="steps[1].state === 'completed'"
                    class="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2.5"
                      d="M5 13l4 4L19 7"
                    ></path>
                  </svg>
                  <span v-else>2</span>
                </div>
                <div>
                  <h2 class="text-lg font-bold text-aa-text font-outfit">
                    {{ t("operations.stepComposeTitle", "Compose Operation") }}
                  </h2>
                  <p
                    v-if="steps[1].state === 'completed'"
                    class="text-xs text-aa-success mt-0.5"
                  >
                    {{
                      t("operations.operationStagedLabel", "Operation staged")
                    }}
                  </p>
                </div>
              </div>
              <svg
                aria-hidden="true"
                class="w-4 h-4 text-aa-muted transition-transform duration-200"
                :class="step2Expanded ? 'rotate-180' : ''"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                ></path>
              </svg>
            </button>
            <div
              id="step2-content"
              v-show="step2Expanded"
              class="p-6 md:p-8 animate-fade-in"
            >
              <OperationComposerPanel
                class=""
                :preset="preset"
                :preset-options="presetOptions"
                :target-contract="targetContract"
                :resolved-contract-hash="resolvedContractHash"
                :resolved-contract-name="resolvedContractName"
                :contract-suggestions="contractSuggestions"
                :contract-lookup-status="contractLookupStatus"
                :contract-lookup-error="contractLookupError"
                :method-options="methodOptions"
                :parameter-fields="parameterFields"
                :method="method"
                :args-text="argsText"
                :transfer-token-script-hash="transferTokenScriptHash"
                :transfer-recipient="transferRecipient"
                :transfer-amount="transferAmount"
                :transfer-data="transferData"
                :multisig-title="multisigTitle"
                :multisig-description="multisigDescription"
                :summary-title="composerSummary.title"
                :summary-detail="composerSummary.detail"
                :batch-account-ids="batchAccountIds"
                :batch-signers="batchSigners"
                :batch-threshold="batchThreshold"
                @update:preset="preset = $event"
                @update:target-contract="targetContract = $event"
                @update:method="method = $event"
                @select-contract-suggestion="selectContractSuggestion"
                @update:parameter-value="updateParameterValue"
                @update:args-text="argsText = $event"
                @update:transfer-token-script-hash="
                  transferTokenScriptHash = $event
                "
                @update:transfer-recipient="transferRecipient = $event"
                @update:transfer-amount="transferAmount = $event"
                @update:transfer-data="transferData = $event"
                @update:multisig-title="multisigTitle = $event"
                @update:multisig-description="multisigDescription = $event"
                @update:batch-account-ids="batchAccountIds = $event"
                @update:batch-signers="batchSigners = $event"
                @update:batch-threshold="batchThreshold = $event"
                @stage="stageOperation"
              />
            </div>
          </div>

          <div
            class="rounded-[20px] border border-aa-border bg-aa-panel/60 overflow-hidden shadow-glow-panel backdrop-blur-lg transition-all duration-200"
          >
            <button
              @click="step3Expanded = !step3Expanded"
              :aria-expanded="step3Expanded"
              aria-controls="step3-content"
              class="w-full bg-aa-panel/40 px-6 py-5 border-b border-aa-border flex items-center justify-between hover:bg-aa-dark/40 transition-colors duration-200"
            >
              <div class="flex items-center gap-4">
                <div
                  class="w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm"
                  :class="
                    steps[2].state === 'completed'
                      ? 'bg-aa-success/20 border border-aa-success/50 text-aa-success shadow-glow-green-sm'
                      : 'bg-neo-500/20 border border-neo-500/50 text-neo-400 shadow-glow-green-sm'
                  "
                >
                  <svg
                    aria-hidden="true"
                    v-if="steps[2].state === 'completed'"
                    class="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2.5"
                      d="M5 13l4 4L19 7"
                    ></path>
                  </svg>
                  <span v-else>3</span>
                </div>
                <div>
                  <h2 class="text-lg font-bold text-aa-text font-outfit">
                    {{ t("operations.stepSignTitle", "Collect Signatures") }}
                  </h2>
                  <p
                    v-if="steps[2].state === 'completed'"
                    class="text-xs text-aa-success mt-0.5"
                  >
                    {{
                      t("operations.signaturesReadyLabel", "Signatures ready")
                    }}
                  </p>
                </div>
              </div>
              <svg
                aria-hidden="true"
                class="w-4 h-4 text-aa-muted transition-transform duration-200"
                :class="step3Expanded ? 'rotate-180' : ''"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                ></path>
              </svg>
            </button>
            <div
              id="step3-content"
              v-show="step3Expanded"
              class="p-6 md:p-8 animate-fade-in space-y-6"
            >
              <div class="flex gap-4">
                <button
                  class="btn-secondary flex-1 border-neo-500/30 text-neo-300 hover:bg-neo-500/10 hover:border-neo-500/60 hover:text-neo-100"
                  :class="{ 'btn-loading': signingWithEvm }"
                  :disabled="
                    !workspace.transactionBody.value ||
                    isSubmissionPending ||
                    signingWithEvm
                  "
                  @click="signWithEvmWallet"
                >
                  {{
                    signingWithEvm
                      ? t("operations.signingEvm", "Signing…")
                      : t("operations.signWithEvm", "Sign with EVM")
                  }}
                </button>
                <button
                  class="btn-secondary flex-1 border-aa-info/30 text-aa-info-light hover:bg-aa-info/10 hover:border-aa-info/60 hover:text-aa-text"
                  :class="{ 'btn-loading': signingWithZkLogin }"
                  :disabled="
                    !workspace.transactionBody.value ||
                    isSubmissionPending ||
                    signingWithZkLogin
                  "
                  @click="signWithZkLogin"
                >
                  {{
                    signingWithZkLogin
                      ? t("operations.signingZkLogin", "Preparing ZK Ticket…")
                      : t("operations.signWithZkLogin", "Sign with ZK Login")
                  }}
                </button>
              </div>
              <SignatureWorkflowPanel
                class=""
                :signer-id="signerId"
                :signer-kind="signerKind"
                :signature-hex="signatureHex"
                :required-signer-count="signerProgress.requiredCount"
                :signature-count="signerProgress.signatureCount"
                :signatures="workspace.signatures.value"
                :is-appending-signature="isAppendingSignature"
                @update:signer-id="signerId = $event"
                @update:signer-kind="signerKind = $event"
                @update:signature-hex="signatureHex = $event"
                @append-signature="appendManualSignature"
              />
            </div>
          </div>

          <DraftSummaryStrip
            class="shadow-xl"
            v-if="
              workspace.operationBody.value || workspace.share.value.draftId
            "
            :draft="draftSummaryDraft"
            :action-context="activityActionContext"
            @summary-action="handleSummaryAction"
          />

          <div
            class="rounded-[20px] border border-neo-500/20 bg-aa-panel/60 overflow-hidden shadow-glow-green-diffuse backdrop-blur-lg transition-all duration-200 relative"
          >
            <div
              class="absolute inset-0 bg-gradient-to-t from-neo-500/5 to-transparent pointer-events-none"
            ></div>
            <button
              @click="step4Expanded = !step4Expanded"
              :aria-expanded="step4Expanded"
              aria-controls="step4-content"
              class="relative w-full bg-aa-panel/40 px-6 py-5 border-b border-neo-500/20 flex items-center justify-between hover:bg-aa-dark/60 transition-colors duration-200"
            >
              <div class="flex items-center gap-4">
                <div
                  class="w-8 h-8 rounded-full bg-neo-500 text-aa-dark flex items-center justify-center font-bold text-sm shadow-glow-green-lg"
                >
                  4
                </div>
                <h2 class="text-lg font-bold text-aa-text font-outfit">
                  {{ t("operations.stepBroadcastTitle", "Broadcast") }}
                </h2>
              </div>
              <svg
                aria-hidden="true"
                class="w-4 h-4 text-aa-muted transition-transform duration-200"
                :class="step4Expanded ? 'rotate-180' : ''"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M19 9l-7 7-7-7"
                ></path>
              </svg>
            </button>
            <div
              id="step4-content"
              v-show="step4Expanded"
              class="relative p-6 md:p-8 animate-fade-in space-y-6"
            >
              <template v-if="!workspace.operationBody.value">
                <div class="empty-state">
                  <svg
                    aria-hidden="true"
                    class="w-10 h-10 mx-auto mb-3 text-aa-muted"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="1.5"
                      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                    ></path>
                  </svg>
                  <p class="text-sm font-semibold text-aa-text mb-1">
                    {{ t("didPanel.broadcastLockedTitle", "Broadcast Locked") }}
                  </p>
                  <p class="text-xs text-aa-muted max-w-sm mx-auto">
                    {{
                      t(
                        "didPanel.broadcastLockedHint",
                        "Complete Steps 1–2 (load an account and stage an operation) to unlock the broadcast panel.",
                      )
                    }}
                  </p>
                </div>
              </template>
              <template v-else>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <button
                    class="btn-primary"
                    :class="{
                      'btn-loading':
                        pendingSubmissionAction === 'client-broadcast',
                    }"
                    :disabled="!canClientBroadcast || isSubmissionPending"
                    @click="requestConfirmation('broadcast')"
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
                      relayPayloadOptions.length === 0 || isSubmissionPending
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
                    :disabled="!canRelayBroadcast || isSubmissionPending"
                    @click="requestConfirmation('relay')"
                  >
                    {{
                      pendingSubmissionAction === "relay-submit"
                        ? t("sharedDraft.submitting", "Submitting…")
                        : t("sharedDraft.submitViaRelay", "Submit via Relay")
                    }}
                  </button>
                </div>
                <BroadcastOptionsPanel
                  class=""
                  :active-mode="workspace.broadcast.value.mode"
                  :modes="runtime.broadcastModes"
                  :active-relay-payload-mode="relayPayloadMode"
                  :relay-payload-options="relayPayloadOptions"
                  :relay-endpoint="runtime.relayEndpoint"
                  :paymaster-enabled="paymasterEnabled"
                  :paymaster-dapp-id="paymasterDappId"
                  :is-persisting="isPersisting"
                  @set-mode="workspace.setBroadcastMode($event)"
                  @set-relay-payload-mode="relayPayloadMode = $event"
                  @set-paymaster-enabled="
                    (value) => {
                      paymasterEnabled = value;
                      workspace.setTransactionBody(
                        applyPaymasterConfig(workspace.transactionBody.value),
                      );
                    }
                  "
                  @set-paymaster-dapp-id="
                    (value) => {
                      paymasterDappId = value;
                      workspace.setTransactionBody(
                        applyPaymasterConfig(workspace.transactionBody.value),
                      );
                    }
                  "
                  @persist-draft="persistDraft"
                />
                <RelayPreflightPanel
                  class="mt-6 border-aa-border"
                  v-if="relayCheck.level !== 'idle'"
                  :level="relayCheck.level"
                  :status-label="relayCheck.label"
                  :detail="relayCheck.detail"
                  :payload-mode="relayCheck.payloadMode"
                  :vm-state="relayCheck.vmState"
                  :gas-consumed="relayCheck.gasConsumed"
                  :operation="relayCheck.operation"
                  :exception="relayCheck.exception"
                  :stack="relayCheck.stack"
                  :can-copy-payload="Boolean(relayCheckRequest)"
                  :can-copy-stack="relayCheck.stack.length > 0"
                  :can-export-json="
                    Boolean(relayCheckRequest) || relayCheck.stack.length > 0
                  "
                  @copy-payload="copyRelayPayload"
                  @copy-stack="copyRelayStack"
                  @export-json="exportRelayPreflight"
                />

                <transition name="fade-in-up">
                  <SubmissionReceiptCard
                    v-if="activeSubmissionReceipt"
                    :receipt="activeSubmissionReceipt"
                    :history-items="submissionReceiptHistoryItems"
                    :copied-key="copiedKey"
                    @copy="
                      ({ text, key }) => {
                        copyText(text);
                        markCopied(key);
                      }
                    "
                  />
                </transition>
              </template>
            </div>
          </div>
        </div>
        <div>
          <button
            @click="sidebarExpanded = !sidebarExpanded"
            :aria-expanded="sidebarExpanded"
            :aria-label="
              t('operations.toggleActivitySidebar', 'Toggle activity sidebar')
            "
            class="xl:hidden w-full mb-3 flex items-center justify-between rounded-xl border border-aa-border bg-aa-panel/60 px-4 py-3 text-sm font-semibold text-aa-text hover:bg-aa-dark/60 transition-colors duration-200 backdrop-blur-md"
          >
            <span class="flex items-center gap-2">
              <span
                class="w-2 h-2 rounded-full bg-aa-orange animate-pulse"
              ></span>
              {{ t("operations.activitySidebarTitle", "Draft Activity") }}
            </span>
            <svg
              aria-hidden="true"
              class="w-3.5 h-3.5 text-aa-muted transition-transform duration-200"
              :class="sidebarExpanded ? 'rotate-180' : ''"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M19 9l-7 7-7-7"
              ></path>
            </svg>
          </button>
          <div :class="sidebarExpanded ? 'block' : 'hidden xl:block'">
            <OperatorKeyBackupPanel
              v-if="runtime.collaborationEnabled && workspace.share.value.canOperate && workspace.share.value.shareSlug"
              :share-slug="workspace.share.value.shareSlug"
              :access-slug="workspace.share.value.operatorSlug"
            />
            <ActivitySidebar
              class="xl:sticky xl:top-8 xl:max-h-[calc(100vh-4rem)] overflow-y-auto rounded-[20px] border border-aa-border bg-aa-panel/50 shadow-2xl backdrop-blur-xl"
              :draft-id="workspace.share.value.draftId"
              :share-path="workspace.share.value.sharePath"
              :share-url="shareUrl"
              :collaboration-url="collaborationUrl"
              :operator-url="operatorUrl"
              :can-write="workspace.share.value.canWrite"
              :can-operate="workspace.share.value.canOperate"
              :access-scope="workspace.share.value.accessScope"
              :share-status="workspace.share.value.status"
              :broadcast-mode="workspace.broadcast.value.mode"
              :signature-count="signerProgress.signatureCount"
              :required-signer-count="signerProgress.requiredCount"
              :pending-signer-count="signerProgress.pending.length"
              :relay-readiness-label="relayReadiness.label"
              :relay-readiness-detail="relayReadiness.detail"
              :relay-readiness-level="relayReadiness.level"
              :activity-items="activityItems.slice().reverse().slice(0, 6)"
              :action-context="activityActionContext"
              timeline-preference-key="home-sidebar"
              @activity-action="handleActivityAction"
              :last-txid="lastBroadcastTxid"
            />
          </div>
        </div>
      </div>
    </div>

    <teleport to="body">
      <transition name="fade-in-up">
        <ConfirmationDialog
          ref="confirmationOverlayRef"
          v-if="pendingConfirmation"
          :open="Boolean(pendingConfirmation)"
          :title="confirmationMeta?.title"
          :message="confirmationMeta?.message"
          @cancel="cancelConfirmation"
          @confirm="executeConfirmedAction"
        />
      </transition>
    </teleport>

    <!-- Keyboard shortcuts overlay -->
    <teleport to="body">
      <transition name="fade-in-up">
        <KeyboardShortcutsModal
          ref="shortcutsOverlayRef"
          v-if="showShortcuts"
          @close="showShortcuts = false"
        />
      </transition>
    </teleport>
  </section>
</template>
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "@/i18n";
import { useToast } from "vue-toastification";
import { useClickOutside } from "@/composables/useClickOutside.js";
import { useClipboard } from "@/composables/useClipboard.js";
import { useWalletConnection } from "@/composables/useWalletConnection.js";
import { useDidConnection } from "@/composables/useDidConnection.js";
import { OPERATIONS_RUNTIME } from "@/config/operationsRuntime.js";
import {
  createDraftRecord,
  createDraftStore,
} from "@/features/operations/drafts.js";
import { createOperatorMutationTransport } from "@/features/operations/operatorMutationTransport.js";
import OperatorKeyBackupPanel from "@/features/operations/components/OperatorKeyBackupPanel.vue";
import {
  buildDraftExportBundle,
  buildRelayPayloadOptions,
  buildStagedTransactionBody,
  executeBroadcast,
  resolveRelayPayloadMode,
} from "@/features/operations/execution.js";
import {
  OPERATION_PRESETS,
  tryBuildOperationFromPreset,
} from "@/features/operations/presets.js";
import { createActivityEvent } from "@/features/operations/activity.js";
import { createOperationsPreferences } from "@/features/operations/preferences.js";
import { evaluateRelayReadiness } from "@/features/operations/relayReadiness.js";
import {
  runRelayPreflight,
  buildRelayPreflightRequest,
} from "@/features/operations/relayPreflight.js";
import { createDraftInteractionHandlers } from "@/features/operations/viewActions.js";
import { summarizeSignerProgress } from "@/features/operations/signatures.js";
import {
  buildDraftCollaborationUrl,
  buildDraftShareUrl,
} from "@/features/operations/shareLinks.js";
import {
  assertV3AccountExists,
  buildExecuteUserOpInvocation,
} from "@/features/operations/metaTx.js";
import {
  prepareV3UserOpContext,
  signUserOpWithEvm,
} from "@/features/operations/useUserOpSigning.js";
import { useDraftPersistence } from "@/features/operations/useDraftPersistence.js";
import { useBroadcastReceipts } from "@/features/operations/useBroadcastReceipts.js";
import { createOperationsWorkspace } from "@/features/operations/useOperationsWorkspace.js";
import {
  getAbstractAccountHash,
  walletService,
} from "@/services/walletService.js";
import { morpheusDidService } from "@/services/morpheusDidService.js";
import {
  createVerifyScript,
  getAddressFromScriptHash,
  getScriptHashFromAddress,
  hash160,
  reverseHex,
} from "@/utils/neo.js";
import { sanitizeHex } from "@/utils/hex.js";
import { EC, translateError } from "@/config/errorCodes.js";
import { isMatrixDomain } from "@/services/matrixDomainService.js";
import { isNeoDomain } from "@/services/domainResolverService.js";
import {
  buildParameterFields,
  buildContractParamFromField,
  loadContractManifest,
  searchContractsByName,
} from "@/services/contractLookupService.js";
import AccountDiscoveryPanel from "./AccountDiscoveryPanel.vue";
import ActivitySidebar from "./ActivitySidebar.vue";
import BroadcastOptionsPanel from "./BroadcastOptionsPanel.vue";
import DraftStatusBanner from "./DraftStatusBanner.vue";
import DraftSummaryStrip from "./DraftSummaryStrip.vue";
import LoadAccountPanel from "./LoadAccountPanel.vue";
import OperationComposerPanel from "./OperationComposerPanel.vue";
import RelayPreflightPanel from "./RelayPreflightPanel.vue";
import SignatureWorkflowPanel from "./SignatureWorkflowPanel.vue";
import ConfirmationDialog from "./HomeOperationsWorkspace/ConfirmationDialog.vue";
import KeyboardShortcutsModal from "./HomeOperationsWorkspace/KeyboardShortcutsModal.vue";
import SubmissionReceiptCard from "./HomeOperationsWorkspace/SubmissionReceiptCard.vue";
import WorkflowProgressStepper from "./HomeOperationsWorkspace/WorkflowProgressStepper.vue";
import WorkflowStatusCards from "./HomeOperationsWorkspace/WorkflowStatusCards.vue";
import WorkspaceIdentityBanner from "./HomeOperationsWorkspace/WorkspaceIdentityBanner.vue";

const runtime = OPERATIONS_RUNTIME;
const { t } = useI18n();
const toast = useToast();
const route = useRoute();
const workspace = createOperationsWorkspace();
const draftStore = createDraftStore({
  operatorMutationTransport: createOperatorMutationTransport(),
});
const walletConnection = useWalletConnection();
const didConnection = useDidConnection();
const { copiedKey, markCopied, copyText } = useClipboard();
const preferences = createOperationsPreferences();
const presetOptions = computed(() =>
  OPERATION_PRESETS.map((p) => {
    const labelKey = `operations.preset${p.id.charAt(0).toUpperCase() + p.id.slice(1)}Label`;
    const descKey = `operations.preset${p.id.charAt(0).toUpperCase() + p.id.slice(1)}Desc`;
    const fallbackLabels = {
      invoke: "Generic Invoke",
      nep17Transfer: "NEP-17 Transfer",
      multisigDraft: "Multisig Draft",
      batchCreate: "Batch Create",
    };
    const fallbackDescs = {
      invoke: "Compose any AA wrapper contract call manually.",
      nep17Transfer:
        "Build a token transfer payload with account and recipient hashes.",
      multisigDraft:
        "Prepare a shareable transaction draft for additional co-signers.",
      batchCreate: "Deploy multiple abstract accounts in a single transaction.",
    };
    return {
      ...p,
      label: t(labelKey, fallbackLabels[p.id] || p.label),
      description: t(descKey, fallbackDescs[p.id] || p.description),
    };
  }),
);

const accountAddressScriptHash = ref("");
const preset = ref("invoke");
const targetContract = ref("");
const resolvedContractHash = ref("");
const resolvedContractName = ref("");
const contractSuggestions = ref([]);
const contractLookupStatus = ref("");
const contractLookupError = ref("");
const methodOptions = ref([]);
const parameterFields = ref([]);
const method = ref("");
const argsText = ref("[]");
const transferTokenScriptHash = ref("");
const transferRecipient = ref("");
const transferAmount = ref("");
const transferData = ref("");
const multisigTitle = ref("");
const multisigDescription = ref("");
const batchAccountIds = ref("[]");
const batchSigners = ref("[]");
const batchThreshold = ref("1");
const rawTransaction = ref("");
const notes = ref("");
const signerId = ref("");
const relayPayloadMode = ref(preferences.getRelayPayloadMode("home-workspace"));
const paymasterEnabled = ref(false);
const defaultPaymasterDappId = String(import.meta.env.VITE_DEFAULT_PAYMASTER_DAPP_ID || "").trim();
const paymasterDappId = ref(defaultPaymasterDappId);
const signerKind = ref("neo");
const signatureHex = ref("");
const evmAddress = ref("");
const connectingNeo = ref(false);
const connectingEvm = ref(false);
const loadingAccount = ref(false);
const signingWithEvm = ref(false);
const signingWithZkLogin = ref(false);
const isAppendingSignature = ref(false);
const lastBroadcastTxid = ref("");
const isPersisting = ref(false);
const {
  activityItems,
  submissionReceiptEntries,
  appendActivity,
  persistSubmissionReceipt,
} = useDraftPersistence({
  draftStore,
  getShareSlug: () => workspace.share.value.shareSlug,
  getAccessMutationOptions: () => accessMutationOptions(),
  getOperatorMutationOptions: () => operatorMutationOptions(),
  devWarnTag: "HomeOperationsWorkspace",
});
const {
  pendingSubmissionAction,
  isSubmissionPending,
  submissionReceiptHistoryItems,
  activeSubmissionReceipt,
  setSubmissionPending,
  setSubmissionResult,
} = useBroadcastReceipts({
  submissionReceiptEntries,
  explorerBaseUrl: runtime.explorerBaseUrl,
  t,
});
const relayCheck = ref({
  level: "idle",
  label: t("operations.relayCheckIdle", "Not Checked"),
  detail: t(
    "operations.relayCheckIdleDetail",
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
const showActionsMenu = ref(false);
const showShortcuts = ref(false);
const confirmationOverlayRef = ref(null);
const shortcutsOverlayRef = ref(null);
const actionsMenuRef = ref(null);
useClickOutside(actionsMenuRef, () => {
  showActionsMenu.value = false;
});
const identityWorkspaceLink = computed(() =>
  workspace.account.value.accountAddressScriptHash
    ? {
        path: "/identity",
        query: { account: workspace.account.value.accountAddressScriptHash },
      }
    : "/identity",
);
const step1Expanded = ref(true);
const step2Expanded = ref(false);
const step3Expanded = ref(false);
const step4Expanded = ref(false);
const sidebarExpanded = ref(false);
const pendingConfirmation = ref(null);

watch(pendingConfirmation, (value) => {
  if (value) nextTick(() => confirmationOverlayRef.value?.focus());
});

watch(showShortcuts, (value) => {
  if (value) nextTick(() => shortcutsOverlayRef.value?.focus());
});
let contractLookupRequestId = 0;
let contractSuggestionTimer = null;

const confirmationMeta = computed(() => {
  const map = {
    broadcast: {
      title: t("operations.confirmBroadcastTitle", "Confirm Broadcast"),
      message: t(
        "operations.confirmBroadcastMsg",
        "This will broadcast the signed operation to the Neo network via your connected wallet. This action cannot be undone.",
      ),
    },
    relay: {
      title: t("operations.confirmRelayTitle", "Confirm Relay Submission"),
      message: t(
        "operations.confirmRelayMsg",
        "This will submit the signed operation through the relay endpoint. Gas will be handled by the relay/paymaster. This action cannot be undone.",
      ),
    },
    "rotate-collaborator": {
      title: t(
        "operations.confirmRotateCollaboratorTitle",
        "Rotate Collaborator Link",
      ),
      message: t(
        "operations.confirmRotateCollaboratorMsg",
        "The current collaborator signing link will be invalidated. Any pending signers using the old link will lose access.",
      ),
    },
    "rotate-operator": {
      title: t("operations.confirmRotateOperatorTitle", "Rotate Operator Link"),
      message: t(
        "operations.confirmRotateOperatorMsg",
        "The current operator link will be invalidated. Any pending operators using the old link will lose access.",
      ),
    },
  };
  return pendingConfirmation.value ? map[pendingConfirmation.value] : null;
});

function requestConfirmation(action) {
  pendingConfirmation.value = action;
}

function cancelConfirmation() {
  pendingConfirmation.value = null;
}

function executeConfirmedAction() {
  const action = pendingConfirmation.value;
  pendingConfirmation.value = null;
  if (action === "broadcast") broadcastWithNeoWallet();
  else if (action === "relay") submitViaRelay();
  else if (action === "rotate-collaborator") rotateCollaboratorLink();
  else if (action === "rotate-operator") rotateOperatorLink();
}

const invokeTargetContract = computed(() => {
  if (resolvedContractHash.value) return resolvedContractHash.value;
  const raw = String(targetContract.value || "").trim();
  if (raw.startsWith("N")) {
    try {
      return sanitizeHex(getScriptHashFromAddress(raw));
    } catch (_error) {
      if (import.meta.env.DEV)
        console.warn("[HomeOperationsWorkspace] address parse failed:", raw);
      return "";
    }
  }
  const sanitized = sanitizeHex(raw);
  return /^[0-9a-f]{40}$/.test(sanitized) ? sanitized : "";
});

// A preset can refuse to build an operation that cannot do what it says (a NEP-17 transfer out of the account
// proxy returns false and still costs the nonce and the fee). The refusal is a normal answer here: it is shown in
// the composer and blocks staging.
const presetBuild = computed(() =>
  tryBuildOperationFromPreset({
    broadcastMode: workspace.broadcast.value.mode,
    preset: preset.value,
    account: workspace.account.value,
    invoke: {
      targetContract: invokeTargetContract.value,
      method: method.value,
      argsText: argsText.value,
    },
    transfer: {
      tokenScriptHash: transferTokenScriptHash.value,
      recipient: transferRecipient.value,
      amount: transferAmount.value,
      data: transferData.value,
    },
    multisig: {
      title: multisigTitle.value,
      description: multisigDescription.value,
    },
    batch: {
      accountIds: batchAccountIds.value,
      signers: batchSigners.value,
      threshold: batchThreshold.value,
    },
  }),
);
const draftCandidate = computed(() => presetBuild.value.operation);
const presetRefusal = computed(() =>
  presetBuild.value.refusal
    ? translateError(presetBuild.value.refusal.message, t)
    : "",
);

function translateSummary(operation = {}) {
  if (!operation || !operation.kind) {
    return {
      title: t("operations.presetSummaryNoOperation", "No operation staged"),
      detail: t(
        "operations.presetSummaryNoOperationDetail",
        "Choose a preset and stage an operation to generate a transaction body.",
      ),
    };
  }
  if (operation.kind === "transfer") {
    return {
      title: t("operations.presetTransferLabel", "NEP-17 Transfer"),
      detail: `${t("operations.presetSummaryTransferDetail", "via")} ${operation.args?.[2]?.value || "0"} — ${operation.targetContract || "token contract pending"}`,
    };
  }
  if (operation.kind === "multisig") {
    return {
      title:
        operation.metadata?.title ||
        t("operations.presetSummaryMultisigDefault", "Multisig Draft"),
      detail:
        operation.metadata?.description ||
        `${operation.method || "method pending"} ${t("operations.presetSummaryMultisigDetail", "requires additional co-signers")}`,
    };
  }
  if (operation.kind === "batchCreate") {
    const count = operation.metadata?.accountCount || 0;
    return {
      title: t("operations.presetBatchLabel", "Batch Create"),
      detail: `${t("operations.presetSummaryBatchDetail", "Deploy")} ${count} ${count === 1 ? t("operations.presetSummaryBatchAccounts", "account") : t("operations.presetSummaryBatchAccountsPlural", "accounts")} ${t("operations.presetSummaryBatchWith", "with shared governance")}`,
    };
  }
  return {
    title: t("operations.presetInvokeLabel", "Generic Invoke"),
    detail: `${operation.method || "method pending"} ${t("operations.presetSummaryInvokeDetail", "on")} ${operation.targetContract || "target contract pending"}`,
  };
}
const composerSummary = computed(() =>
  presetRefusal.value
    ? {
        title: t("operations.presetRefusedTitle", "NEP-17 transfer refused"),
        detail: presetRefusal.value,
      }
    : translateSummary(draftCandidate.value),
);
const signerProgress = computed(() =>
  summarizeSignerProgress(
    workspace.signerRequirements.value,
    workspace.signatures.value,
  ),
);
const didLabel = computed(() =>
  didConnection.isConnected.value
    ? didConnection.shortDid.value
    : didConnection.isConfigured.value
      ? t("operations.available", "available")
      : t("operations.notConfigured", "not configured"),
);
const neoWalletLabel = computed(() =>
  walletConnection.isConnected.value
    ? walletService.address
    : t("didPanel.notConnected", "not connected"),
);
const evmWalletLabel = computed(
  () => evmAddress.value || t("didPanel.notConnected", "not connected"),
);
const shareUrl = computed(() => {
  const slug = workspace.share.value.shareSlug;
  if (!slug) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return origin
    ? buildDraftShareUrl(origin, slug)
    : workspace.share.value.sharePath;
});
const collaborationUrl = computed(() => {
  const shareSlug = workspace.share.value.shareSlug;
  const collaborationSlug = workspace.share.value.collaborationSlug;
  if (!shareSlug || !collaborationSlug) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return origin
    ? buildDraftCollaborationUrl(origin, shareSlug, collaborationSlug)
    : workspace.share.value.collaborationPath;
});
const operatorUrl = computed(() => {
  const shareSlug = workspace.share.value.shareSlug;
  const operatorSlug = workspace.share.value.operatorSlug;
  if (!shareSlug || !operatorSlug) return "";
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return origin
    ? buildDraftCollaborationUrl(origin, shareSlug, operatorSlug)
    : workspace.share.value.operatorPath;
});
const canClientBroadcast = computed(() =>
  Boolean(
    workspace.transactionBody.value?.clientInvocation &&
    walletConnection.isConnected.value,
  ),
);
const relayPayloadOptions = computed(() =>
  buildRelayPayloadOptions({
    runtime,
    transactionBody: workspace.transactionBody.value,
    signatures: workspace.signatures.value,
  }),
);
const selectedRelayPayloadMode = computed(() =>
  resolveRelayPayloadMode({
    relayPayloadMode: relayPayloadMode.value,
    availableModes: relayPayloadOptions.value,
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
      transactionBody: workspace.transactionBody.value,
      signatures: workspace.signatures.value,
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
const relayReadiness = computed(() =>
  evaluateRelayReadiness({
    runtime,
    transactionBody: workspace.transactionBody.value,
    signatures: workspace.signatures.value,
    t,
  }),
);
const canRelayBroadcast = computed(() =>
  Boolean(
    relayReadiness.value.payloadReady &&
      relayCheck.value?.ok === true &&
      relayCheckMatchesCurrentPayload.value,
  ),
);
const activityActionContext = computed(() => ({
  shareUrl: shareUrl.value,
  collaboratorUrl: collaborationUrl.value,
  operatorUrl: operatorUrl.value,
  relayTargetId: "relay-preflight-panel",
  explorerBaseUrl: runtime.explorerBaseUrl,
}));

const currentStepLabel = computed(() => {
  if (step1Expanded.value)
    return t("operations.step1Of4", "Step 1 of 4: Load Account");
  if (step2Expanded.value)
    return t("operations.step2Of4", "Step 2 of 4: Compose Operation");
  if (step3Expanded.value)
    return t("operations.step3Of4", "Step 3 of 4: Collect Signatures");
  if (step4Expanded.value)
    return t("operations.step4Of4", "Step 4 of 4: Broadcast");
  return t("operations.workflowOverview", "Workflow Overview");
});

const steps = computed(() => [
  {
    id: "step1",
    label: t("operations.stepLoadAccount", "Load Account"),
    state:
      workspace.account.value.accountIdHash ||
      workspace.account.value.accountAddressScriptHash
        ? "completed"
        : step1Expanded.value
          ? "active"
          : "pending",
  },
  {
    id: "step2",
    label: t("operations.stepCompose", "Compose"),
    state: workspace.operationBody.value
      ? "completed"
      : step2Expanded.value
        ? "active"
        : "pending",
  },
  {
    id: "step3",
    label: t("operations.stepSign", "Sign"),
    state:
      signerProgress.value.isComplete
        ? "completed"
        : step3Expanded.value
          ? "active"
          : "pending",
  },
  {
    id: "step4",
    label: t("operations.stepBroadcast", "Broadcast"),
    state: lastBroadcastTxid.value
      ? "completed"
      : step4Expanded.value
        ? "active"
        : "pending",
  },
]);

function jumpToStep(stepId) {
  const isAlreadyOpen =
    (stepId === "step1" && step1Expanded.value) ||
    (stepId === "step2" && step2Expanded.value) ||
    (stepId === "step3" && step3Expanded.value) ||
    (stepId === "step4" && step4Expanded.value);
  if (isAlreadyOpen) {
    step1Expanded.value = false;
    step2Expanded.value = false;
    step3Expanded.value = false;
    step4Expanded.value = false;
    return;
  }
  step1Expanded.value = stepId === "step1";
  step2Expanded.value = stepId === "step2";
  step3Expanded.value = stepId === "step3";
  step4Expanded.value = stepId === "step4";
}

function resetWorkflow() {
  step1Expanded.value = true;
  step2Expanded.value = false;
  step3Expanded.value = false;
  step4Expanded.value = false;
}

watch(
  () =>
    workspace.account.value.accountIdHash ||
    workspace.account.value.accountAddressScriptHash,
  (val, oldVal) => {
    if (val && !oldVal) {
      step1Expanded.value = false;
      step2Expanded.value = true;
    }
  },
);
watch(
  () => !!workspace.operationBody.value,
  (val, oldVal) => {
    if (val && !oldVal) {
      step2Expanded.value = false;
      step3Expanded.value = true;
    }
  },
);
watch(
  () =>
    signerProgress.value.isComplete,
  (val, oldVal) => {
    if (val && !oldVal) {
      step3Expanded.value = false;
      step4Expanded.value = true;
    }
  },
);

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
    toast.success(message);
  },
  t,
});

watch(relayPayloadMode, (value) => {
  preferences.setRelayPayloadMode("home-workspace", value);
});

function syncArgsTextFromParameters() {
  if (!parameterFields.value.length) return;
  argsText.value = JSON.stringify(
    parameterFields.value.map((field) => buildContractParamFromField(field)),
    null,
    2,
  );
}

function updateParameterValue({ key, value }) {
  parameterFields.value = parameterFields.value.map((field) =>
    field.key === key ? { ...field, value } : field,
  );
  syncArgsTextFromParameters();
}

function selectContractSuggestion(suggestion) {
  targetContract.value =
    suggestion.displayName || `0x${suggestion.contractHash}`;
  resolvedContractHash.value = sanitizeHex(suggestion.contractHash);
  resolvedContractName.value = suggestion.displayName || "";
  contractSuggestions.value = [];
  void refreshContractMethods(`0x${sanitizeHex(suggestion.contractHash)}`);
}

function prefillAccountIdFromRoute() {
  const raw = String(route.query.accountId || route.query.accountIdHash || "")
    .trim();
  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(raw)) return;
  accountAddressScriptHash.value = sanitizeHex(raw);
  step1Expanded.value = true;
}

watch(
  () => [route.query.accountId, route.query.accountIdHash],
  () => prefillAccountIdFromRoute(),
);

async function refreshContractMethods(identifier = targetContract.value) {
  const requestId = ++contractLookupRequestId;
  contractLookupStatus.value = t(
    "operations.loadingContractMethods",
    "Loading contract methods…",
  );
  try {
    const loaded = await loadContractManifest(identifier, {
      rpcUrl: walletService.rpcUrl || runtime.relayRpcUrl,
      matrixContractHash: runtime.matrixContractHash,
      neoNnsContractHash: runtime.neoNnsContractHash,
    });
    if (requestId !== contractLookupRequestId) return;

    resolvedContractHash.value = loaded.resolved?.contractHash || "";
    resolvedContractName.value =
      loaded.manifest?.name ||
      loaded.resolved?.displayName ||
      resolvedContractName.value;
    methodOptions.value = loaded.methods || [];
    contractSuggestions.value = [];

    if (
      method.value &&
      !methodOptions.value.some((option) => option.name === method.value)
    ) {
      method.value = "";
    }
    if (!method.value && methodOptions.value.length === 1) {
      method.value = methodOptions.value[0].name;
    }
    if (!method.value) {
      parameterFields.value = [];
    }

    contractLookupError.value = "";
    contractLookupStatus.value = methodOptions.value.length
      ? `${t("operations.loadedMethodsPrefix", "Loaded")} ${methodOptions.value.length} ${t("operations.loadedMethodsFor", "methods for")} ${resolvedContractName.value || `0x${resolvedContractHash.value}`}.`
      : t(
          "operations.contractResolvedNoMethods",
          "Contract resolved, but no callable ABI methods were returned.",
        );
  } catch (error) {
    if (import.meta.env.DEV)
      console.error(
        "[HomeOperationsWorkspace] Contract lookup failed:",
        error?.message,
      );
    if (requestId !== contractLookupRequestId) return;
    resolvedContractHash.value = "";
    resolvedContractName.value = "";
    methodOptions.value = [];
    parameterFields.value = [];
    contractLookupStatus.value = "";
    contractLookupError.value =
      translateError(error?.message, t) ||
      t(
        "errors.contractLookupFailed",
        "Could not load contract methods. Please check the contract hash and try again.",
      );
  }
}

watch(method, (nextMethod) => {
  const methodDefinition =
    methodOptions.value.find((option) => option.name === nextMethod) || null;
  parameterFields.value = buildParameterFields(methodDefinition);
  if (parameterFields.value.length) {
    syncArgsTextFromParameters();
  }
});

watch(targetContract, (value) => {
  const lookup = String(value || "").trim();
  clearTimeout(contractSuggestionTimer);
  contractSuggestions.value = [];

  if (!lookup) {
    resolvedContractHash.value = "";
    resolvedContractName.value = "";
    methodOptions.value = [];
    parameterFields.value = [];
    contractLookupStatus.value = "";
    contractLookupError.value = "";
    return;
  }

  const directLookup =
    (lookup.startsWith("N") && lookup.length === 34) ||
    isMatrixDomain(lookup) ||
    isNeoDomain(lookup) ||
    /^[0-9a-f]{40}$/i.test(sanitizeHex(lookup));
  if (directLookup) {
    contractSuggestionTimer = setTimeout(() => {
      void refreshContractMethods(lookup);
    }, 250);
    return;
  }

  contractSuggestionTimer = setTimeout(async () => {
    const requestId = ++contractLookupRequestId;
    contractLookupStatus.value = t(
      "operations.searchingContracts",
      "Searching contracts via N3Index…",
    );
    try {
      const suggestions = await searchContractsByName(lookup, {
        baseUrl: runtime.n3IndexApiBaseUrl,
        network: runtime.n3IndexNetwork,
        rpcUrl: walletService.rpcUrl || runtime.relayRpcUrl,
      });
      if (requestId !== contractLookupRequestId) return;
      contractSuggestions.value = suggestions;
      resolvedContractHash.value = "";
      resolvedContractName.value = "";
      methodOptions.value = [];
      parameterFields.value = [];
      contractLookupError.value = "";
      contractLookupStatus.value = suggestions.length
        ? t(
            "operations.selectContractHint",
            "Select a contract to load its ABI methods.",
          )
        : t("operations.noContractsFound", "No matching contracts found yet.");
    } catch (error) {
      if (import.meta.env.DEV)
        console.error(
          "[HomeOperationsWorkspace] Contract search failed:",
          error?.message,
        );
      if (requestId !== contractLookupRequestId) return;
      contractSuggestions.value = [];
      contractLookupStatus.value = "";
      contractLookupError.value =
        translateError(error?.message, t) ||
        t(
          "operations.contractSearchFailed",
          "Contract search failed. Please try again.",
        );
    }
  }, 250);
});

function handleKeydown(e) {
  const tag = e.target.tagName;
  if (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    e.target.isContentEditable
  )
    return;

  const mod = e.ctrlKey || e.metaKey;

  if (e.key === "?" && !mod) {
    e.preventDefault();
    showShortcuts.value = !showShortcuts.value;
    return;
  }

  if (mod && e.key >= "1" && e.key <= "5") {
    e.preventDefault();
    const stepIndex = parseInt(e.key) - 1;
    if (
      stepIndex < 4 &&
      steps.value[stepIndex] &&
      steps.value[stepIndex].state !== "pending"
    ) {
      jumpToStep(steps.value[stepIndex].id);
    }
    return;
  }

  if (mod && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    void persistDraft();
    return;
  }

  if (mod && e.key === "Enter") {
    e.preventDefault();
    if (canRelayBroadcast.value) {
      requestConfirmation("relay");
    } else if (canClientBroadcast.value) {
      requestConfirmation("broadcast");
    }
    return;
  }
}

onMounted(() => {
  prefillAccountIdFromRoute();
  window.addEventListener("keydown", handleKeydown);
  if (String(targetContract.value || "").trim()) {
    void refreshContractMethods(targetContract.value);
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown);
  clearTimeout(contractSuggestionTimer);
});

const draftSummaryDraft = computed(() =>
  buildCurrentDraftRecord({
    draftId: workspace.share.value.draftId || "local-draft",
    shareSlug: workspace.share.value.shareSlug || "local-share",
  }),
);
const exportPreview = computed(() =>
  JSON.stringify(
    buildDraftExportBundle({
      draftRecord: buildCurrentDraftRecord({
        draftId: workspace.share.value.draftId || "local-draft",
        shareSlug: workspace.share.value.shareSlug || "local-share",
      }),
      origin: typeof window !== "undefined" ? window.location.origin : "",
    }),
    null,
    2,
  ),
);

function buildCurrentDraftRecord({ draftId, shareSlug } = {}) {
  return createDraftRecord({
    draftId,
    shareSlug,
    collaborationSlug: workspace.share.value.collaborationSlug || undefined,
    operatorSlug: workspace.share.value.operatorSlug || undefined,
    account: workspace.account.value,
    operationBody: workspace.operationBody.value,
    transactionBody: workspace.transactionBody.value,
    signerRequirements: workspace.signerRequirements.value,
    signatures: workspace.signatures.value,
    broadcastMode: workspace.broadcast.value.mode,
    metadata: {
      preset: preset.value,
      notes: notes.value,
      multisigTitle: multisigTitle.value,
      multisigDescription: multisigDescription.value,
      lastBroadcastTxid: lastBroadcastTxid.value,
      relayPreflight:
        relayCheck.value?.level && relayCheck.value.level !== "idle"
          ? relayCheck.value
          : null,
      activity: activityItems.value,
      submissionReceipts: submissionReceiptEntries.value,
      availableWalletModes: walletConnection.availableWalletModes.value,
    },
  });
}

function applyPaymasterConfig(transactionBody = null) {
  if (!transactionBody || typeof transactionBody !== "object")
    return transactionBody;
  const next = {
    ...transactionBody,
  };
  if (paymasterEnabled.value) {
    next.paymaster = {
      ...(next.paymaster || {}),
      dapp_id: String(paymasterDappId.value || "").trim(),
    };
  } else {
    delete next.paymaster;
  }
  return next;
}

function syncPaymasterStateFromRecord(record = null) {
  paymasterEnabled.value = Boolean(record?.transaction_body?.paymaster);
  paymasterDappId.value =
    record?.transaction_body?.paymaster?.dapp_id || defaultPaymasterDappId;
}

function syncSignerRequirements() {
  if (
    !workspace.account.value.accountAddressScriptHash &&
    !walletService.address &&
    !evmAddress.value
  ) {
    workspace.setSignerRequirements([]);
    return;
  }
  workspace.setSignerRequirements([
    {
      id:
        walletService.address ||
        workspace.account.value.accountAddressScriptHash ||
        "neo-wallet-pending",
      kind: "neo",
    },
    { id: evmAddress.value || "evm-wallet-pending", kind: "evm" },
  ]);
}

// Connect success/error toasts are owned by useWalletConnection so users see
// exactly one toast per connect action; this wrapper only tracks button state
// and syncs the signer roster.
async function connectNeoWallet() {
  connectingNeo.value = true;
  try {
    await walletConnection.connect();
    syncSignerRequirements();
  } catch (_error) {
    /* useWalletConnection.connect already toasted the failure */
  } finally {
    connectingNeo.value = false;
  }
}

async function connectEvmWalletAction() {
  connectingEvm.value = true;
  try {
    const { address } = await walletConnection.connectEvm();
    evmAddress.value = address.toLowerCase();
    syncSignerRequirements();
  } catch (_error) {
    /* useWalletConnection.connectEvm already toasted the failure */
  } finally {
    connectingEvm.value = false;
  }
}

async function loadAccount(overrideAddress = "") {
  const lookup = String(
    overrideAddress || accountAddressScriptHash.value || "",
  ).trim();
  if (!lookup) {
    toast.error(
      t("operations.enterAccountSeed", "Enter a 20-byte accountId hash."),
    );
    return;
  }

  if (lookup.startsWith("N") || isMatrixDomain(lookup)) {
    toast.error(
      t(
        "operations.v3AccountCannotBeDiscovered",
        "V3 accounts cannot be discovered from a Neo address or .matrix domain. Load them from the 20-byte accountId hash.",
      ),
    );
    return;
  }

  if (!/^(0x)?[0-9a-fA-F]{40}$/.test(lookup)) {
    toast.error(
      t("operations.enterAccountSeed", "Enter a 20-byte accountId hash."),
    );
    return;
  }

  const resolvedAccountIdHash = sanitizeHex(lookup);

  const verifyScript = createVerifyScript(
    getAbstractAccountHash(),
    resolvedAccountIdHash,
  );
  const resolvedAddressScriptHash = reverseHex(hash160(verifyScript));
  const resolvedAddress = getAddressFromScriptHash(resolvedAddressScriptHash);

  loadingAccount.value = true;
  try {
    await assertV3AccountExists({
      rpcUrl: walletService.rpcUrl,
      aaContractHash: getAbstractAccountHash(),
      accountIdHash: resolvedAccountIdHash,
    });
    accountAddressScriptHash.value = resolvedAccountIdHash;

    workspace.loadAbstractAccount({
      accountAddressScriptHash: resolvedAddressScriptHash,
      accountIdHash: resolvedAccountIdHash,
    });
    syncSignerRequirements();
    signerId.value =
      walletService.address || workspace.account.value.accountAddressScriptHash;
    appendActivity(
      createActivityEvent({
        type: "account_loaded",
        actor: "workspace",
        detail: t("operations.activityAccountLoaded", "V3 account loaded"),
      }),
    );
    toast.success(
      `${t("operations.v3AccountLoadedPrefix", "V3 account loaded. Virtual address:")} ${resolvedAddress}`,
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    loadingAccount.value = false;
  }
}

function stageOperation() {
  if (presetRefusal.value) {
    toast.error(presetRefusal.value);
    return;
  }
  if (["invoke", "multisigDraft"].includes(preset.value)) {
    if (!invokeTargetContract.value || !String(method.value || "").trim())
      return;
  }

  const nextOperationBody = {
    ...draftCandidate.value,
    createdAt: new Date().toISOString(),
  };
  workspace.setOperationBody(nextOperationBody);
  workspace.setTransactionBody(
    buildStagedTransactionBody({
      aaContractHash: getAbstractAccountHash(),
      account: workspace.account.value,
      operationBody: nextOperationBody,
      signerAddress: walletService.address,
      rawTransaction: rawTransaction.value,
      notes: notes.value,
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      createdAt: nextOperationBody.createdAt,
    }),
  );
  workspace.setTransactionBody(
    applyPaymasterConfig(workspace.transactionBody.value),
  );
  syncSignerRequirements();
  appendActivity(
    createActivityEvent({
      type: "operation_staged",
      actor: "workspace",
      detail: translateSummary(nextOperationBody).title,
    }),
  );
  toast.success(
    `${translateSummary(nextOperationBody).title} ${t("operations.stagedLocallyPrefix", "staged locally. Create a draft to freeze and share it.")}`,
  );
}

async function persistDraft() {
  if (isPersisting.value) return;
  isPersisting.value = true;
  try {
    if (!workspace.transactionBody.value)
      throw new Error(EC.stageBeforeCreatingDraft);
    if (workspace.share.value.draftId) {
      toast.error(
        t(
          "operations.draftAlreadyPersisted",
          "This draft is already persisted and immutable.",
        ),
      );
      return;
    }
    const payload = buildCurrentDraftRecord();
    const record = await draftStore.createDraft(payload);
    workspace.hydrateDraft(record);
    rawTransaction.value = record.transaction_body?.rawTransaction || "";
    syncPaymasterStateFromRecord(record);
    if (record.metadata?.relayPreflight)
      relayCheck.value = {
        ...relayCheck.value,
        ...record.metadata.relayPreflight,
      };
    submissionReceiptEntries.value =
      record.metadata?.submissionReceipts || submissionReceiptEntries.value;
    activityItems.value = record.metadata?.activity || [];
    await appendActivity(
      createActivityEvent({
        type: "draft_created",
        actor: runtime.collaborationEnabled ? "supabase" : "local",
        detail: t("operations.activityDraftPersisted", "Share draft persisted"),
      }),
    );
    toast.success(
      runtime.collaborationEnabled
        ? t(
            "operations.draftPersistedSupabase",
            "Anonymous share draft persisted to Supabase. Share the collaborator link to collect signatures; the share link stays read-only.",
          )
        : t(
            "operations.draftPersistedLocal",
            "Local-only draft persisted in this browser. Share links will only reopen here until Supabase is configured.",
          ),
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    isPersisting.value = false;
  }
}

async function appendSignatureRecordToWorkspace(nextSignature) {
  if (workspace.share.value.shareSlug) {
    const record = await draftStore.appendSignature(
      workspace.share.value.shareSlug,
      nextSignature,
      accessMutationOptions(),
    );
    workspace.replaceSignatures(record.signatures || []);
    workspace.setShareStatus(record.status || workspace.share.value.status);
    return;
  }
  workspace.appendSignature(nextSignature);
}

function resolveSignerId(kindValue) {
  if (signerId.value) return signerId.value.trim();
  if (kindValue === "evm") return evmAddress.value || "evm-wallet-pending";
  if (kindValue === "zklogin")
    return (
      didConnection.didProfile.value?.identityRoot ||
      didConnection.didProfile.value?.providerUid ||
      "zklogin-pending"
    );
  return (
    walletService.address ||
    workspace.account.value.accountAddressScriptHash ||
    "neo-wallet-pending"
  );
}

async function appendManualSignature() {
  isAppendingSignature.value = true;
  try {
    const nextSignature = {
      signerId: resolveSignerId(signerKind.value),
      kind: signerKind.value,
      signatureHex: signatureHex.value,
      createdAt: new Date().toISOString(),
    };
    if (!nextSignature.signatureHex)
      throw new Error(EC.enterSignatureBeforeAppending);
    await appendSignatureRecordToWorkspace(nextSignature);
    signatureHex.value = "";
    signerId.value = resolveSignerId(signerKind.value);
    await appendActivity(
      createActivityEvent({
        type: "signature_added",
        actor: signerKind.value,
        detail: t("operations.activitySignatureAppended", "Signature appended"),
      }),
    );
    toast.success(
      t("operations.signatureAppended", "Signature appended to the workspace."),
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    isAppendingSignature.value = false;
  }
}

async function signWithEvmWallet() {
  signingWithEvm.value = true;
  try {
    if (!workspace.transactionBody.value)
      throw new Error(EC.stageBeforeEvmApproval);
    if (!evmAddress.value) {
      const { address } = await walletConnection.connectEvm();
      evmAddress.value = address.toLowerCase();
      syncSignerRequirements();
    }

    const { signatureRecord, metaInvocation } = await signUserOpWithEvm({
      rpcUrl: walletService.rpcUrl,
      aaContractHash: getAbstractAccountHash(),
      accountIdHash: workspace.account.value.accountIdHash,
      operationBody: workspace.operationBody.value,
      signerId: evmAddress.value,
      chainId: runtime.networkMagic,
      signTypedData: (typedData) => walletService.signTypedDataWithEvm(typedData),
      missingAccountError: EC.v3AccountIdHashMissing,
      missingVerifierError: EC.noVerifierConfigured,
    });
    // Persisted drafts have an immutable transaction body; the broadcast path
    // reads metaInvocation from the signature metadata instead.
    if (!workspace.isDraftImmutable.value) {
      workspace.setTransactionBody({
        ...workspace.transactionBody.value,
        clientInvocation: metaInvocation,
        v3Invocation: metaInvocation,
      });
      workspace.setTransactionBody(
        applyPaymasterConfig(workspace.transactionBody.value),
      );
    }

    await appendSignatureRecordToWorkspace(signatureRecord);
    await appendActivity(
      createActivityEvent({
        type: "signature_added",
        actor: "evm",
        detail: t(
          "operations.activityEvmSignatureCollected",
          "UserOperation signature collected",
        ),
      }),
    );
    toast.success(
      t(
        "operations.evmSignatureCollected",
        "Contract-aligned EVM UserOperation signature collected and attached to the draft.",
      ),
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    signingWithEvm.value = false;
  }
}

async function signWithZkLogin() {
  signingWithZkLogin.value = true;
  try {
    if (!workspace.transactionBody.value)
      throw new Error(EC.stageBeforeEvmApproval);
    if (!didConnection.isConnected.value) {
      await didConnection.connectDid();
    }

    const aaContractHash = getAbstractAccountHash();
    const { argsHashHex, verifierHash, nonce, deadline } =
      await prepareV3UserOpContext({
        rpcUrl: walletService.rpcUrl,
        aaContractHash,
        accountIdHash: workspace.account.value.accountIdHash,
        operationBody: workspace.operationBody.value,
        missingAccountError: EC.v3AccountIdHashMissing,
        missingVerifierError: EC.noVerifierConfigured,
      });

    const zkLoginTicket = await morpheusDidService.previewZkLoginTicket({
      verifierContract: verifierHash,
      accountIdHash: workspace.account.value.accountIdHash,
      targetContract: workspace.operationBody.value?.targetContract,
      method: workspace.operationBody.value?.method,
      argsHashHex,
      nonce: String(nonce),
      deadline: String(deadline),
      provider: "web3auth",
    });

    const metaInvocation = buildExecuteUserOpInvocation({
      aaContractHash,
      accountIdHash: workspace.account.value.accountIdHash,
      targetContract: workspace.operationBody.value?.targetContract,
      method: workspace.operationBody.value?.method,
      methodArgs: workspace.operationBody.value?.args || [],
      nonce,
      deadline,
      signatureHex: zkLoginTicket.proof_hex,
    });
    // Persisted drafts have an immutable transaction body; the broadcast path
    // reads metaInvocation from the signature metadata instead.
    if (!workspace.isDraftImmutable.value) {
      workspace.setTransactionBody({
        ...workspace.transactionBody.value,
        clientInvocation: metaInvocation,
        v3Invocation: metaInvocation,
      });
      workspace.setTransactionBody(
        applyPaymasterConfig(workspace.transactionBody.value),
      );
    }

    await appendSignatureRecordToWorkspace({
      signerId: resolveSignerId("zklogin"),
      kind: "zklogin",
      signatureHex: zkLoginTicket.proof_hex,
      payloadDigest: argsHashHex,
      metadata: {
        verifierHash,
        argsHashHex,
        nonce: String(nonce),
        deadline: String(deadline),
        metaInvocation,
        zkloginTicket: zkLoginTicket,
        verifierParamsHex: zkLoginTicket.verifier_params_hex,
      },
      createdAt: new Date().toISOString(),
    });
    await appendActivity(
      createActivityEvent({
        type: "signature_added",
        actor: "zklogin",
        detail: t(
          "operations.activityZkLoginTicketCollected",
          "ZK login ticket collected",
        ),
      }),
    );
    toast.success(
      t(
        "operations.zkLoginSignatureCollected",
        "Morpheus zklogin ticket prepared and attached to the draft.",
      ),
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    signingWithZkLogin.value = false;
  }
}

async function persistRelayCheckMetadata(snapshot) {
  if (!workspace.share.value.shareSlug) return;
  try {
    await draftStore.setRelayPreflight(
      workspace.share.value.shareSlug,
      { relayPreflight: snapshot },
      operatorMutationOptions(),
    );
  } catch (_) {
    if (import.meta.env.DEV)
      console.warn(
        "[HomeOperationsWorkspace] persistRelayCheckMetadata sync failed",
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
      transactionBody: workspace.transactionBody.value,
      signatures: workspace.signatures.value,
    });
    relayCheck.value = await runRelayPreflight({
      walletService,
      relayEndpoint: runtime.relayEndpoint,
      relayPayloadMode: relayPayloadMode.value,
      relayRawEnabled: runtime.relayRawEnabled,
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      transactionBody: workspace.transactionBody.value,
      signatures: workspace.signatures.value,
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
    toast.success(
      `${t("operations.relayCheckLabelDetailPrefix", "Relay check completed:")} ${relayCheck.value.detail}`,
    );
    await persistSubmissionReceipt(
      setSubmissionResult("relay-check", {
        phase: "success",
        detail: relayCheck.value.detail,
      }),
    );
  } catch (error) {
    relayCheck.value = {
      level: "blocked",
      label: t("operations.relayCheckFailed", "Relay Check Failed"),
      detail: t(
        "operations.relayCheckErrorDetail",
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

async function updateDraftStatus(status) {
  if (!workspace.share.value.shareSlug) return;
  try {
    const record = await draftStore.updateStatus(
      workspace.share.value.shareSlug,
      status,
      operatorMutationOptions(),
    );
    workspace.setShareStatus(record.status || status);
  } catch (_) {
    if (import.meta.env.DEV)
      console.warn(
        "[HomeOperationsWorkspace] updateDraftStatus sync failed",
      ); /* best-effort remote sync; the broadcast itself already succeeded */
  }
}

async function broadcastWithNeoWallet() {
  setSubmissionPending("client-broadcast");
  try {
    const result = await executeBroadcast({
      mode: "client",
      morpheusNetwork: runtime.morpheusNetwork,
      networkMagic: runtime.networkMagic,
      signerAddress: walletService.address,
      transactionBody: workspace.transactionBody.value,
      relayPayloadMode: relayPayloadMode.value,
      signatures: workspace.signatures.value,
      walletService,
      relayEndpoint: runtime.relayEndpoint,
    });
    lastBroadcastTxid.value = result?.txid || result?.result?.hash || "";
    await updateDraftStatus("broadcasted");
    await appendActivity(
      createActivityEvent({
        type: "broadcast_client",
        actor: "neo",
        detail:
          lastBroadcastTxid.value ||
          t(
            "operations.broadcastSubmittedPrefix",
            "Client-side Neo broadcast submitted",
          ),
      }),
    );
    toast.success(
      `${t("operations.broadcastSubmittedPrefix", "Client-side Neo broadcast submitted")}${lastBroadcastTxid.value ? `: ${lastBroadcastTxid.value}` : "."}`,
    );
    await persistSubmissionReceipt(
      setSubmissionResult("client-broadcast", {
        phase: "success",
        detail:
          t(
            "operations.broadcastSubmittedPrefix",
            "Client-side Neo broadcast submitted",
          ) + ".",
        txid: lastBroadcastTxid.value,
      }),
    );
  } catch (error) {
    const errorMessage =
      translateError(error?.message, t) ||
      t(
        "operations.broadcastFailed",
        "Client broadcast failed. Please check your wallet connection and try again.",
      );
    toast.error(errorMessage);
    await persistSubmissionReceipt(
      setSubmissionResult("client-broadcast", {
        phase: "error",
        detail: errorMessage,
      }),
    );
  }
}

async function submitViaRelay() {
  if (!canRelayBroadcast.value) {
    const errorMessage = t(
      "operations.relayPreflightRequired",
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
      transactionBody: workspace.transactionBody.value,
      signatures: workspace.signatures.value,
      walletService,
      relayEndpoint: runtime.relayEndpoint,
    });
    lastBroadcastTxid.value = result?.txid || result?.result?.hash || "";
    await updateDraftStatus("relayed");
    await appendActivity(
      createActivityEvent({
        type: "broadcast_relay",
        actor: "relay",
        detail:
          lastBroadcastTxid.value ||
          t("operations.relaySubmissionPrefix", "Relay submission completed"),
      }),
    );
    toast.success(
      `${t("operations.relaySubmissionPrefix", "Relay submission completed")}${lastBroadcastTxid.value ? `: ${lastBroadcastTxid.value}` : "."}`,
    );
    await persistSubmissionReceipt(
      setSubmissionResult("relay-submit", {
        phase: "success",
        detail:
          t("operations.relaySubmissionPrefix", "Relay submission completed") +
          ".",
        txid: lastBroadcastTxid.value,
      }),
    );
  } catch (error) {
    const errorMessage =
      translateError(error?.message, t) ||
      t(
        "operations.relaySubmitFailed",
        "Relay submission failed. Please try again.",
      );
    toast.error(errorMessage);
    await persistSubmissionReceipt(
      setSubmissionResult("relay-submit", {
        phase: "error",
        detail: errorMessage,
      }),
    );
  }
}

function accessMutationOptions() {
  return {
    accessSlug:
      workspace.share.value.operatorSlug ||
      workspace.share.value.collaborationSlug ||
      "",
  };
}

function operatorMutationOptions() {
  return { accessSlug: workspace.share.value.operatorSlug || "" };
}

async function copyShareLink() {
  if (!shareUrl.value) return;
  await copyText(shareUrl.value);
  toast.success(
    t("operations.shareLinkCopied", "Share link copied to clipboard."),
  );
  showActionsMenu.value = false;
}

async function copyCollaboratorLink() {
  if (!collaborationUrl.value) return;
  await copyText(collaborationUrl.value);
  toast.success(
    t(
      "operations.collaboratorLinkCopied",
      "Collaborator link copied to clipboard.",
    ),
  );
  showActionsMenu.value = false;
}

async function copyOperatorLink() {
  if (!operatorUrl.value) return;
  await copyText(operatorUrl.value);
  toast.success(
    t("operations.operatorLinkCopied", "Operator link copied to clipboard."),
  );
  showActionsMenu.value = false;
}

async function rotateCollaboratorLink() {
  if (!workspace.share.value.shareSlug || !workspace.share.value.operatorSlug)
    return;
  try {
    const record = await draftStore.rotateCollaboratorLink(
      workspace.share.value.shareSlug,
      operatorMutationOptions(),
    );
    workspace.hydrateDraft(record);
    syncPaymasterStateFromRecord(record);
    await appendActivity(
      createActivityEvent({
        type: "collaborator_link_rotated",
        actor: runtime.collaborationEnabled ? "supabase" : "local",
        detail: t(
          "operations.activityCollaboratorLinkRotated",
          "Collaborator link rotated",
        ),
      }),
    );
    toast.success(
      t(
        "operations.collaboratorLinkRotated",
        "Collaborator link rotated. The previous signer link no longer works.",
      ),
    );
    showActionsMenu.value = false;
  } catch (error) {
    toast.error(translateError(error?.message, t));
  }
}

async function rotateOperatorLink() {
  if (!workspace.share.value.shareSlug || !workspace.share.value.operatorSlug)
    return;
  try {
    const record = await draftStore.rotateOperatorLink(
      workspace.share.value.shareSlug,
      operatorMutationOptions(),
    );
    workspace.hydrateDraft(record);
    syncPaymasterStateFromRecord(record);
    await appendActivity(
      createActivityEvent({
        type: "operator_link_rotated",
        actor: runtime.collaborationEnabled ? "supabase" : "local",
        detail: t(
          "operations.activityOperatorLinkRotated",
          "Operator link rotated",
        ),
      }),
    );
    toast.success(
      t(
        "operations.operatorLinkRotated",
        "Operator link rotated. The previous operator link no longer works.",
      ),
    );
    showActionsMenu.value = false;
  } catch (error) {
    toast.error(translateError(error?.message, t));
  }
}

function exportDraftJson() {
  const json = exportPreview.value;
  const blob = new Blob([json], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `${workspace.share.value.shareSlug || "aa-draft"}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
  toast.success(
    t(
      "operations.draftJsonExported",
      "Draft JSON exported for storage, signature collection, or relay submission.",
    ),
  );
  showActionsMenu.value = false;
}
</script>
