import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isBlockedNodeName,
  shouldStripAttribute,
} from "../src/features/docs/rendering.js";

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relativePath) =>
  fs.readFileSync(path.join(frontendRoot, relativePath), "utf8");
const readRepo = (relativePath) =>
  fs.readFileSync(path.join(frontendRoot, "..", relativePath), "utf8");
const readFrontendPackage = () => JSON.parse(read("package.json"));

test("isBlockedNodeName blocks executable embedded tags", () => {
  assert.equal(isBlockedNodeName("script"), true);
  assert.equal(isBlockedNodeName("IFRAME"), true);
  assert.equal(isBlockedNodeName("object"), true);
  assert.equal(isBlockedNodeName("div"), false);
});

test("shouldStripAttribute removes inline handlers and javascript urls", () => {
  assert.equal(shouldStripAttribute("onclick", "alert(1)"), true);
  assert.equal(shouldStripAttribute("href", "javascript:alert(1)"), true);
  assert.equal(shouldStripAttribute("src", " JAVASCRIPT:alert(1)"), true);
  assert.equal(shouldStripAttribute("href", "https://example.com"), false);
  assert.equal(shouldStripAttribute("class", "safe-class"), false);
});

test("supplemental root docs are preserved and indexable", () => {
  const docsIndex = readRepo("docs/INDEX.md");
  const howItWorks = readRepo("docs/HOW_IT_WORKS.md");
  const userGuide = readRepo("docs/USER_GUIDE.md");
  const workflows = readRepo("docs/WORKFLOWS.md");
  const dataFlow = readRepo("docs/DATA_FLOW.md");
  const quickReference = readRepo("docs/QUICK_REFERENCE.md");
  const smokeTest = readRepo("docs/POST_DEPLOY_SMOKE_TEST.md");
  const readmeZh = readRepo("README.zh-CN.md");

  assert.match(docsIndex, /HOW_IT_WORKS\.md/);
  assert.match(docsIndex, /POST_DEPLOY_SMOKE_TEST\.md/);
  assert.match(docsIndex, /USER_GUIDE\.md/);
  assert.match(docsIndex, /WORKFLOWS\.md/);
  assert.match(docsIndex, /DATA_FLOW\.md/);
  assert.match(docsIndex, /QUICK_REFERENCE\.md/);
  assert.match(howItWorks, /How It Works|Usage Guide/i);
  assert.match(userGuide, /User Guide/i);
  assert.match(workflows, /Workflow|Lifecycle/i);
  assert.match(dataFlow, /Data Flow|Storage/i);
  assert.match(quickReference, /Quick Reference/i);
  assert.match(smokeTest, /Post-Deploy Smoke Test/i);
  assert.match(smokeTest, /Wallet Detection/i);
  assert.match(readmeZh, /README\.md/);
});

test("docs registry uses the repo README as the overview source of truth", () => {
  const registrySource = read("src/features/docs/registry.js");
  assert.match(registrySource, /@\/assets\/docs\/repo-readme\.md\?raw/);
  assert.match(read("src/assets/docs/repo-readme.md"), /Abstract Account|Neo N3/i);
});

test("workflow doc explains the V3 execution path after proxy hardening", () => {
  const workflowDoc = read("src/assets/docs/workflow.md");
  assert.match(workflowDoc, /executeUserOp/);
  assert.match(workflowDoc, /direct proxy-signed external/i);
});

test("sdk doc references the verified hardened testnet hash", () => {
  const sdkDoc = read("src/assets/docs/sdk-usage.md");
  assert.match(sdkDoc, /0x5be915aea3ce85e4752d522632f0a9520e377aaf/i);
});

test("sdk paymaster docs track the current helper signatures", () => {
  const sdkDoc = read("src/assets/docs/sdk-usage.md");

  assert.match(sdkDoc, /querySponsorBalance\(paymasterHash, sponsorAddress\)/);
  assert.match(sdkDoc, /createSponsoredUserOpPayload\({/);
  assert.match(sdkDoc, /accountScriptHash|accountAddress/);
  assert.match(sdkDoc, /userOp/);
  assert.match(sdkDoc, /paymasterHash/);
  assert.match(sdkDoc, /sponsorAddress/);
  assert.match(sdkDoc, /validatePaymasterOp\({/);
});

test("repo docs describe a hardened policy-gated execution surface", () => {
  const readme = readRepo("README.md");
  const architectureDoc = readRepo("docs/architecture.md");

  assert.match(readme, /policy-gated/i);
  assert.match(architectureDoc, /policy-gated/i);
  assert.match(architectureDoc, /executeUnifiedByAddress|executeUnified/);
  assert.doesNotMatch(architectureDoc, /fully programmable logic gates/i);
});

test("production docs describe validation preview, module lifecycle, and relay trust boundaries", () => {
  const readme = readRepo("README.md");
  const securityAudit = readRepo("docs/SECURITY_AUDIT.md");
  const frontendArchitecture = read("src/assets/docs/architecture.md");

  assert.match(readme, /validation preview|previewUserOpValidation/i);
  assert.match(readme, /module lifecycle/i);
  assert.match(
    readme,
    /paymaster sponsorship does not replace|relay trust boundary|paymaster does not authorize/i,
  );

  assert.match(frontendArchitecture, /Module Lifecycle/i);
  assert.match(frontendArchitecture, /Validation Preview|relay preflight/i);
  assert.match(frontendArchitecture, /compatibility-only/i);

  assert.match(securityAudit, /external third-party review/i);
  assert.match(securityAudit, /property-based|adversarial/i);
});

test("historical architecture and audit docs stay aligned with the professionalized V3 runtime", () => {
  const v3Blueprint = readRepo("docs/AA_V3_ARCHITECTURE.en.md");
  const securityAudit = readRepo("docs/SECURITY_AUDIT.md");

  assert.doesNotMatch(
    v3Blueprint,
    /Ultimate Abstract Account|Ultimate Security Architecture|Ultimate Answer/i,
  );
  assert.doesNotMatch(
    v3Blueprint,
    /killer plugin|panoramic trusted interaction gateway|frictionless cross-chain/i,
  );
  assert.match(v3Blueprint, /historical|design note|current runtime/i);

  assert.doesNotMatch(securityAudit, /contracts\/AbstractAccount\.cs/);
  assert.doesNotMatch(securityAudit, /contracts\/AbstractAccount\./);
  assert.match(securityAudit, /UnifiedSmartWalletV3|current V3 runtime/i);
});

test("repo README keeps a single quickstart heading", () => {
  const readme = readRepo("README.md");
  const matches = readme.match(/^## Quickstart$/gm) || [];

  assert.equal(matches.length, 1);
});

test("repo README includes a quickstart covering install build and test workflows", () => {
  const readme = readRepo("README.md");

  assert.match(readme, /Quickstart/i);
  assert.match(readme, /dotnet test/i);
  assert.match(readme, /npm (ci|install)/i);
  assert.match(readme, /npm run build/i);
});

test("custom verifier docs explain verifier approval does not bypass runtime restrictions", () => {
  const verifierDoc = read("src/assets/docs/custom-verifiers.md");

  assert.match(verifierDoc, /does not bypass/i);
  assert.match(verifierDoc, /whitelist|blacklist|max-transfer|method policy/i);
});

test("core explainer docs provide onboarding architecture workflow and boundary guidance", () => {
  const guideDoc = read("src/assets/docs/guide.md");
  const architectureDoc = read("src/assets/docs/architecture.md");
  const workflowDoc = read("src/assets/docs/workflow.md");
  const dataFlowDoc = read("src/assets/docs/data-flow.md");
  const readme = readRepo("README.md");

  assert.match(guideDoc, /Who This Is For/i);
  assert.match(guideDoc, /Choose the Right Path/i);
  assert.match(guideDoc, /What Happens During One Transaction\?/i);
  assert.match(guideDoc, /Glossary/i);

  assert.match(architectureDoc, /Component Map/i);
  assert.match(architectureDoc, /Verification Pipeline/i);
  assert.match(architectureDoc, /Application Execution Pipeline/i);
  assert.match(architectureDoc, /Contract File Map/i);

  assert.match(workflowDoc, /First Transaction Walkthrough/i);
  assert.match(workflowDoc, /Choose the Submission Path/i);
  assert.match(workflowDoc, /Before You Broadcast/i);

  assert.match(dataFlowDoc, /System Boundaries/i);
  assert.match(dataFlowDoc, /Data Ownership Matrix/i);
  assert.match(dataFlowDoc, /Mutation Authority by Boundary/i);

  assert.match(readme, /Documentation Map/i);
});

test("operations docs cover the app workspace, anonymous drafts, both broadcast modes, and bounded draft retention", () => {
  const workflowDoc = read("src/assets/docs/workflow.md");
  const mixedMultisigDoc = read("src/assets/docs/mixed-multisig.md");
  const sdkDoc = read("src/assets/docs/sdk-usage.md");
  const readme = readRepo("README.md");

  assert.match(workflowDoc, /app workspace/i);
  assert.match(workflowDoc, /client-side broadcast/i);
  assert.match(workflowDoc, /relay broadcast/i);
  assert.match(workflowDoc, /localStorage|local-only fallback/i);
  assert.match(workflowDoc, /NEP-17 transfer|Multisig Draft|Generic Invoke/i);
  assert.match(workflowDoc, /accountId hash|UserOperation/i);
  assert.match(workflowDoc, /100 activity entries/i);
  assert.match(workflowDoc, /12 submission receipts/i);
  assert.match(readme, /100 activity entries/i);
  assert.match(readme, /12 submission receipts/i);
  assert.match(readme, /Deployment Checklist/i);
  // The README documents the migration chain as "apply every file in
  // filename order" instead of enumerating each file; assert the chain
  // boundaries and the mandatory hardening migrations.
  assert.match(readme, /apply every file in `?supabase\/migrations\/`? in filename order/i);
  assert.match(readme, /20260308_home_operations_workspace\.sql/i);
  assert.match(readme, /20260327_security_hardening\.sql/i);
  assert.match(readme, /20260611_draft_metadata_hardening\.sql/i);
  assert.match(readme, /collaborator link/i);
  assert.match(readme, /operator link/i);
  assert.match(readme, /rotate collaborator link/i);
  assert.match(readme, /read-only/i);
  assert.match(readme, /AA_RELAY_WIF/i);
  assert.match(readme, /frontend\/\.env\.example/i);
  assert.match(readme, /SUPABASE_SERVICE_ROLE_KEY/i);
  assert.match(readme, /signed operator mutation/i);
  assert.match(readme, /draft-operator/i);
  assert.match(readme, /VITE_AA_EXPLORER_BASE_URL/i);
  assert.match(mixedMultisigDoc, /anonymous share/i);
  assert.match(mixedMultisigDoc, /collaborator link/i);
  assert.match(mixedMultisigDoc, /operator link/i);
  assert.match(mixedMultisigDoc, /rotate collaborator link/i);
  assert.match(mixedMultisigDoc, /read-only/i);
  assert.match(mixedMultisigDoc, /supabase/i);
  assert.match(mixedMultisigDoc, /100 activity entries/i);
  assert.match(mixedMultisigDoc, /12 submission receipts/i);
  assert.match(
    read("src/assets/docs/hook-plugin-guide.md"),
    /Choose In Layers/i,
  );
  assert.match(
    read("src/assets/docs/address-market.md"),
    /What A Listing Includes/i,
  );
  assert.match(sdkDoc, /VITE_SUPABASE_URL|VITE_SUPABASE_ANON_KEY|relay/i);
  assert.match(sdkDoc, /Runtime Reference/i);
  assert.match(sdkDoc, /Relay Behavior Matrix/i);
  assert.match(sdkDoc, /preflight only/i);
  assert.match(sdkDoc, /signed raw relay/i);
  assert.match(sdkDoc, /meta relay submission|relay invocation/i);
  assert.match(sdkDoc, /Safe Defaults/i);
  assert.match(sdkDoc, /client-side broadcast is the default safe path/i);
  assert.match(sdkDoc, /optional knobs/i);
  assert.match(sdkDoc, /Security Posture/i);
  assert.match(sdkDoc, /safe to expose client-side/i);
  assert.match(sdkDoc, /server-only/i);
  assert.match(sdkDoc, /SUPABASE_SERVICE_ROLE_KEY/i);
  assert.match(sdkDoc, /AA_RELAY_ALLOWED_HASH/i);
  assert.match(sdkDoc, /AA_RELAY_ALLOW_RAW_FORWARD/i);
  assert.match(sdkDoc, /frontend\/\.env\.example/i);
  assert.match(sdkDoc, /draft-operator/i);
  assert.match(sdkDoc, /signed operator mutation/i);
  assert.match(sdkDoc, /Recommended Deployment Profiles/i);
  assert.match(sdkDoc, /local-only/i);
  assert.match(sdkDoc, /collaborative/i);
  assert.match(sdkDoc, /read-only share link/i);
  assert.match(sdkDoc, /collaborator link/i);
  assert.match(sdkDoc, /operator link/i);
  assert.match(sdkDoc, /rotate collaborator link/i);
  assert.match(sdkDoc, /full relay-enabled/i);
  assert.match(sdkDoc, /\.env\.local Examples/i);
  assert.match(sdkDoc, /local-only profile/i);
  assert.match(sdkDoc, /collaborative profile/i);
  assert.match(sdkDoc, /full relay-enabled profile/i);
  assert.match(sdkDoc, /Testnet vs Production Checklist/i);
  assert.match(sdkDoc, /testnet/i);
  assert.match(sdkDoc, /production/i);
  assert.match(sdkDoc, /AA_RELAY_WIF/i);
  assert.match(sdkDoc, /VITE_AA_EXPLORER_BASE_URL/i);
  assert.match(sdkDoc, /relay meta mode|relay invocation mode/i);
  assert.match(sdkDoc, /Minimum Capability Matrix/i);
  assert.match(sdkDoc, /without Supabase/i);
  assert.match(sdkDoc, /without relay/i);
  assert.match(sdkDoc, /without explorer/i);
  assert.match(sdkDoc, /Troubleshooting/i);
  assert.match(sdkDoc, /missing Supabase env/i);
  assert.match(sdkDoc, /AA_RELAY_WIF/i);
  assert.match(sdkDoc, /relay meta mode/i);
  assert.match(sdkDoc, /explorer base url/i);
  assert.match(sdkDoc, /VITE_AA_EXPLORER_BASE_URL/i);
  assert.match(sdkDoc, /100 activity entries/i);
  assert.match(sdkDoc, /12 submission receipts/i);
});

test("DocsView lazy-loads heavy markdown and diagram dependencies", () => {
  const docsViewSource = read("src/views/DocsView.vue");

  assert.match(docsViewSource, /await import\(["']marked["']\)/);
  assert.match(
    docsViewSource,
    /await import\(["']highlight\.js\/lib\/core["']\)/,
  );
  assert.match(
    docsViewSource,
    /await import\(["']highlight\.js\/lib\/languages\/bash["']\)/,
  );
  assert.match(
    docsViewSource,
    /await import\(["']highlight\.js\/lib\/languages\/javascript["']\)/,
  );
  assert.match(
    docsViewSource,
    /await import\(["']highlight\.js\/lib\/languages\/csharp["']\)/,
  );
  assert.match(docsViewSource, /await import\(["']mermaid["']\)/);
  assert.doesNotMatch(docsViewSource, /await import\(["']highlight\.js["']\)/);
  assert.doesNotMatch(docsViewSource, /import mermaid from ["']mermaid["'];/);
  assert.doesNotMatch(docsViewSource, /sanitizeRenderedHtml\(svg\)/);
});

test("DocsView supports deep-linking to a specific doc entry through the query string", () => {
  const docsViewSource = read("src/views/DocsView.vue");

  assert.match(docsViewSource, /useRoute, useRouter/);
  assert.match(docsViewSource, /route\.query\.doc/);
  assert.match(docsViewSource, /router\.replace/);
  assert.match(docsViewSource, /resolveDocKey/);
});

test("vite config defines manual chunk groups for heavy frontend dependencies", () => {
  const viteConfigSource = read("vite.config.js");

  assert.match(viteConfigSource, /manualChunks/);
  assert.match(viteConfigSource, /supabase/);
  assert.match(viteConfigSource, /jose/);
  assert.match(viteConfigSource, /react-runtime/);
  assert.match(viteConfigSource, /identity-runtime/);
  assert.match(viteConfigSource, /walletconnect-runtime/);
  assert.match(viteConfigSource, /@walletconnect/);
  assert.match(viteConfigSource, /@toruslabs/);
  assert.match(viteConfigSource, /deferredIdentityChunks/);
  assert.match(viteConfigSource, /chunkSizeWarningLimit:\s*3500/);
  assert.match(viteConfigSource, /INVALID_ANNOTATION/);
  assert.match(viteConfigSource, /ox\/_esm\/core\/Base64\.js/);
  // ethers, @web3auth, buffer are NOT in manualChunks (circular dep TDZ fix)
  assert.doesNotMatch(viteConfigSource, /return 'ethers'/);
  assert.doesNotMatch(viteConfigSource, /neon-core/);
  assert.doesNotMatch(viteConfigSource, /return 'mermaid'/);
  assert.doesNotMatch(viteConfigSource, /return 'cytoscape'/);
});

test("vite config polyfills browser crypto dependencies pulled by web3auth wallet connectors", () => {
  const viteConfigSource = read("vite.config.js");
  const frontendPackage = readFrontendPackage();

  assert.ok(frontendPackage.devDependencies?.["vite-plugin-node-polyfills"]);
  assert.match(
    viteConfigSource,
    /import { nodePolyfills } from ["']vite-plugin-node-polyfills["'];/,
  );
  assert.match(viteConfigSource, /nodePolyfills\(\{/);
  assert.match(viteConfigSource, /include:\s*\[/);
  assert.match(viteConfigSource, /["']crypto["']/);
  assert.match(viteConfigSource, /["']buffer["']/);
  assert.match(viteConfigSource, /["']process["']/);
});

test("frontend pins a non-vulnerable vite release in both manifest and lockfile", () => {
  const frontendPackage = readFrontendPackage();
  const packageLock = JSON.parse(read("package-lock.json"));
  const viteEntry = packageLock.packages?.["node_modules/vite"];

  assert.equal(frontendPackage.devDependencies?.vite, "^6.4.3");
  assert.ok(viteEntry);
  assert.match(viteEntry.version, /^6\.4\.[3-9]|^[7-9]\./);
});

test("vite config aliases vm to a local browser shim instead of bundling vm-browserify", () => {
  const viteConfigSource = read("vite.config.js");

  assert.match(
    viteConfigSource,
    /vm:\s*fileURLToPath\(new URL\(["']\.\/src\/shims\/vm\.js["'], import\.meta\.url\)\)/,
  );
  assert.doesNotMatch(viteConfigSource, /include:\s*\[[^\]]*["']vm["']/);
  assert.match(read("src/shims/vm.js"), /runInThisContext/);
});

test("studio controller uses local neo helpers instead of Neon SDK bundles", () => {
  const controllerSource = read("src/features/studio/useStudioController.js");

  assert.match(controllerSource, /from '\@\/utils\/neo\.js'/);
  assert.doesNotMatch(
    controllerSource,
    /await import\('@cityofzion\/neon-core'\)/,
  );
  assert.doesNotMatch(
    controllerSource,
    /await import\('@cityofzion\/neon-js'\)/,
  );
});

test("studio account creation derives account id from the registration config", () => {
  const controllerSource = read("src/features/studio/useStudioController.js");
  const panelSource = read(
    "src/features/studio/components/CreateAccountPanel.vue",
  );
  const i18nSource = read("src/i18n/index.js");
  const zhSource = read("src/i18n/zh-CN.js");

  assert.match(controllerSource, /deriveRegistrationAccountIdHash/);
  assert.doesNotMatch(
    controllerSource,
    /deriveAccountIdHash\(createForm\.value\.accountId\)/,
  );
  assert.doesNotMatch(controllerSource, /createForm\.value\.accountId/);
  assert.doesNotMatch(panelSource, /Advanced: Custom Account Seed/);
  assert.doesNotMatch(panelSource, /Account Seed \(UUID\)/);
  assert.doesNotMatch(panelSource, /v-model="createForm\.accountId"/);
  assert.match(panelSource, /min="7"/);
  assert.match(panelSource, /max="90"/);
  assert.match(
    i18nSource,
    /Countdown before escape hatch activates \(7-90 days\)/,
  );
  assert.match(zhSource, /逃生舱激活前的倒计时（7-90 天）/);
});

test("studio governance and permissions panels expect accountId hashes instead of legacy seeds", () => {
  const managePanelSource = read(
    "src/features/studio/components/ManageGovernancePanel.vue",
  );
  const permissionsPanelSource = read(
    "src/features/studio/components/PermissionsLimitsPanel.vue",
  );
  const helpersSource = read("src/features/studio/helpers.js");

  assert.doesNotMatch(
    managePanelSource,
    /Target Account Seed \/ AccountId Hash/,
  );
  assert.doesNotMatch(
    permissionsPanelSource,
    /Target Account Seed \/ AccountId Hash/,
  );
  assert.doesNotMatch(managePanelSource, /20-byte hash160 or raw seed/);
  assert.doesNotMatch(permissionsPanelSource, /20-byte hash160 or raw seed/);
  assert.doesNotMatch(helpersSource, /isEvmWallet/);
  assert.doesNotMatch(
    helpersSource,
    /export function normalizeAccountId\(value, isEvmWallet\)/,
  );
});

test("frontend package does not depend on Neon SDK bundles directly", () => {
  const packageJson = readFrontendPackage();

  assert.equal(packageJson.dependencies["@cityofzion/neon-core"], undefined);
  assert.equal(packageJson.dependencies["@cityofzion/neon-js"], undefined);
});

test("HomeView keeps the first screen focused on AA operation entry", () => {
  const homeViewSource = read("src/views/HomeView.vue");

  assert.match(homeViewSource, /aa-home-focus/);
  assert.match(homeViewSource, /aa-home-step-link/);
  assert.match(homeViewSource, /Deployment reference/);
  assert.match(homeViewSource, /to="\/app" class="btn-primary/);
  assert.doesNotMatch(homeViewSource, /ArchitectureDiagram/);
  assert.doesNotMatch(homeViewSource, /defineAsyncComponent/);
});

test("AbstractAccountTool lazy-loads heavy studio panels", () => {
  const studioToolSource = read("src/components/AbstractAccountTool.vue");

  assert.match(studioToolSource, /defineAsyncComponent/);
  assert.match(
    studioToolSource,
    /import\(["']@\/features\/studio\/components\/CreateAccountPanel\.vue["']\)/,
  );
  assert.match(
    studioToolSource,
    /import\(["']@\/features\/studio\/components\/ContractSourcePanel\.vue["']\)/,
  );
  assert.doesNotMatch(studioToolSource, /import CreateAccountPanel from/);
});

test("AbstractAccountTool keeps wallet-gated tabs out of the keyboard order", () => {
  const studioToolSource = read("src/components/AbstractAccountTool.vue");

  assert.match(
    studioToolSource,
    /:disabled="!studio\.walletConnected\.value"/,
  );
  assert.match(
    studioToolSource,
    /:aria-disabled="!studio\.walletConnected\.value"/,
  );
  assert.match(
    studioToolSource,
    /studio\.walletConnected\.value && studio\.activePanel\.value === tab\.key/,
  );
});

test("AbstractAccountTool does not present paymaster relay as operational before preflight", () => {
  const studioToolSource = read("src/components/AbstractAccountTool.vue");

  assert.match(studioToolSource, /Runtime configuration detected/);
  assert.match(studioToolSource, /Preflight required/);
  assert.match(studioToolSource, /Relay Preflight/);
  assert.doesNotMatch(studioToolSource, /Configured for live AA operations/);
  assert.doesNotMatch(studioToolSource, /validationConfigured["'], "Configured"/);
});
