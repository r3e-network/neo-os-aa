import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isBlockedNodeName,
  shouldStripAttribute,
} from "../src/features/docs/rendering.js";
import { MORPHEUS_PUBLIC_REGISTRY } from "../src/config/generatedMorpheusRegistry.js";

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
  // The eight former user-guide topics (HOW_IT_WORKS, QUICK_REFERENCE, WORKFLOWS,
  // the four NATIVE_ACCOUNT_* pages and RECOVERY_AND_SESSIONS) merged into
  // GUIDE.md, and the six former architecture topics (architecture,
  // NATIVE_SYSTEM_ARCHITECTURE, ORGANIZATION, SA-SYSTEM-STATUS, DATA_FLOW,
  // ETHEREUM_AA_COMPARISON) merged into ARCHITECTURE.md (docs role-based
  // reorganization phase 1).
  const guide = readRepo("docs/GUIDE.md");
  const architectureBook = readRepo("docs/ARCHITECTURE.md");
  const smokeTest = readRepo("docs/OPERATIONS.md"); // post-deploy smoke test is a chapter of the operations book
  const readmeZh = readRepo("README.zh-CN.md");

  assert.match(docsIndex, /GUIDE\.md/);
  assert.match(docsIndex, /OPERATIONS\.md/);
  assert.match(docsIndex, /ARCHITECTURE\.md/);
  assert.match(guide, /How It Works|Usage Guide/i);
  assert.match(guide, /Recommended Reading Order|Via SDK/i);
  assert.match(guide, /Workflow|Lifecycle/i);
  assert.match(guide, /Quick Reference/i);
  assert.match(architectureBook, /Data Flow|Storage/i);
  assert.match(smokeTest, /Post-Deploy Smoke Test/i);
  assert.match(smokeTest, /Wallet Detection/i);
  assert.match(readmeZh, /README\.md/);
});

test("the seven process documents merged into two engineering books (docs reorganization phase 2)", () => {
  const docsIndex = readRepo("docs/INDEX.md");
  const verificationBook = readRepo("docs/engineering/VERIFICATION-AND-GATES.md");
  const handoffBook = readRepo("docs/engineering/HANDOFF-RECORDS.md");

  // The index routes engineers to the two books instead of the seven former
  // standalone process documents, and those former files stay gone.
  assert.match(docsIndex, /engineering\/VERIFICATION-AND-GATES\.md/);
  assert.match(docsIndex, /engineering\/HANDOFF-RECORDS\.md/);
  const formerProcessDocs = [
    "SA-CLOSURE-GATE.md",
    "SA-ENTRYPOINT-CLOSURE.md",
    "SA-FORMAL-VERIFICATION.md",
    "SA-MIGRATION-MANIFEST.md",
    "SA-CONTRACT-HANDOFF.md",
    "SA-FRONTEND-CORRESPONDENCE.md",
    "SA-REPRODUCIBLE-BUILD.md",
  ];
  for (const former of formerProcessDocs) {
    assert.ok(!docsIndex.includes(`(${former})`), `INDEX.md still links the deleted ${former}`);
    assert.ok(
      !fs.existsSync(path.join(frontendRoot, "..", "docs", former)),
      `docs/${former} must not come back as a standalone file`,
    );
  }

  // Each book opens with a chapter table of contents and carries the demoted
  // chapter headings of its former documents (heading levels follow the phase-1
  // appendix precedent: the former document title became a ## chapter).
  assert.match(verificationBook, /^## Contents$/m);
  assert.match(verificationBook, /^## SA Formal Verification$/m);
  assert.match(verificationBook, /^## SA contracts: reproducible build from published packages$/m);
  assert.match(verificationBook, /^## Integrated refinement closure gate$/m);
  assert.match(verificationBook, /^## Public entrypoint closure inventory$/m);
  assert.match(verificationBook, /^## SA Migration Manifest — Legacy → Protocol v4 \(Design\)$/m);
  assert.match(handoffBook, /^## Contents$/m);
  assert.match(handoffBook, /^## Contract-internal handoff \(kernel-checked, eighteenth gate scope\)$/m);
  assert.match(handoffBook, /^## SA — Source front end and compiler correspondence$/m);
});

test("docs registry uses the repo README as the overview source of truth", () => {
  const registrySource = read("src/features/docs/registry.js");
  assert.match(registrySource, /@\/assets\/docs\/repo-readme\.md\?raw/);
  assert.match(read("src/assets/docs/repo-readme.md"), /Smart Account|Neo N3/i);
});

test("workflow doc explains the V3 execution path after proxy hardening", () => {
  const workflowDoc = read("src/assets/docs/workflow.md");
  assert.match(workflowDoc, /executeUserOp/);
  assert.match(workflowDoc, /direct proxy-signed external/i);
});

test("sdk doc references the canonical testnet SA core from the generated registry", () => {
  const sdkDoc = read("src/assets/docs/sdk-usage.md");
  // The oracle is the generated Morpheus registry, not a literal copied into this test: the
  // literal this assertion used to pin was the removed V1/V2 core (DS-CU-163 section 4.1 P5).
  const testnetCore = MORPHEUS_PUBLIC_REGISTRY.testnet.contracts.saCore;
  assert.ok(testnetCore, "the generated registry publishes no testnet SA core");
  assert.match(sdkDoc, new RegExp(testnetCore, "i"));
  assert.doesNotMatch(sdkDoc, /0x5be915aea3ce85e4752d522632f0a9520e377aaf/i);
});

test("sdk doc tracks the native helper surface and drops the retired paymaster wrapper", () => {
  const sdkDoc = read("src/assets/docs/sdk-usage.md");

  // v4 sponsorship is not a core feature: the client builds the account-creation and operation
  // envelopes itself, and the v3 paymaster helpers (`getSponsorDeposit`, `querySponsorBalance`,
  // `buildSponsoredExecutionScript`, `executeSponsoredUserOp`, `validatePaymasterOp({...})`) do
  // not exist on the client any more - the native SDK exports none of them.
  assert.match(sdkDoc, /buildCreateAccountScript\(\{/);
  assert.match(sdkDoc, /client\.getAccount\(accountId\)/);
  assert.match(sdkDoc, /buildUserOperationTypedData\(\{/);
  assert.match(sdkDoc, /computeArgsHash/);
  assert.match(sdkDoc, /executeUserOp/);
  assert.doesNotMatch(
    sdkDoc,
    /getSponsorDeposit\(|querySponsorBalance\(|buildSponsoredExecutionScript\(|executeSponsoredUserOp\(|validatePaymasterOp\(/,
  );
});

test("repo docs describe a hardened policy-gated execution surface", () => {
  const readme = readRepo("README.md");
  const architectureDoc = readRepo("docs/ARCHITECTURE.md");

  assert.match(readme, /policy-gated/i);
  assert.match(architectureDoc, /policy-gated/i);
  assert.match(architectureDoc, /executeUnifiedByAddress|executeUnified/);
  assert.doesNotMatch(architectureDoc, /fully programmable logic gates/i);
});

test("production docs describe validation preview, module lifecycle, and relay trust boundaries", () => {
  const readme = readRepo("README.md");
  const frontendArchitecture = read("src/assets/docs/architecture.md");

  assert.match(readme, /validation preview|previewUserOpValidation/i);
  assert.match(readme, /module lifecycle/i);
  assert.match(
    readme,
    /paymaster sponsorship does not replace|relay trust boundary|paymaster does not authorize/i,
  );

  assert.match(frontendArchitecture, /Module Lifecycle/i);
  assert.match(frontendArchitecture, /Validation Preview|relay preflight/i);
  // The removed V1/V2 wrapper must be presented as removed; the deployed-ABI check itself lives in
  // docsTruth.test.js, which reads contracts/build. This assertion only keeps the doc from calling
  // the removed wrapper a supported path (DS-CU-163 section 4.5 T2).
  assert.doesNotMatch(frontendArchitecture, /compatibility-only/i);
  assert.match(frontendArchitecture, /executeUserOp/);
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

  // The workflow page is a generated slice of the GUIDE book's "Smart Account Workflow
  // Lifecycle" chapter, which names the operator surface the home operations workspace.
  assert.match(workflowDoc, /home operations workspace/i);
  assert.match(workflowDoc, /client-side broadcast/i);
  assert.match(workflowDoc, /relay broadcast/i);
  assert.match(workflowDoc, /localStorage|local-only fallback/i);
  assert.match(workflowDoc, /NEP-17 transfer|Multisig Draft|Generic Invoke/i);
  assert.match(workflowDoc, /enter the SA address or derive/i);
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
  assert.match(readme, /SA_RELAY_WIF/i);
  assert.match(readme, /frontend\/\.env\.example/i);
  assert.match(readme, /SUPABASE_SERVICE_ROLE_KEY/i);
  assert.match(readme, /signed operator mutation/i);
  assert.match(readme, /draft-operator/i);
  assert.match(readme, /VITE_SA_EXPLORER_BASE_URL/i);
  assert.match(mixedMultisigDoc, /anonymous share/i);
  assert.match(mixedMultisigDoc, /collaborator link/i);
  assert.match(mixedMultisigDoc, /operator link/i);
  assert.match(mixedMultisigDoc, /rotate collaborator link/i);
  assert.match(mixedMultisigDoc, /read-only/i);
  assert.match(mixedMultisigDoc, /supabase/i);
  assert.match(mixedMultisigDoc, /100 activity entries/i);
  assert.match(mixedMultisigDoc, /12 submission receipts/i);
  assert.match(
    read("src/assets/docs/module-guide.md"),
    /Choose In Layers/i,
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
  assert.match(sdkDoc, /SA_RELAY_ALLOWED_HASH/i);
  assert.match(sdkDoc, /SA_RELAY_ALLOW_RAW_FORWARD/i);
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
  assert.match(sdkDoc, /SA_RELAY_WIF/i);
  assert.match(sdkDoc, /VITE_SA_EXPLORER_BASE_URL/i);
  assert.match(sdkDoc, /relay meta mode|relay invocation mode/i);
  assert.match(sdkDoc, /Minimum Capability Matrix/i);
  assert.match(sdkDoc, /without Supabase/i);
  assert.match(sdkDoc, /without relay/i);
  assert.match(sdkDoc, /without explorer/i);
  assert.match(sdkDoc, /Troubleshooting/i);
  assert.match(sdkDoc, /missing Supabase env/i);
  assert.match(sdkDoc, /SA_RELAY_WIF/i);
  assert.match(sdkDoc, /relay meta mode/i);
  assert.match(sdkDoc, /explorer base url/i);
  assert.match(sdkDoc, /VITE_SA_EXPLORER_BASE_URL/i);
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

test("frontend verifier checks the actual built identity dependency boundary", () => {
  const frontendPackage = readFrontendPackage();
  assert.equal(
    frontendPackage.scripts["test:bundle:browser"],
    "node --test tests/deferredIdentityBundle.browser.mjs",
  );
  assert.match(read("../scripts/verify_repo.sh"), /npm run test:bundle:browser/);
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

  assert.equal(frontendPackage.devDependencies?.vite, "^6.4.4");
  assert.ok(viteEntry);
  assert.match(viteEntry.version, /^6\.4\.[4-9]|^[7-9]\./);
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

test("Neon is a declared server dependency and stays out of browser module imports", () => {
  const packageJson = readFrontendPackage();

  assert.equal(packageJson.dependencies["@cityofzion/neon-core"], undefined);
  assert.equal(packageJson.dependencies["@cityofzion/neon-js"], "5.9.0");
  const lock = JSON.parse(read("package-lock.json"));
  for (const name of ["neon-js", "neon-api", "neon-core"]) {
    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith(`/@cityofzion/${name}`));
    assert.ok(entries.length > 0, `${name} is locked`);
    for (const [, entry] of entries) {
      assert.equal(entry.version, "5.9.0", `${name} stays on the validated release`);
      assert.equal(Boolean(entry.dev), false, `${name} is a production dependency`);
    }
  }
  for (const relativePath of fs.readdirSync(path.join(frontendRoot, "src"), { recursive: true })) {
    if (!/\.(?:js|mjs|ts|vue)$/.test(relativePath)) continue;
    assert.doesNotMatch(read(path.join("src", relativePath)),
      /(?:from\s*|(?:import|require)\s*\(\s*)["']@cityofzion\/neon-(?:js|core)["']/,
      `server-only dependency imported by ${relativePath}`);
  }
});

test("HomeView keeps the first screen focused on SA operation entry", () => {
  const homeViewSource = read("src/views/HomeView.vue");

  assert.match(homeViewSource, /sa-home-focus/);
  assert.match(homeViewSource, /sa-home-step-link/);
  assert.match(homeViewSource, /Deployment reference/);
  assert.match(homeViewSource, /to="\/native" class="btn-primary/);
  assert.doesNotMatch(homeViewSource, /ArchitectureDiagram/);
  assert.doesNotMatch(homeViewSource, /defineAsyncComponent/);
});
