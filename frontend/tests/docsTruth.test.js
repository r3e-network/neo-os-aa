// Guards the SA documentation against the drift CU-163 measured: documented entrypoints,
// paymaster ABI names, SDK method names, deployment hashes, the VULN-001 state and cited
// receipts. The oracles are machine-readable and live in code or in committed artifacts:
//
//   contracts/build/*.manifest.json          the ABI actually deployed (SHA-256 pinned by
//                                            tests/localchain/expected-deployed.json)
//   sdk/js/src/**                            the SDK that exists
//   frontend/src/config/generatedMorpheusRegistry.js
//                                            the canonical Morpheus anchors, generated from
//                                            neo-os-services (README: it wins on any conflict)
//   tests/localchain/expected-source.json    the pinned deployed NEF path
//   the filesystem                           cited receipts
//
// The documents and the deployed artifacts do not spell an exported member the same way: the
// contracts build compiles with nccs, whose `Helper.GetDisplayName(symbol, lowercase: true)` (called
// by `AbiMethod`'s constructor) lower-cases the first character of every exported member's name, so
// `ClearAccount` in `contracts/**` is `clearAccount` in a manifest. The rule is stated for contract
// authors in neo-os-contracts `contracts/README.md`, section "The deployed spelling of an exported
// member" (branch `ds/cu-212-abi-spelling-docs` of that repository at the time of writing; the
// section is new in CU-212); this guard derives the set it affects (the divergent class below) from
// the manifests and the sources instead of listing names. Section 2 of DS-CU-212-20261009.md records
// the measurement.
//
// A rule must be able to fail, so §7 of DS-CU-163-20261009.md pairs every rule with a document
// mutant and, where the rule reads an artifact, an oracle mutant.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { MORPHEUS_PUBLIC_REGISTRY } from '../src/config/generatedMorpheusRegistry.js';
// The native ABI 2 profile is a separate runtime with its own documents (DS-CU-163 section 2.2
// excludes it from the current-runtime documents), and NativeSmartAccountClient declares the exact
// method set it validates a deployment against. A native callable is live when that artefact names
// it, the same way a deployed manifest makes an N3 callable live (DS-CU-202 section 3).
import {
  NATIVE_ACCOUNT_ADDRESS_ABI,
  NATIVE_REQUIRED_ABI,
} from '../../shared/nativeSmartAccountClient.mjs';

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(frontendRoot, '..');
// Line-ending portability: every pin, digest and boundary regex below measures the bytes a Linux
// CI checkout carries (LF). A Windows checkout with core.autocrlf=true materialises CRLF worktree
// bytes, which flips every sha256 pin and defeats the `(?=\n\n)` boundary check without proving
// anything about the documents. Normalise CRLF/CR to LF at read time - a no-op on an LF checkout -
// so both platforms measure the same content. Binary artifacts (NEF) are read as raw buffers
// elsewhere and bypass this by construction.
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8').replace(/\r\n?/g, '\n');
const exists = (relative) => fs.existsSync(path.join(repoRoot, relative));

// A Chinese counterpart is the SAME document in another language, not an independent one. The guard
// therefore scans it under the class of the document it mirrors: a mirror of a current document is
// held to the current runtime with the same rules, a mirror of a ratcheted document must reproduce
// that document's ledger entry for entry, and a justified fence mention is justified once per
// document rather than once per language. A `.zh-CN.md` file with no source stays an ordinary
// document of its own, so an orphan translation is scanned rather than silently demoted.
const translationSource = (file) => (file.endsWith('.zh-CN.md') ? file.replace(/\.zh-CN\.md$/, '.md') : file);
const docClass = (file) => (file !== translationSource(file) && exists(translationSource(file)) ? translationSource(file) : file);
const isMirrorDoc = (file) => file.endsWith('.md') && docClass(file) !== file;
const mirrorOf = (file) => file.replace(/\.md$/, '.zh-CN.md');

// Documents whose claims must hold for the runtime that ships today. DS-CU-163-20261009.md
// section 5 lists them and records why the rest of the V2-era documents are debt instead.
const CURRENT_DOCS = [
  'README.md',
  'frontend/src/assets/docs/repo-readme.md',
  'frontend/src/assets/docs/sdk-usage.md',
  'frontend/src/assets/docs/evm-integration.md',
  'frontend/src/assets/docs/mixed-multisig.md',
  'frontend/src/assets/docs/architecture.md',
  // The plugin developer guide merged into docs/SA-MODULE-PROTOCOL.md as its
  // "Appendix: Module developer guide". The module protocol book keeps its ratchet
  // class (its V2_DEBT entry still records the CallHook/CallVerifier removal
  // spellings), and current-class and ratchet-class are mutually exclusive here,
  // so the appendix is read by the fence and ratchet scans like the rest of the
  // book; every name the guide carried is live, so the merge added no debt.
  // Current protocol and refinement documents introduced with the
  // SmartAccount rename. They describe the source ABI directly, so the
  // historical V2 dead-name ratchet must not classify their reviewed terms as
  // legacy deployment debt.
  //
  // The docs reorganization phase 2 merged the three current-class process
  // documents with the source-bridge scope into one book,
  // docs/engineering/HANDOFF-RECORDS.md (the former SA-CONTRACT-HANDOFF and
  // SA-FRONTEND-CORRESPONDENCE chapters; their "Pinned inputs" scope declaration
  // moved with them verbatim). The class follows the book: the same source-only
  // names stay readable through the source-bridge allowance below.
  'docs/engineering/HANDOFF-RECORDS.md',
];

// The custom delivery track has two additive reads in source that are deliberately not copied
// into contracts/build until a release/deployment review publishes the new artifact. The topic
// that carried them (PENDING_CONFIG_UPDATE_READ_ABI.md) merged into docs/SDK.md, which the fence
// and ratchet scans read (it is not a current-class document), so the boundary the caveat used to
// enforce here is now recorded as the two `entrypoint:` ledger entries below: the reads stay
// disclosed, and the document still carries the source-versus-deployment sentence verbatim. Keep
// the map file-scoped and caveat-scoped: it is an explicit source-versus-deployment boundary,
// not a general exemption for undocumented or unshipped entrypoints.
const SOURCE_ONLY_CUSTOM_READS = new Map([
  ['docs/SDK.md', {
    names: new Set(['getPendingVerifierUpdate', 'getPendingHookUpdate']),
    caveat: /newly compiled source|Existing deployments|not evidence of a deployed upgrade/i,
  }],
]);

// Current protocol and refinement documents can describe three different namespaces in one file:
// ABI members of the public artifact, symbols in the current C# source, and members of the pinned
// Neo Core/VM source that are not contracts in this repository. Treating every one as a deployed
// ABI claim produced false drift in both directions: it rejected reviewed C# source spelling while
// also skipping the rest of the current-runtime checks. This explicit document class keeps those
// checks on, but resolves a name against the correct source:
//
//   * a source-only name must be defined in contracts/**;
//   * an external runtime name must be one of the exact, reviewed symbols below;
//   * any other name still fails the current-runtime scan.
//
// The class is not a suppression list. Every entry names a current document and a visible pinned-
// source scope, and the source/external sets are derived or exact rather than inferred from shape.
const SOURCE_BRIDGE_DOCS = new Map([
  // Phase 2 of the docs reorganization merged the three source-bridge documents
  // into docs/engineering/HANDOFF-RECORDS.md (SA-CONTRACT-HANDOFF and
  // SA-FRONTEND-CORRESPONDENCE) and docs/engineering/VERIFICATION-AND-GATES.md
  // (SA-ENTRYPOINT-CLOSURE, beside the former SA-FORMAL-VERIFICATION,
  // SA-REPRODUCIBLE-BUILD, SA-CLOSURE-GATE and SA-MIGRATION-MANIFEST records).
  // VERIFICATION-AND-GATES.md cites dozens of receipts that were never part of
  // this checkout (a citation names the record, not a file you can open here),
  // so it cannot join the current class, whose cited-receipt rule reads every
  // `docs/...` code span; its former source-bridge chapter is scanned by the
  // fence and ratchet rules like the rest of the book instead.
  ['docs/engineering/HANDOFF-RECORDS.md', {
    reason: 'Projects the pinned Neo Core contract-handoff path and records the current SA source implementation boundary beside its ABI consequences, and records source-to-artifact correspondence across the current SA tree, the pinned compiler, Neo Core and Neo VM, including private source members and runtime APIs.',
    marker: /\bPinned inputs \(neo\b|\bpinned (?:C#|artifact|source|sources|Neo|VM)\b/i,
  }],
]);

// Exact external symbols reviewed in the pinned Neo Core/VM source. They are not imported as a
// broad framework vocabulary: a source-bridge document still cannot mention a new runtime method
// until this map and its rationale are reviewed. Fields and locals are included because the formal
// projections read them directly; they are never contracts in this repository.
const PINNED_RUNTIME_SYMBOLS = new Map([
  ['CallFromNativeContractAsync', 'ApplicationEngine native-contract call used by the pinned contract-handoff projection.'],
  ['HasReturnValue', 'MethodToken field consumed by the pinned CALLT admission path.'],
  ['executeNext', 'ApplicationEngine instruction loop projected by the exception-identity lane.'],
  ['hasReturnValue', 'Pinned contract-handoff local derived from the selected ABI descriptor.'],
]);

// The snapshot-audit document class, which held a dated audit and its rendered copy (its method
// names are the ones that existed when it was written, so it is not held to the current ABI, but
// its VULN-001 status still had to agree with the deployed artifact). DS-CU-163 section 4.3 V3.
//
// The class is empty: both members were the March 11, 2026 audit, deleted in the 2026-11 docs
// cleanup. The surviving protocol audit is a current document and is scanned as one.
const NO_SNAPSHOT_AUDIT_DOCS = [];

// The native ABI 2 profile is a separate runtime with its own documents (DS-CU-163 section 2.2),
// and NativeSmartAccountClient declares the exact method set it validates a deployment against.
// Only these documents are read against that artefact; a name that merely coincides with a native
// method (callVerifierChild was also defined in the since-deleted SmartAccount.VerifierChildren.cs
// and absent from the deployed manifest) is still judged by the deployed ABI everywhere else.
const NATIVE_PROFILE_DOCS = ['docs/SDK.md', 'docs/GUIDE.md'];
const nativeAbiNames = new Set([
  ...Object.keys(NATIVE_REQUIRED_ABI),
  ...Object.keys(NATIVE_ACCOUNT_ADDRESS_ABI),
]);
const NO_NAMES = new Set();

// Documents that still name something the deployed runtime does not carry. The list is a ratchet: it
// records the exact names each document may still mention and fails when one grows (new drift) or
// shrinks (the document was corrected and the entry must be dropped). DS-CU-202 worked the list down
// from 31 files / 109 names to the entries below; every remaining entry carries a reason it must stay
// (row CU-202 acceptance), and an entry that also carries a `marker` is only accepted while the
// document itself still says so - the marker is a scope declaration, not a behaviour oracle.
//
// A `spelling:` entry reads `<written>-><deployed>`: the document writes a spelling that differs from
// the one the manifest exports, which is a false claim about the deployed artifact even when the C#
// source defines the written spelling (DS-CU-211, DEC-DS-5). CU-202 recorded these entries in a
// `case:` bucket that described only the letter that differed; CU-211 renamed the bucket to say what
// they are, and CU-212 widened the vocabulary so the entries the shape rule could not read at all
// are visible. The docs cleanup deleted the 2026-03-29 audit snapshot
// (docs/SECURITY_AUDIT_RESULTS.md), the 2026-10-08 dependency record and both copies of the
// March 11, 2026 audit, so their 50 entries left the ledger with them. Rewriting the rendered custom
// module guide in v4 terms removed the last entry that described a verifier binding (`Admin`). The
// docs reorganization merged the SDK topics into one book, so the two source-only custom reads the
// current-class exemption used to carry are now scanned by the ratchet and recorded below; 5
// entries remain (3 `spelling:`, 2 `entrypoint:`) across 3 files, each already justified by the
// reason its document carries.
const V2_DEBT = {
  // The former user-guide topics (HOW_IT_WORKS, QUICK_REFERENCE, WORKFLOWS,
  // NATIVE_ACCOUNT_WORKSPACE, NATIVE_ACCOUNT_TRANSACTION_GUARDS,
  // NATIVE_ACCOUNT_THRESHOLD_RECOVERY, NATIVE_SIGNED_TRANSACTION_IMPORT and
  // RECOVERY_AND_SESSIONS) were merged into GUIDE.md; the ClearAccount spelling
  // debt sentences moved with them verbatim.
  'docs/GUIDE.md': {
    names: ['spelling:ClearAccount->clearAccount'],
    reason: 'The sentences analyse how the recovery modules clean up (MultiSigVerifier.ClearAccount, MultiHook.ClearAccount) and qualify the name with a C# class that no manifest exports; the deployed ABI of those modules spells it clearAccount, so the name is the C# spelling of an exported member and stays recorded (DS-CU-212 section 4, verdict SOUND, recorded).',
  },
  'docs/SA-MODULE-PROTOCOL.md': {
    names: ['spelling:CallHook->callHook', 'spelling:CallVerifier->callVerifier'],
    reason: 'The sentence records that the v3 callVerifier/callHook surfaces are removed without aliases in both kernels: naming those spellings is what the removal statement is about, and both are the C# spelling of members the pinned v3 manifest exports as callVerifier/callHook, so the entry says what the artifact spelled and stays recorded (DS-CU-211, DEC-DS-5).',
  },
  // The pending-config-update read ABI topic merged into docs/SDK.md (chapter "Pending
  // configuration update reads"); the boundary sentence moved with it verbatim.
  'docs/SDK.md': {
    names: ['entrypoint:getPendingHookUpdate', 'entrypoint:getPendingVerifierUpdate'],
    reason: 'The two reads are defined in the custom track\'s source but no deployed manifest exports them: the chapter states that boundary itself (newly compiled source, existing deployments keep the older reads, contracts/bin/public is not evidence of a deployed upgrade), so the names are real source members the artifact does not carry yet and stay recorded.',
  },
};

// Framework and service calls that share a name with a contract method but are not one.
// ContractManagement is the Neo native contract: the retired custom kernel's
// SmartAccount.Accounts.cs:404 calls
// ContractManagement.GetContract and tests/SmartAccount.Contracts.Tests/*.cs invoke the native
// "getContract" by string, so a document that reads a NEF back that way names no SA entrypoint.
// CallFlags is the SmartContract.Framework enum used as the third argument of Contract.Call; it is a
// type, not an entrypoint, and naming it here is what keeps the scan's vocabulary from being widened
// entry by entry (DS-CU-210 section 3).
const FRAMEWORK_RECEIVERS = new Set(['Runtime', 'Contract', 'ContractManagement', 'System', 'CryptoLib', 'Storage', 'Helper', 'ExecutionEngine', 'Neo', 'CallFlags']);
// Inline code that looks like an entrypoint but is a parameter, a field or a service name.
// callHash is a field of the pending-module-call record (SmartAccount.Models.cs:65 of the
// retired custom kernel), not a callable; DS-CU-202 section 4.
// getAuthorityEpoch is an ABI 2 read on the pinned private native core (the sibling native-core
// track), named by the module packager's permission check: it is the one name the native modules are
// required to be able to call on that core, so it is neither a member nor a dead reference of this
// repository's deployed manifests.
const NON_CALLABLES = new Set(['create_sa_draft', 'claimCommitment', 'callData', 'signMessage', 'getPending', 'callHash', 'getAuthorityEpoch']);

const ENTRYPOINT = /^(?:execute|register|preview|initiate|finalize|settle|update|cancel|confirm|propose|compute|get|set|is|has|can|withdraw|revoke|rotate|claim|deposit|call|lock|unlock|create|build|derive|validate|query|prepare|sign|broadcast|discover)[A-Z][A-Za-z0-9]*$/;
// A line that marks a name as gone. The repository's translation copies state removal in Chinese,
// so the marker vocabulary is not English-only; "旧版" (legacy) deliberately does NOT mark a
// removal, because "legacy X is compatibility-only" was itself the false claim (DS-CU-163 B2).
// The Chinese forms mirror the English ones the vocabulary already carries - `absent` / `does not
// exist` are `不存在`, `not part of` is `不属于` - so the same sentence is judged the same way in
// either language instead of the translation having to invent a stronger word than its source.
const REMOVED = /remov|superseded|no longer|not part|does not exist|never existed|absent|retired|deleted|dropped|gone|were never|移除|删除|弃用|废弃|不再|不存在|不属于/i;

const deployedAbi = new Map(); // exact ABI name -> the manifest that carries it
for (const file of fs.readdirSync(path.join(repoRoot, 'contracts/build'))) {
  if (!file.endsWith('.manifest.json')) continue;
  const manifest = JSON.parse(read(path.join('contracts/build', file)));
  for (const method of manifest.abi.methods) deployedAbi.set(method.name, file);
  for (const event of manifest.abi.events ?? []) deployedAbi.set(event.name, file);
}
const deployedAbiLower = new Map([...deployedAbi.keys()].map((name) => [name.toLowerCase(), name]));
// The deployed spelling of a name that differs from the one a document wrote, or undefined when no
// manifest exports the name at all. The map is case-insensitive on purpose: it is how the guard
// FINDS a spelling mismatch, and the rules below are what decide whether such a name is live
// (DS-CU-211). No lowercase key maps to two different exact spellings in this repository.
const deployedSpelling = (name) => deployedAbiLower.get(name.toLowerCase());

// Every name the repository defines or calls somewhere in code. A documented name that is absent
// from both this set and the deployed ABI is dead unless the sentence marks it removed. Strings and
// comments do not count: `'executeUnifiedByAddress'` in an allowlist is a string, not a definition.
const definedNames = new Set(deployedAbi.keys());
const tracked = [];
const SKIP_DIRS = new Set(['node_modules', '.git', 'obj', 'bin', 'dist', 'coverage', 'test-results', '.next', '.codegraph', '.turbo', '.vercel', 'tmp']);
// Generated by the isolated NuGet restore (gitignored, see .gitignore "Isolated NuGet restore
// cache"). It appears on any machine that has compiled contracts and carries package readmes
// whose fenced C# is not a claim about this repository's runtime. The directory is named by
// whoever runs the restore (README: -p:RestorePackagesPath=./nuget-isolated; later lanes used
// ./nuget-isolated1 and ./nuget-isolated-v), so the class is matched by its prefix and not by a
// list of the lanes seen so far: the list missed nuget-isolated-v and let third-party package
// readmes into the ratchets below. Only a directory matches; no tracked path carries the prefix.
const ISOLATED_NUGET_CACHE = /^nuget-isolated/;
// `docs/_merged-zh-CN.md` is the scratch file the retired `docs/_build_pdf.mjs` wrote when it
// concatenated the Chinese documents to render the PDF (the 2026-11 docs cleanup removed the
// script; the authoritative PDF is the manuscript build outside this tree). The scratch file
// can still survive in a work tree from before the removal. It is a concatenation of documents
// already scanned below, not a document of its own: scanning it would report every claim a
// second time under a path no reviewer opens, and its assertions would be keyed by file position
// in a merge this guard cannot predict.
const PDF_MERGE_SCRATCH = '_merged-zh-CN.md';
const skipped = (entry) => SKIP_DIRS.has(entry.name) || entry.name === PDF_MERGE_SCRATCH
  || (entry.isDirectory() && ISOLATED_NUGET_CACHE.test(entry.name));
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    if (skipped(entry) || (entry.name.startsWith('.') && entry.name !== '.')) continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(relative);
    // Path-portability: the ratchet below keys and filters these paths with '/'-separated
    // literals ('contracts/', CURRENT_DOCS, R3_FILE, V2_FENCE_MENTIONS). On a Windows checkout
    // path.join yields '\'-separated paths, which silently defeats every one of those filters
    // (sourceDefinitions and sdkMethods empty, test drivers leaking into definedNames, fence
    // claims keyed under a separator no assertion looks up). Normalize to the git-style '/'
    // spelling so the walk yields the same paths on both platforms.
    else tracked.push(relative.split(path.sep).join('/'));
  }
})('.');
const MOCK_CONTRACTS = 'tests/mocks/';
for (const file of tracked) {
  if (!/\.(cs|js|mjs|ts|py|sql|json)$/.test(file)) continue;
  // Test drivers are not the product surface, and docs are prose about it. The mock contracts in
  // tests/mocks are the exception: compile.sh builds them like any other contract.
  if (file.startsWith('docs/') || file.startsWith('frontend/tests/') || (file.startsWith('tests/') && !file.startsWith(MOCK_CONTRACTS)) || file.startsWith('sdk/js/tests/')) continue;
  const text = read(file);
  // A call is a call whether or not it is optional-chained: frontend/src/features/native/
  // nativeWorkspace.js calls `provider.getNetworks?.()`.
  for (const match of text.matchAll(/([A-Za-z_]\w*)\s*\??\.?\s*\(/g)) definedNames.add(match[1]);
  for (const match of text.matchAll(/DisplayName\("([^"]+)"\)/g)) definedNames.add(match[1]);
  // A module configure command is a name a plugin compares against a string, not a callable: the
  // plugin SDK's `configData` carries `["setMemberKey", publicKey]` and the validator asserts the
  // literal before dispatching, so the command is part of the module model a document may name.
  // Reading it from the comparison that implements it keeps the vocabulary derived rather than
  // listed (the same rule the contract ABI names follow).
  if (file.endsWith('.cs')) {
    for (const match of text.matchAll(/(?:ModuleConfig\.Command\([^)]*\)|\bcommand)\s*==\s*"([A-Za-z_]\w*)"/g)) {
      definedNames.add(match[1]);
    }
  }
  // A contract may only call what its permissions name, and the pinned native authority calls the
  // service by string (contracts/plugins/native-profile/NativeAuthority.cs). Both spellings are live names, and the
  // scanner above cannot see them because the method is a string literal, not a call.
  for (const line of text.split('\n')) {
    if (!/ContractPermission|Contract\.Call/.test(line)) continue;
    for (const match of line.matchAll(/"([A-Za-z_]\w*)"/g)) definedNames.add(match[1]);
  }
}

// C# method definitions in the contract sources, by their exact spelling. The compiler lower-cases
// the first letter of an exported member, so most of these are members the manifests spell
// differently; the set exists so the liveness rule below can say WHICH artifact makes a name live
// (DS-CU-211, DEC-DS-5) instead of inferring it from the shape of the name.
const sourceDefinitions = new Set();
for (const file of tracked) {
  if (!(file.startsWith('contracts/') || file.startsWith(MOCK_CONTRACTS)) || !file.endsWith('.cs')) continue;
  // contracts/native is the consensus-native service: the node's compiler builds it, not nccs, so
  // it exports nothing under the spelling rule below and its members are not manifest names.
  if (file.startsWith('contracts/native/')) continue;
  for (const match of read(file).matchAll(/^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\(/gm)) {
    sourceDefinitions.add(match[1]);
  }
}

// The spelling the compiler exports a C# member under, from the build's own rule and not from a
// list: nccs lower-cases the first character of the name (`_deploy` keeps its underscore and
// lower-cases the second). See the rule stated in neo-os-contracts `contracts/README.md`, section
// "The deployed spelling of an exported member", and in the compiler's Helper.GetDisplayName,
// which AbiMethod calls with lowercase: true.
const deployedSpellingOfSource = (name) => (name.startsWith('_')
  ? `_${name.slice(1, 2).toLowerCase()}${name.slice(2)}`
  : `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`);
const currentContractSourceNames = new Set();
for (const name of sourceDefinitions) {
  currentContractSourceNames.add(name);
  currentContractSourceNames.add(deployedSpellingOfSource(name));
}

// A source-bridge document may name a current contract-source identity or one exact pinned runtime
// symbol. It does not turn arbitrary current source into public ABI, and it does not apply outside
// the documents that declare the pinned-source scope.
function isSourceBridgeName(file, name) {
  return SOURCE_BRIDGE_DOCS.has(file)
    && (currentContractSourceNames.has(name) || PINNED_RUNTIME_SYMBOLS.has(name));
}

// THE DIVERGENT CLASS (DS-CU-212, DEC-DS-6): every C# definition the compiler exports under a
// DIFFERENT spelling than the source writes. This is the set of names the `ENTRYPOINT` prefix list
// below could not read, and it is derived from the manifests and the sources rather than listed,
// because the class is what the renaming rule produces: 191 members at this base, and it moves when
// a contract exports or loses a member. A name that merely looks capitalised is not in it, and neither is
// a C# definition no manifest exports (DEC-DS-5 rule 2: that one is live as source).
const divergentSpellings = new Set([...sourceDefinitions].filter((name) => {
  const deployed = deployedSpelling(name);
  return deployedAbi.has(deployed) && !deployedAbi.has(name);
}));
// A source definition the compiler exports under the SAME spelling (only `_deploy` in this
// repository) is not divergent; the set above would not carry it, and it needs no widening because
// `deployedAbi` already holds its exact spelling.
const exportedInSourceSpelling = new Set([...sourceDefinitions].filter((name) => deployedAbi.has(name)));

// The v4 configuration action codes. An intent's action is an Array whose first element is an
// integer code, and the core spells each code once, as an `Action<Name>` constant
// (contracts/native/SmartAccount/SmartAccountModuleProtocol.cs). A document names an action by the
// camelCase form of that constant - `setThresholdPolicy`, `installModule` - and no manifest exports
// it, because an action is a wire value inside `proposeConfiguration`, not an ABI member. The set is
// derived from the constants for the same reason the divergent class is derived from the manifests:
// a new action becomes readable the moment the core defines it, and no document can invent one.
const actionNames = new Set();
for (const file of tracked) {
  if (!file.startsWith('contracts/native/') || !file.endsWith('.cs')) continue;
  for (const match of read(file).matchAll(/const int Action([A-Z]\w*)\s*=/g)) {
    actionNames.add(match[1][0].toLowerCase() + match[1].slice(1));
  }
}

// The SDK surface: class methods plus the methods that unconditionally report a V3 removal. The
// native client lives in shared/nativeSmartAccountClient.mjs and is re-exported by sdk/js/src.
const sdkMethods = new Set();
const legacySdkMethods = new Set();
for (const file of tracked) {
  if (!/\.(js|mjs)$/.test(file)) continue;
  if (!file.startsWith('sdk/js/src/') && !file.startsWith('shared/')) continue;
  const text = read(file);
  for (const match of text.matchAll(/^\s*(?:async\s+)?(?:static\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm)) sdkMethods.add(match[1]);
  // A client factory returns the SDK surface as an object literal: sdk/js/src/multisig.js:24-33
  // exposes buildBundle, buildChildConfiguration, buildChildTypedData and the rest as `name: value`
  // keys, so a documented call to one of them is a real SDK method. The scan is limited to sdk/js/src
  // because the native client's descriptor table (NATIVE_REQUIRED_ABI) has the same key shape.
  if (file.startsWith('sdk/js/src/')) {
    for (const match of text.matchAll(/^\s{2,}([A-Za-z_]\w*):\s*(?:async\s*)?(?=\(|tools\.|[A-Za-z_]\w*\()/gm)) sdkMethods.add(match[1]);
  }
  for (const match of text.matchAll(/^\s*(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{([\s\S]*?)\n  \}/gm)) {
    if (/LEGACY_V3_REMOVED/.test(match[2])) legacySdkMethods.add(match[1]);
  }
}

// VULN-001 (verifier gas DoS) closes only behind a per-callback gas bound. The platform no
// longer carries any such capability: a transaction's declared system fee is the only gas limit,
// so no build of this repository can bound one callback on its own. The VULN-001 guards below used
// to derive that state from a bounded-call site in the deployed NEF; it is now a property of the
// platform, read from nothing and therefore constant.
const VULN_001_OPEN_REASON = 'no build bounds a callback\'s gas: the declared system fee is the only gas limit';
const canonicalHashes = new Set();
(function collect(value) {
  if (typeof value === 'string') canonicalHashes.add(value.toLowerCase());
  else if (value && typeof value === 'object') for (const child of Object.values(value)) collect(child);
})(MORPHEUS_PUBLIC_REGISTRY);

// MEASUREMENT BOUNDARY. The patterns below and in the ratchet read INLINE-CODE SPANS only: a call
// inside `backticks` is a name reference, and the same call written as raw code inside a fenced block
// is not. That is how docs/TRANSACTION_FLOW.md and docs/TRANSACTION_LAYOUTS.md carried 33 dead names
// past this ratchet until CU-202 deleted them (DS-CU-202-20261009.md finding F3, re-filed as
// RV-DSCU202R1-r1 minor), so wherever the fenced measurement is absent this count is a FLOOR, not
// the repository's drift. Row CU-210 owns that measurement and separates a fenced claim from a
// fenced mention (DS-CU-210-20261009.md); it reads fences, it does not widen this reader. The test
// "CU-202: the ratchet reads inline-code spans and declares the boundary it does not cross" holds
// both halves of this note, and holds this note itself: delete it and that test fails.

function codeSpans(line) {
  const spans = [];
  for (const match of line.matchAll(/`([^`]+)`/g)) spans.push(match[1].trim());
  return spans;
}

// The shape vocabulary: what the `ENTRYPOINT` prefix list reads. It is the base's rule and it stays,
// because it is also what keeps a diagram label or an English word in a code span from being read as
// a callable (DS-CU-212, DEC-DS-6 rule 5).
function shapedLikeEntrypoint(name) {
  return ENTRYPOINT.test(name[0].toLowerCase() + name.slice(1));
}

// THE WIDENED VOCABULARY (DS-CU-212): a name is one the guard reads as a callable when the shape
// vocabulary reads it, or when the compiler exports it under a different spelling than the source
// writes (the divergent class). The union keeps every name the base read, so no recorded entry can
// be dropped by the widening.
//
// ---------------------------------------------------------------------------------------------
// CU-210 R2, after the r1 NO-GO. The union above is still not the whole vocabulary a fenced call
// can be written in, and the gap was invisible because a name the vocabulary cannot read is not
// reported and not recorded - it is simply gone:
//
//   * `collectChildProofs(context, operation)` and `childSigns()` in the fenced JavaScript
//     example of docs/SDK.md (the merged threshold-session chapter, formerly docs/MULTISIG_SDK.md)
//     name nothing the repository contains (no `.cs`, `.js`,
//     `.mjs`, `.ts` or `.py` file defines or calls either one; the example's real calls are
//     `multisig.fetchContext`, `multisig.prepareOperation` and `multisig.validateBundle`);
//   * neither is read by the shape rule, because the shape rule needs a capital after the
//     prefix (`deposit` + `A`), and the build lower-cases an exported member's first letter -
//     so the canonical spelling of every exported member is exactly the class the shape rule
//     drops. `transfer` and `forward` are deployed ABI members this oracle never looked at.
//
// The widening has two halves, both read as RULES rather than as lists of names:
//
//   1. the build's own naming rule: a lowercase-initial, capital-bearing (camelCase) identifier is
//      the spelling `Helper.GetDisplayName` produces for an exported member (DS-CU-212, DEC-DS-6);
//   2. the artefacts' own vocabulary: a name a pinned manifest exports is readable in that exact
//      spelling, whatever its shape - 58 of the 246 ABI names are neither shape-readable nor
//      camelCase (`transfer`, `forward`, `admin`, `update`, `verify`, `register`, `rotate` and the
//      45 capital-initial event names), and the shape rule dropped every one of them before the
//      liveness rule could see it. That is the class the review's mutant landed in: it planted
//      `transfer()` in a fenced diagram, `transfer` is exported by MockTransferTarget.manifest.json,
//      and the mutant survived for a reason the review's note did not state.
//
// Reading a name is not reporting it: `isLiveName` still decides, so both halves report nothing by
// themselves. The wrapper exists so the kill controls can switch the widening OFF and show the
// planted drifts surviving. A rule that cannot be removed cannot be shown to be the thing doing the
// work.
const widenVocabulary = { enabled: true };
const LOWER_CAMEL = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/;
function isReadableName(name) {
  return isCallableName(name)
    || (widenVocabulary.enabled && (LOWER_CAMEL.test(name) || deployedAbi.has(name)));
}
function isCallableName(name) {
  return shapedLikeEntrypoint(name) || divergentSpellings.has(name);
}

// The names a single code span contributes. A span is a CALL when it is a dotted identifier with one
// parenthesised argument list: its head (up to the first `(`) is the name and its arguments are not
// names. A span is a single NAME when it has no whitespace and no parentheses -
// `MultiSigVerifier.ClearAccount`, `VerifyAdmin`. A span is a name LIST only when its words are
// separated by a comma, semicolon or slash, which is how `createListing, updateListingPrice` and
// `VerifyAdmin, ClearAccount` are written. Anything else is PROSE and contributes nothing:
// `Transfer amount exceeds subscription` (a fault message quoted in prose) names no callable even
// though its first word is a member of the class, and a span that is only `Transfer(` is a
// fragment, not a name.
//
// The base rule split every span on whitespace, which is why it read the first word of a sentence as
// a name whenever the shape vocabulary happened to match it, and why a call whose parentheses were
// split across two spans lost its argument list. DS-CU-212 section 4 records both.
//
// SENTENCE PUNCTUATION IS NOT PART OF THE NAME (CU-212 R2, after RV-DSCU212R1-r1). The rule above
// first read the call form as "the last character of the span is `)`", and the last character is not
// the property that decides what a span is: the base tokenizer discarded everything from the first
// `(` to the end of the span, so `InitiateEscape(accountId);` - the form a sentence gives a call,
// and the form the ratchet exists to catch - was read there and falls into the PROSE branch here,
// where no rule below can see it. The tail is removed first and the span is classified on what is
// left, so the classification is a property of the span's shape rather than of the character it
// happens to end with; the same accident emptied a name list that ends with its own separator. The
// removal is ONE-DIRECTIONAL by construction - it can only move a span out of PROSE into the call,
// name or list form, never the other way - and the R2 test asserts that over every scanned line, so
// no name the r1 parser read can be dropped by it (DEC-DS-4).
const SENTENCE_TAIL = /[.,;:!?]+$/;
const stripSentenceTail = { enabled: true };
function spanSegments(span) {
  const text = stripSentenceTail.enabled ? span.replace(SENTENCE_TAIL, '') : span;
  if (text.endsWith(')')) {
    const head = text.slice(0, Math.max(text.indexOf('('), 0)).trim();
    return /^[A-Za-z_]\w*(\.\w+)*$/.test(head) ? [head] : [];
  }
  if (text.includes('(')) return [];
  if (!/[,;/]/.test(text)) {
    return /^[A-Za-z_]\w*(\.\w+)*$/.test(text) ? [text] : [];
  }
  const segments = text.split(/[,;/]+/).map((part) => part.trim()).filter(Boolean);
  return segments.every((part) => /^[A-Za-z_]\w*(\.\w+)*$/.test(part)) ? segments : [];
}

function callableNames(line) {
  const names = [];
  for (const span of codeSpans(line)) {
    for (const segment of spanSegments(span)) {
      const receiver = segment.includes('.') ? segment.slice(0, segment.lastIndexOf('.')) : '';
      const receivers = receiver.split('.');
      const last = segment.split('.').pop();
      if (!last || !/^[A-Za-z_]\w*$/.test(last)) continue;
      if (FRAMEWORK_RECEIVERS.has(last) || receivers.some((part) => FRAMEWORK_RECEIVERS.has(part))) continue;
      if (NON_CALLABLES.has(last)) continue;
      if (!isCallableName(last)) continue;
      names.push({ name: last, called: span.includes('('), receiver });
    }
  }
  return names;
}

// A section that declares itself historical is allowed to name the runtime it describes.
function historicalSections(lines) {
  const flags = new Array(lines.length).fill(false);
  let historical = false;
  lines.forEach((line, index) => {
    if (/^#{2,4}\s/.test(line)) historical = /historical|archived|removed|V1\/V2|pre-V3/i.test(line);
    flags[index] = historical;
  });
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Fenced code blocks. The ratchet above reads inline-code spans, so a dead name inside a fence was
// invisible by construction: CU-202 (finding F3) lost 33 dead names between two V2 documents that
// way. The scan below reads fences too, and it separates a mention from a claim, because the two
// need opposite treatment (DS-CU-210 section 3):
//
//   a CLAIM is a name the block presents as something to call or to look up on the current runtime:
//   `name(` in code position, a `name:` value in the definition list of a doc example, a quoted
//   method argument of Contract.Call, or a `public static <ret> Name(` definition.
//   A claim whose name the repository does not contain is drift and must be corrected.
//
//   a MENTION is a bare identifier with no call syntax - a mermaid state or node label, a field, a
//   type, a variable. It asserts nothing about the ABI, so it is recorded in V2_FENCE_MENTIONS with
//   the reason it stays instead of being counted as a claim. This is why `HasID` or `CallCustom` in
//   a flowchart is not debt while `IsAnyExecutionActive()` in a C# block is.
//
// Two document-level mechanisms bound the rule, both existing ones: a line that marks the name
// removed, and a `## ... historical` section. A third is new and is visible in the document itself:
// an annotation `<!-- docs-truth: no fence claims for <lang>; reason: ... -->` declares that fenced
// blocks in the named languages are illustrations of another runtime, not claims about this one.
// The annotation must name its languages from the vocabulary below, must not name a Neo language,
// and must carry a reason, so it can silence only the family it states and never "everything".
const DIAGRAM_LANGUAGES = new Set(['mermaid', 'dot', 'graphviz', 'text', 'ascii']);
const NEO_FENCE_LANGUAGES = new Set(['csharp', 'cs']);
const ILLUSTRATIVE_LANGUAGES = new Set(['solidity', 'typescript', 'javascript', 'js', 'python', 'java', 'go', 'rust', 'bash', 'shell', 'sh', 'sql', 'yaml', 'yml', 'json', 'toml', 'ini', 'dockerfile', 'powershell', 'html', 'css', 'xml', 'graphql']);
const NO_FENCE_CLAIMS = /<!--\s*docs-truth:\s*no fence claims for ([a-z0-9, ]+);\s*reason:\s*(.+?)\s*-->/g;
// A dated snapshot declares in its own words that its code snippets are evidence of the revision it
// audited, not a description of what ships. The declaration is a fixed phrase so it can be checked,
// and a document that carries one is registered in V2_FENCE_SCOPES with a reason: the exemption is
// never available implicitly, and a new document cannot adopt it without the guard's list changing.
const HISTORICAL_SNIPPET_SCOPE = /retained as historical security context|as a description of the deployed artifact/i;

// A name is live when an artifact spells it that way, and the artifact decides (DS-CU-211,
// DEC-DS-5):
//
//   * a contract ABI member is live ONLY in its manifest spelling. A document that writes any other
//     spelling of an exported member - including the C# source spelling of it - asserts a name the
//     deployment does not carry, so it is debt. This is the half CU-210 finding F6 measured: the
//     previous rule asked `deployedAbiLower.has(name.toLowerCase())` and therefore judged
//     `CanExecuteHook` live while every manifest exports `canExecuteHook`;
//   * a C# definition no manifest exports is live as source. `GetThresholdPolicy`
//     (SmartAccount.Modules.cs, the private read behind the threshold-policy actions) is the recorded
//     example: the pinned build cannot export it because the v4 core deliberately has no policy
//     getter, and a document that names it names real code.
//
// The two halves are why the rule keys on the artifact rather than on letter case: refusing every
// PascalCase name would kill the second class, and accepting every case variant would keep the
// first invisible.
// STANDARD MODULE ABI (Task 51 R2). The five standard modules under contracts/modules/<Module>/ are
// not carried by this tree's pinned custom manifests, so `deployedAbi` above knows none of their
// names and every module README was charged with dead references for its own surface. Their
// REGISTERED names come from the ABI reference docs/proposals/smartaccount-module-abis.md, which is
// regenerated from the compiled manifests and not written by hand (contracts/modules/README.md,
// "ABI appendix"). The reference is the source; no module name is read out of a build artifact.
//
// The reference is cross-checked here rather than trusted, so nothing is registered on the strength
// of a document alone:
//   * docs/proposals/smartaccount-named-module-interfaces.json lists only the EXTRA methods a
//     profile requires beyond the common lifecycle. It is a subset of the reference and cannot be
//     the source on its own: `validateMessageSignature`, `authorizedCore`, `setAuthorizedCore` and
//     every lifecycle callback are absent from it. The test below holds the subset relation.
//   * every name the reference carries for a standard module must resolve to a member of that
//     module's C# source (contracts/modules/<Module>/*.cs plus the Shared/ sources compiled into
//     every module) under the compiler's exported-spelling rule, or to a pinned manifest (the
//     compiler-emitted `_initialize`, which no source declares). A name that resolves to neither is
//     dropped from the oracle and fails the test below; it is never registered as live.
const MODULE_ABI_REFERENCE = 'docs/proposals/smartaccount-module-abis.md';
const moduleAbi = new Map(); // standard module -> Set of its ABI names, in manifest spelling
{
  let section = null;
  for (const line of read(MODULE_ABI_REFERENCE).split('\n')) {
    const heading = line.match(/^## (\w+)\s*$/);
    if (heading) {
      // A profile without a source directory under contracts/modules is a plugin: its names are
      // live through contracts/build or not at all, exactly as before this block existed.
      section = exists(`contracts/modules/${heading[1]}`) ? heading[1] : null;
      if (section) moduleAbi.set(section, new Set());
      continue;
    }
    if (section && !/^```/.test(line)) {
      const signature = line.match(/^(?:safe\s+)?([A-Za-z_]\w*)\s*\(/);
      if (signature) moduleAbi.get(section).add(signature[1]);
    }
  }
}
// C# members (methods, properties and fields) of each standard module, by source spelling.
const MODULE_MEMBER = /^\s*(?:\[[^\]]*\]\s*)*(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:override\s+|virtual\s+|abstract\s+|readonly\s+|new\s+)*[\w<>[\],.?\s]+?\s+([A-Za-z_]\w*)\s*(?:\(|=>|\{|;)/gm;
const moduleSourceMembers = new Map([...moduleAbi.keys()].map((module) => [module, new Set()]));
const sharedModuleMembers = new Set();
for (const file of tracked) {
  if (!file.endsWith('.cs')) continue;
  const own = file.match(/^contracts\/modules\/(\w+)\/[^/]+\.cs$/);
  const into = own && moduleSourceMembers.has(own[1]) ? moduleSourceMembers.get(own[1])
    : file.startsWith('contracts/modules/Shared/') ? sharedModuleMembers : null;
  if (into) for (const match of read(file).matchAll(MODULE_MEMBER)) into.add(match[1]);
}
// Read-only cross-check of the reference against the module sources.
const moduleAbiUnresolved = [];
for (const [module, names] of moduleAbi) {
  for (const name of [...names]) {
    if (deployedAbi.has(name)
      || [...moduleSourceMembers.get(module), ...sharedModuleMembers].some((member) => deployedSpellingOfSource(member) === name)) continue;
    moduleAbiUnresolved.push(`${module}.${name}`);
    names.delete(name);
  }
}
const moduleAbiNames = new Set([...moduleAbi.values()].flatMap((names) => [...names]));
const moduleReadme = (file) => file.match(/^contracts\/modules\/(\w+)\/README\.md$/)?.[1] ?? null;
// A backticked span that carries the name as a bare reference or as a call:
// `getHookOrder`, `getMessagePolicy(accountId, moduleId)`.
const namesSpan = (name) => new RegExp('`[^`]*\\b' + name + '(?=`|\\()');
function isModuleDirectoryMethod(name, file) {
  const module = moduleReadme(file);
  // A module's own README may name the methods registered for that module, in manifest spelling.
  if (module !== null) return moduleAbi.get(module)?.has(name) ?? false;
  // The directory README attributes a name to the module whose table row carries it.
  if (file !== 'contracts/modules/README.md' || !moduleAbiNames.has(name)) return false;
  return read(file).split('\n').some((line) => {
    const owner = line.match(/^\| \[(\w+)\]/)?.[1];
    return owner !== undefined && moduleAbi.get(owner)?.has(name) === true && namesSpan(name).test(line);
  });
}
// A README surface table writes the ABI name and the C# member implementing it side by side:
// `| `authorizedCore()` | `AuthorizedCore` | `Hash160` | read-only |`. The second column is a
// declared mapping, not a mis-spelled call. It is exempt only when the first spelling is the
// module's registered name, that name is what the source spelling compiles to, and the member is
// the module's own source; a PascalCase write anywhere else stays in the spelling bucket.
function isModuleAbiMappingRow(name, line, file) {
  const module = moduleReadme(file);
  if (module === null || !line.startsWith('|')) return false;
  const deployed = deployedSpellingOfSource(name);
  return deployedSpelling(name) === deployed && moduleAbi.get(module)?.has(deployed) === true
    && (moduleSourceMembers.get(module).has(name) || sharedModuleMembers.has(name))
    && new RegExp('`' + name + '`').test(line) && namesSpan(deployed).test(line);
}
// RECORD FIELDS. `updateCounter` is a field of the module-instance record the native core keeps
// (contracts/native/SmartAccount/SmartAccountRecords.cs, class ModuleInstance: `internal ulong
// UpdateCounter;`), not a callable: ModuleSupport.cs compares it with the descriptor
// (`deployed.UpdateCounter == descriptor[FieldModuleUpdateCounter]`) and lists it among the code
// binding columns. The shape rule reads it (update + Counter) because a field and a getter share the
// camelCase form, so a document that NAMES the field was charged with a dead entrypoint. A field
// may be named, never called: the ratchet exempts the uncalled form only, and the set is derived
// from the record declarations.
const RECORDS_SOURCE = 'contracts/native/SmartAccount/SmartAccountRecords.cs';
const recordFieldNames = new Set();
{
  const source = read(RECORDS_SOURCE);
  const declaredAsCallables = new Set([...source.matchAll(/([A-Za-z_]\w*)\s*\(/g)].map((match) => match[1]));
  for (const match of source.matchAll(/^\s*(?:\[[^\]]*\]\s*)*(?:public|internal|private|protected)\s+(?!const\b)(?:static\s+)?(?:readonly\s+)?[\w.<>[\],?]+\s+([A-Z]\w*)\s*;/gm)) {
    const field = deployedSpellingOfSource(match[1]);
    if (!declaredAsCallables.has(match[1]) && !deployedAbi.has(field) && !moduleAbiNames.has(field)) recordFieldNames.add(field);
  }
}
const isRecordField = (name) => recordFieldNames.has(name);
function isLiveName(name, file) {
  if (isModuleDirectoryMethod(name, file)) return true;
  if (deployedAbi.has(name)) return true;
  if (deployedSpelling(name) !== undefined) return false;
  // A standard module's registered method is live in its manifest spelling, in any document -
  // except a module README, where the per-module rule above has already decided: a module's README
  // may not claim a method registered for another module.
  if (moduleReadme(file) === null && moduleAbiNames.has(name)) return true;
  if (sourceDefinitions.has(name) || definedNames.has(name) || sdkMethods.has(name)) return true;
  if (actionNames.has(name)) return true;
  if (NATIVE_PROFILE_DOCS.includes(docClass(file)) && nativeAbiNames.has(name)) return true;
  return false;
}

// These drafts retain the source vocabulary of the experiments they describe.
function isResearchDocument(file) {
  return file.startsWith('docs/proposals/') || file.startsWith('docs/archive/native-research/');
}

// The names a single fenced line asserts. `claim` is a property of the line's own syntax, so a
// definition spread over two lines (a C# signature with its parameters on the next line) declares
// itself on the line that carries the name. The claim side reads the WIDENED vocabulary
// (DS-CU-212 and CU-210 R2): a fenced call to the source spelling of an exported member, and a
// fenced call written in the build's camelCase spelling, are both claims about the deployed
// artifact, and the shape rule alone could not read either.
//
// A COMMENT is not code position, so it asserts nothing (CU-210 R2/R3). Widening the vocabulary made
// this visible: `// ~ paymaster.sponsorshipPolicy (time-based expiry)` in
// docs/ARCHITECTURE.md (the merged architecture book, whose Ethereum-comparison chapter came from
// the former ETHEREUM_AA_COMPARISON topic) is prose comparing two systems, and reading it as a claim invented
// a Neo entrypoint out of an Ethereum field name. Nothing else speaks for the fenced code around it,
// so the claim that would have silenced a real finding stays silent (DEC-DS-9).
//
// The r2 rule cut ONE single-line marker out of each line on its own, which made it narrower than
// the property it stated: a fenced `/* deadCall() */` was read as code, so a valid document failed
// the gate. The lexer below IS the property - no comment content of either kind is a claim, in any
// fence language the guard reads - and it says what a comment is per language, in that language's
// own terms, instead of assuming one marker fits all of them.
//
// WHERE THE BOUNDARY IS, stated rather than left implicit:
//
//   * It models COMMENTS ONLY. A comment marker inside a string literal is not a marker, so
//     `'https://host/path'` is code and does not cut the line; but the string's CONTENT is returned
//     as code as well, because three of the claim rules below deliberately read a name out of a
//     string (`operation: 'updateVerifier'`, `'name', CallFlags`, `DisplayName("name")`). The guard
//     cannot tell a string from a claim, and it is not "fixed" here to pretend otherwise: a lexer
//     that made strings opaque would silently DROP those claims, which is a narrowed rule wearing a
//     fix's clothes - the defect class this round exists to close.
//   * String tracking is line-local and errs toward CODE: a quote that does not close on its line is
//     closed at the line's end, so a runaway quote cannot swallow the rest of a fence.
//   * A language this table does not name has no comment syntax here and its text is returned
//     unchanged. An unknown fence is read as code, never as a comment.
//   * The forms deliberately NOT modelled are named in the evidence (DS-CU-210 section 11): Ruby's
//     `=begin/=end`, Perl's POD, INI's `;`, YAML block scalars and DOT's leading `#` are distinct
//     lexical families, no scanned fence uses one, and the table grows by one row plus one planted
//     shape - which the coverage test below refuses to let anyone skip.
const COMMENT_SYNTAX = new Map(Object.entries({
  // `//` to end of line, `/* ... */` in pairs that do not nest.
  csharp: { line: ['//'], block: ['/*', '*/'] },
  cs: { line: ['//'], block: ['/*', '*/'] },
  c: { line: ['//'], block: ['/*', '*/'] },
  javascript: { line: ['//'], block: ['/*', '*/'] },
  js: { line: ['//'], block: ['/*', '*/'] },
  typescript: { line: ['//'], block: ['/*', '*/'] },
  ts: { line: ['//'], block: ['/*', '*/'] },
  java: { line: ['//'], block: ['/*', '*/'] },
  go: { line: ['//'], block: ['/*', '*/'] },
  solidity: { line: ['//'], block: ['/*', '*/'] },
  kotlin: { line: ['//'], block: ['/*', '*/'] },
  scala: { line: ['//'], block: ['/*', '*/'] },
  dot: { line: ['//'], block: ['/*', '*/'] },
  graphviz: { line: ['//'], block: ['/*', '*/'] },
  // `/* ... */` pairs that NEST: rust and swift are the two fence languages here whose own grammar
  // says a comment opened inside a comment is still the same comment.
  rust: { line: ['//'], block: ['/*', '*/'], nest: true },
  swift: { line: ['//'], block: ['/*', '*/'], nest: true },
  // PHP has both single-line markers, and GraphQL's only marker is `#` (it has no `//`), which
  // corrects the family the r2 regex put it in. Neither language has a fence in the scanned
  // documents today, so both corrections are inert on the corpus and each carries a planted shape.
  php: { line: ['//', '#'], block: ['/*', '*/'] },
  graphql: { line: ['#'] },
  // `#` to end of line, plus PowerShell's own `<# ... #>` pair.
  python: { line: ['#'] },
  py: { line: ['#'] },
  bash: { line: ['#'] },
  shell: { line: ['#'] },
  sh: { line: ['#'] },
  zsh: { line: ['#'] },
  yaml: { line: ['#'] },
  yml: { line: ['#'] },
  toml: { line: ['#'] },
  ini: { line: ['#'] },
  dockerfile: { line: ['#'] },
  r: { line: ['#'] },
  ruby: { line: ['#'] },
  perl: { line: ['#'] },
  powershell: { line: ['#'], block: ['<#', '#>'] },
  // Mermaid's comment marker is `%%`. A diagram has no string syntax, so a label's apostrophe must
  // not open one; the flag keeps that from happening.
  mermaid: { line: ['%%'], strings: false },
}));

// The comment syntax of one fence's language. An unknown language has none: its text is code.
function commentSyntax(language) {
  return COMMENT_SYNTAX.get(language) ?? {};
}

// A lexer for ONE FENCE. A block comment that opens on one line and closes on a later one is the
// same comment, so the state lives in the lexer, which is created when the fence opens and dropped
// when it closes: a comment can never leak from one fence into the next.
function commentLexer(language) {
  const syntax = commentSyntax(language);
  const markers = syntax.line ?? [];
  const block = syntax.block ?? null;
  let depth = 0;
  return {
    code(line) {
      let code = '';
      let index = 0;
      while (index < line.length) {
        if (depth > 0) {
          if (syntax.nest && line.startsWith(block[0], index)) { depth += 1; index += block[0].length; continue; }
          if (line.startsWith(block[1], index)) { depth -= 1; index += block[1].length; continue; }
          index += 1;
          continue;
        }
        if (syntax.strings !== false) {
          const quote = line[index];
          if (quote === '"' || quote === "'" || quote === '`') {
            const end = stringEnd(line, index, quote);
            code += line.slice(index, end);
            index = end;
            continue;
          }
        }
        if (block !== null && line.startsWith(block[0], index)) { depth = 1; index += block[0].length; continue; }
        if (markers.some((marker) => line.startsWith(marker, index))) break;
        code += line[index];
        index += 1;
      }
      return code;
    },
  };
}

// A string literal ends on its own line: an unclosed quote is closed at the line's end rather than
// swallowing the fence, and the text is copied through as code either way.
function stringEnd(line, start, quote) {
  let index = start + 1;
  while (index < line.length) {
    if (line[index] === '\\' && index + 1 < line.length) { index += 2; continue; }
    if (line[index] === quote) return index + 1;
    index += 1;
  }
  return line.length;
}

// The single-line form, for a caller that reads one line with no fence around it (the vocabulary
// assertions near the end of this file). A comment that spans lines needs the per-fence lexer.
function codePart(line, language) {
  return commentLexer(language).code(line);
}

// The names one line of CODE asserts.
function claimNames(code) {
  const names = new Set();
  for (const match of code.matchAll(/([A-Za-z_]\w*)\s*\(/g)) names.add(match[1]);
  for (const match of code.matchAll(/\b(?:operation|method|entrypoint|function|func)\s*:\s*['"]([A-Za-z_]\w*)['"]/gi)) names.add(match[1]);
  for (const match of code.matchAll(/["']([A-Za-z_]\w*)["']\s*,\s*(?:CallFlags|CallPermission)/g)) names.add(match[1]);
  for (const match of code.matchAll(/(?:public|private|internal|protected)\s+static\s+(?:[\w<>[\],.?]+\s+)?([A-Za-z_]\w*)\s*\(/g)) names.add(match[1]);
  for (const match of code.matchAll(/DisplayName\("([^"]+)"\)/g)) names.add(match[1]);
  return [...names].filter((name) => isReadableName(name)
    && !FRAMEWORK_RECEIVERS.has(name) && !NON_CALLABLES.has(name));
}

// The names a single fenced line asserts, with the comment rule applied in that line's own language.
function fenceClaims(line, language = '') {
  return claimNames(codePart(line, language));
}

// What the fenced scan finds, as data: { claims: { file: [names] }, mentions: { file: [names] } }.
// Kept as a function, not as assertions, so the planted-drift test can call it on a temporary copy
// of a document and see exactly what the guard would report.
function fenceScan({ mirrors = false } = {}) {
  const claims = {};
  const mentions = {};
  const snippetScopes = new Set();
  const files = tracked.filter((file) => file.endsWith('.md')
    && !isResearchDocument(file) && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/')
    && !CURRENT_DOCS.includes(docClass(file))
    && (mirrors ? isMirrorDoc(file) : !isMirrorDoc(file)));
  for (const file of files) {
    const text = read(file);
    const lines = text.split('\n');
    const historical = historicalSections(lines);
    // The scope note sits in the document's preamble, so it applies to the snippets after it; the
    // pre-pass keeps that order-independent rather than making the note's position load-bearing.
    const snippetScope = HISTORICAL_SNIPPET_SCOPE.test(text.replace(/\s+/g, ' '));
    if (snippetScope) snippetScopes.add(file);
    const exempt = new Set();
    for (const match of text.matchAll(NO_FENCE_CLAIMS)) {
      const languages = match[1].split(',').map((entry) => entry.trim()).filter(Boolean);
      for (const language of languages) {
        assert.ok(ILLUSTRATIVE_LANGUAGES.has(language),
          `${file}: the no-fence-claims annotation names "${language}", which is not an illustrative (non-Neo) language`);
        exempt.add(language);
      }
      assert.ok(match[2].length >= 40, `${file}: the no-fence-claims annotation needs a reason it must stay`);
    }
    for (const language of exempt) {
      assert.ok(!NEO_FENCE_LANGUAGES.has(language),
        `${file}: the no-fence-claims annotation covers "${language}", a Neo language a claim can be written in`);
    }
    let info = null;
    // One lexer per fence, created when the fence opens and dropped when it closes, so a block
    // comment cannot carry its state across a fence boundary.
    let lexer = null;
    lines.forEach((line, index) => {
      if (/^\s*```/.test(line)) {
        info = info === null ? line.trim().replace(/^```/, '').trim() : null;
        lexer = info === null ? null : commentLexer(info.split(/[\s{:]/)[0].toLowerCase());
        return;
      }
      if (info === null) return;
      const language = info.split(/[\s{:]/)[0].toLowerCase();
      if (exempt.has(language) || snippetScope) return;
      if (REMOVED.test(line) || historical[index]) return;
      const code = lexer.code(line);
      // A bare identifier is recorded as a mention only in a diagram: a flowchart or state diagram
      // has a reason to name things that are not called (a node, a state), while a bare identifier
      // in a code block is a variable or a field. Call syntax is a claim in both, which is why a
      // state label reading `InitiateEscape()` is reported and `HasID` inside `class … decision`
      // is recorded instead of being read as an entrypoint.
      if (DIAGRAM_LANGUAGES.has(language)) {
        // A name the same line asserts as a call is a claim, not a mention: the two ledgers stay
        // disjoint, so a label like `InitiateEscape()` is reported once as a claim and is never also
        // recorded as a justified mention (DS-CU-211).
        const claimed = new Set(claimNames(code));
        for (const match of code.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
          const name = match[1];
          if (claimed.has(name)) continue;
          // The mention ledger keeps the SHAPE vocabulary (DS-CU-212, DEC-DS-6 rule 4): a diagram
          // label is prose about a flow, so widening it would book ordinary words (`Transfer`,
          // `Verify`, `Admin`) as debt and force the exact mention list to grow - an allowance
          // widened to silence a finding. A label that is really a call is a claim above and is read
          // under the widened vocabulary there.
          if (!shapedLikeEntrypoint(name)) continue;
          if (FRAMEWORK_RECEIVERS.has(name) || NON_CALLABLES.has(name)) continue;
          if (isLiveName(name, file)) continue;
          if (!mentions[file]) mentions[file] = new Set();
          mentions[file].add(name);
        }
      }
      for (const name of claimNames(code)) {
        if (isLiveName(name, file)) continue;
        (claims[file] ??= []).push(name);
      }
    });
  }
  const sorted = (map) => Object.fromEntries(Object.entries(map)
    .map(([file, names]) => [file, [...names].sort()])
    .sort(([a], [b]) => a.localeCompare(b)));
  return { claims: sorted(claims), mentions: sorted(mentions), snippetScopes: [...snippetScopes].sort() };
}


function failures() {
  const problems = [];
  // The mirrors are scanned as their sources: same class, same rules, their own bytes. A Chinese
  // counterpart that drops the removal marker making a name historical, or spells a current method
  // differently, therefore fails here instead of escaping because only the English file is listed.
  const guarded = [...CURRENT_DOCS, ...NO_SNAPSHOT_AUDIT_DOCS];
  const guardedWithMirrors = [...guarded, ...guarded.map(mirrorOf).filter(exists)];
  for (const file of guardedWithMirrors) {
    assert.ok(exists(file), `guarded document ${file} does not exist`);
    const classFile = docClass(file);
    const nameRules = CURRENT_DOCS.includes(classFile);
    const lines = read(file).split('\n');
    const historical = historicalSections(lines);
    let fence = false;
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      const markedRemoved = REMOVED.test(line) || historical[index];
      if (/^\s*```/.test(line)) { fence = !fence; return; }
      if (nameRules) for (const { name } of callableNames(line)) {
        if (isModuleDirectoryMethod(name, classFile)) continue;
        if (isSourceBridgeName(classFile, name)) continue;
        if (deployedAbi.has(name)) continue;
        if (deployedAbiLower.has(name.toLowerCase())) {
          problems.push(`${where}: ${name} is not a deployed ABI name; the artifact spells it ${deployedAbiLower.get(name.toLowerCase())}`);
          continue;
        }
        const sourceOnly = SOURCE_ONLY_CUSTOM_READS.get(classFile);
        if (sourceOnly?.names.has(name)) {
          if (!sourceOnly.caveat.test(read(file))) {
            problems.push(`${where}: ${name} is source-only in the custom track but the document does not disclose the unshipped-artifact boundary`);
          }
          continue;
        }
        if (definedNames.has(name) || actionNames.has(name)) continue;
        if (markedRemoved) continue;
        problems.push(`${where}: ${name} is not defined in any contract, manifest or SDK source and the line does not mark it removed`);
      }
      if (nameRules && fence && !markedRemoved) for (const match of line.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) {
        if (canonicalHashes.has(match[0].toLowerCase())) continue;
        if (!/current|canonical|verified hardened|masterHash|SA_RELAY_ALLOWED_HASH/i.test(line)) continue;
        problems.push(`${where}: ${match[0]} is presented as the current deployment but is not in generatedMorpheusRegistry.js`);
      }
      if (nameRules && !markedRemoved) for (const match of line.matchAll(/\b(?:saClient|client|sdk)\.([A-Za-z_]\w*)\s*\(/g)) {
        const name = match[1];
        if (legacySdkMethods.has(name)) problems.push(`${where}: ${name} always throws LEGACY_V3_REMOVED in the SDK and must not be documented as usable`);
        else if (!sdkMethods.has(name)) problems.push(`${where}: ${name} is not an SDK method`);
      }
      for (const match of line.matchAll(/`(docs\/[\w./-]+\.(?:json|md))`/g)) {
        if (!exists(match[1])) problems.push(`${where}: cited receipt ${match[1]} does not exist`);
      }
      if (/VULN-001/.test(line) && /fix|clos|resolv|mitigat|eliminat/i.test(line) && !/private|only|not\b|pending|open|historical/i.test(line)) {
        problems.push(`${where}: ${file} claims VULN-001 closed, but ${VULN_001_OPEN_REASON}`);
      }
    });
    if (nameRules) {
      // Hashes in prose are checked per paragraph, not per line: the prose wraps, and a stale
      // anchor on the second line of a sentence must not escape the rule. Fenced examples keep the
      // line check above, because a code block is where a placeholder hash lives.
      const prose = read(file).replace(/^\s*```[\s\S]*?^\s*```/gm, '');
      for (const paragraph of prose.split(/\n\s*\n/)) {
        const flat = paragraph.replace(/\s+/g, ' ');
        if (!/current|canonical|verified hardened|masterHash|SA_RELAY_ALLOWED_HASH/i.test(flat)) continue;
        if (REMOVED.test(flat)) continue;
        for (const match of flat.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) {
          if (canonicalHashes.has(match[0].toLowerCase())) continue;
          problems.push(`${file}: ${match[0]} is presented as the current deployment but is not in generatedMorpheusRegistry.js (paragraph: ${flat.slice(0, 90)}…)`);
        }
      }
      // A section that reports the matrix as verified or passed must say which target the run used.
      // The script that produced the record targets MockTransferTarget, so the disclosure is not
      // prose decoration: without it a reader takes an authorization result for a value transfer.
      let section = [];
      const flush = (heading) => {
        const text = section.join('\n');
        if (/verified on-chain|passed on testnet/i.test(text) && !/MockTransferTarget|mock (contract|target)/i.test(text)) {
          problems.push(`${file}: the section "${heading}" reports the plugin matrix as verified on chain without disclosing the MockTransferTarget target the matrix script uses`);
        }
        section = [];
      };
      let heading = 'preamble';
      for (const line of read(file).split('\n')) {
        if (/^#{1,6}\s/.test(line)) { flush(heading); heading = line.trim(); }
        section.push(line);
      }
      flush(heading);
    }
  }
  return problems;
}

// DS-CU-202 finding F3, filed again as RV-DSCU202R1-r1 (minor): the name patterns read INLINE-CODE
// SPANS only, so a dead name written as raw code inside a fenced block is invisible. The boundary is
// measured in both directions here, and the guard has to declare it where the measurement happens,
// because the ratchet's count is a floor while the boundary stands. Row CU-210 owns the fenced
// measurement (DS-CU-210-20261009.md); this test does not approve the boundary, it refuses to let it
// stay silent.
test('CU-202: the ratchet reads inline-code spans and declares the boundary it does not cross', () => {
  // The boundary: raw code, the shape a fenced block carries, is not a span.
  assert.deepEqual(callableNames('const accountId = executeLegacyControlThing(accountId);'), [],
    'the inline reader must not read raw code as a name reference; if this fails the boundary moved and every count below it is wrong');
  // The same dead name inside one inline span is read, so the boundary is the span, not the name.
  assert.deepEqual(
    callableNames('stop calling `executeLegacyControlThing(accountId)`; it is gone').map((entry) => entry.name),
    ['executeLegacyControlThing'],
    'the same name inside an inline span must be read, or the declared boundary is not where the guard reads');
  // The declaration, at the measurement site: deleting it has to fail here rather than silently widen
  // the ratchet's claim to be the repository's drift. The note is matched with its comment markers
  // and line wrapping normalised, so reflowing it is free and removing it is not.
  const declaration = read('frontend/tests/docsTruth.test.js').match(/\/\/ MEASUREMENT BOUNDARY[\s\S]*?(?=\n\n)/);
  assert.ok(declaration, 'the guard must declare the inline-span measurement boundary where it measures (DS-CU-202 F3)');
  const note = declaration[0].replace(/^\/\/ ?/gm, ' ').replace(/\s+/g, ' ');
  assert.match(note, /INLINE-CODE SPANS only/i, 'the declaration must state the boundary it draws');
  assert.match(note, /CU-210/, 'the declaration must name the row that owns the fenced measurement');
});

// ---------------------------------------------------------------------------------------------
// The gitleaks configuration, held as a whole set
//
// RV-AAADSCU202R2-r1 (major): round two validated ONE [[allowlists]] block - the first whose text
// mentions sdk-usage - and said nothing about the rest of the file. A second allowance block
// carrying global paths and regexes could therefore be appended and all eight tests still passed
// while gitleaks stopped reporting a planted secret. Round 3 measures the whole family
// (DS-CU-202-20261009.md, "Round 3"): a second block, a global path, a global regex, a rule-level
// allowance, a commit allowlist, a stopword, a redefined rule, a configuration reached through
// [extend] path, an .gitleaksignore entry and a nested configuration all suppress findings, and
// most of them also passed the round-two guard. The property is not "this block is scoped" but
// "every suppression the scanner resolves from this repository's tree is one the review triaged"
// (DEC-DS-9: refuse for the property, not by accident of the pattern). The declaration below is
// that triage: the guard parses the file into suppression carriers, holds the whole set to the
// declaration, refuses every carrier the declaration does not name - by kind and by block - and
// binds each declared entry to one file and one value with controls derived from the repository
// rather than from the declaration.
//
// The choice, stated: the guard rejects ANY allowance it did not review rather than permitting a
// bounded set of "scoped-looking" new ones, because a scoped-looking allowance is exactly what the
// round-one sdk-usage block was, and nothing in a block's shape distinguishes a triaged
// suppression from an untriaged one. The cost is deliberate friction: a new triage has to be added
// here, in the same commit, where a reviewer sees it as a change to the reviewed inventory. Values
// are compared by value, so reformatting or re-quoting the configuration is free.
// ---------------------------------------------------------------------------------------------
const GITLEAKS_CONFIG = '.gitleaks.toml';
// Exact historical locations only. The reviewed matches are build hashes, nonce
// vectors, published contract addresses, or a sentence naming the key encoder.
const REVIEWED_GITLEAKS_IGNORE = {
  path: '.gitleaksignore',
  sha256: '04863dc1da364917bc731d56182b308835e3926acd2535688c508bcf3150e096',
  findings: 340,
  report: 'docs/reports/aa-artifact-reproducibility-20261025.json',
  byCommitAndPath: {
    '012a3b4c323e692f750c6d1115c68868cbac2d18:formal/refinement/fixtures/current-method-proof/method-proof.json': 15,
    '012a3b4c323e692f750c6d1115c68868cbac2d18:tests/SmartAccount.Native.Tests/TestFile/smartaccount-v4-vectors.json': 1,
    '012a3b4c323e692f750c6d1115c68868cbac2d18:tests/fixtures/sa-module-protocol/golden-vectors/nonce-channel.json': 2,
    '66b1715894f1eb38354ccc02f6cbdeb1c29911aa:docs/SDK.md': 1,
    '9f6819c399df876b15db4143a146d35dc5cad42d:docs/SA-MODULE-PROTOCOL.md': 1,
    '9f6819c399df876b15db4143a146d35dc5cad42d:docs/reports/sa-artifact-reproducibility-20261118.json': 37,
    '9f6819c399df876b15db4143a146d35dc5cad42d:frontend/src/config/generatedMorpheusRegistry.js': 4,
    '9f6819c399df876b15db4143a146d35dc5cad42d:frontend/src/config/generatedMorpheusRuntimeCatalog.js': 4,
    'bdf41dd1cc5ee4fabcb14bad5a5add8c7fb47f5e:docs/reports/sa-artifact-reproducibility-20261118.json': 26,
    'c315fe38b8765c6fefe693dde80c42369ac62606:tests/SmartAccount.Native.Tests/TestFile/smartaccount-v4-vectors.json': 1,
    'c315fe38b8765c6fefe693dde80c42369ac62606:tests/fixtures/sa-module-protocol/golden-vectors/nonce-channel.json': 4,
    'da74a6f1870f2749899e60b5ec1b1f22476c6bc4:docs/reports/aa-artifact-reproducibility-20261025.json': 37,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/core-nep-model/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/gate-recheck/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/governed-config-formal.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/module-admission/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/module-configuration/policy-model.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/module-install-forms/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/module-removal/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/module-wire-types/typed-build.json': 8,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/native-nep/module-build.json': 8,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/native-nep/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/storage-getter-regression/result.json': 20,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:docs/reports/smartaccount-current-20261124/subscription-model/result.json': 17,
    '56ad7f6c86e9bc307767377011ab0d4ebdb7bd65:formal/refinement/ordinary_query_references.py': 1,
  },
};
// Every file name gitleaks resolves a configuration or an ignore set from, anywhere in the tree.
const GITLEAKS_CONFIG_FILES = ['.gitleaks.toml', '.gitleaksignore'];
// The keys the reviewed form of an allowance carries. Any other suppression key (`commits`,
// `stopwords`, ...) is a lever this review did not triage and is reported rather than ignored.
const ALLOWLIST_REVIEWED_KEYS = ['targetRules', 'condition', 'paths', 'regexTarget', 'regexes'];
const ALLOWLIST_KNOWN_KEYS = [...ALLOWLIST_REVIEWED_KEYS, 'commits', 'stopwords'];
// An allowance that names a line of a document is derived from that document, so the guard holds
// the reviewed line without keeping a copy of it: `^[[:space:]]*<the line as written>[[:space:]]*$`.
// The reviewed line is the one `const <identifier> = '...'` assignment the document carries; zero or
// two mean the reviewed line is gone, and the set comparison below then refuses the configuration.
// A document that re-spells the assignment is refused too, which is friction a reviewer sees rather
// than a silent re-scope.
function reviewedLineRegex(relative, identifier) {
  const carried = read(relative).split('\n')
    .filter((line) => new RegExp(`^[ \\t]*const ${identifier} = '`).test(line));
  return carried.length === 1 ? [`^[[:space:]]*${escapeRegex(carried[0].trim())}[[:space:]]*$`] : [];
}

const reviewedAllowlists = () => [
  {
    id: 'morpheus-golden-envelope-keypair',
    fields: {
      targetRules: ['generic-api-key'],
      condition: 'AND',
      paths: ['^sdk/js/tests/morpheus-envelope-roundtrip\\.unit\\.test\\.js$'],
      regexTarget: 'match',
      regexes: ["^GOLDEN_PRIVATE_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEI[A-Za-z0-9+/]{43}'$"],
    },
    literalPath: 'sdk/js/tests/morpheus-envelope-roundtrip.unit.test.js',
    // What gitleaks hands to the regex under regexTarget = "match": the assignment without the
    // surrounding statement, which is the form the reviewed value was triaged in (DS-CU-163
    // section 12.4).
    matchOf: (line) => (line.match(/\bGOLDEN_PRIVATE_KEY_PKCS8 = '[^']*'/) || [])[0],
    // The declared boundary, asserted in both directions: the identifier, the DER prefix and the
    // width are pinned; the 43 characters of key material are not, because pinning them would copy
    // a private key into the guard. Another identifier, another prefix or another width is
    // reported; a different key under the reviewed identifier is allowed on purpose.
    accepts: [`GOLDEN_PRIVATE_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEI${'A'.repeat(43)}'`],
    rejects: [
      { why: 'the same key material under a different identifier', line: `GOLDEN_OTHER_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEI${'A'.repeat(43)}'` },
      { why: 'a different DER prefix under the reviewed identifier', line: `GOLDEN_PRIVATE_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIF${'A'.repeat(43)}'` },
      { why: 'a shorter key than the reviewed width', line: `GOLDEN_PRIVATE_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEI${'A'.repeat(42)}'` },
    ],
  },
  {
    id: 'web3auth-verifier-hash',
    fields: {
      targetRules: ['generic-api-key'],
      condition: 'AND',
      paths: ['^frontend/src/assets/docs/sdk-usage\\.md$'],
      regexTarget: 'line',
      // The reviewed line, read out of the document rather than copied here: a guard that carries
      // the value it allows is a second copy of that value, and this branch's own canonical scan
      // has to stay clean (DS-CU-202 round 3). An empty list means the document no longer carries
      // the reviewed line, and the set comparison below refuses the configuration for it.
      regexes: reviewedLineRegex('frontend/src/assets/docs/sdk-usage.md', 'web3AuthVerifierHash'),
    },
    literalPath: 'frontend/src/assets/docs/sdk-usage.md',
    matchOf: (line) => line,
    accepts: null,
    // The reviewed line is read from the document, so these controls cannot drift from it. The
    // value must also still be one the registry carries (the round-two control).
    rejects: null,
    canonicalValue: /\b0x[0-9a-fA-F]{40}\b/,
  },
  // CU-231: the four generated audit reports the default head's canonical scan reports. Each is an
  // inventory allowance - the reviewed unit is one artefact and one value class, not one value,
  // because a generated digest map carries the same class on hundreds of lines and enumerating them
  // would copy the artefact into this guard. What keeps that from being a blanket is the `inventory`
  // binding asserted below: the number of lines the allowance reaches and the SHA-256 of the bytes
  // this triage read. Any edit to the artefact changes the digest and refuses until the triage is
  // redone, so no unreviewed byte can ride under an existing allowance.
  //
  // The classification (WS-CU-231-20261012.md, measurement 2): all 37 findings are
  // `generic-api-key`, all from one commit, and in every one of them the rule's keyword comes from
  // the JSON member name - a source path containing `Key`, `Token` or `API`, or the artefact name
  // `SessionKeyVerifier` - while the value is a content digest or a chain script hash. Neither
  // class is a credential: a SHA-256 of a public source file and a 20-byte Neo script hash are
  // public identifiers that authenticate nothing. Zero of the 37 is a real exposure.
  {
    id: 'native-domain-copy-runner-build-source-digests',
    fields: {
      targetRules: ['generic-api-key'],
      condition: 'AND',
      paths: ['^docs/reports/native-domain-copy-20261009/runner-build\\.json$'],
      regexTarget: 'line',
      // A JSON member whose name is a repo-relative C# source path or an assembly name and whose
      // value is exactly 64 lower-case hex: the shape of one `sourceSha256` or `builds/runtime`
      // entry. A value of another width or case, an upper-case digest, or the same digest under a
      // name that is not a `.cs`/`.dll` path is outside the allowance and still reported.
      regexes: ['^[[:space:]]*"[A-Za-z0-9._/-]+\\.(cs|dll)": "[0-9a-f]{64}",?[[:space:]]*$'],
    },
    literalPath: 'docs/reports/native-domain-copy-20261009/runner-build.json',
    matchOf: (line) => line,
    accepts: null,
    rejects: digestInventoryControls,
    inventory: { lines: 736, sha256: 'b172f9846e98d3a4649b2e1b24d10ac8e21acd1710d50ec1c30a890d8b0242fe' },
  },
  {
    id: 'native-domain-copy-candidate-acceptance-artifact-digests',
    fields: {
      targetRules: ['generic-api-key'],
      condition: 'AND',
      paths: ['^docs/reports/native-domain-copy-20261009/candidate-acceptance\\.json$'],
      regexTarget: 'line',
      // The same class for compiled artefacts: a `.nef` name mapped to its 64-hex SHA-256, the
      // shape of one `artifactHashes` entry.
      regexes: ['^[[:space:]]*"[A-Za-z0-9._/-]+\\.nef": "[0-9a-f]{64}",?[[:space:]]*$'],
    },
    literalPath: 'docs/reports/native-domain-copy-20261009/candidate-acceptance.json',
    matchOf: (line) => line,
    accepts: null,
    rejects: digestInventoryControls,
    inventory: { lines: 3, sha256: '646342edcc462ef3d5d17275ae038d0fba36466738761b5c466172632e4973bd' },
  },
  {
    id: 'native-domain-copy-comparison-artifact-digests',
    fields: {
      targetRules: ['generic-api-key'],
      condition: 'AND',
      paths: ['^docs/reports/native-domain-copy-20261009/comparison\\.json$'],
      regexTarget: 'line',
      regexes: ['^[[:space:]]*"[A-Za-z0-9._/-]+\\.nef": "[0-9a-f]{64}",?[[:space:]]*$'],
    },
    literalPath: 'docs/reports/native-domain-copy-20261009/comparison.json',
    matchOf: (line) => line,
    accepts: null,
    rejects: digestInventoryControls,
    inventory: { lines: 6, sha256: '4e21ff6af5575be1acd44fd5ecb53d30b13c233ec29f22b0d5fbf531e9fee237' },
  },
  {
    id: 'native-usability-private-runtime-session-verifier-hashes',
    fields: {
      targetRules: ['generic-api-key'],
      condition: 'AND',
      paths: ['^docs/reports/native-usability-20261009/private-runtime\\.json$'],
      regexTarget: 'line',
      // The `accounts` and `proxies` entries for `SessionKeyVerifier`: a 20-byte Neo script hash,
      // with and without the `0x` prefix the report uses for contracts. That report declares
      // `publicNetworksTouched: false` and `networkMagic: 2787300650`, an ephemeral neo-express
      // chain, and its proxy hash differs from the shared TestNet `saSessionKeyVerifier` the
      // registry carries - so this is a private-chain address, not even a public deployment.
      regexes: ['^[[:space:]]*"SessionKeyVerifier": "(0x)?[0-9a-f]{40}",?[[:space:]]*$'],
    },
    literalPath: 'docs/reports/native-usability-20261009/private-runtime.json',
    matchOf: (line) => line,
    accepts: null,
    rejects: (line) => [
      { why: 'a hash of another width under the reviewed member', line: line.replace(/[0-9a-f]{40}/, (hash) => hash.slice(1)) },
      { why: 'an upper-case value under the reviewed member', line: line.replace(/[0-9a-f]{40}/, (hash) => hash.toUpperCase()) },
      { why: 'the same value under a member the allowance does not name', line: line.replace(/"[^"]+":/, '"apiKey":') },
    ],
    inventory: { lines: 2, sha256: '611a3495cf8bb7a3158fa60d06cbcb518f0b218e7a93b4b19775aa150e6facb0' },
  },
  // The 2026-10 reports add 93 findings of the same non-secret class: a file-shaped
  // JSON member whose value is the SHA-256 of a public source, model or artifact.
  // The allowance is still per artifact and per value class; the inventory binds
  // every matched line and the exact receipt bytes.
  ...digestReportInventoryAllowances(),
];

function digestReportInventoryAllowances() {
  const fieldsFor = (literalPath) => ({
    targetRules: ['generic-api-key'],
    condition: 'AND',
    paths: [`^${escapeRegex(literalPath)}$`],
    regexTarget: 'line',
    regexes: ['^[[:space:]]*"[A-Za-z0-9._/-]+\\.(cs|csproj|json|nef|dll|props|targets)": "[0-9a-f]{64}",?[[:space:]]*$'],
  });
  const entry = (id, literalPath, lines, sha256) => ({
    id,
    fields: fieldsFor(literalPath),
    literalPath,
    matchOf: (line) => line,
    accepts: null,
    rejects: digestInventoryControls,
    inventory: { lines, sha256 },
  });
  return [
    // Re-triaged when the AA -> SA rename changed the schema string to sa-formal-source-lock/v2 and
    // renamed coq/SmartAccountAA.v to coq/SmartAccountSA.v: same 349 digest lines, new bytes.
    // Re-triaged again when the contracts moved under contracts/{custom,plugins}: 45 keys renamed,
    // every digest value unchanged. The same change dropped the two pins of the deleted
    // SmartAccount.HookChildren.cs / SmartAccount.VerifierChildren.cs partials and re-pinned
    // scripts/build_native_modules.py for its path rewrite: 347 digest lines.
    // Re-triaged when the public build profile was renamed v3 -> public and the three
    // coq/Ordinary*.v model keys became coq/Custom*.v: no digest line changed.
    // Re-triaged for the v4 module protocol: contracts/plugins/verifiers/ became
    // contracts/plugins/validators/ (Verifier* shared files became Validator*), the
    // v4 core partials (Intents, Message, Migration, ModuleProtocol, Modules, Nonce,
    // Proxy, Events) joined the roster, and the external native-core pins were
    // re-read from the reviewed core HEAD: 354 digest lines.
    // Re-triaged when the native PAIRED FILE comment and the custom-kernel wording
    // were corrected in SmartAccount.ModuleProtocol.cs: one pin's value reviewed
    // and updated.
    // Re-triaged for the v4 native core roster: SmartAccountState.cs became
    // SmartAccountRecords.cs, Intents/Message/ModuleProtocol joined, and the ten
    // rewritten native files plus ApplicationEngine.Runtime.cs were re-pinned from
    // the reviewed core checkout: 357 digest lines.
    // Re-triaged for the v4 native packaging: the native-v4 marker replacement in
    // scripts/native_module_profile.py, the v4 parameter-sheet references in
    // scripts/build_native_modules.py, and the native-v4 wording in
    // docs/proposals/SMARTACCOUNT-NATIVE-MODULE-PROFILES.md were reviewed against
    // the sources and re-pinned; same 357 digest lines, new bytes.
    // Re-triaged for the v4 generation/provenance work: nine repo pins (the six
    // rewritten custom partials, DailyLimitHook, the authority-epoch proposal and
    // scripts/verify_repo.sh) and eight external native-core pins were re-read from
    // the reviewed sources through formal/verify.py's own digest functions; no key
    // was added or removed, so the digest-line count is unchanged.
    // Re-triaged for the native-only cleanup: the retired custom sources left the
    // roster (60 pinned repo sources remain), and SmartAccount.cs,
    // SmartAccountModuleProtocol.cs, scripts/check_neo_platform_packages.mjs and
    // scripts/verify_repo.sh were re-read through formal/verify.py's own digest
    // function: 349 digest lines. verify_repo.sh was re-pinned once more after the
    // native gate re-adopted the docs dependency-security and identity-bundle
    // browser checks the custom profile used to own.
    // Re-triaged for the 2026-11-22 re-pin: sources 60 -> 56 and nativeCoreSources
    // 313 -> 309 (verify.py re-pinned in the same pass). The allowance regex reaches
    // 341 of the lock's 365 digest lines; the other 24 name extensions outside the
    // reviewed class (.md/.py/.sh/.mjs/.txt/.resx, Dockerfile, nuget.config).
    // Re-pinned once more on 2026-11-22 when the native threshold-policy guards and
    // check_multisig_bounded retired from verify.py: only the formal/verify.py digest
    // value changed, so the count stays 341 (a .py line is outside the reviewed class)
    // and the full-text hash moved.
    // Re-pinned for the 2026-11-22 protocol-audit fixes: the six native SmartAccount
    // kernel sources (SmartAccount.cs, SmartAccount.Execution.cs, SmartAccount.Modules.cs,
    // SmartAccountRecords.cs, SmartAccountModulePolicy.cs, SmartAccountModuleProtocol.cs)
    // and their six mirrored external native-core pins were re-read through
    // formal/verify.py's own digest functions; no key was added or removed, so the
    // count stays 341 and the full-text hash moved.
    // Re-pinned for the C-24 implementation round: SmartAccount.Modules.cs,
    // SmartAccount.cs and SmartAccountModuleProtocol.cs (three kernel sources and
    // their three mirrored external native-core pins) were re-read through
    // formal/verify.py's own digest functions; no key was added or removed, so the
    // count stays 341 and the full-text hash moved.
    // Re-pinned for the 2026-11-24 recovery-policy decision: six existing digests moved
    // (RecoveryModule.cs, SmartAccount.Modules.cs, SmartAccountRecords.cs,
    // SA-MODULE-PROTOCOL.md, nep-smartaccount-module-profiles.mediawiki and
    // smartaccount-named-module-interfaces.json); no key was added or removed, so the
    // count stays 341 and the full-text hash moved.
    // Core and module proposal inputs are bound alongside the reviewed model sources.
    // Re-pinned for the v4.1 release re-lock: the same 361 digest lines were re-read
    // through formal/verify.py's own functions (81 sources, 309 native-core files) after
    // the nonce, gas, reset-initialization and module-artifact changes; no key was added
    // or removed, so the line count stays and only the full-text hash moved.
    // Re-pinned 2026-11-26 for the v4.1 profile-digest correction: the lock was
    // regenerated through formal/verify.py's own functions (81 -> 80 sources, 309 -> 308
    // native-core files, the retired SmartAccountEnvelope.cs left both rosters), so the
    // count is 359 and the full-text hash moved.
    // Re-pinned 2026-11-26 for the profile-parameter correction (accountDescriptorFields
    // 15 -> 9, batchMax 32 -> 64): five digest lines moved (the core contract, its
    // native-core copy, SA-MODULE-PROTOCOL, the IDL-facing module-profiles draft and
    // the parameter file itself); no key was added or removed, so the count stays 359.
    entry('sa-formal-source-lock-content-digests',
      'formal/source-lock.json', 359,
      'fd904998a928902cbb0d7374a7b37069e494be7ff057a17dd229abb764dee77d'),
    entry('sa-artifact-reproducibility-20261025-content-digests',
      'docs/reports/sa-artifact-reproducibility-20261025.json', 281,
      '42b29b2c68c76ccf4e1fdfbc17c8c24cf4f23568de1ef24b1d6ab5edaa3953ac'),
    entry('sa-artifact-reproducibility-20261030-content-digests',
      'docs/reports/sa-artifact-reproducibility-20261030.json', 281,
      'a4dab5e934898c42c2944ba0ebc16fce3bd25598e33bf17c72fb2c955bc06da4'),
    entry('sa-artifact-reproducibility-20261031-content-digests',
      'docs/reports/sa-artifact-reproducibility-20261031.json', 281,
      '1b38295dfc9f13ffab795615864ff3903c7c706616691358e7b63789444d3053'),
    entry('sa-artifact-reproducibility-20261113-content-digests',
      'docs/reports/sa-artifact-reproducibility-20261113.json', 283,
      '90a4f52e7cdfaa69a2ae57a349bf20530831e33973f7f05580be6a674825fd2f'),
    entry('sa-artifact-reproducibility-20261116-content-digests',
      'docs/reports/sa-artifact-reproducibility-20261116.json', 296,
      '32762269e32af335e5d2a45b95a9a81d00ebc3fdaf2a89a73689a27177441854'),
    entry('sa-formal-gate-20261030-content-digests',
      'docs/reports/sa-formal-gate-20261030.json', 346,
      '6c467afc4865c0ce091f9683772704a8d1b1faf42e9181dee4b65e50fbd32f07'),
    entry('sa-formal-gate-20261031-content-digests',
      'docs/reports/sa-formal-gate-20261031.json', 347,
      '0e4d67450a326c318f971ddd7c31c6c5383fe097d5aa9a33ef48b2e814088198'),
    entry('sa-native-ci-probe-consistency-20261009-content-digests',
      'docs/reports/sa-native-ci-probe-consistency-20261009.json', 14,
      '55c58d6989b3da94bc151b68e0ac43d090cba6121a697a3a04347f3afe79e198'),
  ];
}

// The controls for a digest-inventory allowance, derived from a line the artefact itself carries so
// this guard holds no copy of the artefact: a digest one character short, the same digest in upper
// case, and the same digest under a member name that is not a source path. All three must still be
// reported, which is what makes the allowance a class and not a blanket.
function digestInventoryControls(line) {
  return [
    { why: 'a digest one character short of the reviewed width', line: line.replace(/"[0-9a-f]{64}"/, (digest) => `"${digest.slice(1, -2)}"`) },
    { why: 'the reviewed digest in upper case', line: line.replace(/[0-9a-f]{64}/, (digest) => digest.toUpperCase()) },
    { why: 'the reviewed digest under a member that is not a source path', line: line.replace(/"[^"]+":/, '"apiKey":') },
  ];
}

// The population this row classified, by artefact: the files and per-file counts the canonical
// scan of the default head reports. The original 2026-10-12 row classified 37 findings over
// `be06b8f..3dc7d8a`; the 2026-10 artifact refresh adds 93 findings of the same digest-map class.
// The scanner-level test below holds both directions against every count.
const CU231_CLASSIFIED = new Map([
  // 2026-11-22 source-lock re-pin (sources 60 -> 56, nativeCoreSources 313 -> 309):
  // the canonical control scan of the new lock bytes reports 17 findings, was 19.
  ['formal/source-lock.json', 17],
  ['docs/reports/sa-artifact-reproducibility-20261025.json', 37],
  ['docs/reports/sa-artifact-reproducibility-20261030.json', 37],
  ['docs/reports/sa-artifact-reproducibility-20261031.json', 37],
  ['docs/reports/sa-artifact-reproducibility-20261113.json', 37],
  ['docs/reports/sa-artifact-reproducibility-20261116.json', 37],
  ['docs/reports/sa-formal-gate-20261030.json', 18],
  ['docs/reports/sa-formal-gate-20261031.json', 18],
  ['docs/reports/sa-native-ci-probe-consistency-20261009.json', 1],
  ['docs/reports/native-domain-copy-20261009/runner-build.json', 32],
  ['docs/reports/native-domain-copy-20261009/candidate-acceptance.json', 1],
  ['docs/reports/native-domain-copy-20261009/comparison.json', 2],
  ['docs/reports/native-usability-20261009/private-runtime.json', 2],
]);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One line of TOML, with comments removed and triple-quoted strings kept whole. `open` carries a
// triple quote that is still open at the end of the line, so a multi-line description can never
// hide a table header or a key from this parser.
function scanTomlLine(raw) {
  let code = '';
  let open = null;
  for (let index = 0; index < raw.length;) {
    const three = raw.slice(index, index + 3);
    if (three === "'''" || three === '"""') {
      code += three;
      open = open === three ? null : open || three;
      index += 3;
      continue;
    }
    if (!open && raw[index] === '#') break;
    code += raw[index];
    index += 1;
  }
  return { code, open };
}

function tomlStatements(text) {
  const statements = [];
  let open = null;
  for (const raw of text.split('\n')) {
    if (open) {
      if (raw.includes(open)) open = null;
      statements.push('');
      continue;
    }
    const scanned = scanTomlLine(raw);
    if (scanned.open) open = scanned.open;
    statements.push(scanned.code);
  }
  return statements;
}

function splitTomlList(inner) {
  const items = [];
  let current = '';
  let open = null;
  for (let index = 0; index < inner.length;) {
    const three = inner.slice(index, index + 3);
    if (three === "'''" || three === '"""') {
      open = open === three ? null : open || three;
      current += three;
      index += 3;
      continue;
    }
    if (!open && (inner[index] === '"' || inner[index] === "'")) { open = inner[index]; current += inner[index]; index += 1; continue; }
    if (!open && inner[index] === ',') { items.push(current); current = ''; index += 1; continue; }
    current += inner[index];
    index += 1;
  }
  if (current.trim()) items.push(current);
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

// Values are compared by value, not by spelling: quoting style, whitespace, a trailing comma or a
// different key order do not change what gitleaks suppresses, so they must not change this verdict.
function parseTomlValue(raw) {
  const value = raw.trim();
  if (value.startsWith('[')) {
    return splitTomlList(value.slice(1, value.lastIndexOf(']'))).map((item) => parseTomlValue(item));
  }
  for (const quote of ["'''", '"""', '"', "'"]) {
    if (value.length >= 2 * quote.length && value.startsWith(quote) && value.endsWith(quote)) {
      return value.slice(quote.length, value.length - quote.length);
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

// The whole file as suppression carriers. Every table the review did not triage is a carrier too:
// [allowlist] and [[rules.allowlists]] suppress findings just as [[allowlists]] does.
function parseGitleaksConfig(text) {
  const parsed = {
    topLevel: new Map(), allowlists: [], legacyTables: [], ruleBlocks: [],
    ruleAllowlists: [], otherTables: [], extend: new Map(), extendAt: 0,
  };
  let current = null;
  tomlStatements(text).forEach((line, index) => {
    const at = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    const header = trimmed.match(/^\[\[?([^\]]+?)\]\]?$/);
    if (header) {
      const name = header[1].trim();
      if (name === 'allowlists') { current = { kind: 'allowlist', name, fields: new Map(), at }; parsed.allowlists.push(current); return; }
      if (name === 'allowlist') { current = { kind: 'legacy', name, fields: new Map(), at }; parsed.legacyTables.push(current); return; }
      if (name === 'rules') { current = { kind: 'rule', name, fields: new Map(), at }; parsed.ruleBlocks.push(current); return; }
      if (name === 'rules.allowlists' || name === 'rules.allowlist') {
        current = { kind: 'rule-allowlist', name, fields: new Map(), at };
        parsed.ruleAllowlists.push(current);
        return;
      }
      if (name === 'extend') { current = { kind: 'extend', name, fields: parsed.extend, at }; parsed.extendAt = at; return; }
      current = { kind: 'other', name, fields: new Map(), at };
      parsed.otherTables.push(current);
      return;
    }
    const assignment = trimmed.match(/^([A-Za-z_][\w.-]*)\s*=\s*([\s\S]*)$/);
    if (!assignment) return;
    const [, key, rawValue] = assignment;
    if (!current) parsed.topLevel.set(key, parseTomlValue(rawValue));
    else current.fields.set(key, parseTomlValue(rawValue));
  });
  return parsed;
}

const canonicalAllowlist = (fields) => JSON.stringify(Object.fromEntries(
  [...ALLOWLIST_KNOWN_KEYS].sort().filter((key) => fields.has(key)).map((key) => [key, fields.get(key)])));

const sameAllowlist = (entry, block) => canonicalAllowlist(new Map(Object.entries(entry.fields))) === canonicalAllowlist(block.fields);

const describeAllowlist = (block) => `${block.fields.has('paths') ? `paths ${JSON.stringify(block.fields.get('paths'))}` : 'no path'}`
  + `${block.fields.has('regexes') ? `, regexes ${JSON.stringify(block.fields.get('regexes'))}` : ', no regex'}`
  + `${block.fields.has('description') ? `, "${String(block.fields.get('description')).slice(0, 60)}"` : ''}`;

// Return every carrier outside the primary config for validation. Only the exact
// pinned root fingerprint file is also reviewed; nested configurations stay refused.
function otherGitleaksFiles() {
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      if (skipped(entry)) continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) walk(relative); continue; }
      if (GITLEAKS_CONFIG_FILES.includes(entry.name) && relative !== GITLEAKS_CONFIG)
        found.push(relative.split(path.sep).join('/'));
    }
  })('.');
  return found.sort();
}

// The reported set. An empty array is the only accepting verdict; every entry names the carrier it
// refuses and the line it sits on. Nothing here reports a boolean or an exit code, so a mutant can
// only be killed by a violation that names it.
function configurationViolations(text, files = otherGitleaksFiles(),
  ignoreText = exists(REVIEWED_GITLEAKS_IGNORE.path) ? read(REVIEWED_GITLEAKS_IGNORE.path) : '') {
  const problems = [];
  const add = (kind, detail) => problems.push(`${kind}: ${detail}`);
  if (!text.trim()) {
    add('missing-configuration', `${GITLEAKS_CONFIG} is absent; the reviewed allowances are not the ones a scan would apply`);
    return problems;
  }
  const parsed = parseGitleaksConfig(text);
  for (const table of parsed.legacyTables) {
    add('legacy-singular-table', `${GITLEAKS_CONFIG}:${table.at} uses [allowlist], the pre-8.19 table this review did not triage; alone it suppresses globally, and gitleaks refuses it beside [[allowlists]]`);
  }
  for (const block of parsed.ruleBlocks) {
    add('rule-override', `${GITLEAKS_CONFIG}:${block.at} redefines a rule ([[rules]]); a redefinition can drop a default rule's detection or carry its own allowance`);
  }
  for (const block of parsed.ruleAllowlists) {
    add('rule-scoped-allowlist', `${GITLEAKS_CONFIG}:${block.at} attaches an allowance to one rule ([${block.name}]), a placement this review did not triage`);
  }
  for (const table of parsed.otherTables) {
    add('unknown-table', `${GITLEAKS_CONFIG}:${table.at} carries [${table.name}], which the reviewed configuration does not`);
  }
  for (const [key, value] of parsed.topLevel) {
    if (['minVersion', 'maxVersion', 'title', 'description'].includes(key)) continue;
    add('unreviewed-key', `${GITLEAKS_CONFIG} sets the top-level ${key} = ${JSON.stringify(value)}, which the reviewed configuration does not`);
  }
  if (parsed.extend.has('path')) {
    add('extend-path', `${GITLEAKS_CONFIG}:${parsed.extendAt} reaches another configuration through [extend] path = ${JSON.stringify(parsed.extend.get('path'))}; that file is outside this guard's inventory`);
  }
  if (!parsed.extend.has('useDefault')) {
    add('defaults-missing', `${GITLEAKS_CONFIG} does not set [extend] useDefault = true; the default rules are the detection this configuration must keep`);
  } else if (parsed.extend.get('useDefault') !== true) {
    add('defaults-disabled', `${GITLEAKS_CONFIG}:${parsed.extendAt} sets [extend] useDefault = ${JSON.stringify(parsed.extend.get('useDefault'))}; the default rules are the detection this configuration must keep`);
  }
  const remaining = [...reviewedAllowlists()];
  parsed.allowlists.forEach((block) => {
    for (const key of block.fields.keys()) {
      if (key === 'description' || ALLOWLIST_REVIEWED_KEYS.includes(key)) continue;
      add('unreviewed-field', `${GITLEAKS_CONFIG}:${block.at} sets ${key} inside a [[allowlists]] block; the reviewed form carries only ${ALLOWLIST_REVIEWED_KEYS.join(', ')}`);
    }
    const at = remaining.findIndex((entry) => sameAllowlist(entry, block));
    if (at === -1) {
      add('unreviewed-allowlist', `${GITLEAKS_CONFIG}:${block.at} carries a [[allowlists]] block (${describeAllowlist(block)}) that is not one of the ${reviewedAllowlists().length} allowances this review triaged`);
    } else {
      remaining.splice(at, 1);
    }
  });
  for (const entry of remaining) {
    add('missing-allowlist', `${GITLEAKS_CONFIG} does not carry the reviewed ${entry.id} allowance as reviewed; every suppression the scanner applies must be one the review triaged`);
  }
  for (const file of files) {
    if (file === REVIEWED_GITLEAKS_IGNORE.path
      && createHash('sha256').update(ignoreText).digest('hex') === REVIEWED_GITLEAKS_IGNORE.sha256) continue;
    add('extra-configuration', `${file} is outside the reviewed configuration/fingerprint set or has unreviewed contents`);
  }
  return problems;
}

const violationKinds = (problems) => [...new Set(problems.map((problem) => problem.split(':')[0]))].sort();

const configurationProblems = () => configurationViolations(exists(GITLEAKS_CONFIG) ? read(GITLEAKS_CONFIG) : '');

// The reviewed allowances, each held to one file and one value, with both directions of that
// boundary asserted. DS-CU-163 section 12.4 established the shape with planted secrets in a clone;
// here it runs against the repository copy itself, for every entry rather than for one.
test('CU-202: every reviewed allowance stays attached to the one value it triaged', () => {
  const ignoreText = read(REVIEWED_GITLEAKS_IGNORE.path);
  assert.equal(createHash('sha256').update(ignoreText).digest('hex'), REVIEWED_GITLEAKS_IGNORE.sha256,
    'the historical ignore file must contain only the exact reviewed fingerprint bytes');
  const fingerprints = ignoreText.trimEnd().split('\n');
  assert.equal(fingerprints.length, REVIEWED_GITLEAKS_IGNORE.findings);
  assert.equal(new Set(fingerprints).size, REVIEWED_GITLEAKS_IGNORE.findings);
  const actualGroups = {};
  for (const fingerprint of fingerprints) {
    const match = /^([0-9a-f]{40}:[^:]+):generic-api-key:\d+$/.exec(fingerprint);
    assert.ok(match, 'an exception must identify a commit, path, rule and line');
    actualGroups[match[1]] = (actualGroups[match[1]] ?? 0) + 1;
  }
  assert.deepEqual(actualGroups, REVIEWED_GITLEAKS_IGNORE.byCommitAndPath);
  assert.ok(reviewedAllowlists().length > 0, 'the reviewed allowance inventory must not be empty');
  for (const entry of reviewedAllowlists()) {
    const where = entry.id;
    assert.equal(entry.fields.targetRules.length, 1, `${where}: the allowance must suppress exactly one rule`);
    assert.equal(entry.fields.condition, 'AND', `${where}: every clause of the allowance must have to match`);
    assert.ok(['line', 'match'].includes(entry.fields.regexTarget), `${where}: the allowance must constrain a reviewed target, not ${entry.fields.regexTarget}`);
    // The path half: one file, named literally, with no pattern power and no second match anywhere
    // in the tree. A wildcard, a missing anchor or a prefix match breaks the equality below.
    assert.equal(entry.fields.paths.length, 1, `${where}: the allowance must name exactly one path`);
    assert.equal(entry.fields.paths[0], `^${escapeRegex(entry.literalPath)}$`,
      `${where}: the path clause must be the literal path and nothing else`);
    const pathRegex = new RegExp(entry.fields.paths[0]);
    const reached = tracked.filter((file) => pathRegex.test(file));
    assert.deepEqual(reached, [entry.literalPath], `${where}: the path clause must reach exactly the one file it triages`);
    // The value half: one anchored regex, matching the reviewed assignment in its own document.
    // gitleaks reads Go's regexp, where [[:space:]] is a POSIX class JavaScript does not carry, so
    // that one class is translated; any other POSIX class fails here instead of being read wrongly.
    assert.equal(entry.fields.regexes.length, 1, `${where}: the allowance must carry exactly one value regex`);
    const source = entry.fields.regexes[0];
    assert.match(source, /^\^[\s\S]*\$$/, `${where}: the value regex must be anchored at both ends`);
    assert.ok(!/\[\[:(?!space:\]\])/.test(source), `${where}: the allowance uses a POSIX class this test cannot translate`);
    const pattern = new RegExp(source.replace(/\[\[:space:\]\]/g, '[ \\t]'));
    const matchesLine = (line) => {
      const target = entry.matchOf(line);
      return typeof target === 'string' && pattern.test(target);
    };
    const covered = read(entry.literalPath).split('\n').filter(matchesLine);
    // One value, one line: the reviewed unit for an allowance that triages a single assignment. An
    // inventory allowance (CU-231) triages one value class across a generated artefact instead, so
    // the reviewed unit is the artefact's bytes: the entry records how many lines the allowance
    // reaches and the SHA-256 it read, and both are held here. The digest is the half that matters
    // - a line count alone would let an edited artefact keep its allowance by keeping the count.
    const expectedLines = entry.inventory ? entry.inventory.lines : 1;
    assert.equal(covered.length, expectedLines,
      `${where}: the allowance must match exactly ${expectedLines} line(s) of the document it triages; it matches ${covered.length}`);
    if (entry.inventory) {
      assert.ok(entry.inventory.lines > 0, `${where}: an inventory allowance that reaches no line suppresses nothing and must be removed`);
      // The triage pinned the LF bytes of the artefact (the committed form); read() applies the
      // same normalization, so an autocrlf worktree measures the same content.
      const digest = createHash('sha256').update(read(entry.literalPath)).digest('hex');
      assert.equal(digest, entry.inventory.sha256,
        `${where}: ${entry.literalPath} no longer carries the bytes this triage reviewed; review the new bytes and record their digest here`);
    }
    if (entry.canonicalValue) {
      const value = covered[0].match(entry.canonicalValue)[0];
      assert.ok(canonicalHashes.has(value.toLowerCase()),
        `${where}: the allowed value ${value} must be the canonical registry hash, not a value generatedMorpheusRegistry.js does not carry`);
    }
    for (const accepted of entry.accepts || [covered[0]]) {
      assert.ok(matchesLine(accepted), `${where}: the allowance must still cover the assignment it triages`);
    }
    // Controls may be declared as a list or derived from the reviewed line, so an allowance whose
    // value this guard must not copy can still state both directions of its boundary.
    const rejected = (typeof entry.rejects === 'function' ? entry.rejects(covered[0]) : entry.rejects) || [
      { why: 'a different value on the reviewed line (the DS-CU-163 section 12.4 control)', line: covered[0].replace(/\b0x[0-9a-fA-F]{40}\b/, '0x9f2c41ab77de05361c8b0e4a6d5f31c7b8a2e904') },
      { why: 'the same value under a different identifier', line: covered[0].replace('web3AuthVerifierHash', 'otherVerifierHash') },
    ];
    assert.ok(rejected.length > 0, `${where}: an allowance must state at least one control that is still reported`);
    for (const control of rejected) {
      assert.ok(!matchesLine(control.line), `${where}: ${control.why} must still be reported`);
    }
  }
});

test('CU-202: the gitleaks configuration carries the reviewed allowance set and nothing else', () => {
  const problems = configurationProblems();
  assert.deepEqual(problems, [], `the gitleaks configuration carries suppressions the review did not triage:\n${problems.join('\n')}`);
});

// One mutant per widening shape, taken from the reviewed text itself. Each is refused by a
// violation that names the shape it adds, and the assertion is on the reported set, so no kill is
// incidental and none is read off an exit code.
test('CU-202: every widening of the gitleaks configuration is refused by the shape it adds', () => {
  const base = read(GITLEAKS_CONFIG);
  const appended = (text) => `${base}\n${text}`;
  // Literal replacement, every occurrence: the reviewed value appears in the block's comment as
  // well as in its regex, and a mutant that only rewrote the comment would not be a mutant.
  const replaced = (from, to) => base.split(from).join(to);
  const sdkBlock = base.split('[[allowlists]]').find((entry) => entry.includes('sdk-usage'));
  assert.ok(sdkBlock, 'the reviewed sdk-usage allowance must be in the configuration for these mutants to mean anything');
  const inSdkBlock = (from, to) => base.replace(sdkBlock, () => sdkBlock.split(from).join(to));
  // A mutant that removes a whole field of the reviewed block, addressed by its key rather than by
  // its value, so this test carries no copy of the value the allowance triages.
  const withoutSdkField = (key) => base.replace(sdkBlock, () => sdkBlock.split('\n')
    .filter((line) => !line.trimStart().startsWith(`${key} = `)).join('\n'));
  const shapes = [
    { name: 'control: the reviewed configuration', text: base, kinds: [] },
    { name: 'a second allowance block, global on paths and regexes', text: appended("\n[[allowlists]]\ndescription = \"mutant: a global allowance\"\npaths = ['''.*''']\nregexes = ['''.*''']\n"), kinds: ['unreviewed-allowlist'], names: 'a global allowance' },
    { name: 'a second allowance block, global path only', text: appended("\n[[allowlists]]\ndescription = \"mutant: a global path\"\npaths = ['''.*''']\n"), kinds: ['unreviewed-allowlist'], names: 'a global path' },
    { name: 'a second allowance block, global regex only', text: appended("\n[[allowlists]]\ndescription = \"mutant: a global regex\"\nregexes = ['''.*''']\n"), kinds: ['unreviewed-allowlist'], names: 'a global regex' },
    { name: 'a second allowance block, one rule named but a global regex', text: appended("\n[[allowlists]]\ndescription = \"mutant: rule-scoped global regex\"\ntargetRules = [\"generic-api-key\"]\nregexes = ['''.*''']\n"), kinds: ['unreviewed-allowlist'], names: 'rule-scoped global regex' },
    { name: 'a second allowance block, an empty path regex', text: appended("\n[[allowlists]]\ndescription = \"mutant: empty path\"\npaths = ['''''' ]\n"), kinds: ['unreviewed-allowlist'], names: 'empty path' },
    { name: 'a commit allowlist', text: appended("\n[[allowlists]]\ndescription = \"mutant: commit allowlist\"\ncommits = [\"a64f88968d43fb7daca25ecd2f6965e96d194c59\"]\n"), kinds: ['unreviewed-allowlist', 'unreviewed-field'], names: 'commits inside a [[allowlists]] block' },
    { name: 'a stopword allowance', text: appended("\n[[allowlists]]\ndescription = \"mutant: stopword\"\ntargetRules = [\"generic-api-key\"]\nstopwords = [\"8f3a9c2b\"]\n"), kinds: ['unreviewed-allowlist', 'unreviewed-field'], names: 'stopwords inside a [[allowlists]] block' },
    { name: 'a decoy block that names sdk-usage and is placed first', text: replaced('[[allowlists]]', "[[allowlists]]\ndescription = \"mutant: sdk-usage decoy\"\npaths = ['''.*''']\nregexes = ['''.*''']\n\n[[allowlists]]"), kinds: ['unreviewed-allowlist'], names: 'sdk-usage decoy' },
    { name: 'the pre-8.19 singular table, alone', text: "minVersion = \"v8.30.1\"\n\n[extend]\nuseDefault = true\n\n[allowlist]\ndescription = \"mutant: legacy\"\npaths = ['''.*''']\nregexes = ['''.*''']\n", kinds: ['legacy-singular-table', 'missing-allowlist'], names: '[allowlist], the pre-8.19 table' },
    { name: 'a rule redefinition that can never match', text: appended("\n[[rules]]\nid = \"generic-api-key\"\ndescription = \"mutant: rule redefinition\"\nregex = '''nevermatches'''\n"), kinds: ['rule-override'], names: 'redefines a rule' },
    { name: 'a rule-scoped allowance under a new rule', text: appended("\n[[rules]]\nid = \"mutant-rule\"\ndescription = \"mutant: rule scope\"\nregex = '''apiKey'''\n[[rules.allowlists]]\nregexes = ['''.*''']\n"), kinds: ['rule-override', 'rule-scoped-allowlist'], names: '[rules.allowlists]' },
    { name: 'a configuration reached through [extend] path', text: replaced('useDefault = true', 'path = "cu202-extra.toml"'), kinds: ['defaults-missing', 'extend-path'], names: '[extend] path' },
    { name: 'the default rules switched off', text: replaced('useDefault = true', 'useDefault = false'), kinds: ['defaults-disabled'], names: 'useDefault' },
    { name: 'the exact reviewed historical ignore file', text: base, files: ['.gitleaksignore'], kinds: [] },
    { name: 'an unreviewed .gitleaksignore entry', text: base, files: ['.gitleaksignore'], ignoreText: 'unreviewed\n', kinds: ['extra-configuration'], names: '.gitleaksignore' },
    { name: 'an extra fingerprint beside the reviewed set', text: base, files: ['.gitleaksignore'], ignoreText: `${read(REVIEWED_GITLEAKS_IGNORE.path)}unreviewed\n`, kinds: ['extra-configuration'], names: '.gitleaksignore' },
    { name: 'a nested ignore file with reviewed contents', text: base, files: ['frontend/.gitleaksignore'], kinds: ['extra-configuration'], names: 'frontend/.gitleaksignore' },
    { name: 'a nested configuration', text: base, files: ['frontend/.gitleaks.toml'], kinds: ['extra-configuration'], names: 'frontend/.gitleaks.toml' },
    { name: 'an unknown top-level key', text: replaced('minVersion = "v8.30.1"', 'minVersion = "v8.30.1"\nkeywords = ["mutant"]'), kinds: ['unreviewed-key'], names: 'keywords' },
    { name: 'an unknown table', text: appended("\n[[mutant-table]]\ndescription = \"mutant: unknown table\"\n"), kinds: ['unknown-table'], names: 'mutant-table' },
    { name: 'a broader value regex inside the reviewed block', text: inSdkBlock("const web3AuthVerifierHash = '", "const \\w+ = '"), kinds: ['missing-allowlist', 'unreviewed-allowlist'], names: 'web3auth-verifier-hash' },
    { name: 'a second target rule inside the reviewed block', text: inSdkBlock('targetRules = ["generic-api-key"]', 'targetRules = ["generic-api-key", "stripe-access-token"]'), kinds: ['missing-allowlist', 'unreviewed-allowlist'], names: 'web3auth-verifier-hash' },
    { name: 'a different regexTarget inside the reviewed block', text: inSdkBlock('regexTarget = "line"', 'regexTarget = "match"'), kinds: ['missing-allowlist', 'unreviewed-allowlist'], names: 'web3auth-verifier-hash' },
    { name: 'OR instead of AND inside the reviewed block', text: inSdkBlock('condition = "AND"', 'condition = "OR"'), kinds: ['missing-allowlist', 'unreviewed-allowlist'], names: 'web3auth-verifier-hash' },
    { name: 'the reviewed block without its path', text: withoutSdkField('paths'), kinds: ['missing-allowlist', 'unreviewed-allowlist'], names: 'no path' },
    { name: 'the reviewed block without its value regex', text: withoutSdkField('regexes'), kinds: ['missing-allowlist', 'unreviewed-allowlist'], names: 'no regex' },
  ];
  for (const shape of shapes) {
    const problems = configurationViolations(shape.text, shape.files || [], shape.ignoreText);
    const kinds = violationKinds(problems);
    assert.deepEqual(kinds, [...shape.kinds].sort(), `${shape.name}: the configuration must be refused for the shapes it adds, and for nothing else:\n${problems.join('\n') || '(nothing reported)'}`);
    if (shape.names) {
      assert.ok(problems.some((problem) => problem.includes(shape.names)),
        `${shape.name}: the refusal must name what it refuses (${shape.names}):\n${problems.join('\n')}`);
    }
  }
});

// The scanner-level direction of the same rule, on a throwaway repository: the reviewed
// configuration still reports a secret nothing triaged, and the widening that would silence it is
// refused by the guard rather than by an exit code. Skipped, explicitly, where gitleaks is absent.
test('CU-202: a planted secret survives the reviewed configuration, and the widening that silences it is refused', (t) => {
  let available = true;
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'pipe' });
  } catch {
    available = false;
  }
  if (!available) return t.skip('gitleaks is not on PATH: the scanner-level direction of this rule is unmeasured in this run');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cu202-gitleaks-'));
  const git = (...args) => execFileSync('git', args, { cwd: scratch, stdio: 'pipe' });
  const write = (relative, body) => {
    fs.mkdirSync(path.dirname(path.join(scratch, relative)), { recursive: true });
    fs.writeFileSync(path.join(scratch, relative), body);
  };
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CU-202');
    git('config', 'user.email', 'cu-202@localhost');
    write(GITLEAKS_CONFIG, read(GITLEAKS_CONFIG));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim();
    // Synthetic, high-entropy key material: it is what the rules report, so every direction below
    // measures a real suppression rather than a value no rule would have found.
    const material = 'Zq7xK2mP9vL4nR8tB3wY6cH1jF5dG0sA9bC2eD4fGh6';
    assert.equal(material.length, 43, 'the probe material must be the 43 characters the reviewed keypair allowance pins');
    // Derived, not written down, so this guard carries no scanner-visible secret of its own: the
    // branch's canonical scan is a gate, and a test that plants a literal secret in itself reds it.
    const probeSecret = createHash('sha256').update('CU-202 round 3 probe').digest('hex').slice(0, 48);
    assert.equal(probeSecret.length, 48, 'the probe secret must be the 48 characters the rule reports');
    // A secret nothing triaged; the reviewed identifier carrying that material; and the same
    // material under an identifier the reviewed allowance does not name.
    write('frontend/src/config/probe.js', `export const apiKey = "${probeSecret}";\n`);
    write('sdk/js/tests/morpheus-envelope-roundtrip.unit.test.js', `const GOLDEN_PRIVATE_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEI${material}';\n`);
    write('frontend/src/config/probe-key.js', `const GOLDEN_OTHER_KEY_PKCS8 = 'MC4CAQAwBQYDK2VuBCIEI${material}';\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', 'plant');
    const plant = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim();
    const scan = (label, config) => {
      write(GITLEAKS_CONFIG, config);
      const report = path.join(scratch, `${label}.json`);
      // The canonical invocation this repository documents; the verdict is read from the report
      // rather than from the exit code, because a scan that fails writes no report at all.
      try {
        execFileSync('gitleaks', ['git', '--redact', '--no-banner', '--exit-code', '1', `--log-opts=${base}..${plant}`, '--report-format', 'json', `--report-path=${report}`, '.'], { cwd: scratch, stdio: 'pipe' });
      } catch { /* a finding is the expected outcome of the reviewed run */ }
      assert.ok(fs.existsSync(report), `${label}: the scan produced no report`);
      return (JSON.parse(fs.readFileSync(report, 'utf8')) || []).map((found) => `${found.RuleID} ${found.File}`).sort();
    };
    const reviewedConfig = read(GITLEAKS_CONFIG);
    // Both directions of the reviewed keypair allowance: the shape it triaged is not reported, and
    // the same material under another identifier is.
    assert.deepEqual(scan('reviewed', reviewedConfig), [
      'generic-api-key frontend/src/config/probe-key.js',
      'generic-api-key frontend/src/config/probe.js',
    ], 'the reviewed configuration must still report every secret it did not triage');
    // The direction above is only a suppression if the same line is reported without the
    // allowance: the block is removed and the scan must find it.
    const withoutKeypair = reviewedConfig.split('[[allowlists]]')
      .filter((block, index) => index === 0 || !block.includes('morpheus-envelope-roundtrip')).join('[[allowlists]]');
    assert.ok(!withoutKeypair.includes('morpheus-envelope-roundtrip'), 'the control must actually remove the reviewed keypair allowance');
    assert.deepEqual(scan('without-keypair', withoutKeypair), [
      'generic-api-key frontend/src/config/probe-key.js',
      'generic-api-key frontend/src/config/probe.js',
      'generic-api-key sdk/js/tests/morpheus-envelope-roundtrip.unit.test.js',
    ], 'without the reviewed allowance the fixture line must be reported; otherwise the suppression above proves nothing');
    // The widening the reviewer appended. It silences the scan, which is why the guard has to
    // refuse it: the refusal is asserted on the reported set, and the harm is measured here.
    const widened = `${reviewedConfig}\n[[allowlists]]\ndescription = "reviewer probe: a global allowance"\npaths = ['''.*''']\nregexes = ['''.*''']\n`;
    assert.deepEqual(scan('widened', widened), [], 'the widening must be what silences the scan; if it is not, this measurement is not the reviewer\'s');
    const problems = configurationViolations(widened, []);
    assert.equal(violationKinds(problems).includes('unreviewed-allowlist'), true,
      `the guard must refuse the configuration that silences the scan:\n${problems.join('\n') || '(nothing reported)'}`);

    // Historical fingerprints cannot authorize a new credential in the same
    // report path: its new commit produces a different finding identity.
    write(GITLEAKS_CONFIG, reviewedConfig);
    const historicalIgnore = read(REVIEWED_GITLEAKS_IGNORE.path);
    write(REVIEWED_GITLEAKS_IGNORE.path, historicalIgnore);
    write(REVIEWED_GITLEAKS_IGNORE.report, `${JSON.stringify({ apiKey: probeSecret })}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', 'new report credential control');
    const newCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim();
    const newReport = path.join(scratch, 'new-report-credential.json');
    try {
      execFileSync('gitleaks', ['git', '--redact=100', '--no-banner', '--exit-code', '1',
        `--log-opts=${plant}..${newCommit}`, '--report-format', 'json', `--report-path=${newReport}`, '.'],
      { cwd: scratch, stdio: 'pipe' });
    } catch { /* the new credential must still be reported */ }
    assert.ok(fs.existsSync(newReport), 'the new-commit control must produce an actual scanner report');
    const newFindings = JSON.parse(fs.readFileSync(newReport, 'utf8')).map((found) => ({
      rule: found.RuleID, file: found.File, commit: found.Commit, fingerprint: found.Fingerprint,
    }));
    assert.deepEqual(newFindings.map(({ rule, file }) => `${rule} ${file}`),
      [`generic-api-key ${REVIEWED_GITLEAKS_IGNORE.report}`],
      'the historical ignore set must not hide a new credential in the same report path');
    assert.equal(newFindings[0].commit, newCommit);
    assert.ok(!historicalIgnore.split('\n').includes(newFindings[0].fingerprint),
      'a new commit must not borrow a reviewed historical fingerprint');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// The acceptance of CU-231, at the scanner rather than at the guard: the generated reports the
// default head's canonical scan reports are committed into a throwaway repository with the reviewed
// configuration, and the canonical range scan must be clean. The control is the half that gives
// "clean" a meaning - with the classified allowances removed, the same range must report the same
// 130 findings, by artefact and by count. Without it a clean scan could mean the scanner never
// looked. Skipped, explicitly, where gitleaks is absent.
test('CU-231: the reviewed allowances are what clears the classified report findings', (t) => {
  let available = true;
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'pipe' });
  } catch {
    available = false;
  }
  if (!available) return t.skip('gitleaks is not on PATH: the scanner-level direction of this rule is unmeasured in this run');
  const classified = reviewedAllowlists().filter((entry) => entry.inventory);
  assert.deepEqual(classified.map((entry) => entry.literalPath).sort(), [...CU231_CLASSIFIED.keys()].sort(),
    'the inventory allowances and the classified artefacts must be the same set; a classified artefact with no allowance is an unresolved finding');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cu231-gitleaks-'));
  const git = (...args) => execFileSync('git', args, { cwd: scratch, stdio: 'pipe' });
  const write = (relative, body) => {
    fs.mkdirSync(path.dirname(path.join(scratch, relative)), { recursive: true });
    fs.writeFileSync(path.join(scratch, relative), body);
  };
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'CU-231');
    git('config', 'user.email', 'cu-231@localhost');
    write(GITLEAKS_CONFIG, read(GITLEAKS_CONFIG));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'configuration');
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim();
    // The artefacts themselves, byte for byte, added by one commit: that is how the default head
    // carries them, and `gitleaks git` reports a finding against the patch that introduces it.
    for (const relative of CU231_CLASSIFIED.keys()) write(relative, read(relative));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'reports');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim();
    // The canonical invocation this repository documents, with the verdict read from the report
    // rather than from the exit code: a scan that fails to run writes no report at all.
    const perFile = (label, config) => {
      write(GITLEAKS_CONFIG, config);
      const report = path.join(scratch, `${label}.json`);
      try {
        execFileSync('gitleaks', ['git', '--redact', '--no-banner', '--exit-code', '1', `--log-opts=${base}..${head}`, '--report-format', 'json', `--report-path=${report}`, '.'], { cwd: scratch, stdio: 'pipe' });
      } catch { /* a finding is the expected outcome of the control run */ }
      assert.ok(fs.existsSync(report), `${label}: the scan produced no report`);
      const counts = new Map();
      for (const found of JSON.parse(fs.readFileSync(report, 'utf8')) || []) {
        counts.set(found.File, (counts.get(found.File) || 0) + 1);
      }
      return counts;
    };
    const reviewedConfig = read(GITLEAKS_CONFIG);
    assert.deepEqual(perFile('reviewed', reviewedConfig), new Map(),
      'the reviewed configuration must leave the canonical scan of these artefacts clean');
    // The same range with the classified allowances dropped, addressed by the path clause each
    // one carries so the control cannot silently remove a different block.
    const withoutClassified = reviewedConfig.split('[[allowlists]]')
      .filter((block, index) => index === 0 || !classified.some((entry) => block.includes(entry.fields.paths[0])))
      .join('[[allowlists]]');
    assert.equal(withoutClassified.split('[[allowlists]]').length, reviewedConfig.split('[[allowlists]]').length - classified.length,
      'the control must remove exactly the classified allowances');
    assert.deepEqual(perFile('without-classified', withoutClassified), CU231_CLASSIFIED,
      'without the classified allowances the canonical scan must report the findings this row classified; otherwise the clean scan above proves nothing');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('CU-163: the current-runtime documents state only what the code and the deployed artifacts decide', () => {
  const problems = failures();
  assert.deepEqual(problems, [], `documentation drift:\n${problems.join('\n')}`);
});

test('CU-163: source-bridge scope is explicit and admits only current source or pinned runtime names', () => {
  const used = new Set();
  for (const [file, entry] of SOURCE_BRIDGE_DOCS) {
    assert.ok(CURRENT_DOCS.includes(file), `${file}: source-bridge class is not attached to a current document`);
    assert.ok(exists(file), `${file}: source-bridge document does not exist`);
    assert.ok(entry.reason.length >= 40, `${file}: source-bridge entry needs a reason it must stay`);
    assert.ok(entry.marker.test(read(file)),
      `${file}: source-bridge entry must keep a visible pinned-source scope declaration`);
    // A citation is any inline code span naming the symbol, not only one the call-shape vocabulary
    // reads. This matters for `Register` (the ApplicationEngine interop registration method): its
    // C# definition lives in the pinned Neo Core source, outside this repository, so no contract
    // source or manifest here can put the symbol into the callable vocabulary - the citation check
    // below is the only oracle that keeps a reviewed pinned symbol in evidence.
    for (const line of read(file).split('\n')) {
      for (const span of codeSpans(line)) {
        for (const segment of spanSegments(span)) {
          const last = segment.split('.').pop();
          if (last) used.add(last);
        }
      }
    }
  }

  assert.ok(currentContractSourceNames.has('ClearAccount'));
  assert.ok(currentContractSourceNames.has('clearAccount'));
  assert.ok(currentContractSourceNames.has('RequirePinnedCore'));
  assert.ok(currentContractSourceNames.has('requirePinnedCore'));
  for (const [name, reason] of PINNED_RUNTIME_SYMBOLS) {
    assert.ok(reason.length >= 40, `${name}: pinned runtime symbol needs a reviewed rationale`);
    assert.ok(used.has(name), `${name}: pinned runtime symbol is no longer cited by a source-bridge document`);
  }

  assert.ok(isSourceBridgeName('docs/engineering/HANDOFF-RECORDS.md', 'CallFromNativeContractAsync'));
  assert.ok(isSourceBridgeName('docs/engineering/HANDOFF-RECORDS.md', 'ClearAccount'));
  assert.ok(!isSourceBridgeName('docs/ARCHITECTURE.md', 'Register'),
    'a source-bridge name escaped into a deployed-ABI document');
  assert.ok(!isSourceBridgeName('docs/engineering/HANDOFF-RECORDS.md', 'ExecuteInjectedBridgeOp'),
    'the source-bridge class admitted a name from neither permitted oracle');

  // The rule itself must be able to fail in the real scanner. Plant a call that exists in neither the
  // current contract source nor the reviewed pinned-runtime set and require the current-runtime gate
  // to report it, then restore the document for every later test.
  const target = 'docs/engineering/HANDOFF-RECORDS.md';
  const absolute = path.join(repoRoot, target);
  // The plant and its checks run on LF-normalized content (the committed form), while the restore
  // writes the raw worktree bytes back, so an autocrlf checkout neither defeats the marker lookup
  // nor has its line endings rewritten by the test.
  const original = fs.readFileSync(absolute, 'utf8');
  const normalized = original.replace(/\r\n?/g, '\n');
  // The merged book demoted the former SA-CONTRACT-HANDOFF.md chapter headings one
  // step, so the pinned-source declaration is now a chapter section.
  const heading = normalized.split('\n').find((line) => line.startsWith('### Pinned inputs'));
  assert.ok(heading, 'the planted-drift document lost its pinned-source marker');
  fs.writeFileSync(absolute,
    normalized.replace(heading, `${heading}\n\n\`ExecuteInjectedBridgeOp()\` is not in either oracle.`));
  try {
    const problems = failures();
    assert.ok(problems.some((problem) => problem.includes(`${target}:`)
      && problem.includes('ExecuteInjectedBridgeOp is not defined in any contract, manifest or SDK source')),
    `the source-bridge allowance suppressed an unknown name:\n${problems.join('\n')}`);
  } finally {
    fs.writeFileSync(absolute, original);
  }
});

// The ledger, not a document's prose, is the current VULN-001 state. No build bounds a
// callback's gas, so the ledger must say the public state is open. Closing it requires a
// platform capability that does not exist; a ledger edit alone can never satisfy this guard.
test('CU-163: the VULN-001 ledger stays open while no build bounds a callback\'s gas', () => {
  const row = read('docs/SECURITY.md').split('\n').find((line) => /\*\*VULN-001\*\*/.test(line));
  assert.ok(row, 'docs/SECURITY.md has no VULN-001 row');
  assert.match(row, /open|not\b|pending/i,
    `${VULN_001_OPEN_REASON}, so the ledger must not close VULN-001 for the public build`);
});

// VULN-002 has local source, scoped formal and private-chain evidence, but no public deployment.
// Keep the ledger from collapsing those three states into an unsupported public-closure claim.
test('CU-163: VULN-002 records local evidence without claiming public deployment', () => {
  const row = read('docs/SECURITY.md').split('\n').find((line) => /\*\*VULN-002\*\*/.test(line));
  assert.ok(row, 'docs/SECURITY.md has no VULN-002 row');
  assert.match(row, /source candidate/i);
  assert.match(row, /scoped Coq governance\/recovery models/i);
  assert.match(row, /private NeoExpress escape\/market scenarios verified/i);
  assert.match(row, /TestNet\/MainNet deployment parity remains pending/i);

  for (const file of ['formal/coq/CustomGovernance.v', 'formal/coq/CustomRecovery.v']) {
    assert.ok(exists(file), `VULN-002 cites a missing formal model: ${file}`);
  }

  const receipt = JSON.parse(read('docs/reports/sa-neoexpress-validation-20261031.json'));
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.network.publicNetwork, false);
  assert.ok(receipt.scenarios.some((scenario) => scenario.name === 'escape hatch'));
  assert.ok(receipt.scenarios.some((scenario) => /^market escrow:/.test(scenario.name)));
});

// ERC-1271 direct-digest verification has a hardfork-dependent CryptoLib implementation.
// The reviewed path is the Huyao implementation with r/s bounds; the pre-Huyao compatibility
// implementation remains outside the deployment profile even though it exposes the same method.
test('CU-163: Web3Auth ERC-1271 documents its Huyao deployment requirement', () => {
  const web3auth = read('contracts/plugins/validators/Web3AuthValidator.cs');
  assert.match(web3auth, /CryptoLib\.RecoverSecp256K1\(hash, signature\)/,
    'the message adapter no longer consumes the supplied digest directly');

  for (const file of [
    'docs/SECURITY.md',
    'docs/engineering/VERIFICATION-AND-GATES.md',
  ]) {
    const text = read(file).replace(/\s+/g, ' ');
    assert.match(text, /Web3Auth\s+ERC-1271.*`?HF_Huyao`? or later/i,
      `${file} does not pin the reviewed ERC-1271 hardfork profile`);
    assert.match(text, /pre-Huyao compatibility implementation does not enforce.*bounds/i,
      `${file} does not disclose the pre-Huyao compatibility boundary`);
  }
});

// The remaining security rows have finite shipped-profile evidence and explicit open boundaries.
// Bind each row to the model and private-chain scenario it cites so a later edit cannot widen a
// bounded claim into arbitrary-plugin, private-key or public-deployment closure.
test('CU-163: bounded security claims retain their explicit open boundaries', () => {
  const ledger = read('docs/SECURITY.md');
  const row = (id) => ledger.split('\n').find((line) => new RegExp(`\\*\\*${id}\\*\\*`).test(line));

  const multisig = row('VULN-004');
  assert.ok(multisig, 'docs/SECURITY.md has no VULN-004 row');
  assert.match(multisig, /571 VM tests/i);
  assert.match(multisig, /private-key independence/i);
  assert.match(multisig, /arbitrary future plugins/i);

  const orphan = row('VULN-005');
  assert.ok(orphan, 'docs/SECURITY.md has no VULN-005 row');
  assert.match(orphan, /shipped MultiSig\/MultiHook/i);
  assert.match(orphan, /arbitrary future-plugin/i);
  assert.match(orphan, /remains open/i);

  const rotation = row('VULN-007');
  assert.ok(rotation, 'docs/SECURITY.md has no VULN-007 row');
  assert.match(rotation, /delayed proposal\/confirmation\/cancellation/i);
  assert.match(rotation, /final source-built artifact passed private NeoExpress/i);
  assert.match(rotation, /new-owner witness/i);
  assert.match(rotation, /public ABI migration/i);
  assert.match(rotation, /public deployment readback remains pending/i);

  for (const file of [
    'formal/coq/MultiSigPolicy.v',
    'formal/coq/CallbackPluginTopology.v',
    'formal/coq/CustomGovernance.v',
  ]) {
    assert.ok(exists(file), `bounded security evidence is missing ${file}`);
  }

  const receipt = JSON.parse(read('docs/reports/sa-neoexpress-validation-20261031.json'));
  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.network.publicNetwork, false);
  for (const prefix of ['MultiSig child pre-check', 'MultiHook child pre-check']) {
    assert.ok(receipt.scenarios.some((scenario) => scenario.name === prefix),
      `private-chain evidence is missing ${prefix}`);
  }

  const rotationScenario = receipt.scenarios.find(
    (scenario) => scenario.name === 'platform account owner rotation');
  assert.ok(rotationScenario, 'private-chain evidence is missing platform account owner rotation');
  assert.equal(rotationScenario.assertions.length, 19,
    'platform owner rotation must retain all state-invariance assertions');
  for (const check of [
    'owner rotation proposal emits the expected event',
    'proposal does not change the current owner',
    'unauthorized cancellation preserves the pending rotation',
    'unauthorized cancellation preserves the current owner',
    'owner cancellation emits the expected event',
    'owner cancellation clears the pending rotation',
    'early confirmation preserves the pending rotation',
    'early confirmation preserves the current owner',
    'confirmation without the new-owner witness preserves the pending rotation',
    'confirmation without the new-owner witness preserves the current owner',
    'new owner is persisted',
    'successful rotation clears the pending record',
    'owner rotation preserves the proxy address',
  ]) {
    assert.ok(rotationScenario.assertions.some((assertion) => assertion.check === check && assertion.ok),
      `platform owner rotation is missing assertion: ${check}`);
  }
  for (const expectedFault of [
    'Unauthorized platform owner rotation cancellation',
    'Platform owner rotation timelock not expired',
    'New platform owner witness required',
  ]) {
    assert.ok(rotationScenario.steps.some(
      (step) => step.expectedFault === expectedFault && step.outcome === 'FAULT'),
    `platform owner rotation is missing expected fault: ${expectedFault}`);
  }
});

// The snapshot-audit presentation rule (a VULN-00N item had to sit under a heading that called the
// snapshot historical, and the rendered copy had to equal the repository copy) retired with the
// March 11, 2026 audit in the 2026-11 docs cleanup. The identifier rule below still holds for every
// document: only docs/SECURITY.md numbers issues.

// The ledger is the only place that numbers an issue VULN-00N. A second document reusing an id
// makes a reviewer read two different issues under one name (DS-CU-163 section 4.3 V4).
test('CU-163: only the ledger numbers issues VULN-00N', () => {
  const markdown = tracked.filter((file) => file.endsWith('.md')
    && !isResearchDocument(file) && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/'));
  const collisions = [];
  for (const file of markdown) {
    read(file).split('\n').forEach((line, index) => {
      if (/^#{1,6}\s*VULN-00\d/.test(line)) collisions.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(collisions, [], `a document reuses a ledger identifier as a heading:\n${collisions.join('\n')}`);
});

// The closure claim is checked for every document, not only the guarded ones: no build bounds a
// callback's gas, so no document may say the public build is fixed. A document may describe a
// private artifact as closed only when it says so in those words.
test('CU-163: no document closes VULN-001 for the public build while no build bounds a callback\'s gas', () => {
  const markdown = tracked.filter((file) => file.endsWith('.md')
    && !isResearchDocument(file) && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/'));
  const claims = [];
  for (const file of markdown) {
    // A paragraph is the unit: the prose wraps, so the qualifier can sit on the next line.
    const paragraphs = read(file).split(/\n\s*\n/);
    for (const paragraph of paragraphs) {
      const flat = paragraph.replace(/\s+/g, ' ');
      if (!/VULN-001/.test(flat) || !/fix|clos|resolv|mitigat|eliminat/i.test(flat)) continue;
      if (/private|only|not\b|pending|open|historical/i.test(flat)) continue;
      claims.push(`${file}: ${flat.slice(0, 140)}`);
    }
  }
  assert.deepEqual(claims, [], `a document claims VULN-001 closed for the public build while ${VULN_001_OPEN_REASON}:\n${claims.join('\n')}`);
});

// What the ratchet reads, as data, so a planted drift can call it and see exactly what the guard
// would record. Three buckets, disjoint by construction:
//
//   entrypoint: a callable no artifact carries, on a line that does not mark it removed;
//   spelling:   a spelling of an exported member that differs from the manifest spelling. This is
//               debt, not a style difference: the document asserts a name the deployment does not
//               export even where the C# source defines the PascalCase member (DS-CU-211, DEC-DS-5).
//               The entry carries the deployed spelling so the ledger says what it should have been;
//   sdk:        a client method that does not exist, or one that always throws LEGACY_V3_REMOVED.
function ratchetDebt({ mirrors = false, only = null } = {}) {
  const patterns = {
    entrypoint: (line, file) => (REMOVED.test(line) ? [] : callableNames(line)
      .filter(({ name }) => !(NATIVE_PROFILE_DOCS.includes(file) ? nativeAbiNames : NO_NAMES).has(name))
      // A documented callable the SDK defines is not a dead reference either: the MultiSig guide
      // names client methods (buildBundle, buildChildTypedData) without the `client.` prefix that
      // the sdk rule below requires, and sdk/js/src/multisig.js exposes exactly those.
      .filter(({ name }) => !sdkMethods.has(name))
      // The `spelling` bucket below owns every case-variant entry, so such a name is reported once.
      .filter(({ name }) => deployedSpelling(name) === undefined)
      // A dead reference is a NAME, so a token whose spelling no ABI member carries must still read
      // as one by shape. Without this the widened vocabulary would charge prose that begins with a
      // word the ABI happens to use - `Transfer amount exceeds subscription` - as a dead entrypoint,
      // inventing debt for an English word (DS-CU-212, DEC-DS-6 rule 5).
      .filter(({ name }) => shapedLikeEntrypoint(name))
      // A record field that a document names - `updateCounter` - is not a callable; see RECORD
      // FIELDS above. Only the uncalled form is exempt, so `updateCounter()` stays a dead call.
      .filter(({ name, called }) => called || !isRecordField(name))
      .filter(({ name }) => !isLiveName(name, file))
      .map(({ name }) => `entrypoint:${name}`)),
    spelling: (line, file) => callableNames(line)
      // A surface-table row that pairs the ABI name with the C# member implementing it is a
      // declared mapping, not a mis-spelling (see isModuleAbiMappingRow).
      .filter(({ name }) => !isModuleAbiMappingRow(name, line, file))
      .filter(({ name }) => !deployedAbi.has(name) && deployedSpelling(name) !== undefined)
      .map(({ name }) => `spelling:${name}->${deployedSpelling(name)}`),
    sdk: (line) => [...line.matchAll(/\b(?:saClient|client|sdk)\.([A-Za-z_]\w*)\s*\(/g)].flatMap((match) => legacySdkMethods.has(match[1]) ? [`legacy:${match[1]}`] : sdkMethods.has(match[1]) ? [] : [`sdk:${match[1]}`]),
  };
  const found = {};
  const files = only ?? tracked.filter((file) => file.endsWith('.md')
    && !isResearchDocument(file) && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/')
    && !CURRENT_DOCS.includes(docClass(file))
    && (mirrors ? isMirrorDoc(file) : !isMirrorDoc(file)));
  for (const file of files) {
    const names = new Set();
    for (const line of read(file).split('\n')) {
      for (const build of Object.values(patterns)) for (const name of build(line, docClass(file))) names.add(name);
    }
    if (names.size) found[file] = [...names].sort();
  }
  return found;
}

test('CU-163: the V2-era documents do not grow new dead references (ratchet)', () => {
  const found = ratchetDebt();
  if (process.env.DOCS_TRUTH_REPORT) {
    console.log(JSON.stringify(found, null, 2));
    return;
  }
  // The recorded list is exact: a new dead reference, a new document, or an entry that is no longer
  // found all fail. Every recorded entry also has to carry the reason it must stay, and an entry with
  // a marker has to find that marker in its document, so a scope note cannot be deleted silently.
  const recorded = Object.fromEntries(Object.entries(V2_DEBT).map(([file, entry]) => [file, entry.names]));
  assert.deepEqual(found, recorded, 'the V2-era debt list changed: a document drifted, or a corrected document must be removed from the ratchet');
  for (const [file, entry] of Object.entries(V2_DEBT)) {
    assert.ok(entry.reason && entry.reason.length >= 40, `${file}: the ratchet entry needs a reason it must stay`);
    if (entry.marker) {
      assert.ok(exists(file) && read(file).includes(entry.marker),
        `${file}: the justification claims a scope declaration the document no longer carries: ${entry.marker}`);
    }
  }
});

// A counterpart carries the same sentences, so it must carry the same dead references. Each mirror is
// scanned under its source's class and compared with the source's recorded entry: a translation that
// introduces a name the English text does not carry, or drops the caveat that made a name historical,
// changes the entry and fails here. The recorded ledger therefore stays one row per document.
test('CU-163: a Chinese counterpart records exactly the debt of the document it mirrors', () => {
  const recorded = ratchetDebt();
  const mirrors = tracked.filter((file) => file.endsWith('.md') && isMirrorDoc(file)
    && !isResearchDocument(file) && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/')
    && !CURRENT_DOCS.includes(docClass(file)));
  for (const file of mirrors) {
    const source = docClass(file);
    const found = ratchetDebt({ only: [file] });
    assert.deepEqual(found[file] ?? [], recorded[source] ?? [],
      `${file}: the translation records different dead references than ${source}`);
  }
});

// The module README oracle above is a widening of the liveness rule, so it is held to the same
// standard as every other one (DS-CU-212 section 4): its source is checked against the repository,
// each exemption is killed by a planted drift, and a planted registered name is the control that
// proves the plant form itself is not what the guard reports.
test('module READMEs: a standard-module method is live from the ABI reference, and an invented name is still reported', () => {
  // 1. The source is the reference, cross-checked: the named-interface catalogue is a subset of
  //    it, and every registered name resolves to the module's source or to a pinned manifest.
  const namedModuleInterfaces = JSON.parse(read('docs/proposals/smartaccount-named-module-interfaces.json'));
  const notInReference = [];
  for (const [module, entry] of Object.entries(namedModuleInterfaces)) {
    if (!moduleAbi.has(module)) continue;
    for (const name of Object.keys(entry.methods ?? {})) if (!moduleAbi.get(module).has(name)) notInReference.push(`${module}.${name}`);
  }
  assert.deepEqual(notInReference, [], 'the named-interface catalogue carries a name the ABI reference does not');
  assert.deepEqual(moduleAbiUnresolved, [],
    `the ABI reference carries a name no module source or pinned manifest defines; it was NOT registered as live:\n${moduleAbiUnresolved.join('\n')}`);
  assert.deepEqual([...moduleAbi.keys()].sort(), ['GovernanceModule', 'HookOrchestratorModule', 'RecoveryModule', 'SigningModule', 'ThresholdPolicyModule'],
    'the set of standard modules changed');
  for (const name of ['getLastCompletion', 'getMessagePolicy', 'validateMessageSignature', 'getThresholdPolicy', 'getExecutedRecoveryNonce', 'authorizedCore']) {
    assert.ok(moduleAbiNames.has(name), `${name} is a registered standard-module method the oracle does not carry`);
  }
  for (const name of ['getDailyLimit', 'getMemberKey', 'preCheck']) {
    assert.ok(!moduleAbiNames.has(name), `${name} belongs to a plugin profile and leaked into the standard-module oracle`);
  }

  // 2. The oracle answers by artifact, not by shape.
  const governance = 'contracts/modules/GovernanceModule/README.md';
  const signing = 'contracts/modules/SigningModule/README.md';
  const directory = 'contracts/modules/README.md';
  assert.equal(isLiveName('getLastCompletion', governance), true, 'a registered method of the module its README describes is still dead');
  assert.equal(isLiveName('getInventedRead', governance), false, 'an unregistered name is live in a module README');
  assert.equal(isModuleDirectoryMethod('getMessagePolicy', signing), true, 'the Signing README cannot name its own roster read');
  assert.equal(isModuleDirectoryMethod('getMessagePolicy', governance), false,
    'a module README is allowed the methods of ANOTHER module under its own row');
  assert.equal(isModuleDirectoryMethod('getMessagePolicy', directory), true,
    'the directory README form `getMessagePolicy(accountId, moduleId)` is not recognised');
  assert.equal(isModuleDirectoryMethod('getInventedRead', directory), false);
  assert.equal(isLiveName('AuthorizedCore', governance), false,
    'the C# spelling of a registered member became live in its own right');
  assert.equal(isRecordField('updateCounter'), true, 'the module record field is not derived from SmartAccountRecords.cs');
  assert.equal(isRecordField('getLastCompletion'), false, 'a registered method is treated as a record field');

  // 3. Planted drift in a module README. Each plant is written to the document and restored byte for
  //    byte in `finally`; the reported set is asserted, never an exit code.
  const plant = (file, line, check) => {
    const target = path.join(repoRoot, file);
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, `${original}${original.endsWith('\n') ? '' : '\n'}${line}\n`);
    try {
      check(ratchetDebt({ only: [file] })[file] ?? []);
    } finally {
      fs.writeFileSync(target, original);
    }
  };
  // 3a. An invented backticked method in a surface-table row is a dead entrypoint.
  plant(governance, '| `getInventedRead(accountId)` | `UInt256` | read-only |', (reported) => {
    assert.deepEqual(reported.filter((entry) => entry.startsWith('entrypoint:')), ['entrypoint:getInventedRead'],
      'an invented method in a module README is not reported');
  });
  // 3b. CONTROL: the same row carrying a registered name reports nothing, so the plant form is not
  //     what 3a reported.
  plant(governance, '| `getLastCompletion(accountId)` | `UInt256` | read-only |', (reported) => {
    assert.deepEqual(reported, [], `a registered method in the same row form was reported: ${reported}`);
  });
  // 3c. The exemption is per module: RecoveryModule does not carry the hook planner's snapshot read.
  plant('contracts/modules/RecoveryModule/README.md', '| `getHookSnapshot(accountId)` | `Array` | read-only |', (reported) => {
    assert.ok(reported.includes('entrypoint:getHookSnapshot'),
      'a README claimed a method registered for another module and the ratchet accepted it');
  });
  // 3d. Only a mapping ROW exempts the C# spelling; the same name in prose is still debt.
  plant(governance, 'The core address comes from `AuthorizedCore` on every call.', (reported) => {
    assert.deepEqual(reported.filter((entry) => entry.startsWith('spelling:')), ['spelling:AuthorizedCore->authorizedCore'],
      'the C# spelling outside a mapping row is no longer reported');
  });
  // 3e. A mapping row is exempt only when the C# name compiles to a name the module registered.
  plant(governance, '| `clearAccount(accountId)` | `ClearAccount` | `Void` | core only |', (reported) => {
    assert.deepEqual(reported.filter((entry) => entry.startsWith('spelling:')), ['spelling:ClearAccount->clearAccount'],
      'a mapping row to a name the module does not register was exempted');
  });
  // 3f. A field may be named, never called: the directory README names `updateCounter` and reports
  //     nothing for it; the same name as a call is a dead entrypoint.
  assert.ok(!(ratchetDebt({ only: [directory] })[directory] ?? []).includes('entrypoint:updateCounter'));
  plant(governance, 'The binding is refreshed by `updateCounter()`.', (reported) => {
    assert.ok(reported.includes('entrypoint:updateCounter'), 'a call to the record field was exempted as a field reference');
  });
  // 4. The widened oracle does not move the recorded ledger (CU-163, CU-212 part 4).
  assert.equal(Object.values(ratchetDebt()).flat().length, 5);
});

// Fenced blocks whose names the scan judges to be mentions rather than claims. Each entry is a name
// that a diagram uses as a label while the code the label stands for is called by its deployed
// spelling; the arrow of the correction is the other way round from the ratchet, so these are
// recorded here and the guard fails if one disappears rather than if one appears. DS-CU-210 section 4.
const V2_FENCE_MENTIONS = {
  'docs/ARCHITECTURE.md': {
    names: ['CallCustom', 'HasID', 'ValidatePaymasterOp', 'ValidateSig', 'validateUserOpLogic'],
    reason: 'Bare mermaid node labels of the merged architecture book (absorbing the former DATA_FLOW and ETHEREUM_AA_COMPARISON topics): HasID is the account-id decision node and CallCustom the verifier branch of the authorization flowchart, ValidatePaymasterOp the relay preflight node of the paymaster flow, and ValidateSig/validateUserOpLogic the Ethereum validation-path nodes of the ERC-4337 comparison; none is written as a call, the underlying reads are named in the deployed ABI, and the diagrams are pictures of the flow, not examples a reader copies.',
  },
  // The frontend help pages below are generated slices of an authoritative book chapter
  // (scripts/sync-frontend-docs.mjs), so a label the book justifies reappears here byte for
  // byte. Each entry restates the source book's ledgered reason for the same diagram nodes.
  'frontend/src/assets/docs/data-flow.md': {
    names: ['CallCustom', 'HasID'],
    reason: 'Generated slice of the "Data flow and storage" chapter of docs/ARCHITECTURE.md: HasID is the account-id decision node and CallCustom the verifier branch of the internal execution flowchart, the same ledgered labels as the source book, none written as a call, and the underlying reads are named in the deployed ABI.',
  },
  'frontend/src/assets/docs/data-flow.zh.md': {
    names: ['CallCustom', 'HasID'],
    reason: 'Generated slice of the "数据流与存储" chapter of docs/ARCHITECTURE.zh-CN.md: HasID is the account-id decision node and CallCustom the verifier branch of the internal execution flowchart, mirroring the ledgered labels of the English architecture book, and neither is written as a call.',
  },
  'frontend/src/assets/docs/architecture.zh.md': {
    names: ['ValidatePaymasterOp'],
    reason: 'Generated slice of the "Neo N3 Smart Account 架构" chapter of docs/ARCHITECTURE.zh-CN.md: ValidatePaymasterOp is the relay preflight node of the paymaster flow, the same ledgered label as the English architecture book, written as a bare mermaid label while the deployed ABI names the underlying read.',
  },
};


// Dated snapshots whose own scope note says their code snippets are evidence of the revision they
// audited rather than a description of the deployed artifact. The guard requires the phrase to be
// present; this list is what lets a document use it, so an exemption is never implicit and adopting
// it in a new document fails the test instead of silencing the scan (DS-CU-210 section 3).
//
// The list is empty. Its only two members were the March 11, 2026 audit and its rendered copy, both
// deleted in the 2026-11 docs cleanup. An empty list is the enforced state, not a disabled rule: a
// document that starts carrying the phrase makes the scan report a scope the list does not record.
const V2_FENCE_SCOPES = {};

test('CU-210: fenced blocks assert nothing the code does not, and the ratchet still holds', () => {
  const scan = fenceScan();
  // CU-210 R2 (the NO-GO fix forward). The four names below are the ones the claim side of this
  // oracle could not READ at the r1 head, so their drift was invisible to it while the test above
  // stayed green - a check that could not fail. Two are dead calls that the fenced examples really
  // make (`collectChildProofs`, `childSigns` in the threshold-session chapter of docs/SDK.md, formerly
  // docs/MULTISIG_SDK.md; F7 and F8 below), and two are
  // live ABI members written the way the build spells an exported member (`transfer`, `forward`),
  // which the shape rule dropped without ever reaching the liveness rule.
  assert.ok(!scan.claims['docs/SDK.md']?.includes('collectChildProofs'),
    'the dead call in the fenced MultiSig example is reported now; correct the document and move this name into the widening mutant');
  // The two live ABI members the review's mutant planted. They must be READABLE (the shape rule
  // cannot read either, which is why the oracle previously dropped them before the liveness rule)
  // and they must not be reported, because the artifact that owns them spells them exactly. A fix
  // that made them fail would be rejecting the build's own spelling, not reading it.
  for (const live of ['transfer', 'forward']) {
    assert.ok(isReadableName(live), `${live} is a deployed ABI member the vocabulary cannot read`);
    assert.ok(isLiveName(live, 'docs/ARCHITECTURE.md'), `${live} is a deployed ABI member the oracle calls dead`);
  }
  assert.deepEqual(scan.claims, {},
    `a fenced block calls a name the repository does not define:\n${JSON.stringify(scan.claims, null, 2)}`);
  const recorded = Object.fromEntries(Object.entries(V2_FENCE_MENTIONS).map(([file, entry]) => [file, entry.names]));
  const recordedSorted = Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(scan.mentions, recordedSorted,
    'the justified fence mentions changed: a diagram gained a dead label, or a corrected diagram must be removed here');
  for (const [file, entry] of Object.entries(V2_FENCE_MENTIONS)) {
    assert.ok(entry.reason && entry.reason.length >= 40, `${file}: the fence-mention entry needs a reason it must stay`);
  }
  // A counterpart's fences are the same fences in another language: the same diagram labels and the
  // same code positions. Scanning them under their source's class and comparing in both directions
  // catches a translation that adds a dead label and one that drops a justified label.
  const mirrorScan = fenceScan({ mirrors: true });
  assert.deepEqual(mirrorScan.claims, {},
    `a translated fenced block calls a name the repository does not define:\n${JSON.stringify(mirrorScan.claims, null, 2)}`);
  for (const file of tracked.filter((entry) => entry.endsWith('.md') && isMirrorDoc(entry)
    && !isResearchDocument(entry) && !entry.startsWith('docs/reports/') && !entry.startsWith('docs/plans/')
    && !CURRENT_DOCS.includes(docClass(entry)))) {
    assert.deepEqual(mirrorScan.mentions[file] ?? [], scan.mentions[docClass(file)] ?? [],
      `${file}: the translation's justified fence mentions differ from ${docClass(file)}`);
  }
  // The scope list is exact: a snapshot may only use the exemption when it says so, and a document
  // that starts saying so must be registered with a reason.
  assert.deepEqual(scan.snippetScopes, Object.keys(V2_FENCE_SCOPES).sort(),
    'the set of documents claiming a historical-snippet scope changed');
  for (const [file, reason] of Object.entries(V2_FENCE_SCOPES)) {
    assert.ok(reason && reason.length >= 40, `${file}: the historical-snippet scope needs a reason it must stay`);
  }
});

// Every rule above must be able to fail, so each one gets a document mutant, run against a temporary
// copy of the tree's document and restored immediately. A mutant that survives means the rule is
// decoration; the messages are asserted, not the exit code, so an incidental failure elsewhere does
// not count as a kill. DS-CU-210 section 6.
test('CU-210: each fenced rule is killed by its planted drift', () => {
  // fenceScan reports; it only throws for a malformed declaration. A mutant therefore kills its rule
  // when the reported claim set changes to include the planted name, and an incidental assertion
  // failure elsewhere is not a kill.
  const mutants = [
    {
      rule: 'a dead call inside a fenced code block is reported (the drift that was invisible before CU-210)',
      file: 'docs/SDK.md',
      plant: (text) => text.replace("const install = client.buildAccountActionScript({", "const install = client.buildLegacyVerifierConfig({"),
      claim: 'buildLegacyVerifierConfig',
    },
    {
      rule: 'a fenced block cannot show a removed entrypoint as current, and a marked removal silences it',
      file: 'docs/SDK.md',
      plant: (text) => text.replace("const install = client.buildAccountActionScript({", "const install = client.buildLegacyVerifierConfig({ // removed call, kept as the before example"),
      claim: null,
    },
    {
      rule: 'a definition in a fence is a claim even without a call site',
      file: 'docs/SECURITY.md',
      plant: (text) => text.replace('### 9.2 Security Properties', '```csharp\npublic static void InitiateLegacyRecovery(UInt160 accountId)\n```\n\n### 9.2 Security Properties'),
      claim: 'InitiateLegacyRecovery',
    },
    {
      rule: 'a bare identifier in a diagram is recorded as a mention rather than reported as a claim',
      file: 'docs/ARCHITECTURE.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'HasLegacyIdCheck{Account ID Valid?}'),
      claim: null,
      mention: 'HasLegacyIdCheck',
    },
    {
      rule: 'a dead call spelled the way the build spells an exported member is reported (the drift the camel-case filter made invisible; F7)',
      file: 'docs/SDK.md',
      plant: (text) => text.replace("const install = client.buildAccountActionScript({", "const install = client.buildAccountActionScript({\n  preflight: await listDeployedVerifiers(masterContractHash),"),
      claim: 'listDeployedVerifiers',
    },
    {
      rule: 'the same widening reads a camel-case call in a fenced diagram label, not only in a code block (F8)',
      file: 'docs/ARCHITECTURE.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'HasID{bulkVerifySignatures(accountId)}'),
      claim: 'bulkVerifySignatures',
    },
    {
      rule: 'CONTROL: widening the vocabulary does not invent drift - a live camel-case spelling stays unreported, and a bare camel-case identifier in a diagram stays a mention',
      file: 'docs/ARCHITECTURE.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'HasID{transfer(accountId) and forward(target, args) are the deployed camel spellings}'),
      bare: (text) => text.replace('HasID{Account ID Valid?}', 'collectionActive{Account ID Valid?}'),
      liveUnreported: ['transfer', 'forward'],
      notAClaim: 'collectionActive',
      survivesWithoutVocabulary: true,
    },
    {
      rule: 'the same dead camel-case call is a claim in code position and silent inside a comment (F9)',
      file: 'docs/SDK.md',
      plant: (text) => text.replace('const session = createThresholdSession({ rpcUrl });', 'const session = createThresholdSession({ rpcUrl });\nconst packets = await gatherChildProofPackets(context, operation);'),
      claim: 'gatherChildProofPackets',
      commentedOut: (text) => text.replace('const session = createThresholdSession({ rpcUrl });', 'const session = createThresholdSession({ rpcUrl });\n// gatherChildProofPackets(context, operation)'),
    },
    {
      rule: 'the illustrative-language annotation must carry a reason, so it cannot be a bare silence',
      file: 'docs/ARCHITECTURE.md',
      plant: (text) => text.replace('reason: the document compares Neo with Ethereum, so every solidity block lists the Ethereum interface (IValidator, IPaymaster, the ECDSA helper), not a Neo entrypoint.', 'reason: short.'),
      throws: /needs a reason/,
    },
    {
      rule: 'the illustrative-language annotation cannot be widened to a Neo language',
      file: 'docs/ARCHITECTURE.md',
      plant: (text) => text.replace('no fence claims for solidity;', 'no fence claims for solidity, csharp;'),
      throws: /not an illustrative \(non-Neo\) language/,
    },
  ];
  // The pre-mutant bytes of every file this test is about to write to, so the restore below is
  // checked against what was really there rather than against a list of names the test remembers.
  const pristine = new Map();
  for (const file of new Set(mutants.map((mutant) => mutant.file))) {
    pristine.set(file, fs.readFileSync(path.join(repoRoot, file), 'utf8'));
  }
  for (const mutant of mutants) {
    const target = path.join(repoRoot, mutant.file);
    const original = pristine.get(mutant.file);
    const planted = mutant.plant(original);
    assert.notEqual(planted, original, `${mutant.rule}: the mutant did not change ${mutant.file}`);
    fs.writeFileSync(target, planted);
    try {
      if (mutant.throws) {
        // assert.throws only tests the error message when the expectation is a function, so the
        // predicate is written out rather than passed as a regex
        assert.throws(() => fenceScan(), (error) => mutant.throws.test(error.message),
          `${mutant.rule}: the planted drift survived`);
        continue;
      }
      const scan = fenceScan();
      if (mutant.claims) {
        // the gate held and the widened exemption did not silence the fence it now covers
        for (const name of mutant.claims) {
          assert.ok(scan.claims[mutant.file]?.includes(name),
            `${mutant.rule}: widening the annotation silenced "${name}" in ${mutant.file}`);
        }
        continue;
      }
      if (mutant.liveUnreported) {
        // The control proves the widening is not a blanket "read every camel-case token": both
        // names it plants are real ABI members (transfer, forward are exported by the pinned
        // MockTransferTarget and NativeAuthority manifests), so a report here would be the
        // vocabulary inventing drift rather than finding it.
        for (const name of mutant.liveUnreported) {
          assert.ok(!scan.claims[mutant.file]?.includes(name),
            `${mutant.rule}: "${name}" is a deployed ABI member and the scan reported it as drift`);
        }
        continue;
      }
      if (mutant.claim) {
        assert.ok(scan.claims[mutant.file]?.includes(mutant.claim),
          `${mutant.rule}: the planted drift survived; the scan reported ${JSON.stringify(scan.claims)}`);
      } else if (mutant.mention) {
        assert.ok(scan.mentions[mutant.file]?.includes(mutant.mention),
          `${mutant.rule}: the planted label was not recorded as a mention`);
        assert.ok(!scan.claims[mutant.file]?.includes(mutant.mention),
          `${mutant.rule}: the planted label was reported as a claim`);
      } else {
        assert.ok(!scan.claims[mutant.file]?.includes('buildLegacyVerifierConfig'),
          `${mutant.rule}: a fence the document marks removed was still reported`);
      }
    } finally {
      fs.writeFileSync(target, original);
    }
    // The bare-identifier half of the control: the mention side keeps the shape vocabulary, so a
    // camel-case diagram label is neither a claim nor a recorded mention. It is planted and
    // restored in the same breath so the check cannot leave the tree drifted.
    if (mutant.bare) {
      const bare = mutant.bare(original);
      assert.notEqual(bare, original, `${mutant.rule}: the bare-label mutant did not change ${mutant.file}`);
      fs.writeFileSync(target, bare);
      try {
        const scan = fenceScan();
        assert.ok(!scan.claims[mutant.file]?.includes(mutant.notAClaim),
          `${mutant.rule}: the mention side read the bare camel-case label "${mutant.notAClaim}" as a claim`);
      } finally {
        fs.writeFileSync(target, original);
      }
    }
    // The commented half: the same dead call inside a comment must be silent in BOTH ledgers. A
    // document that keeps a stale name as a comment makes no claim about the runtime, so recording
    // it as a justified mention would be the guard charging prose as debt.
    if (mutant.commentedOut) {
      const commented = mutant.commentedOut(original);
      assert.notEqual(commented, original, `${mutant.rule}: the commented mutant did not change ${mutant.file}`);
      fs.writeFileSync(target, commented);
      try {
        const scan = fenceScan();
        assert.ok(!scan.claims[mutant.file]?.includes(mutant.claim),
          `${mutant.rule}: a commented-out call was reported as a claim`);
        assert.ok(!(scan.mentions[mutant.file] ?? []).includes(mutant.claim),
          `${mutant.rule}: a commented-out call was recorded as a justified mention`);
        assert.ok(!(ratchetDebt()[mutant.file] ?? []).some((entry) => entry.endsWith(`:${mutant.claim}`)),
          `${mutant.rule}: a commented-out call was charged to the inline ratchet`);
      } finally {
        fs.writeFileSync(target, original);
      }
    }
  }
  // THE KILL CONTROLS, run as a second pass: with the widening switched off, each mutant that
  // exists to exercise it must stop being reported. A mutant that still died would be killing
  // something else, and its "kill" above would not be evidence for this rule (DEC-DS-9).
  for (const mutant of mutants.filter((entry) => entry.survivesWithoutVocabulary === true
    || entry.claim === 'listDeployedVerifiers' || entry.claim === 'bulkVerifySignatures'
    || entry.claim === 'gatherChildProofPackets')) {
    const target = path.join(repoRoot, mutant.file);
    const original = pristine.get(mutant.file);
    fs.writeFileSync(target, mutant.plant(original));
    widenVocabulary.enabled = false;
    try {
      const scan = fenceScan();
      assert.ok(!scan.claims[mutant.file]?.includes(mutant.claim),
        `${mutant.rule}: the planted drift is still reported with the camel-case vocabulary switched off, so the mutant kills some other rule`);
      for (const name of mutant.liveUnreported ?? []) {
        assert.ok(!scan.claims[mutant.file]?.includes(name), `${mutant.rule}: the control reported "${name}"`);
      }
    } finally {
      widenVocabulary.enabled = true;
      fs.writeFileSync(target, original);
    }
  }
  // The mutants must leave the tree byte-identical to what they found. This is a stronger check
  // than looking for a planted name: `transfer` is a substring of `MaxTransferPrefix`, a key prefix
  // docs/ARCHITECTURE.md legitimately names, so a substring test on the name would fail on an untouched
  // tree, and a check that only lists the names it knows about cannot see a partial restore.
  for (const file of new Set(mutants.map((mutant) => mutant.file))) {
    assert.equal(fs.readFileSync(path.join(repoRoot, file), 'utf8'), pristine.get(file),
      `${file} was not restored to its pre-mutant bytes`);
  }
});

// =============================================================================================
// CU-210 R3. Round two established that a comment is not a code position and used that to remove a
// false claim rather than to grant an exemption. The rule it added was narrower than the property
// it claimed: it cut ONE single-line marker out of each line on its own, so a fenced
// `/* deadCall() */` was read as code and a valid document failed the gate. The rule is now the
// property - no comment content of either kind is a claim, in any fence language the guard reads.
//
// Every shape below is planted alone on an unmutated document so the assertion that refuses it
// names the shape, and every shape carries a per-shape control: the same fence also holds a dead
// call in code position, which must be reported. A rule that silenced the whole fence would fail
// that control instead of passing quietly, so no "kill" here can be an incidental one.
//
// >>> CU-210 R3 comment shapes
// The matrix is written out HERE rather than read from the lexer's own table, so a shape cannot
// pass by agreeing with the table it is supposed to test (DEC-DS-9). The test after the block is
// the other direction: it refuses a table row that no shape plants.
const R3_FILE = 'frontend/src/assets/docs/guide.md';
const R3_COMMENTED = 'gatherChildProofPackets(context, operation)';
const R3_COMMENTED_NAME = 'gatherChildProofPackets';
const R3_CONTROL = 'bulkVerifySignatures(context, operation);';
const R3_CONTROL_NAME = 'bulkVerifySignatures';
const R3_LINE_MARKERS = [
  // `//` to end of line
  ['csharp', '//'], ['cs', '//'], ['c', '//'], ['javascript', '//'], ['js', '//'],
  ['typescript', '//'], ['ts', '//'], ['java', '//'], ['go', '//'], ['rust', '//'],
  ['solidity', '//'], ['swift', '//'], ['kotlin', '//'], ['scala', '//'], ['php', '//'],
  ['dot', '//'], ['graphviz', '//'],
  // `#` to end of line
  ['python', '#'], ['py', '#'], ['bash', '#'], ['shell', '#'], ['sh', '#'], ['zsh', '#'],
  ['yaml', '#'], ['yml', '#'], ['toml', '#'], ['ini', '#'], ['dockerfile', '#'],
  ['powershell', '#'], ['r', '#'], ['ruby', '#'], ['perl', '#'], ['graphql', '#'], ['php', '#'],
  // a diagram language's own marker
  ['mermaid', '%%'],
];
const R3_BLOCK_MARKERS = [
  // `/* ... */` pairs that do not nest
  ['csharp', '/*', '*/'], ['cs', '/*', '*/'], ['c', '/*', '*/'], ['javascript', '/*', '*/'],
  ['js', '/*', '*/'], ['typescript', '/*', '*/'], ['ts', '/*', '*/'], ['java', '/*', '*/'],
  ['go', '/*', '*/'], ['solidity', '/*', '*/'], ['kotlin', '/*', '*/'], ['scala', '/*', '*/'],
  ['php', '/*', '*/'], ['dot', '/*', '*/'], ['graphviz', '/*', '*/'],
  // `/* ... */` pairs that NEST, which is what these two languages' own grammar says
  ['rust', '/*', '*/'], ['swift', '/*', '*/'],
  // PowerShell's block comment is not a C-style pair
  ['powershell', '<#', '#>'],
];
const r3Fence = (language, body) => `\n\`\`\`${language}\n${body}\n\`\`\`\n`;
const R3_SHAPES = [
  ...R3_LINE_MARKERS.map(([language, marker]) => ({
    rule: `a "${marker}" single-line comment is not a code position in a ${language} fence`,
    append: r3Fence(language, `${marker} ${R3_COMMENTED}\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  })),
  ...R3_BLOCK_MARKERS.map(([language, open, close]) => ({
    rule: `a "${open} ... ${close}" block comment is not a code position in a ${language} fence`,
    append: r3Fence(language, `${open} ${R3_COMMENTED} ${close}\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  })),
  {
    rule: 'an unterminated block comment silences its own fence and does not leak into the next one',
    append: r3Fence('csharp', `${R3_CONTROL}\n/* ${R3_COMMENTED}`) + r3Fence('csharp', R3_CONTROL),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a block comment that opens on one line and closes on a later one is one comment, and a call on the continuation line is inside it',
    append: r3Fence('csharp', `var note = /* ${R3_COMMENTED}\n  ${R3_COMMENTED} */ 3;\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a nested block comment in rust is one comment, as that language nests them',
    append: r3Fence('rust', `/* outer /* inner /* deepest */ */ ${R3_COMMENTED} */\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a nested block comment in swift is one comment, as that language nests them',
    append: r3Fence('swift', `/* outer /* inner */ ${R3_COMMENTED} */\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a block comment in a language whose comments do not nest ends at the first close, and the name after it is code',
    append: r3Fence('csharp', `/* outer /* inner */ ${R3_COMMENTED};`),
    reported: R3_COMMENTED_NAME,
  },
  {
    rule: 'a block comment containing a quote and an apostrophe is still one comment',
    append: r3Fence('javascript', `/* it is the "child" helper's ${R3_COMMENTED} */\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a block comment containing backslash escapes is still one comment',
    append: r3Fence('javascript', `/* an escaped quote \\" and a newline \\n: ${R3_COMMENTED} */\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a line that mixes code and a trailing block comment reads only the code',
    append: r3Fence('csharp', `var count = 3; /* ${R3_COMMENTED} */\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a line that mixes a leading block comment and a code position reads only the code',
    append: r3Fence('javascript', `/* ${R3_COMMENTED} */ ${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a line that mixes code and a trailing single-line comment reads only the code',
    append: r3Fence('bash', `echo counted  # ${R3_COMMENTED}\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a block-comment opener inside a string literal does not open a comment',
    append: r3Fence('javascript', `const marker = "/*"; ${R3_COMMENTED};`),
    reported: R3_COMMENTED_NAME,
  },
  {
    rule: 'a single-line marker inside a string literal does not cut the line short',
    append: r3Fence('javascript', `const url = 'https://example.invalid'; ${R3_CONTROL}`),
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a string literal holding a comment opener does not silence the comment after it',
    append: r3Fence('javascript', `const marker = "/*"; /* ${R3_COMMENTED} */\n${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a code position after a PowerShell block comment on the same line is still read',
    append: r3Fence('powershell', `<# ${R3_COMMENTED} #> ${R3_CONTROL}`),
    silent: R3_COMMENTED_NAME,
    reported: R3_CONTROL_NAME,
  },
  {
    rule: 'a mermaid fence has no block-comment syntax, so a call inside "/* */" stays a code position',
    append: r3Fence('mermaid', `/* ${R3_COMMENTED} */`),
    reported: R3_COMMENTED_NAME,
  },
  {
    rule: 'a plain text fence has no comment syntax, so its text stays a code position',
    append: r3Fence('text', `// ${R3_COMMENTED}`),
    reported: R3_COMMENTED_NAME,
  },
  {
    rule: 'an untagged fence has no comment syntax, so its text stays a code position',
    append: r3Fence('', `// ${R3_COMMENTED}`),
    reported: R3_COMMENTED_NAME,
  },
  {
    rule: 'a mermaid fence has no "//" comment syntax, so a call after it stays a code position',
    append: r3Fence('mermaid', `// ${R3_COMMENTED}`),
    reported: R3_COMMENTED_NAME,
  },
];
for (const shape of R3_SHAPES) {
  test(`CU-210 R3: ${shape.rule}`, () => {
    const target = path.join(repoRoot, R3_FILE);
    const original = fs.readFileSync(target, 'utf8');
    const planted = `${original.replace(/\n*$/, '\n')}${shape.append}`;
    assert.notEqual(planted, original, `${shape.rule}: the shape did not change ${R3_FILE}`);
    fs.writeFileSync(target, planted);
    let scan;
    try {
      scan = fenceScan();
    } finally {
      fs.writeFileSync(target, original);
    }
    assert.equal(fs.readFileSync(target, 'utf8'), original,
      `${shape.rule}: ${R3_FILE} was not restored to its pre-shape bytes`);
    const claims = scan.claims[R3_FILE] ?? [];
    const mentions = scan.mentions[R3_FILE] ?? [];
    if (shape.reported) {
      assert.ok(claims.includes(shape.reported),
        `${shape.rule}: the code position beside the comment was not read at all, so a silence here would be vacuous; the scan reported ${JSON.stringify(claims)}`);
    }
    if (shape.silent) {
      assert.ok(!claims.includes(shape.silent),
        `${shape.rule}: the guard read comment content as a live claim; the scan reported ${JSON.stringify(claims)}`);
      assert.ok(!mentions.includes(shape.silent),
        `${shape.rule}: the guard recorded comment content as a justified mention`);
    }
  });
}
// <<< CU-210 R3 comment shapes

// The control the shapes above need in order to mean anything: the lexer must not have emptied the
// claim set to make them pass. Two halves - the unmutated tree still reports exactly what the guard
// records (nothing invented, nothing newly silenced), and the same dead name in CODE position in
// the same document is still reported, so a silence in the shapes above is the comment rule's work
// and not a reader that stopped reading.
test('CU-210 R3: CONTROL - the unmutated document still yields its claims', () => {
  const scan = fenceScan();
  assert.deepEqual(scan.claims, {},
    `the lexer invented drift on the unmutated tree: ${JSON.stringify(scan.claims)}`);
  const recorded = Object.fromEntries(Object.entries(V2_FENCE_MENTIONS).map(([file, entry]) => [file, entry.names]));
  const recordedSorted = Object.fromEntries(Object.entries(recorded).sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(scan.mentions, recordedSorted,
    'the lexer changed the recorded fence mentions on the unmutated tree');
  const target = path.join(repoRoot, R3_FILE);
  const original = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, `${original.replace(/\n*$/, '\n')}${r3Fence('csharp', R3_COMMENTED)}`);
  try {
    const planted = fenceScan();
    assert.ok((planted.claims[R3_FILE] ?? []).includes(R3_COMMENTED_NAME),
      `the same name in code position was not reported, so the shapes above prove nothing; the scan reported ${JSON.stringify(planted.claims)}`);
  } finally {
    fs.writeFileSync(target, original);
  }
  assert.equal(fs.readFileSync(target, 'utf8'), original,
    `${R3_FILE} was not restored to its pre-control bytes`);
});

// The other direction of the matrix: a comment form the lexer names but no shape plants is an
// untested rule, and a shape for a form the lexer does not implement is a test of nothing. The two
// are compared here rather than one being derived from the other, so adding a row to the lexer's
// table without planting its shape fails, and planting a marker the lexer does not strip fails too.
test('CU-210 R3: the lexer names exactly the comment forms the shapes plant', () => {
  const planted = new Map();
  for (const [language, marker] of R3_LINE_MARKERS) planted.set(`${language}|line|${marker}`, false);
  for (const [language, open, close] of R3_BLOCK_MARKERS) planted.set(`${language}|block|${open} ${close}`, false);
  let declared = 0;
  for (const [language, syntax] of COMMENT_SYNTAX) {
    for (const marker of syntax.line ?? []) {
      declared += 1;
      assert.ok(planted.has(`${language}|line|${marker}`),
        `the lexer strips "${marker}" in a ${language} fence and no shape plants it`);
    }
    if (syntax.block) {
      declared += 1;
      assert.ok(planted.has(`${language}|block|${syntax.block.join(' ')}`),
        `the lexer strips ${syntax.block.join(' ... ')} in a ${language} fence and no shape plants it`);
    }
    if (syntax.nest) {
      assert.ok(R3_SHAPES.some((shape) => shape.rule.includes(`nested block comment in ${language}`)),
        `the lexer nests block comments in ${language} and no shape plants a nested one`);
    }
  }
  for (const [language, marker] of R3_LINE_MARKERS) {
    const syntax = COMMENT_SYNTAX.get(language);
    assert.ok(syntax?.line?.includes(marker),
      `a shape plants "${marker}" in a ${language} fence and the lexer does not strip it`);
  }
  for (const [language, open, close] of R3_BLOCK_MARKERS) {
    const syntax = COMMENT_SYNTAX.get(language);
    assert.deepEqual(syntax?.block, [open, close],
      `a shape plants ${open} ... ${close} in a ${language} fence and the lexer does not strip that pair`);
  }
  // The count is stated so that an emptied table cannot make the loops above pass vacuously.
  assert.equal(declared, planted.size,
    `the lexer declares ${declared} comment forms and the shapes plant ${planted.size}`);
  assert.ok(R3_LINE_MARKERS.length >= 35 && R3_BLOCK_MARKERS.length >= 18,
    `the shape matrix shrank: ${R3_LINE_MARKERS.length} single-line and ${R3_BLOCK_MARKERS.length} block forms`);
});

// The rule CU-210 found case-blind (its finding F6): the oracle asked the deployed-ABI map and the
// source scan in the same breath, so a document that wrote the C# spelling of an exported member was
// judged live. The oracle now keys on the artifact that spells a name (DS-CU-211, DEC-DS-5), and this
// test states both directions as data a reader can check.
test('CU-211: the liveness oracle is case-aware in both directions', () => {
  assert.equal(deployedSpelling('CanExecuteHook'), 'canExecuteHook',
    'the VerifyContext member the finding names is no longer spelled canExecuteHook in a manifest');
  // The file argument only distinguishes the native-profile class (isLiveName step 4), so any other
  // document asks the same oracle; the deleted March 11 audit is named as docs/SECURITY.md now.
  assert.equal(isLiveName('CanExecuteHook', 'docs/SECURITY.md'), false,
    'the C# source spelling of an exported member is live again; the fence scan cannot see such a name');
  assert.equal(isLiveName('canExecuteHook', 'docs/SECURITY.md'), true,
    'the manifest spelling of an exported member is not live');
  assert.ok(sourceDefinitions.has('RequirePinnedCore'),
    'the source-definition oracle lost RequirePinnedCore, a plugin guard no manifest exports');
  assert.equal(deployedSpelling('RequirePinnedCore'), undefined,
    'RequirePinnedCore is exported by a manifest now, so the live-as-source control is stale');
  assert.equal(isLiveName('RequirePinnedCore', 'docs/SECURITY.md'), true,
    'a C# definition that no manifest exports is treated as dead; the oracle is rejecting names by shape, not by artifact');
  // The ledger keeps the two classes apart and says what the artifact exports, so a reader does not
  // have to open a manifest to know what a `spelling:` entry should have been.
  const found = ratchetDebt();
  const buckets = { entrypoint: new Set(), spelling: new Set(), sdk: new Set(), legacy: new Set() };
  const writtenSpellings = new Set();
  for (const entries of Object.values(found)) {
    for (const entry of entries) {
      const bucket = entry.slice(0, entry.indexOf(':'));
      const body = entry.slice(entry.indexOf(':') + 1);
      buckets[bucket].add(body);
      if (bucket !== 'spelling') continue;
      const [written, deployed] = body.split('->');
      writtenSpellings.add(written);
      assert.equal(deployedSpelling(written), deployed, `${entry} does not name the deployed spelling`);
      assert.ok(!deployedAbi.has(written), `${entry} writes the deployed spelling and must not be recorded as debt`);
    }
  }
  assert.deepEqual([...buckets.entrypoint].filter((name) => writtenSpellings.has(name)), [],
    'the same name is recorded in both the entrypoint and the spelling bucket');
});

// The vocabulary rule of DS-CU-212 (DEC-DS-6): both oracles read the source spelling of an exported
// member, the set that makes them do it is DERIVED from the manifests and the sources rather than
// listed, and the recorded ledger is the measurement that widening produced. A reader can check every
// number here against contracts/build/*.manifest.json and contracts/**/*.cs.
test('CU-212: the entrypoint vocabulary is derived from the build and both oracles read the class', () => {
  // 1. The derivation. 134 C# definitions at this base are exported under a different spelling than
  //    the source writes, which is the class CU-211 could not read; the count is what makes this a
  //    derivation over the build rather than a list of names a document happened to use. The count
  //    moved 198 -> 194 when commit 26ad769 deleted contracts/mocks/PlatformRegistrarMock.cs and its
  //    build manifest: the members that artifact exported left the divergent class together with
  //    the artifact that carried them, which is exactly the move a derivation exists to record.
  //    It moved 194 -> 191 when the AA -> SA rename spelled SetAllowedAA / IsAllowedAA / GetAAContract
  //    as SetAllowedSA / IsAllowedSA / GetSAContract. It moved 191 -> 134 in the v4 migration: the
  //    verifier, hook, escape and backup-owner modules were deleted from the custom tree (their
  //    state moved into the module model), so the C# members those files defined left the source
  //    with the files, and the members they exported left the pinned manifests with their artifacts.
  //    The class measures the source it is given against the build it is given, and these are the
  //    two on disk. It moved 134 -> 81 with the deletion of the custom contract tree (Task #43):
  //    the custom tree held the account, market-escrow, paymaster and registrar members the pinned
  //    manifests still export, so those members left the source and the class together with the
  //    files, leaving contracts/plugins and tests/mocks as the only contract sources on disk.
  assert.equal(divergentSpellings.size, 81,
    'the divergent class changed size: a contract member was added, renamed or removed, and the ledger below must be re-measured');
  for (const name of divergentSpellings) {
    assert.equal(deployedSpellingOfSource(name), (() => {
      const lower = name.startsWith('_') ? `_${name.slice(1, 2).toLowerCase()}${name.slice(2)}` : `${name.slice(0, 1).toLowerCase()}${name.slice(1)}`;
      return lower;
    })(), `${name} is not spelled by the rule the compiler applies`);
    assert.ok(deployedAbi.has(deployedSpellingOfSource(name)),
      `${name} is in the divergent class but no manifest exports its lower-cased form`);
    assert.ok(!deployedAbi.has(name),
      `${name} is exported exactly, so it is not a divergent spelling`);
  }
  // The one definition the compiler exports under the source spelling is not divergent and is live
  // through `deployedAbi`, which is why the class keys on the export rather than on letter case.
  assert.ok(exportedInSourceSpelling.has('_deploy'),
    'the _deploy definition is no longer exported under its source spelling; the exported-in-source control is stale');
  assert.ok(!divergentSpellings.has('_deploy'), '_deploy is not a divergent spelling');
  // The other direction of DEC-DS-5 rule 2: a C# definition no manifest exports stays live as source
  // and must not be dragged into the class.
  assert.ok(sourceDefinitions.has('RequirePinnedCore'),
    'the source-definition oracle lost RequirePinnedCore, a plugin guard no manifest exports');
  assert.equal(deployedSpelling('RequirePinnedCore'), undefined,
    'RequirePinnedCore is exported by a manifest now, so the live-as-source control is stale');
  assert.ok(!divergentSpellings.has('RequirePinnedCore'),
    'a source-only definition was pulled into the divergent class');
  assert.equal(isLiveName('RequirePinnedCore', 'docs/SECURITY.md'), true,
    'a C# definition that no manifest exports is treated as dead; the oracle is rejecting names by shape, not by artifact');

  // 2. Both oracles read the class. The inline oracle is asked through `callableNames`, the fence
  //    oracle through `fenceClaims`, and the manifest spelling of the same member stays live.
  assert.equal(isCallableName('OnNEP17Payment'), true,
    'the inline oracle cannot read the source spelling of an exported member');
  // The correction CU-211's F8 count carried: the source-spelled exported members the scanned
  // documents carry are all read now, not all-but-one, and the assertion is written against the
  // derivation so it keeps meaning when the class moves. The three verifier-model members the list
  // carried before the v4 migration (VerifyExecution, VerifyAdmin, VerifyMetaTx) left it with the
  // modules that defined them, and three v4 members replace them.
  const blind = ['ClearAccount', 'OnOracleResult', 'PreExecute', 'PostExecute', 'Transfer',
    'SetupRecovery', 'BalanceOf', 'ClearSessionKey', 'OnNEP17Payment', 'Admin'];
  for (const name of blind) {
    assert.ok(!shapedLikeEntrypoint(name), `${name} is read by the shape rule now, so it is not a blind name`);
    assert.ok(isCallableName(name), `${name} is still invisible to the vocabulary`);
    assert.ok(divergentSpellings.has(name), `${name} is no longer derived as a divergent spelling`);
  }
  assert.ok(callableNames('the callback `OnNEP17Payment(accountId, amount, data)` runs').some(({ name }) => name === 'OnNEP17Payment'),
    'the inline oracle does not collect the source spelling of an exported member');
  // A deployed spelling is READ by the fence oracle now (CU-210 R2 widened the vocabulary to the
  // build's own camelCase class, which is exactly how an exported member is spelled), and reading a
  // name is not reporting it: the liveness rule owns that, and it keeps a deployed spelling live.
  assert.ok(fenceClaims('onNEP17Payment(accountId, amount, data)').includes('onNEP17Payment'),
    'the fence oracle cannot read the deployed spelling of an exported member');
  assert.ok(fenceClaims('OnNEP17Payment(accountId, amount, data)').includes('OnNEP17Payment'),
    'the fence oracle cannot read the source spelling of an exported member');
  assert.equal(isLiveName('onNEP17Payment', 'docs/SECURITY.md'), true,
    'the deployed spelling of the member is not live, so the oracle would report it as drift');
  assert.equal(isLiveName('OnNEP17Payment', 'docs/SECURITY.md'), false,
    'the source spelling of an exported member is live again, so the class is invisible');

  // 3. The vocabulary is a union with the shape rule and not a replacement: names only the shape rule
  //    reads are still read, and prose is not a name.
  assert.ok(shapedLikeEntrypoint('IsAnyExecutionActive'), 'the shape vocabulary lost a name it used to read');
  assert.equal(isCallableName('IsAnyExecutionActive'), true, 'a shape-read name is no longer a callable');
  assert.equal(isCallableName('exceeds'), false, 'an ordinary word is read as a callable');
  // Prose that STARTS with a name the class carries is read as that name - `Transfer` really is the
  // source spelling of an exported member, and pretending otherwise is the blindness this row fixes.
  // What keeps it out of the ledger is the span, not a rule that lies about the vocabulary: the
  // entrypoint bucket only charges a token whose spelling no ABI member carries when the shape rule
  // reads it.
  assert.deepEqual(callableNames('the fault says `Transfer amount exceeds subscription`'), [],
    'prose inside a code span is read as a contract name, so an English sentence that begins with a member of the class is charged as debt');
  assert.deepEqual(callableNames('the name `Transfer` alone').map(({ name }) => name),
    ['Transfer'], 'a span that names the class on its own is not read');
  assert.deepEqual(callableNames('list `createListing, updateListingPrice`').map(({ name }) => name),
    ['createListing', 'updateListingPrice'], 'a comma-separated name list is no longer read');
  assert.deepEqual(callableNames('call `ClearSessionKey(accountId)`').map(({ name }) => name),
    ['ClearSessionKey'], 'a call to the source spelling is no longer read, or its argument names are read as names');
  // The other direction: the deployed spelling is exact ABI, and the shape rule deliberately does not
  // read it, so the vocabulary is not "any case variant" either.
  assert.deepEqual(callableNames('call `clearSessionKey(accountId)`').map(({ name }) => name),
    [], 'the vocabulary reads a name the shape rule never read and no source definition carries');

  // 4. The ledger this vocabulary produces: 3 `spelling:` entries and 2 `entrypoint:` entries (the
  //    source-only custom reads the merged SDK book discloses) in 3 files. It shrank from the 48/7/7
  //    measurement this row was dispatched to report when the
  //    documents cleanup retired docs/SECURITY_AUDIT_RESULTS.md and
  //    docs/DEPENDENCY-CONVERGENCE-20261008.md (28 names), and it shrank again when the same cleanup
  //    deleted both copies of the March 11, 2026 audit (22 names); the v4 migration then left one
  //    entrypoint (`validateUserOp`, now defined by the native core source) and one spelling
  //    (`VerifyExecution`/`VerifyAdmin`, whose modules were deleted) behind, and rewriting the
  //    rendered custom module guide dropped the `Admin` spelling with the verifier binding it
  //    described. The docs reorganization then merged the pending-config-update read ABI topic into
  //    docs/SDK.md, which the scans read, so its two disclosed source-only reads joined the ledger
  //    as `entrypoint:` entries. The vocabulary rules themselves are unchanged, so the r2 measurement
  //    of the same corpus in section 7 below must agree with these numbers.
  const found = ratchetDebt();
  const entries = Object.values(found).flat();
  assert.equal(entries.length, 5, `the recorded ledger is not the widened one: ${entries.length} entries`);
  assert.equal(entries.filter((entry) => entry.startsWith('spelling:')).length, 3, 'the spelling bucket changed size');
  assert.equal(entries.filter((entry) => entry.startsWith('entrypoint:')).length, 2, 'the entrypoint bucket changed size');
  assert.equal(Object.keys(found).length, 3, 'the ledger no longer covers 3 files');
  // Every source-spelled occurrence in a scanned document is now read: the class has no blind spot.
  const missed = [];
  for (const file of Object.keys(found)) {
    for (const line of read(file).split('\n')) {
      for (const { name } of callableNames(line)) {
        if (deployedSpelling(name) !== undefined && !deployedAbi.has(name)
          && !found[file].includes(`spelling:${name}->${deployedSpelling(name)}`)) {
          missed.push(`${file}: ${name}`);
        }
      }
    }
  }
  assert.deepEqual(missed, [], `a source spelling in a scanned document is still not recorded:\n${missed.join('\n')}`);
});

// Every rule CU-212 adds must be able to fail, and every mutant must be paired with a kill control:
// the rule is removed from THIS process's oracle, the same document mutation is re-applied, and a
// control that does not change the answer proves the rule was decoration. The mutants are asserted on
// the reported set, never on an exit code, so an incidental failure elsewhere cannot count as a kill.
// DS-CU-212 section 4.
test('CU-212: each vocabulary rule is killed by its planted drift', () => {
  // The former standalone audit doc was merged into SECURITY.md as Appendix A.
  const auditDoc = 'docs/SECURITY.md';
  // The ledger a mutant writes, compared as the recorded list plus exactly the planted name: an
  // incidental entry elsewhere cannot pass for a kill, and a dropped recorded entry cannot hide.
  const ledgerWith = (planted) => {
    const found = ratchetDebt();
    const reported = found[auditDoc] ?? [];
    const base = [...(V2_DEBT[auditDoc]?.names ?? [])];
    const expected = base.includes(planted) ? [...base] : [...base, planted].sort();
    return { reported, expected };
  };
  const mutants = [
    {
      rule: 'the inline oracle reads the source spelling of an exported member and records it as spelling debt',
      plant: (text) => text.replace('### 6. Market Escrow', '`OnNEP17Payment(accountId, amount, data)` is the token callback.\n\n### 6. Market Escrow'),
      check: () => {
        const { reported, expected } = ledgerWith('spelling:OnNEP17Payment->onNEP17Payment');
        assert.ok(reported.includes('spelling:OnNEP17Payment->onNEP17Payment'),
          `the planted source spelling was not recorded; the scan reported ${JSON.stringify(reported)}`);
        assert.deepEqual(reported, expected, 'the planted spelling changed more of the ledger than itself');
        assert.ok(!reported.includes('entrypoint:OnNEP17Payment'),
          'the planted source spelling was also recorded as a dead entrypoint');
      },
      control: () => !(ratchetDebt()[auditDoc] ?? []).includes('spelling:OnNEP17Payment->onNEP17Payment')
        || assert.fail('the planted drift survived without the divergent class; the control did not kill it'),
    },
    {
      rule: 'the fence oracle reads the same spelling in a fenced block, and the class stays out of the mention ledger',
      plant: (text) => text.replace('### 6. Market Escrow', '```csharp\nOnNEP17Payment(accountId, amount, data);\n```\n\n### 6. Market Escrow'),
      check: () => {
        const scan = fenceScan();
        assert.ok(scan.claims[auditDoc]?.includes('OnNEP17Payment'),
          `the planted fenced call survived; the scan reported ${JSON.stringify(scan.claims)}`);
        assert.ok(!scan.mentions[auditDoc]?.includes('OnNEP17Payment'),
          'the planted fenced call was recorded as a claim and as a mention');
      },
      control: () => !(fenceScan().claims[auditDoc] ?? []).includes('OnNEP17Payment')
        || assert.fail('the planted fenced call survived without the divergent class; the control did not kill it'),
    },
    {
      rule: 'CONTROL: a name live in both spellings stays live - the exact manifest spelling and a C# definition no manifest exports',
      plant: (text) => text.replace('### 6. Market Escrow', '```csharp\nclearAccount(accountId);\nGetThresholdPolicy(accountId, policyId);\n```\n\n### 6. Market Escrow'),
      check: () => {
        assert.deepEqual(fenceScan().claims[auditDoc] ?? [], [],
          'the oracle killed a name the artifact that owns it spells exactly');
      },
      // This control must survive the rule's removal too: if it died without the class the mutant
      // itself would be broken rather than the rule, so the control proves the mutant is well-formed.
      control: () => assert.deepEqual(fenceScan().claims[auditDoc] ?? [], [],
        'the control mutant reports a claim even without the widened vocabulary, so it cannot kill anything'),
    },
  ];
  const target = path.join(repoRoot, auditDoc);
  const original = fs.readFileSync(target, 'utf8');
  for (const mutant of mutants) {
    const planted = mutant.plant(original);
    assert.notEqual(planted, original, `${mutant.rule}: the mutant did not change ${auditDoc}`);
    fs.writeFileSync(target, planted);
    try {
      mutant.check();
    } finally {
      fs.writeFileSync(target, original);
    }
  }
  // the mutants leave the tree exactly as they found it
  const drifted = fs.readFileSync(target, 'utf8');
  for (const name of ['OnNEP17Payment(', 'clearAccount, policyId']) {
    assert.ok(!drifted.includes(name), `${auditDoc} kept a planted drift: ${name}`);
  }
  // THE KILL CONTROLS: with the divergent class emptied, the same mutation must stop being reported.
  for (const mutant of mutants) {
    const saved = [...divergentSpellings];
    divergentSpellings.clear();
    try {
      fs.writeFileSync(target, mutant.plant(original));
      mutant.control();
    } finally {
      divergentSpellings.clear();
      for (const name of saved) divergentSpellings.add(name);
      fs.writeFileSync(target, original);
    }
  }
});

// Every rule above must be able to fail, so each one gets a document mutant, run against the real
// file and restored in a finally. The mutants are asserted on the reported set, never on an exit
// code, so an incidental failure elsewhere cannot count as a kill. DS-CU-211 section 5.
test('CU-211: each case rule is killed by its planted drift', () => {
  const mutants = [
    {
      rule: 'a document that writes the C# source spelling of an exported member is reported (the drift that was invisible before CU-211)',
      file: 'docs/ARCHITECTURE.md',
      plant: (text) => text.replace('RecoveryInitiated --> Configured: cancelRecovery(accountId)', 'RecoveryInitiated --> Configured: FinalizeEscape(accountId)'),
      claim: 'FinalizeEscape',
      notMention: 'FinalizeEscape',
    },
    {
      rule: 'the same rule reaches a fenced C# block, not only a diagram',
      file: 'docs/SECURITY.md',
      plant: (text) => text.replace('ExecutionEngine.Assert(!isMarketEscrowActive(accountId)', 'ExecutionEngine.Assert(!IsMarketEscrowActive(accountId)'),
      claim: 'IsMarketEscrowActive',
    },
    {
      rule: 'a source spelling is ratchet debt exactly once, in the spelling bucket, never in the entrypoint bucket',
      file: 'docs/SECURITY.md',
      plant: (text) => text.replace('### 6. Market Escrow', '`CanExecuteHook(accountId, caller, hook)` is asserted as live.\n\n### 6. Market Escrow'),
      recorded: 'spelling:CanExecuteHook->canExecuteHook',
      notRecorded: 'entrypoint:CanExecuteHook',
    },
    {
      rule: 'a call-shaped label in a diagram is a claim and is not also recorded as a justified mention',
      file: 'docs/ARCHITECTURE.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'InitiateLegacyThing(){Account ID Valid?}'),
      claim: 'InitiateLegacyThing',
      notMention: 'InitiateLegacyThing',
    },
    {
      rule: 'both halves of the decision stay live: a C# definition no manifest exports, and the manifest spelling of one that is exported',
      file: 'docs/SECURITY.md',
      plant: (text) => text.replace('### 6. Market Escrow', '```csharp\nGetThresholdPolicy(accountId, policyId);\ncanExecuteHook(accountId, callerContract, hookContract);\n```\n\n### 6. Market Escrow'),
      live: ['GetThresholdPolicy', 'canExecuteHook'],
    },
  ];
  for (const mutant of mutants) {
    const target = path.join(repoRoot, mutant.file);
    const original = fs.readFileSync(target, 'utf8');
    const planted = mutant.plant(original);
    assert.notEqual(planted, original, `${mutant.rule}: the mutant did not change ${mutant.file}`);
    fs.writeFileSync(target, planted);
    try {
      if (mutant.recorded) {
        const found = ratchetDebt();
        assert.ok(found[mutant.file]?.includes(mutant.recorded),
          `${mutant.rule}: the planted source spelling was not recorded as ${mutant.recorded}; the scan reported ${JSON.stringify(found[mutant.file])}`);
        assert.ok(!found[mutant.file]?.includes(mutant.notRecorded),
          `${mutant.rule}: the planted source spelling was also recorded as ${mutant.notRecorded}`);
        continue;
      }
      const scan = fenceScan();
      if (mutant.live) {
        for (const name of mutant.live) {
          assert.ok(!scan.claims[mutant.file]?.includes(name),
            `${mutant.rule}: the oracle killed "${name}", which the artifact that owns it spells exactly`);
        }
        continue;
      }
      assert.ok(scan.claims[mutant.file]?.includes(mutant.claim),
        `${mutant.rule}: the planted drift survived; the scan reported ${JSON.stringify(scan.claims)}`);
      if (mutant.notMention) {
        assert.ok(!scan.mentions[mutant.file]?.includes(mutant.notMention),
          `${mutant.rule}: the planted call was recorded as a claim and as a mention`);
      }
    } finally {
      fs.writeFileSync(target, original);
    }
  }
  // the mutants leave the tree exactly as they found it
  for (const mutant of mutants) {
    const target = path.join(repoRoot, mutant.file);
    const text = fs.readFileSync(target, 'utf8');
    for (const name of ['CanExecuteHook(', 'InitiateEscape()', 'IsMarketEscrowActive(', 'InitiateLegacyThing', 'GetThresholdPolicy(']) {
      assert.ok(!text.includes(name), `${mutant.file} kept a planted drift: ${name}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// CU-212 R2, after the r1 NO-GO (RV-DSCU212R1-r1 finding F1). The span rule of section 3 read the
// call form as "the last character of the span is `)`", so `InitiateEscape(accountId);` - an
// ordinary documented call at the end of a sentence - contributed nothing. The consequence was
// measured before this test was written and is recorded in DS-CU-212-20261009.md section "Round 2
// after the NO-GO": planted in a scanned document at the r1 head, that drift leaves the ratchet
// green (12/12, no ledger entry, rc=0), while the same name without the semicolon is reported as
// `spelling:InitiateEscape->initiateEscape`; at the base (790cef9, the CU-211 head) the punctuated
// form was reported. The name is not a live one that the oracle would be wrong to report: no
// manifest exports `InitiateEscape` and `deployedSpelling` maps it to the `initiateEscape` the
// manifests do export, which is why the ledger already records that entry for
// docs/SECURITY_AUDIT_RESULTS.md (DEC-DS-5). This mutant is therefore the reviewer's, and the
// demanded behaviour is the correct one.
//
// The reviewer's fixed property is asserted in three parts: the parser reads the punctuated forms,
// a planted punctuated drift is recorded, and the rule that does it can be switched off to show the
// drift surviving (a rule that cannot be removed cannot be shown to be the thing doing the work,
// the same control CU-210 R2 used). The fourth part is the DEC-DS-4 direction: the rule-disabled
// parser IS the r1 parser, and every name it reads in every scanned line is still read with the
// rule on, so the widening cannot have dropped anything the 55-entry ledger records.
test('CU-212 R2: a call the sentence punctuates is read, and its drift is reported', () => {
  // 1. The end-to-end defect the reviewer measured: an ordinary documented call at the end of a
  //    sentence, planted in a scanned document, must be recorded. The ledger for that document is
  //    exactly that one entry - an incidental entry elsewhere could not pass for the kill, and a
  //    recorded entry that disappeared could not hide.
  const auditDoc = 'docs/SECURITY.md';
  const target = path.join(repoRoot, auditDoc);
  const original = fs.readFileSync(target, 'utf8');
  const planted = original.replace('### 6. Market Escrow',
    '`InitiateEscape(accountId);` starts the backup-owner recovery window.\n\n### 6. Market Escrow');
  assert.notEqual(planted, original, 'the mutant did not change the document');
  const recordedEntry = 'spelling:InitiateEscape->initiateEscape';
  fs.writeFileSync(target, planted);
  try {
    const reported = ratchetDebt()[auditDoc] ?? [];
    assert.ok(reported.includes(recordedEntry),
      `the planted punctuated call was not recorded as ${recordedEntry}; the scan reported ${JSON.stringify(reported)}`);
    assert.deepEqual(reported, [recordedEntry], 'the planted punctuated call changed more of the ledger than itself');
  } finally {
    fs.writeFileSync(target, original);
  }

  // 2. The parser's contract, on the reviewer's own span and the other tails a sentence gives a call.
  for (const span of ['InitiateEscape(accountId);', 'InitiateEscape(accountId).', 'InitiateEscape(accountId),']) {
    assert.deepEqual(callableNames(`the guide says \`${span}\``).map(({ name }) => name), ['InitiateEscape'],
      `a call the sentence punctuates is not read: \`${span}\``);
  }
  // 3. The same dead end for a name list that ends with its own separator: the last character is not
  //    what decides a span, and the base read both names of `createListing, updateListingPrice;`.
  for (const span of ['CreateListing, UpdateListingPrice;', 'CreateListing, UpdateListingPrice,', 'CreateListing, UpdateListingPrice/']) {
    assert.deepEqual(callableNames(`see \`${span}\``).map(({ name }) => name), ['CreateListing', 'UpdateListingPrice'],
      `a name list that ends with its separator is not read: \`${span}\``);
  }
  // 4. Removing the tail is not the same as not classifying the span: a sentence that ends in a
  //    punctuated call is still PROSE, because the head before the first `(` is not a dotted name.
  assert.deepEqual(callableNames('the sentence is `the guide says InitiateEscape(accountId);`'), [],
    'a sentence that ends in a punctuated call is read as a name');

  // 5. THE KILL CONTROL: with the punctuation rule switched off, the same plant must survive. If it
  //    did not, the mutant would be killed by something else and the rule would be decoration.
  stripSentenceTail.enabled = false;
  try {
    fs.writeFileSync(target, planted);
    assert.ok(!(ratchetDebt()[auditDoc] ?? []).includes(recordedEntry),
      'the planted drift survived without the punctuation rule; the control did not kill it');
  } finally {
    fs.writeFileSync(target, original);
    stripSentenceTail.enabled = true;
  }

  // 6. The direction of the widening (DEC-DS-4): with the rule off, `callableNames` is the r1 parser,
  //    so this compares the two rules over every line of every document the ratchet scans. A name the
  //    r1 parser read and the R2 parser does not would be enforcement silently lost.
  const scanned = tracked.filter((file) => file.endsWith('.md')
    && !isResearchDocument(file) && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/')
    && !CURRENT_DOCS.includes(file));
  const lost = [];
  let linesScanned = 0;
  for (const file of scanned) {
    for (const line of read(file).split('\n')) {
      linesScanned += 1;
      stripSentenceTail.enabled = false;
      const before = new Set(callableNames(line).map(({ name }) => name));
      stripSentenceTail.enabled = true;
      const after = new Set(callableNames(line).map(({ name }) => name));
      for (const name of before) if (!after.has(name)) lost.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(lost, [], `the punctuation rule dropped names the r1 parser read:\n${lost.join('\n')}`);
  assert.ok(linesScanned > 10000, `the direction check scanned only ${linesScanned} lines, so it proves little`);

  // 7. On today's corpus the widening moves no entry: the ledger is 3 files / 5 names (3 `spelling:`
  //    plus the 2 `entrypoint:` reads the merged SDK book records as source-only), the r1
  //    records minus the deleted snapshot documents and the v3-only members the v4 migration
  //    removed, so the fix adds enforcement rather than changing what is recorded.
  const found = ratchetDebt();
  const entries = Object.values(found).flat();
  assert.equal(entries.length, 5, `the punctuated-call rule changed the ledger size: ${entries.length} entries`);
  assert.equal(entries.filter((entry) => entry.startsWith('spelling:')).length, 3, 'the spelling bucket changed size');
  assert.equal(entries.filter((entry) => entry.startsWith('entrypoint:')).length, 2, 'the entrypoint bucket changed size');
  assert.equal(Object.keys(found).length, 3, 'the ledger no longer covers 3 files');
  assert.ok(!entries.includes(`entrypoint:InitiateEscape`), 'the punctuated call was recorded in both buckets');
});

// The integrated closure receipt is deliberately NO-GO: it records a scoped PASS without
// promoting any public entrypoint or the whole implementation to verified. Keep that distinction
// machine-checked against the receipt the gate document actually cites.
test('SA integrated closure remains scoped, fail-closed, and bound to current evidence', () => {
  const receiptPath = 'docs/reports/sa-closure-gate-20261117.json';
  const gate = JSON.parse(read(receiptPath));

  assert.equal(gate.schema, 'neoos-aa-integrated-closure/v1');
  assert.equal(gate.status, 'NO-GO');
  assert.equal(gate.selectedScopeStatus, 'PASS');
  assert.equal(gate.implementationVerified, false);
  assert.equal(gate.fullImplementationVerified, false);
  assert.deepEqual(gate.verifiedEntrypoints, []);
  assert.equal(gate.publicNetworkWritesPerformed, false);
  assert.equal(gate.abiEntryCount, 109);
  assert.equal(gate.fullUnprovedCount, 109);
  assert.equal(gate.entrypointCoverage.total, 109);
  assert.equal(gate.entrypointCoverage.fullyClosed, 0);
  assert.equal(gate.entrypointCoverage.bodyLevelRefined, 34);
  assert.deepEqual(gate.openObligations, [
    'SOURCE_FRONTEND_AND_COMPILER_CORRESPONDENCE',
    'ACTUAL_VM_APPLICATION_ENGINE_ABI_DISPATCH',
    'GAS_RESOURCE_EXCEPTION_AND_TRANSACTION_COMPOSITION',
    'ALL_PUBLIC_ENTRYPOINT_DEPENDENCY_CLOSURES',
  ]);
  // The receipt binds every scoped proof run it consumed, and records at most two concurrent lanes.
  assert.equal(Object.keys(gate.rawReceiptSha256).length, 24);
  assert.equal(Object.keys(gate.commands).length, 27);
  for (const record of Object.values(gate.commands)) {
    assert.equal(record.exitCode, 0, `${record.log} did not exit zero`);
    assert.equal(record.timedOut, false, `${record.log} timed out`);
  }
  assert.equal(gate.maximumConcurrentLanes, 2);

  const gateDoc = read('docs/engineering/VERIFICATION-AND-GATES.md');
  assert.match(gateDoc, /sa-closure-gate-20261117\.json/);
  assert.doesNotMatch(gateDoc, /[A-Za-z]:\\Users\\/);
});

// Bilingual parity. A `.zh-CN.md` file with an English source is the same book in another
// language, so its H2/H3 heading sequence - level for level, outside code fences - has to match
// the English book's. A translation that silently drops a chapter fails here, and so does an
// English book that grows a chapter nobody declared. The declared English-only chapters live in
// HEADING_PARITY_EXCEPTIONS and are restated in the "Language policy" section of docs/INDEX.md
// and the 语言策略 section of docs/INDEX.zh-CN.md.
const HEADING_PARITY_EXCEPTIONS = new Map([
  // docs/INDEX.md "Language policy": chapters 1-18 are parallel, and the module developer
  // appendix followed by the frontend module chooser guide exist in English only.
  ['docs/SA-MODULE-PROTOCOL.md', ['Appendix: Module developer guide', 'Frontend module chooser guide']],
]);

// ATX headings of level 2-3 outside fenced code blocks (a `# comment` inside a bash fence is
// not a chapter). H1 is the book title and is deliberately not compared.
function headingSequence(text) {
  const headings = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[2][0];
      else if (marker[2][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^(#{2,3})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) headings.push({ level: heading[1].length, text: heading[2] });
  }
  return headings;
}

// Remove the declared English-only chapters: an excepted H2 and every H3 under it, up to the
// next H2. An exception must name a chapter that exists, so a renamed chapter cannot leave a
// stale allowance behind.
function withoutEnglishOnlyChapters(headings, englishOnly, file) {
  const kept = [];
  let skipping = false;
  for (const heading of headings) {
    if (heading.level === 2) {
      skipping = englishOnly.includes(heading.text);
      if (skipping) continue;
    }
    if (!skipping) kept.push(heading);
  }
  for (const title of englishOnly) {
    assert.ok(headings.some((heading) => heading.level === 2 && heading.text === title),
      `${file}: the declared English-only chapter "${title}" no longer exists; update HEADING_PARITY_EXCEPTIONS and docs/INDEX.md`);
  }
  return kept;
}

test('bilingual books: every Chinese counterpart carries the H2/H3 chapters of its English book', () => {
  const pairs = tracked.filter((file) => file.startsWith('docs/') && file.endsWith('.zh-CN.md')
    && exists(file.replace(/\.zh-CN\.md$/, '.md')))
    .map((file) => [file.replace(/\.zh-CN\.md$/, '.md'), file]);
  pairs.push(['README.md', 'README.zh-CN.md']);
  // The guard is only meaningful if it reads the books INDEX.md declares as the 12 bilingual pairs.
  assert.equal(pairs.length, 12, `the bilingual pair count changed: ${pairs.map(([en]) => en).join(', ')}`);
  for (const [english, chinese] of pairs) {
    const expected = withoutEnglishOnlyChapters(
      headingSequence(read(english)), HEADING_PARITY_EXCEPTIONS.get(english) ?? [], english);
    const found = headingSequence(read(chinese));
    const levels = (headings) => headings.map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`);
    assert.equal(found.length, expected.length,
      `${chinese}: ${found.length} H2/H3 headings against ${expected.length} in ${english}. English-only chapters:\n${levels(expected).join('\n')}`);
    expected.forEach((heading, index) => assert.equal(found[index].level, heading.level,
      `${chinese}: heading ${index + 1} is H${found[index].level} ("${found[index].text}") where ${english} has H${heading.level} ("${heading.text}")`));
  }
  // The declared exceptions are exactly the English-only chapters docs/INDEX.md announces.
  const index = read('docs/INDEX.md');
  for (const [english, titles] of HEADING_PARITY_EXCEPTIONS) {
    for (const title of titles) assert.ok(index.includes(`"${title}"`),
      `docs/INDEX.md no longer declares "${title}" (${english}) as English-only`);
  }
});
