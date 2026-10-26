// Guards the AA documentation against the drift CU-163 measured: documented entrypoints,
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
import { NATIVE_REQUIRED_ABI } from '../../shared/nativeSmartAccountClient.mjs';

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(frontendRoot, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(repoRoot, relative));

// Documents whose claims must hold for the runtime that ships today. DS-CU-163-20261009.md
// section 5 lists them and records why the rest of the V2-era documents are debt instead.
const CURRENT_DOCS = [
  'README.md',
  'docs/PLUGIN_MATRIX.md',
  'docs/QUICK_REFERENCE.md',
  'docs/architecture.md',
  'frontend/src/assets/docs/repo-readme.md',
  'frontend/src/assets/docs/sdk-usage.md',
  'frontend/src/assets/docs/evm-integration.md',
  'frontend/src/assets/docs/mixed-multisig.md',
  'frontend/src/assets/docs/architecture.md',
  'docs/PLUGIN_DEVELOPER_GUIDE.md',
];

// A snapshot audit: its method names are the ones that existed when it was written, so it is not
// held to the current ABI, but its VULN-001 status must still agree with the deployed artifact and
// its cited receipts must exist. DS-CU-163 section 4.3 V3.
const AUDIT_DOCS = ['frontend/src/assets/docs/SECURITY_AUDIT.md'];

// The native ABI 2 profile is a separate runtime with its own documents (DS-CU-163 section 2.2),
// and NativeSmartAccountClient declares the exact method set it validates a deployment against.
// Only these documents are read against that artefact; a name that merely coincides with a native
// method (callVerifierChild is also defined in contracts/UnifiedSmartWallet.VerifierChildren.cs and
// absent from the deployed manifest) is still judged by the deployed ABI everywhere else.
const NATIVE_PROFILE_DOCS = ['docs/NATIVE_SDK.md', 'docs/NATIVE_ACCOUNT_WORKSPACE.md'];
const nativeAbiNames = new Set(Object.keys(NATIVE_REQUIRED_ABI));
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
// are visible: 34 names became 55 (48 `spelling:` + 7 `entrypoint:`), the rise CU-212 was dispatched
// to measure and report. The 21 added `spelling:` entries are the same class as the 27 CU-211
// reclassified, each already justified by the reason its document carries; 0 of the 34 recorded
// entries was dropped, because the widened vocabulary is a union with the shape rule.
const V2_DEBT = {
  'docs/DEPENDENCY-CONVERGENCE-20261008.md': {
    names: ['entrypoint:getAuthTokenInfo'],
    reason: 'The name is the token API of the Web3Auth v11 SDK upgrade this record rejects, not a Neo contract method; the document is a package decision record, and no deployed manifest carries it.',
  },
  'docs/ACCOUNT_RECOVERY_AND_IDENTITY.md': {
    names: ['spelling:ClearAccount->clearAccount', 'spelling:VerifyAdmin->verifyAdmin', 'spelling:VerifyExecution->verifyExecution'],
    reason: 'The sentences analyse how the recovery modules clean up and verify (MultiSigVerifier.ClearAccount, MultiHook.ClearAccount, SocialRecoveryVerifier.VerifyExecution/VerifyAdmin) and qualify each name with a C# class that no manifest exports; the deployed ABI of those modules spells them clearAccount, verifyExecution and verifyAdmin, so the names are the C# spelling of exported members and stay recorded (DS-CU-212 section 4, verdict SOUND, recorded).',
  },
  'docs/ETHEREUM_AA_COMPARISON.md': {
    names: ['entrypoint:validateUserOp'],
    reason: 'The name is the Ethereum ERC-4337 validator entry point on the Ethereum side of an explicit mapping (IVerifier.validateSignature is compared with IValidator.validateUserOp), not a Neo entrypoint.',
  },
  'docs/SECURITY_AUDIT.md': {
    names: ['entrypoint:IsAnyExecutionActive', 'entrypoint:IsDomeOracleUnlocked', 'spelling:CanExecuteHook->canExecuteHook', 'spelling:ClearAccount->clearAccount', 'spelling:ClearSessionKey->clearSessionKey', 'spelling:EnterMarketEscrow->enterMarketEscrow', 'spelling:SettleMarketEscrow->settleMarketEscrow', 'spelling:SetupRecovery->setupRecovery', 'spelling:ValidateSignature->validateSignature', 'spelling:Verify->verify', 'spelling:VerifyMetaTx->verifyMetaTx'],
    reason: 'Dated audit (March 11, 2026) of an earlier contract generation: the names and code quotes are that revision\'s, and the document is bannered as historical context rather than a description of the current system.',
    marker: 'retained as historical security context',
  },
  'docs/SECURITY_AUDIT_RESULTS.md': {
    names: ['entrypoint:IsAnyExecutionActive', 'spelling:CallHook->callHook', 'spelling:CallVerifier->callVerifier', 'spelling:CanConfigureHook->canConfigureHook', 'spelling:CanConfigureVerifier->canConfigureVerifier', 'spelling:ClearAccount->clearAccount', 'spelling:ConfirmHookUpdate->confirmHookUpdate', 'spelling:ConfirmVerifierUpdate->confirmVerifierUpdate', 'spelling:CreateListing->createListing', 'spelling:ExecuteUserOp->executeUserOp', 'spelling:FinalizeEscape->finalizeEscape', 'spelling:InitiateEscape->initiateEscape', 'spelling:OnNEP17Payment->onNEP17Payment', 'spelling:PostExecute->postExecute', 'spelling:PreExecute->preExecute', 'spelling:RefundPendingPayment->refundPendingPayment', 'spelling:RegisterAccount->registerAccount', 'spelling:RotateAdmin->rotateAdmin', 'spelling:SetDailyLimit->setDailyLimit', 'spelling:SetHooks->setHooks', 'spelling:SetSessionKey->setSessionKey', 'spelling:SettleListing->settleListing', 'spelling:SettleMarketEscrow->settleMarketEscrow', 'spelling:UpdateHook->updateHook', 'spelling:UpdateListingPrice->updateListingPrice', 'spelling:UpdateVerifier->updateVerifier', 'spelling:ValidateSignature->validateSignature'],
    reason: 'Dated audit (2026-03-29): the finding sections preserve original evidence, status labels and code snippets of the audited revision, and the status note says not to read the snippets as a description of the deployed artifact.',
    marker: 'some original code snippets/status labels are intentionally historical',
  },
  'frontend/src/assets/docs/custom-verifiers.md': {
    names: ['spelling:Admin->admin'],
    reason: 'The sentence binds a custom verifier to an account "by an existing Admin of the account": the role is the ABI method the paymaster, the market and the mock target export as admin (contracts/paymaster/Paymaster.cs:93, contracts/market/AAAddressMarket.cs:83, contracts/mocks/MockTransferTarget.cs:36, and the internal HookAuthority.Admin at contracts/hooks/HookAuthority.cs:63), so the C# spelling is a claim about a name the deployment spells admin and it stays recorded (DS-CU-212 section 4).',
  },
  'frontend/src/assets/docs/SECURITY_AUDIT.md': {
    names: ['entrypoint:IsAnyExecutionActive', 'entrypoint:IsDomeOracleUnlocked', 'spelling:CanExecuteHook->canExecuteHook', 'spelling:ClearAccount->clearAccount', 'spelling:ClearSessionKey->clearSessionKey', 'spelling:EnterMarketEscrow->enterMarketEscrow', 'spelling:SettleMarketEscrow->settleMarketEscrow', 'spelling:SetupRecovery->setupRecovery', 'spelling:ValidateSignature->validateSignature', 'spelling:Verify->verify', 'spelling:VerifyMetaTx->verifyMetaTx'],
    reason: 'The rendered copy of the dated March 11, 2026 audit: the guard requires this file to equal docs/SECURITY_AUDIT.md byte for byte, so its entries stand or fall with that file and its historical banner.',
    marker: 'retained as historical security context',
  },
};

// Framework and service calls that share a name with a contract method but are not one.
// ContractManagement is the Neo native contract: contracts/UnifiedSmartWallet.Accounts.cs:404 calls
// ContractManagement.GetContract and tests/AbstractAccount.Contracts.Tests/*.cs invoke the native
// "getContract" by string, so a document that reads a NEF back that way names no AA entrypoint.
// CallFlags is the SmartContract.Framework enum used as the third argument of Contract.Call; it is a
// type, not an entrypoint, and naming it here is what keeps the scan's vocabulary from being widened
// entry by entry (DS-CU-210 section 3).
const FRAMEWORK_RECEIVERS = new Set(['Runtime', 'Contract', 'ContractManagement', 'System', 'CryptoLib', 'Storage', 'Helper', 'ExecutionEngine', 'Neo', 'CallFlags']);
// Inline code that looks like an entrypoint but is a parameter, a field or a service name.
// callHash is a field of the pending-module-call record (contracts/UnifiedSmartWallet.Models.cs:65),
// not a callable; DS-CU-202 section 4.
const NON_CALLABLES = new Set(['create_aa_draft', 'claimCommitment', 'callData', 'signMessage', 'getPending', 'callHash']);

const ENTRYPOINT = /^(?:execute|register|preview|initiate|finalize|settle|update|cancel|confirm|propose|compute|get|set|is|has|can|withdraw|revoke|rotate|claim|deposit|call|lock|unlock|create|build|derive|validate|query|prepare|sign|broadcast|discover)[A-Z][A-Za-z0-9]*$/;
// A line that marks a name as gone. The repository's translation copies state removal in Chinese,
// so the marker vocabulary is not English-only; "旧版" (legacy) deliberately does NOT mark a
// removal, because "legacy X is compatibility-only" was itself the false claim (DS-CU-163 B2).
const REMOVED = /remov|superseded|no longer|not part|does not exist|never existed|absent|retired|deleted|dropped|gone|were never|移除|删除|弃用|废弃|不再/i;

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
(function walk(dir) {
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.')) continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(relative);
    else tracked.push(relative);
  }
})('.');
for (const file of tracked) {
  if (!/\.(cs|js|mjs|ts|py|sql|json)$/.test(file)) continue;
  // Test drivers are not the product surface, and docs are prose about it.
  if (file.startsWith('docs/') || file.startsWith('frontend/tests/') || file.startsWith('tests/') || file.startsWith('sdk/js/tests/')) continue;
  const text = read(file);
  // A call is a call whether or not it is optional-chained: frontend/src/features/native/
  // nativeWorkspace.js calls `provider.getNetworks?.()`.
  for (const match of text.matchAll(/([A-Za-z_]\w*)\s*\??\.?\s*\(/g)) definedNames.add(match[1]);
  for (const match of text.matchAll(/DisplayName\("([^"]+)"\)/g)) definedNames.add(match[1]);
  // A contract may only call what its permissions name, and the pinned native authority calls the
  // service by string (contracts/native/NativeAuthority.cs). Both spellings are live names, and the
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
  if (!file.startsWith('contracts/') || !file.endsWith('.cs')) continue;
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

// THE DIVERGENT CLASS (DS-CU-212, DEC-DS-6): every C# definition the compiler exports under a
// DIFFERENT spelling than the source writes. This is the set of names the `ENTRYPOINT` prefix list
// below could not read, and it is derived from the manifests and the sources rather than listed,
// because the class is what the renaming rule produces: 198 members at this base, and it moves when
// a contract exports a new member. A name that merely looks capitalised is not in it, and neither is
// a C# definition no manifest exports (DEC-DS-5 rule 2: that one is live as source).
const divergentSpellings = new Set([...sourceDefinitions].filter((name) => {
  const deployed = deployedSpelling(name);
  return deployedAbi.has(deployed) && !deployedAbi.has(name);
}));
// A source definition the compiler exports under the SAME spelling (only `_deploy` in this
// repository) is not divergent; the set above would not carry it, and it needs no widening because
// `deployedAbi` already holds its exact spelling.
const exportedInSourceSpelling = new Set([...sourceDefinitions].filter((name) => deployedAbi.has(name)));

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

// The deployed NEF: the gas-bounded syscall VULN-001 is about. The token is read from the
// pinned artifact, never from a document.
const GAS_BOUNDED_SYSCALL = 'System.Contract.CallWithGasLimit';
const NEF_SYSCALL_OPCODE = 0x41;
const OPERAND_SIZE = {
  0x00: 1, 0x01: 2, 0x02: 4, 0x03: 8, 0x04: 16, 0x05: 32, 0x0a: 4,
  0x22: 1, 0x23: 4, 0x24: 1, 0x25: 4, 0x26: 1, 0x27: 4, 0x28: 1, 0x29: 4,
  0x2a: 1, 0x2b: 4, 0x2c: 1, 0x2d: 4, 0x2e: 1, 0x2f: 4, 0x30: 1, 0x31: 4,
  0x32: 1, 0x33: 4, 0x34: 1, 0x35: 4, 0x37: 2, 0x3b: 2, 0x3c: 8, 0x3e: 4,
  0x41: 4, 0x56: 1, 0x57: 2, 0x5f: 1, 0x67: 1, 0x6f: 1, 0x77: 1, 0x7f: 1,
  0x87: 1, 0xc4: 1, 0xd9: 1, 0xdb: 1,
};
const PUSHDATA_PREFIX = { 0x0c: 1, 0x0d: 2, 0x0e: 4 };
const GAS_BOUNDED_INTEROP = 1371299780;

function readVarint(bytes, offset) {
  const first = bytes[offset];
  if (first < 0xfd) return [first, offset + 1];
  const width = { 0xfd: 2, 0xfe: 4, 0xff: 8 }[first];
  return [Number(bytes.readUIntLE(offset + 1, width)), offset + 1 + width];
}

function readVarstring(bytes, offset) {
  const [length, next] = readVarint(bytes, offset);
  return [bytes.subarray(next, next + length), next + length];
}

// Walk the NEF header the way NefFile does and return the contract script.
function nefScript(file) {
  const bytes = fs.readFileSync(path.join(repoRoot, file));
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'NEF3', `${file} is not a NEF3 artifact`);
  let offset = 4 + 64; // magic + compiler
  [, offset] = readVarstring(bytes, offset); // source
  assert.equal(bytes[offset], 0, `${file}: reserved byte after the source is not zero`);
  offset += 1;
  const [tokenCount, afterCount] = readVarint(bytes, offset);
  offset = afterCount;
  for (let i = 0; i < tokenCount; i += 1) {
    offset += 20; // token hash
    [, offset] = readVarstring(bytes, offset); // method
    offset += 4; // parameters + return value + call flags
  }
  assert.equal(bytes[offset], 0, `${file}: reserved bytes before the script are not zero`);
  assert.equal(bytes[offset + 1], 0, `${file}: reserved bytes before the script are not zero`);
  offset += 2;
  const [scriptLength, afterLength] = readVarint(bytes, offset);
  return bytes.subarray(afterLength, afterLength + scriptLength);
}

function gasBoundedCallSites(file) {
  const script = nefScript(file);
  const sites = [];
  let i = 0;
  while (i < script.length) {
    const opcode = script[i];
    if (opcode === NEF_SYSCALL_OPCODE) {
      const token = script.readUInt32LE(i + 1);
      if (token === GAS_BOUNDED_INTEROP) sites.push(i);
      i += 1 + OPERAND_SIZE[0x41];
      continue;
    }
    if (PUSHDATA_PREFIX[opcode] !== undefined) {
      const lengthSize = PUSHDATA_PREFIX[opcode];
      const length = lengthSize === 1 ? script[i + 1] : lengthSize === 2 ? script.readUInt16LE(i + 1) : script.readUInt32LE(i + 1);
      i += 1 + lengthSize + length;
      continue;
    }
    const size = OPERAND_SIZE[opcode];
    i += size === undefined ? 1 : 1 + size;
  }
  return sites;
}

const deployedCorePath = JSON.parse(read('tests/localchain/expected-source.json')).deployedCore.path;
const gasBoundedSites = gasBoundedCallSites(deployedCorePath);
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
//     example of docs/MULTISIG_SDK.md name nothing the repository contains (no `.cs`, `.js`,
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
// `Transfer amount exceeds subscription` (the quoted fault message at docs/PLUGIN_MATRIX.md:124)
// names no callable even though its first word is a member of the class, and a span that is only
// `Transfer(` is a fragment, not a name.
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
//   * a C# definition no manifest exports is live as source. `CallVerifierChild`
//     (contracts/UnifiedSmartWallet.VerifierChildren.cs) is the recorded example: the pinned build
//     does not export it (DS-CU-202 finding F1), and a document that names it names real code.
//
// The two halves are why the rule keys on the artifact rather than on letter case: refusing every
// PascalCase name would kill the second class, and accepting every case variant would keep the
// first invisible.
function isLiveName(name, file) {
  if (deployedAbi.has(name)) return true;
  if (deployedSpelling(name) !== undefined) return false;
  if (sourceDefinitions.has(name) || definedNames.has(name) || sdkMethods.has(name)) return true;
  if (NATIVE_PROFILE_DOCS.includes(file) && nativeAbiNames.has(name)) return true;
  return false;
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
// docs/ETHEREUM_AA_COMPARISON.md is prose comparing two systems, and reading it as a claim invented
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
function fenceScan() {
  const claims = {};
  const mentions = {};
  const snippetScopes = new Set();
  const files = tracked.filter((file) => file.endsWith('.md')
    && !file.startsWith('docs/proposals/') && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/')
    && !CURRENT_DOCS.includes(file));
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
  for (const file of [...CURRENT_DOCS, ...AUDIT_DOCS]) {
    assert.ok(exists(file), `guarded document ${file} does not exist`);
    const nameRules = CURRENT_DOCS.includes(file);
    const lines = read(file).split('\n');
    const historical = historicalSections(lines);
    let fence = false;
    lines.forEach((line, index) => {
      const where = `${file}:${index + 1}`;
      const markedRemoved = REMOVED.test(line) || historical[index];
      if (/^\s*```/.test(line)) { fence = !fence; return; }
      if (nameRules) for (const { name } of callableNames(line)) {
        if (deployedAbi.has(name)) continue;
        if (deployedAbiLower.has(name.toLowerCase())) {
          problems.push(`${where}: ${name} is not a deployed ABI name; the artifact spells it ${deployedAbiLower.get(name.toLowerCase())}`);
          continue;
        }
        if (definedNames.has(name)) continue;
        if (markedRemoved) continue;
        problems.push(`${where}: ${name} is not defined in any contract, manifest or SDK source and the line does not mark it removed`);
      }
      if (nameRules && fence && !markedRemoved) for (const match of line.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) {
        if (canonicalHashes.has(match[0].toLowerCase())) continue;
        if (!/current|canonical|verified hardened|masterHash|AA_RELAY_ALLOWED_HASH/i.test(line)) continue;
        problems.push(`${where}: ${match[0]} is presented as the current deployment but is not in generatedMorpheusRegistry.js`);
      }
      if (nameRules && !markedRemoved) for (const match of line.matchAll(/\b(?:aaClient|client|sdk)\.([A-Za-z_]\w*)\s*\(/g)) {
        const name = match[1];
        if (legacySdkMethods.has(name)) problems.push(`${where}: ${name} always throws LEGACY_V3_REMOVED in the SDK and must not be documented as usable`);
        else if (!sdkMethods.has(name)) problems.push(`${where}: ${name} is not an SDK method`);
      }
      for (const match of line.matchAll(/`(docs\/[\w./-]+\.(?:json|md))`/g)) {
        if (!exists(match[1])) problems.push(`${where}: cited receipt ${match[1]} does not exist`);
      }
      if (/VULN-001/.test(line) && /fix|clos|resolv|mitigat|eliminat/i.test(line) && !/private|only|not\b|pending|open|historical/i.test(line)) {
        if (gasBoundedSites.length === 0) {
          problems.push(`${where}: ${file} claims VULN-001 closed, but ${deployedCorePath} carries no ${GAS_BOUNDED_SYSCALL} call site`);
        }
      }
    });
    if (nameRules) {
      // Hashes in prose are checked per paragraph, not per line: the prose wraps, and a stale
      // anchor on the second line of a sentence must not escape the rule. Fenced examples keep the
      // line check above, because a code block is where a placeholder hash lives.
      const prose = read(file).replace(/^\s*```[\s\S]*?^\s*```/gm, '');
      for (const paragraph of prose.split(/\n\s*\n/)) {
        const flat = paragraph.replace(/\s+/g, ' ');
        if (!/current|canonical|verified hardened|masterHash|AA_RELAY_ALLOWED_HASH/i.test(flat)) continue;
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
// These 37 historical findings are public source/build digests in one immutable
// report commit. Pin the entire fingerprint file, never the report path or rule.
const REVIEWED_GITLEAKS_IGNORE = {
  path: '.gitleaksignore',
  sha256: '2e665bb7444285dcddb0fe507bd3a9a4e852fc22a1b8ab773fa13f3473cc82c3',
  commit: 'da74a6f1870f2749899e60b5ec1b1f22476c6bc4',
  report: 'docs/reports/aa-artifact-reproducibility-20261025.json',
  findings: 37,
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
    inventory: { lines: 6, sha256: '191917ca34fd1d5ba12872ba739a33d3f2ed71ca9d72a96b4c1606643125150b' },
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
      // chain, and its proxy hash differs from the shared TestNet `aaSessionKeyVerifier` the
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
];

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

// The population this row classified, by artefact: the files and per-file counts the canonical scan
// of the default head reports (WS-CU-231-20261012.md, measurement 1 - 37 findings over
// `be06b8f..3dc7d8a`, symmetric difference zero against the 21-commit range the row measured). The
// scanner-level test below holds both directions against these numbers.
const CU231_CLASSIFIED = new Map([
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
      if (SKIP_DIRS.has(entry.name)) continue;
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.')) walk(relative); continue; }
      if (GITLEAKS_CONFIG_FILES.includes(entry.name) && relative !== GITLEAKS_CONFIG) found.push(relative);
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
  for (const fingerprint of fingerprints) {
    const prefix = `${REVIEWED_GITLEAKS_IGNORE.commit}:${REVIEWED_GITLEAKS_IGNORE.report}:generic-api-key:`;
    assert.ok(fingerprint.startsWith(prefix) && /^\d+$/.test(fingerprint.slice(prefix.length)),
      'every reviewed fingerprint must bind the exact historical commit, report, rule and line');
  }
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
      const digest = createHash('sha256').update(fs.readFileSync(path.join(repoRoot, entry.literalPath))).digest('hex');
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

// The acceptance of CU-231, at the scanner rather than at the guard: the four generated reports the
// default head's canonical scan reports are committed into a throwaway repository with the reviewed
// configuration, and the canonical range scan must be clean. The control is the half that gives
// "clean" a meaning - with the four classified allowances removed, the same range must report the
// same 37 findings, by artefact and by count. Without it a clean scan could mean the scanner never
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
    // The same range with the four classified allowances dropped, addressed by the path clause each
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

// The ledger, not a document's prose, is the current VULN-001 state. While the deployed artifact
// carries no bounded call site the ledger must say the public state is open; if the artifact ever
// gains the bounded call, this fails until the ledger is updated too.
test('CU-163: the VULN-001 ledger agrees with the deployed artifact', () => {
  const row = read('docs/SECURITY_MODEL.md').split('\n').find((line) => /\*\*VULN-001\*\*/.test(line));
  assert.ok(row, 'docs/SECURITY_MODEL.md has no VULN-001 row');
  if (gasBoundedSites.length === 0) {
    assert.match(row, /open|not\b|pending/i,
      `the deployed core has no ${GAS_BOUNDED_SYSCALL} call site, so the ledger must not close VULN-001 for the public build`);
  }
});

// Presentation rule for snapshot audits: a VULN-00N item must sit under a heading that calls the
// snapshot historical. This is weaker than the artifact checks above and is stated as such — it
// cannot prove an item is right, only that a reader is not shown a pre-remediation list as current.
// The rendered copy must also stay equal to the repository copy, which is the copy the ledger rule
// above is about.
test('CU-163: the rendered audit presents its findings as the historical snapshot', () => {
  for (const file of AUDIT_DOCS) {
    const lines = read(file).split('\n');
    let heading = '';
    lines.forEach((line, index) => {
      if (/^#{1,4}\s/.test(line)) heading = line;
      if (!/VULN-00\d/.test(line)) return;
      const marked = /historical|archived|retained for audit/i.test(line) || /historical|archived|retained for audit/i.test(heading);
      assert.ok(marked, `${file}:${index + 1}: a VULN-00N item is presented outside a historical section`);
    });
  }
  assert.equal(read('frontend/src/assets/docs/SECURITY_AUDIT.md'), read('docs/SECURITY_AUDIT.md'),
    'the rendered security audit has drifted from docs/SECURITY_AUDIT.md');
});

// The ledger is the only place that numbers an issue VULN-00N. A second document reusing an id
// makes a reviewer read two different issues under one name (DS-CU-163 section 4.3 V4).
test('CU-163: only the ledger numbers issues VULN-00N', () => {
  const markdown = tracked.filter((file) => file.endsWith('.md')
    && !file.startsWith('docs/proposals/') && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/'));
  const collisions = [];
  for (const file of markdown) {
    read(file).split('\n').forEach((line, index) => {
      if (/^#{1,6}\s*VULN-00\d/.test(line)) collisions.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(collisions, [], `a document reuses a ledger identifier as a heading:\n${collisions.join('\n')}`);
});

// The closure claim is checked against the artifact for every document, not only the guarded ones:
// while the deployed core carries no bounded call site, no document may say the public build is
// fixed. A document may say the private artifact is closed when it says so in those words.
test('CU-163: no document closes VULN-001 for the public build while the deployed core has no bounded call', () => {
  if (gasBoundedSites.length > 0) return;
  const markdown = tracked.filter((file) => file.endsWith('.md')
    && !file.startsWith('docs/proposals/') && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/'));
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
  assert.deepEqual(claims, [], `a document claims VULN-001 closed for the public build while ${deployedCorePath} carries no ${GAS_BOUNDED_SYSCALL} call site:\n${claims.join('\n')}`);
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
function ratchetDebt() {
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
      // word the ABI happens to use - `Transfer amount exceeds subscription`
      // (docs/PLUGIN_MATRIX.md:124) - as a dead entrypoint, inventing debt for an English word
      // (DS-CU-212, DEC-DS-6 rule 5).
      .filter(({ name }) => shapedLikeEntrypoint(name))
      .filter(({ name }) => !isLiveName(name, file))
      .map(({ name }) => `entrypoint:${name}`)),
    spelling: (line) => callableNames(line)
      .filter(({ name }) => !deployedAbi.has(name) && deployedSpelling(name) !== undefined)
      .map(({ name }) => `spelling:${name}->${deployedSpelling(name)}`),
    sdk: (line) => [...line.matchAll(/\b(?:aaClient|client|sdk)\.([A-Za-z_]\w*)\s*\(/g)].flatMap((match) => legacySdkMethods.has(match[1]) ? [`legacy:${match[1]}`] : sdkMethods.has(match[1]) ? [] : [`sdk:${match[1]}`]),
  };
  const found = {};
  const files = tracked.filter((file) => file.endsWith('.md')
    && !file.startsWith('docs/proposals/') && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/')
    && !CURRENT_DOCS.includes(file));
  for (const file of files) {
    const names = new Set();
    for (const line of read(file).split('\n')) {
      for (const build of Object.values(patterns)) for (const name of build(line, file)) names.add(name);
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

// Fenced blocks whose names the scan judges to be mentions rather than claims. Each entry is a name
// that a diagram uses as a label while the code the label stands for is called by its deployed
// spelling; the arrow of the correction is the other way round from the ratchet, so these are
// recorded here and the guard fails if one disappears rather than if one appears. DS-CU-210 section 4.
const V2_FENCE_MENTIONS = {
  'docs/DATA_FLOW.md': {
    names: ['CallCustom', 'HasID'],
    reason: 'Bare mermaid node labels of the authorization flowchart (HasID is the account-id decision node, CallCustom the verifier branch), not calls; the underlying reads are named in the deployed ABI and the diagram is a picture of the flow, not an example a reader copies.',
  },
  'docs/ETHEREUM_AA_COMPARISON.md': {
    names: ['ValidateSig', 'validateUserOpLogic'],
    reason: 'Bare mermaid node labels in the diagram that maps the Ethereum validation path onto the Neo one (ValidateSig stands for the signature-check stage, validateUserOpLogic for the Ethereum validator logic); neither is written as a call, and the solidity blocks of the same document are already declared illustrative.',
  },
  'docs/NATIVE_ACCOUNT_TRANSACTION_GUARDS.md': {
    names: ['cancelModuleCall'],
    reason: 'The native account work landed on the default branch after this chain forked; its text fence is the NeoVM script the signed application runs, and the name is the AccountManagement method that script pushes as a string, so the document names the call rather than making it.',
  },
  'frontend/src/assets/docs/data-flow.md': {
    names: ['CallCustom', 'HasID'],
    reason: 'The rendered copy of the same flowchart; the rendered documents are required to stay in step with their source, so its mention list stands or falls with docs/DATA_FLOW.md.',
  },
};


// Dated snapshots whose own scope note says their code snippets are evidence of the revision they
// audited rather than a description of the deployed artifact. The guard requires the phrase to be
// present; this list is what lets a document use it, so an exemption is never implicit and adopting
// it in a new document fails the test instead of silencing the scan (DS-CU-210 section 3).
const V2_FENCE_SCOPES = {
  'docs/SECURITY_AUDIT_RESULTS.md': 'Dated audit (2026-03-29) whose status note ends "Do not use the historical snippets below as a description of the deployed artifact": the fenced C# is that revision\'s code, and the document already carries the note as the reason its inline entries stay in the ratchet.',
  'docs/SECURITY_AUDIT.md': 'Dated audit (March 11, 2026) whose summary says it "is retained as historical security context rather than as the sole description of the current system": the same reasoning as the results document, in the file the ratchet already justifies with that marker.',
  'frontend/src/assets/docs/SECURITY_AUDIT.md': 'The rendered copy of the March 11, 2026 audit, required by this guard to equal docs/SECURITY_AUDIT.md byte for byte, so its snippets inherit that document\'s scope note exactly as its ratchet entries already do.',
};

test('CU-210: fenced blocks assert nothing the code does not, and the ratchet still holds', () => {
  const scan = fenceScan();
  // CU-210 R2 (the NO-GO fix forward). The four names below are the ones the claim side of this
  // oracle could not READ at the r1 head, so their drift was invisible to it while the test above
  // stayed green - a check that could not fail. Two are dead calls that the fenced examples really
  // make (`collectChildProofs`, `childSigns` in docs/MULTISIG_SDK.md; F7 and F8 below), and two are
  // live ABI members written the way the build spells an exported member (`transfer`, `forward`),
  // which the shape rule dropped without ever reaching the liveness rule.
  assert.ok(!scan.claims['docs/MULTISIG_SDK.md']?.includes('collectChildProofs'),
    'the dead call in the fenced MultiSig example is reported now; correct the document and move this name into the widening mutant');
  // The two live ABI members the review's mutant planted. They must be READABLE (the shape rule
  // cannot read either, which is why the oracle previously dropped them before the liveness rule)
  // and they must not be reported, because the artifact that owns them spells them exactly. A fix
  // that made them fail would be rejecting the build's own spelling, not reading it.
  for (const live of ['transfer', 'forward']) {
    assert.ok(isReadableName(live), `${live} is a deployed ABI member the vocabulary cannot read`);
    assert.ok(isLiveName(live, 'docs/DATA_FLOW.md'), `${live} is a deployed ABI member the oracle calls dead`);
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
      file: 'frontend/src/assets/docs/custom-verifiers.md',
      plant: (text) => text.replace("  operation: 'updateVerifier',", "  operation: 'setLegacyVerifierAddress',"),
      claim: 'setLegacyVerifierAddress',
    },
    {
      rule: 'a fenced block cannot show a removed entrypoint as current, and a marked removal silences it',
      file: 'frontend/src/assets/docs/custom-verifiers.md',
      plant: (text) => text.replace("  operation: 'updateVerifier',", "  operation: 'setLegacyVerifierAddress', // removed call, kept as the before example"),
      claim: null,
    },
    {
      rule: 'a definition in a fence is a claim even without a call site',
      file: 'docs/SECURITY_MODEL.md',
      plant: (text) => text.replace('### 9.2 Security Properties', '```csharp\npublic static void InitiateLegacyRecovery(UInt160 accountId)\n```\n\n### 9.2 Security Properties'),
      claim: 'InitiateLegacyRecovery',
    },
    {
      rule: 'a bare identifier in a diagram is recorded as a mention rather than reported as a claim',
      file: 'docs/DATA_FLOW.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'HasLegacyIdCheck{Account ID Valid?}'),
      claim: null,
      mention: 'HasLegacyIdCheck',
    },
    {
      rule: 'a dead call spelled the way the build spells an exported member is reported (the drift the camel-case filter made invisible; F7)',
      file: 'frontend/src/assets/docs/custom-verifiers.md',
      plant: (text) => text.replace("  operation: 'updateVerifier',", "  operation: 'updateVerifier',\n  preflight: await listDeployedVerifiers(masterContractHash),"),
      claim: 'listDeployedVerifiers',
    },
    {
      rule: 'the same widening reads a camel-case call in a fenced diagram label, not only in a code block (F8)',
      file: 'docs/DATA_FLOW.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'HasID{bulkVerifySignatures(accountId)}'),
      claim: 'bulkVerifySignatures',
    },
    {
      rule: 'CONTROL: widening the vocabulary does not invent drift - a live camel-case spelling stays unreported, and a bare camel-case identifier in a diagram stays a mention',
      file: 'docs/DATA_FLOW.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'HasID{transfer(accountId) and forward(target, args) are the deployed camel spellings}'),
      bare: (text) => text.replace('HasID{Account ID Valid?}', 'collectionActive{Account ID Valid?}'),
      liveUnreported: ['transfer', 'forward'],
      notAClaim: 'collectionActive',
      survivesWithoutVocabulary: true,
    },
    {
      rule: 'the same dead camel-case call is a claim in code position and silent inside a comment (F9)',
      file: 'docs/MULTISIG_SDK.md',
      plant: (text) => text.replace('const bundle = await multisig.validateBundle({ context, operation, childProofs });', 'const bundle = await multisig.validateBundle({ context, operation, childProofs });\nconst packets = await gatherChildProofPackets(context, operation);'),
      claim: 'gatherChildProofPackets',
      commentedOut: (text) => text.replace('const bundle = await multisig.validateBundle({ context, operation, childProofs });', 'const bundle = await multisig.validateBundle({ context, operation, childProofs });\n  // gatherChildProofPackets(context, operation)'),
    },
    {
      rule: 'the illustrative-language annotation must carry a reason, so it cannot be a bare silence',
      file: 'docs/ETHEREUM_AA_COMPARISON.md',
      plant: (text) => text.replace('reason: the document compares Neo with Ethereum, so every solidity block lists the Ethereum interface (IValidator, IPaymaster, the ECDSA helper), not a Neo entrypoint.', 'reason: short.'),
      throws: /needs a reason/,
    },
    {
      rule: 'the illustrative-language annotation cannot be widened to a Neo language',
      file: 'docs/ETHEREUM_AA_COMPARISON.md',
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
        assert.ok(!scan.claims[mutant.file]?.includes('setLegacyVerifierAddress'),
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
  // docs/DATA_FLOW.md legitimately names, so a substring test on the name would fail on an untouched
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
const R3_FILE = 'frontend/src/assets/docs/custom-verifiers.md';
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
  assert.equal(isLiveName('CanExecuteHook', 'docs/SECURITY_AUDIT.md'), false,
    'the C# source spelling of an exported member is live again; the fence scan cannot see such a name');
  assert.equal(isLiveName('canExecuteHook', 'docs/SECURITY_AUDIT.md'), true,
    'the manifest spelling of an exported member is not live');
  assert.ok(sourceDefinitions.has('CallVerifierChild'),
    'the source-definition oracle lost CallVerifierChild, the C# definition CU-202 finding F1 records as absent from the pinned build');
  assert.equal(deployedSpelling('CallVerifierChild'), undefined,
    'CallVerifierChild is exported by a manifest now, so the live-as-source control is stale');
  assert.equal(isLiveName('CallVerifierChild', 'docs/SECURITY_AUDIT.md'), true,
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
  // 1. The derivation. 198 C# definitions at this base are exported under a different spelling than
  //    the source writes, which is the class CU-211 could not read; the count is what makes this a
  //    derivation over the build rather than a list of names a document happened to use.
  assert.equal(divergentSpellings.size, 198,
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
  assert.ok(sourceDefinitions.has('CallVerifierChild'),
    'the source-definition oracle lost CallVerifierChild, the C# definition CU-202 finding F1 records as absent from the pinned build');
  assert.equal(deployedSpelling('CallVerifierChild'), undefined,
    'CallVerifierChild is exported by a manifest now, so the live-as-source control is stale');
  assert.ok(!divergentSpellings.has('CallVerifierChild'),
    'a source-only definition was pulled into the divergent class');
  assert.equal(isLiveName('CallVerifierChild', 'docs/SECURITY_AUDIT.md'), true,
    'a C# definition that no manifest exports is treated as dead; the oracle is rejecting names by shape, not by artifact');

  // 2. Both oracles read the class. The inline oracle is asked through `callableNames`, the fence
  //    oracle through `fenceClaims`, and the manifest spelling of the same member stays live.
  assert.equal(isCallableName('OnNEP17Payment'), true,
    'the inline oracle cannot read the source spelling of an exported member');
  // The correction CU-211's F8 count carried: fourteen source-spelled exported members appear in the
  // scanned documents, not thirteen, and every one of them is read now. The assertion is written
  // against the shape rule so it keeps meaning if the class moves.
  const blind = ['ClearAccount', 'VerifyExecution', 'VerifyAdmin', 'PreExecute', 'PostExecute', 'Transfer',
    'SetupRecovery', 'Verify', 'VerifyMetaTx', 'ClearSessionKey', 'EnterMarketEscrow', 'OnNEP17Payment',
    'RefundPendingPayment', 'Admin'];
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
  assert.equal(isLiveName('onNEP17Payment', 'docs/SECURITY_AUDIT.md'), true,
    'the deployed spelling of the member is not live, so the oracle would report it as drift');
  assert.equal(isLiveName('OnNEP17Payment', 'docs/SECURITY_AUDIT.md'), false,
    'the source spelling of an exported member is live again, so the class is invisible');

  // 3. The vocabulary is a union with the shape rule and not a replacement: names only the shape rule
  //    reads are still read, and prose is not a name.
  assert.ok(shapedLikeEntrypoint('IsAnyExecutionActive'), 'the shape vocabulary lost a name it used to read');
  assert.equal(isCallableName('IsAnyExecutionActive'), true, 'a shape-read name is no longer a callable');
  assert.equal(isCallableName('exceeds'), false, 'an ordinary word is read as a callable');
  // Prose that STARTS with a name the class carries is read as that name - `Transfer` really is the
  // source spelling of an exported member, and pretending otherwise is the blindness this row fixes.
  // What keeps it out of the ledger is the document, not a rule that lies about the vocabulary: the
  // occurrence in docs/PLUGIN_MATRIX.md is written as plain text, and the entrypoint bucket only
  // charges a token whose spelling no ABI member carries when the shape rule reads it.
  assert.deepEqual(callableNames('the fault says `Transfer amount exceeds subscription`'), [],
    'prose inside a code span is read as a contract name, so an English sentence that begins with a member of the class is charged as debt');
  assert.deepEqual(callableNames('the name `Transfer` alone').map(({ name }) => name),
    ['Transfer'], 'a span that names the class on its own is not read');
  assert.deepEqual(ratchetDebt()['docs/PLUGIN_MATRIX.md'], undefined,
    'a current-facing document is in the ratchet ledger');
  assert.deepEqual(callableNames('list `createListing, updateListingPrice`').map(({ name }) => name),
    ['createListing', 'updateListingPrice'], 'a comma-separated name list is no longer read');
  assert.deepEqual(callableNames('call `EnterMarketEscrow(accountId, marketContract, listingId)`').map(({ name }) => name),
    ['EnterMarketEscrow'], 'a call to the source spelling is no longer read, or its argument names are read as names');
  // The other direction: the deployed spelling is exact ABI, and the shape rule deliberately does not
  // read it, so the vocabulary is not "any case variant" either.
  assert.deepEqual(callableNames('call `enterMarketEscrow(accountId, marketContract, listingId)`').map(({ name }) => name),
    [], 'the vocabulary reads a name the shape rule never read and no source definition carries');

  // 4. The ledger this vocabulary produces: 48 `spelling:` entries and 7 `entrypoint:` entries in 7
  //    files. The rise from CU-202's 34 is the measurement the row was dispatched to report.
  const found = ratchetDebt();
  const entries = Object.values(found).flat();
  assert.equal(entries.length, 55, `the recorded ledger is not the widened one: ${entries.length} entries`);
  assert.equal(entries.filter((entry) => entry.startsWith('spelling:')).length, 48, 'the spelling bucket changed size');
  assert.equal(entries.filter((entry) => entry.startsWith('entrypoint:')).length, 7, 'the entrypoint bucket changed size');
  assert.equal(Object.keys(found).length, 7, 'the ledger no longer covers 7 files');
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
  const auditDoc = 'docs/PROTOCOL_COMPLETENESS_AUDIT.md';
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
      plant: (text) => text.replace('### 6. Market Escrow', '```csharp\nclearAccount(accountId);\nCallVerifierChild(accountId, childVerifier, method, args);\n```\n\n### 6. Market Escrow'),
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
  for (const name of ['OnNEP17Payment(', 'clearAccount, childVerifier']) {
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
      file: 'docs/ETHEREUM_AA_COMPARISON.md',
      plant: (text) => text.replace('Configured --> EscapeInitiated: initiateEscape(accountId) called', 'Configured --> EscapeInitiated: InitiateEscape() called'),
      claim: 'InitiateEscape',
      notMention: 'InitiateEscape',
    },
    {
      rule: 'the same rule reaches a fenced C# block, not only a diagram',
      file: 'docs/PROTOCOL_COMPLETENESS_AUDIT.md',
      plant: (text) => text.replace('ExecutionEngine.Assert(!isMarketEscrowActive(accountId)', 'ExecutionEngine.Assert(!IsMarketEscrowActive(accountId)'),
      claim: 'IsMarketEscrowActive',
    },
    {
      rule: 'a source spelling is ratchet debt exactly once, in the spelling bucket, never in the entrypoint bucket',
      file: 'docs/PROTOCOL_COMPLETENESS_AUDIT.md',
      plant: (text) => text.replace('### 6. Market Escrow', '`CanExecuteHook(accountId, caller, hook)` is asserted as live.\n\n### 6. Market Escrow'),
      recorded: 'spelling:CanExecuteHook->canExecuteHook',
      notRecorded: 'entrypoint:CanExecuteHook',
    },
    {
      rule: 'a call-shaped label in a diagram is a claim and is not also recorded as a justified mention',
      file: 'docs/DATA_FLOW.md',
      plant: (text) => text.replace('HasID{Account ID Valid?}', 'InitiateLegacyThing(){Account ID Valid?}'),
      claim: 'InitiateLegacyThing',
      notMention: 'InitiateLegacyThing',
    },
    {
      rule: 'both halves of the decision stay live: a C# definition no manifest exports, and the manifest spelling of one that is exported',
      file: 'docs/PROTOCOL_COMPLETENESS_AUDIT.md',
      plant: (text) => text.replace('### 6. Market Escrow', '```csharp\nCallVerifierChild(accountId, childVerifier, method, args);\ncanExecuteHook(accountId, callerContract, hookContract);\n```\n\n### 6. Market Escrow'),
      live: ['CallVerifierChild', 'canExecuteHook'],
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
    for (const name of ['CanExecuteHook(', 'InitiateEscape()', 'IsMarketEscrowActive(', 'InitiateLegacyThing', 'CallVerifierChild(']) {
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
  const auditDoc = 'docs/PROTOCOL_COMPLETENESS_AUDIT.md';
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
    && !file.startsWith('docs/proposals/') && !file.startsWith('docs/reports/') && !file.startsWith('docs/plans/')
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

  // 7. On today's corpus the widening moves no entry: the ledger is the same 7 files / 55 names the
  //    r1 head recorded, so the fix adds enforcement rather than changing what is recorded.
  const found = ratchetDebt();
  const entries = Object.values(found).flat();
  assert.equal(entries.length, 55, `the punctuated-call rule changed the ledger size: ${entries.length} entries`);
  assert.equal(entries.filter((entry) => entry.startsWith('spelling:')).length, 48, 'the spelling bucket changed size');
  assert.equal(entries.filter((entry) => entry.startsWith('entrypoint:')).length, 7, 'the entrypoint bucket changed size');
  assert.equal(Object.keys(found).length, 7, 'the ledger no longer covers 7 files');
  assert.ok(!entries.includes(`entrypoint:InitiateEscape`), 'the punctuated call was recorded in both buckets');
});
