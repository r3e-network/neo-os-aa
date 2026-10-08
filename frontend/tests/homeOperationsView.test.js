import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Some markup/logic from a parent SFC was extracted into colocated child
// components living in a sibling folder named after the parent (e.g.
// `HomeOperationsWorkspace.vue` -> `HomeOperationsWorkspace/*.vue`). This helper
// reads the parent file plus every colocated child so source-text contract
// assertions still check the real current location of the asserted feature.
function readComponentTree(parentVuePath) {
  const sources = [fs.readFileSync(parentVuePath, "utf8")];
  const childDir = parentVuePath.replace(/\.vue$/, "");
  if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
    for (const entry of fs.readdirSync(childDir).sort()) {
      const childPath = path.join(childDir, entry);
      if (fs.statSync(childPath).isFile()) {
        sources.push(fs.readFileSync(childPath, "utf8"));
      }
    }
  }
  return sources.join("\n\n");
}

const homePath = path.resolve("src/views/HomeView.vue");
const workspacePath = path.resolve(
  "src/features/operations/components/HomeOperationsWorkspace.vue",
);
const loadPanelPath = path.resolve(
  "src/features/operations/components/LoadAccountPanel.vue",
);
const composerPath = path.resolve(
  "src/features/operations/components/OperationComposerPanel.vue",
);
const signaturePath = path.resolve(
  "src/features/operations/components/SignatureWorkflowPanel.vue",
);
const broadcastPath = path.resolve(
  "src/features/operations/components/BroadcastOptionsPanel.vue",
);
const sidebarPath = path.resolve(
  "src/features/operations/components/ActivitySidebar.vue",
);
const preflightPanelPath = path.resolve(
  "src/features/operations/components/RelayPreflightPanel.vue",
);
const summaryStripPath = path.resolve(
  "src/features/operations/components/DraftSummaryStrip.vue",
);
const statusBannerPath = path.resolve(
  "src/features/operations/components/DraftStatusBanner.vue",
);
const timelinePath = path.resolve(
  "src/features/operations/components/ActivityTimeline.vue",
);
const activityTimelinePath = path.resolve(
  "src/features/operations/activityTimeline.js",
);
const preferencesPath = path.resolve("src/features/operations/preferences.js");
const presetsPath = path.resolve("src/features/operations/presets.js");
const identityViewPath = path.resolve("src/views/IdentityView.vue");
const routerPath = path.resolve("src/router/index.js");
const didPanelPath = path.resolve(
  "src/features/operations/components/DidIdentityPanel.vue",
);

test("home view is a focus workflow entry with app, market, and deployment reference", () => {
  const homeSource = fs.readFileSync(homePath, "utf8");
  assert.doesNotMatch(homeSource, /HomeOperationsWorkspace/);
  assert.match(homeSource, /Programmable Accounts for Neo N3/);
  assert.match(homeSource, /Open App Workspace/);
  assert.match(homeSource, /Browse Address Market/);
  assert.match(homeSource, /aa-home-focus/);
  assert.match(homeSource, /aa-home-step-link/);
  assert.match(homeSource, /Deployment reference/);
  assert.match(homeSource, /Address Market/);
  assert.match(homeSource, /Paymaster Readiness/);
  assert.match(homeSource, /Open Validation Ledger/);
  assert.match(homeSource, /Open Explorer Tx/);
  assert.match(homeSource, /buildTransactionExplorerUrl/);
  assert.match(homeSource, /paymasterValidation/);
  assert.doesNotMatch(homeSource, /ArchitectureDiagram/);
});

test("operation composer supports live contract suggestions, method dropdowns, and generated parameter fields", () => {
  const composerSource = fs.readFileSync(
    path.resolve(
      "src/features/operations/components/OperationComposerPanel.vue",
    ),
    "utf8",
  );
  const workspaceSource = fs.readFileSync(
    path.resolve(
      "src/features/operations/components/HomeOperationsWorkspace.vue",
    ),
    "utf8",
  );

  assert.match(composerSource, /contractSuggestions/);
  assert.match(composerSource, /methodOptions/);
  assert.match(composerSource, /parameterFields/);
  assert.match(workspaceSource, /targetContract/);
  assert.match(workspaceSource, /resolvedContractHash/);
});

test("home workspace avoids accountId-first state outside creation flow", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");
  const loadPanelSource = fs.readFileSync(loadPanelPath, "utf8");

  assert.doesNotMatch(workspaceSource, /const accountIdHex = ref/);
  assert.doesNotMatch(loadPanelSource, /update:accountIdHex/);
  assert.doesNotMatch(loadPanelSource, /accountIdHex:/);
});

test("operations workspace exposes load, compose, signature, and broadcast sections", () => {
  // Read the DID panel together with its colocated child components; pending
  // state / maintenance markup was extracted into DidIdentityPanel/*.vue.
  const didPanelSource = readComponentTree(didPanelPath);
  assert.match(
    fs.readFileSync(workspacePath, "utf8"),
    /Abstract Account Workspace/,
  );
  assert.doesNotMatch(
    fs.readFileSync(workspacePath, "utf8"),
    /DidIdentityPanel/,
  );
  assert.match(
    fs.readFileSync(workspacePath, "utf8"),
    /Open Identity Workspace/,
  );
  assert.match(fs.readFileSync(workspacePath, "utf8"), /Identity Workspace/);
  assert.match(fs.readFileSync(identityViewPath, "utf8"), /DidIdentityPanel/);
  assert.match(
    fs.readFileSync(identityViewPath, "utf8"),
    /Web3Auth \/ NeoDID Workspace/,
  );
  assert.match(fs.readFileSync(routerPath, "utf8"), /path: 'identity'/);
  assert.match(didPanelSource, /NeoDID \/ Web3Auth/);
  assert.match(didPanelSource, /fetchAccountIdentity/);
  assert.match(didPanelSource, /fetchUnifiedVerifierState/);
  assert.match(didPanelSource, /fetchAccountMaintenanceState/);
  assert.match(didPanelSource, /Refresh Chain State/);
  assert.match(didPanelSource, /Pending Recovery/);
  assert.match(didPanelSource, /Active Private Session/);
  assert.match(didPanelSource, /Pending Account Maintenance/);
  assert.match(didPanelSource, /emit\(["']status["']/);
  assert.match(didPanelSource, /emit\(["']activity["']/);
  assert.match(fs.readFileSync(loadPanelPath, "utf8"), /Load V3 Account/);
  assert.match(fs.readFileSync(composerPath, "utf8"), /Compose Operation/);
  assert.match(fs.readFileSync(presetsPath, "utf8"), /Generic Invoke/);
  assert.match(fs.readFileSync(presetsPath, "utf8"), /NEP-17 Transfer/);
  assert.match(fs.readFileSync(presetsPath, "utf8"), /Multisig Draft/);
  assert.match(fs.readFileSync(signaturePath, "utf8"), /Signature Workflow/);
  assert.match(
    fs.readFileSync(signaturePath, "utf8"),
    /ZK Login - Sign with Morpheus NeoDID/,
  );
  assert.match(fs.readFileSync(broadcastPath, "utf8"), /Broadcast Options/);
  assert.match(fs.readFileSync(broadcastPath, "utf8"), /Best Available/);
  assert.match(fs.readFileSync(broadcastPath, "utf8"), /Signed Raw Tx/);
  assert.match(fs.readFileSync(broadcastPath, "utf8"), /Relay Invocation/);
  assert.match(fs.readFileSync(broadcastPath, "utf8"), /Paymaster/);
  assert.match(fs.readFileSync(broadcastPath, "utf8"), /DApp ID/);
  assert.match(fs.readFileSync(broadcastPath, "utf8"), /Included/);
  assert.match(
    fs.readFileSync(broadcastPath, "utf8"),
    /Open Paymaster Readiness Ledger/,
  );
  assert.match(
    fs.readFileSync(workspacePath, "utf8"),
    /relayCheck\.value\?\.ok === true/,
  );
  assert.match(
    fs.readFileSync(workspacePath, "utf8"),
    /relayCheckMatchesCurrentPayload/,
  );
  assert.match(fs.readFileSync(workspacePath, "utf8"), /Check Relay/);
  assert.match(fs.readFileSync(workspacePath, "utf8"), /Sign with ZK Login/);
  assert.match(fs.readFileSync(sidebarPath, "utf8"), /Relay Readiness/);
  assert.match(fs.readFileSync(sidebarPath, "utf8"), /Recent Activity/);
  assert.match(fs.readFileSync(activityTimelinePath, "utf8"), /All Events/);
  assert.match(fs.readFileSync(activityTimelinePath, "utf8"), /Signatures/);
  assert.match(fs.readFileSync(activityTimelinePath, "utf8"), /Workflow/);
  assert.match(fs.readFileSync(activityTimelinePath, "utf8"), /Relay/);
  assert.match(fs.readFileSync(activityTimelinePath, "utf8"), /Broadcast/);
  assert.match(
    fs.readFileSync(activityTimelinePath, "utf8"),
    /buildActivityPresentation/,
  );
  assert.match(fs.readFileSync(timelinePath, "utf8"), /filterCounts/);
  assert.match(
    fs.readFileSync(activityTimelinePath, "utf8"),
    /buildActivityActions/,
  );
  assert.match(
    fs.readFileSync(activityTimelinePath, "utf8"),
    /buildActivityEmptyState/,
  );
  assert.match(fs.readFileSync(preferencesPath, "utf8"), /relayPayloadMode/);
  assert.match(fs.readFileSync(preferencesPath, "utf8"), /activityFilter/);
  assert.match(fs.readFileSync(timelinePath, "utf8"), /preferenceKey/);
  assert.match(
    fs.readFileSync(timelinePath, "utf8"),
    /buildActivityPresentation\(item\)\.icon/,
  );
  assert.match(fs.readFileSync(timelinePath, "utf8"), /Copied!/);
  assert.match(
    fs.readFileSync(activityTimelinePath, "utf8"),
    /Copy Share Link/,
  );
  assert.match(fs.readFileSync(activityTimelinePath, "utf8"), /Jump to Relay/);
  assert.match(fs.readFileSync(activityTimelinePath, "utf8"), /Copy TxID/);
  assert.match(fs.readFileSync(summaryStripPath, "utf8"), /Draft Overview/);
  assert.match(
    fs.readFileSync(summaryStripPath, "utf8"),
    /buildDraftSummaryItems/,
  );
  assert.match(fs.readFileSync(statusBannerPath, "utf8"), /Latest Draft State/);
  assert.match(
    fs.readFileSync(statusBannerPath, "utf8"),
    /buildDraftStatusBanner/,
  );
  assert.match(
    fs.readFileSync(summaryStripPath, "utf8"),
    /buildDraftSummaryActions/,
  );
  assert.match(fs.readFileSync(summaryStripPath, "utf8"), /Copied!/);
  assert.match(
    fs.readFileSync(
      path.resolve("src/features/operations/draftSummary.js"),
      "utf8",
    ),
    /Copy Account/,
  );
  assert.match(
    fs.readFileSync(
      path.resolve("src/features/operations/draftSummary.js"),
      "utf8",
    ),
    /Copy Share URL/,
  );
  assert.match(fs.readFileSync(workspacePath, "utf8"), /Copy Operator Link/);
  assert.match(
    fs.readFileSync(workspacePath, "utf8"),
    /Rotate Collaborator Link/,
  );
  assert.match(
    fs.readFileSync(path.resolve("src/views/TransactionInfoView.vue"), "utf8"),
    /Copy Operator Link/,
  );
  assert.match(
    fs.readFileSync(path.resolve("src/views/TransactionInfoView.vue"), "utf8"),
    /Rotate Collaborator Link/,
  );
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Relay Preflight/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /VM State/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Gas Consumed/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Stack Preview/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /View Stack/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Decoded Value/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Copy Payload/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Copy Stack/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Export JSON/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /Copied!/);
  assert.match(fs.readFileSync(preflightPanelPath, "utf8"), /copyActionKey/);
});

test("relay preflight state is persisted through draft metadata hooks", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");
  const txViewSource = fs.readFileSync(
    path.resolve("src/views/TransactionInfoView.vue"),
    "utf8",
  );

  assert.match(workspaceSource, /setRelayPreflight/);
  assert.match(workspaceSource, /relayPreflight/);
  assert.match(
    txViewSource,
    /metadata?.relayPreflight|metadata.relayPreflight/,
  );
});

test("shared draft relay submit requires a matching successful preflight", () => {
  const txViewSource = fs.readFileSync(
    path.resolve("src/views/TransactionInfoView.vue"),
    "utf8",
  );

  assert.match(txViewSource, /currentRelayPreflightRequest\s*=\s*computed/);
  assert.match(txViewSource, /buildRelayPreflightRequest\(\{/);
  assert.match(txViewSource, /relayCheckMatchesCurrentPayload\s*=\s*computed/);
  assert.match(
    txViewSource,
    /JSON\.stringify\(currentRelayPreflightRequest\.value\)/,
  );
  assert.match(txViewSource, /JSON\.stringify\(relayCheckRequest\.value\)/);
  assert.match(txViewSource, /relayReadiness\.value\.payloadReady/);
  assert.match(txViewSource, /relayCheck\.value\?\.ok === true/);
  assert.match(txViewSource, /!canRelayBroadcast\s*\|\|/);
  assert.match(txViewSource, /if \(!canRelayBroadcast\.value\)/);
  assert.match(txViewSource, /sharedDraft\.relayPreflightRequired/);
});

test("home workspace appends activity events for signatures relay checks and broadcasts", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");
  const txViewSource = fs.readFileSync(
    path.resolve("src/views/TransactionInfoView.vue"),
    "utf8",
  );

  assert.match(workspaceSource, /appendActivity/);
  assert.match(txViewSource, /metadata?.activity|metadata.activity/);
});

test("timeline actions are wired to parent handlers in workspace and shared draft views", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");
  const txViewSource = fs.readFileSync(
    path.resolve("src/views/TransactionInfoView.vue"),
    "utf8",
  );

  assert.match(workspaceSource, /handleActivityAction/);
  assert.match(txViewSource, /handleActivityAction/);
  assert.match(workspaceSource, /activity-action/);
  assert.match(txViewSource, /activity-action/);
});

test("workspace and shared draft views persist relay payload and timeline preferences", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");
  const txViewSource = fs.readFileSync(
    path.resolve("src/views/TransactionInfoView.vue"),
    "utf8",
  );

  assert.match(workspaceSource, /createOperationsPreferences/);
  assert.match(workspaceSource, /setRelayPayloadMode/);
  assert.match(txViewSource, /createOperationsPreferences/);
  assert.match(txViewSource, /setRelayPayloadMode/);
});

test("home workspace uses the reusable draft summary strip when a draft exists", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");
  const txViewSource = fs.readFileSync(
    path.resolve("src/views/TransactionInfoView.vue"),
    "utf8",
  );

  assert.match(workspaceSource, /DraftSummaryStrip/);
  assert.match(txViewSource, /DraftSummaryStrip/);
});

test("summary strip actions are wired in home and shared draft views", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");
  const txViewSource = fs.readFileSync(
    path.resolve("src/views/TransactionInfoView.vue"),
    "utf8",
  );

  assert.match(workspaceSource, /handleSummaryAction/);
  assert.match(txViewSource, /handleSummaryAction/);
  assert.match(workspaceSource, /summary-action/);
  assert.match(txViewSource, /summary-action/);
});

test("home workspace uses the latest draft state banner", () => {
  const workspaceSource = fs.readFileSync(workspacePath, "utf8");

  assert.match(workspaceSource, /DraftStatusBanner/);
});

test("home workspace surfaces wallet connect, export, broadcast actions, and submission feedback", () => {
  // Submission receipt / history markup was extracted into the colocated
  // HomeOperationsWorkspace/SubmissionReceiptCard.vue child component.
  const workspaceSource = readComponentTree(workspacePath);

  assert.match(workspaceSource, /Connect Neo Wallet/);
  assert.match(workspaceSource, /Connect EVM Wallet/);
  assert.match(workspaceSource, /Export Draft JSON/);
  assert.match(workspaceSource, /Copy Share Link/);
  assert.match(workspaceSource, /Broadcast with Neo Wallet/);
  assert.match(workspaceSource, /Submit via Relay/);
  assert.match(workspaceSource, /Checking Relay…/);
  assert.match(workspaceSource, /Broadcasting…/);
  assert.match(workspaceSource, /Submitting…/);
  assert.match(workspaceSource, /Submission Receipt/);
  assert.match(workspaceSource, /Receipt History/);
});

test("receipt history uses formatted labels instead of raw createdAt fields", () => {
  // Receipt rendering (including the formatted createdLabel) lives in the
  // colocated HomeOperationsWorkspace/SubmissionReceiptCard.vue child component.
  const source = readComponentTree(
    path.resolve(
      "src/features/operations/components/HomeOperationsWorkspace.vue",
    ),
  );
  assert.match(source, /createdLabel/);
});

test("console view exists with service cards linking to workspace, identity, market, and docs", () => {
  const consolePath = path.resolve("src/views/ConsoleView.vue");
  const consoleSource = fs.readFileSync(consolePath, "utf8");
  assert.match(consoleSource, /Console/);
  assert.match(consoleSource, /Account Workspace/);
  assert.match(consoleSource, /Identity & DID/);
  assert.match(consoleSource, /Address Market/);
  assert.match(consoleSource, /Plugins & Hooks/);
  assert.match(consoleSource, /Documentation/);
  assert.match(consoleSource, /Getting Started/);
  assert.match(consoleSource, /\/app/);
  assert.match(consoleSource, /\/identity/);
  assert.match(consoleSource, /\/market/);
  assert.match(consoleSource, /\/docs/);
});

test("router includes console route", () => {
  const routerSource = fs.readFileSync(routerPath, "utf8");
  assert.match(routerSource, /path: 'console'/);
  assert.match(routerSource, /ConsoleView/);
  assert.match(routerSource, /Console — Neo Abstract Account/);
});

test("home view prioritizes focus workflow entry points", () => {
  const homeSource = fs.readFileSync(homePath, "utf8");
  assert.match(homeSource, /aa-home-focus/);
  assert.match(homeSource, /aa-home-step-link/);
  assert.match(homeSource, /to="\/app" class="btn-primary/);
  assert.match(homeSource, /to="\/market" class="btn-secondary/);
  assert.match(homeSource, /Deployment reference/);
  assert.doesNotMatch(homeSource, /to="\/console" class="btn-primary/);
});

test("main layout navigation includes console link with distinct styling", () => {
  const layoutPath = path.resolve("src/components/layout/MainLayout.vue");
  const layoutSource = fs.readFileSync(layoutPath, "utf8");
  assert.match(layoutSource, /\/console/);
  assert.match(layoutSource, /isConsole/);
  assert.match(layoutSource, /nav\.console/);
});
