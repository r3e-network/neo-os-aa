#!/usr/bin/env python3
"""Persist real heterogeneous native approval, phase isolation and leaf cleanup locally."""
import argparse
import base64
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import time

from neoexpress_validate import Chain, RawKey, P256Key, ValidationFailure, H, B, I, S, A, ZERO, decode, hash_le, serialize_unsigned, serialize_witnesses, aa_proxy_rules
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require
from neoexpress_native_service_validate import CORE, check_native, persist
from neoexpress_native_proxy_validate import GAS, GAS_TOKEN, proxy_address, push_bytes, verification_script, application_script, check_transaction, check_fault, transfer
from neoexpress_native_configuration_validate import call_script, pending_log
from neoexpress_native_recovery_validate import equal_typed
from neoexpress_native_modules_validate import nef_from_rpc, check_module_build, CONTEXT
from neoexpress_native_session_validate import serialize_value, signing_preimage, NULL
from neoexpress_native_daily_validate import storage_prefix, raw_integer
from neoexpress_reproducible_build import check_runtime_receipt, sha256

DAY = 86_400_000
NAMES = ('MultiSigVerifier', 'SessionKeyVerifier', 'NeoNativeVerifier')


def bundle(values):
    require(type(values) is list and 0 < len(values) <= 10 and all(v is None or type(v) is bytes for v in values), 'Exact child signatures required')
    return serialize_value(A(*(NULL if v is None else B(v) for v in values)))


def signers(keys, root, scoped):
    require(keys and len({key.script_hash for key in keys}) == len(keys), 'Distinct transaction signing keys required')
    result = [{'account': '0x' + key.script_hash[::-1].hex(), 'scopes': 'CalledByEntry'} for key in keys]
    if scoped:
        for row in result[1:]:
            row.update(scopes='WitnessRules', rules=[{'action': 'Allow', 'condition': {'type': 'Or', 'expressions': [{'type': 'CalledByContract', 'hash': root}]}}])
    return result


def record(*values):
    return serialize_value(A(*values))


def raw_entry(account, prefix, value):
    return {base64.b64encode(bytes([prefix]) + hash_le(account)).decode(): base64.b64encode(value).decode()}


class CompositeTransactions:
    def __init__(self, chain, modules, account, other, recipient, report):
        self.chain, self.modules, self.account, self.other, self.recipient, self.report = chain, modules, account, other, recipient, report

    def value(self, target, method, args):
        return self.chain.rpc_invoke(target, method, args)[0]

    def state(self, account):
        root, session, native = [self.modules[name] for name in NAMES]
        return {'account': self.value(CORE, 'getAccount', [H(account)]), 'nonce': self.value(CORE, 'getNonce', [H(account), I(0)]),
                'pending': self.value(CORE, 'getPendingModuleCall', [H(account), S('verifier')]),
                'dependencies': self.value(CORE, 'getModuleDependencies', [H(account), S('verifier')]),
                'root': self.value(root, 'getConfig', [H(account)]), 'native': self.value(native, 'getConfig', [H(account)]),
                'session': self.value(session, 'getSessionKey', [H(account)]), 'metadata': self.value(session, 'getSessionKeyMetadata', [H(account)]),
                'spent': self.value(session, 'getSpentAmount', [H(account)]),
                'balance': self.value(GAS_TOKEN, 'balanceOf', [H(proxy_address(account))]),
                'raw': {name: [storage_prefix(self.chain, self.modules[name], bytes([prefix]) + hash_le(account)) for prefix in prefixes]
                        for name, prefixes in [(NAMES[0], (1,)), (NAMES[1], (1, 2, 3, 4)), (NAMES[2], (1, 2))]}}

    def send(self, label, target, method, args, keys, *, scoped=True, proxy=False, fault=None, expected=None, events=(), change=None,
             recipient_delta=0, admission_rejection=False):
        require(not admission_rejection or proxy and fault is None, 'Admission rejection must be a proxy Verification case')
        before = self.state(self.account); other = self.state(self.other)
        recipient = self.value(GAS_TOKEN, 'balanceOf', [H(self.recipient)])
        rows = signers(keys, self.modules[NAMES[0]], scoped)
        if proxy: rows.append({'account': proxy_address(self.account), 'scopes': 'WitnessRules', 'rules': aa_proxy_rules(CORE, GAS_TOKEN)})
        script = application_script(self.account, args[1]) if proxy else call_script(target, method, args)
        unsigned = serialize_unsigned(int.from_bytes(os.urandom(4), 'little'), 10 * GAS, 2 * GAS, self.chain.rpc('getblockcount', []) + 50, rows, script)
        digest = hashlib.sha256(unsigned).digest(); txid = '0x' + digest[::-1].hex()
        witnesses = [(push_bytes(key.sign(self.chain.magic.to_bytes(4, 'little') + digest)), key.verification) for key in keys]
        if proxy: witnesses.append((b'', verification_script(self.account)))
        raw = base64.b64encode(unsigned + serialize_witnesses(witnesses)).decode()
        try: submitted = self.chain.rpc('sendrawtransaction', [raw])
        except ValidationFailure as error:
            if not admission_rejection: raise
            require(str(error) == 'rpc sendrawtransaction: Inventory verification failed - Invalid', 'Unexpected witness rejection')
            require(equal_typed(before, self.state(self.account)) and equal_typed(other, self.state(self.other)), 'Admission changed state')
            require(self.value(GAS_TOKEN, 'balanceOf', [H(self.recipient)]) == recipient, 'Admission changed recipient balance')
            self.report['rejectedWitnesses'].append({'step': label, 'txid': txid, 'persisted': False, 'observedStateAndIsolationMatched': True})
            print(label + ': REJECTED at witness admission', flush=True)
            return
        require(not admission_rejection and submitted.get('hash') == txid, 'Unexpected transaction admission')
        limit = time.monotonic() + 90; execution = None
        while time.monotonic() < limit:
            try: execution = self.chain.rpc('getapplicationlog', [txid])['executions'][0]; break
            except ValidationFailure as error:
                if not pending_log(error): raise
            time.sleep(0.5)
        require(execution is not None, 'Composite transaction not persisted')
        tx = self.chain.rpc('getrawtransaction', [txid, True]); check_transaction(tx, txid, script, rows, witnesses)
        print(label + ': ' + execution['vmstate'] + (' ' + str(execution.get('exception')) if execution['vmstate'] != 'HALT' else ''), flush=True)
        if fault: check_fault(execution, fault)
        else:
            require(execution['vmstate'] == 'HALT', 'Unexpected composite fault')
            require(len(execution['stack']) == 1 and equal_typed(decode(execution['stack'][0]), expected), 'Wrong exact composite return')
            require([(n['contract'], n['eventname']) for n in execution['notifications']] == list(events), 'Wrong composite event sequence')
            for event in execution['notifications']:
                values = decode(event['state'])
                if event['contract'] == GAS_TOKEN:
                    require(equal_typed(values, [hash_le(proxy_address(self.account)), hash_le(self.recipient), recipient_delta]), 'Wrong GAS transfer event')
                else: require(values[0] == hash_le(self.account), 'Wrong notification account')
        timestamp = self.chain.rpc('getblockheader', [tx['blockhash'], True])['time']
        desired = copy.deepcopy(before)
        if change: change(desired, timestamp)
        after = self.state(self.account)
        if not equal_typed(desired, after):
            print('Expected state:', desired, 'Actual state:', after, flush=True)
            raise ValidationFailure('Composite state, raw storage or dependencies mismatch')
        require(equal_typed(other, self.state(self.other)), 'Composite modified another account')
        require(self.value(GAS_TOKEN, 'balanceOf', [H(self.recipient)]) == recipient + recipient_delta, 'Wrong recipient balance')
        self.report['executions'].append({'step': label, 'vmstate': execution['vmstate'], 'txid': txid, 'persisted': True,
            'expectedFailure': fault, 'proxyWitnessIncluded': proxy, 'rawTransactionAndWitnessReadbackMatched': True,
            'observedStateAndIsolationMatched': True, 'operationNonce': after['nonce'], 'configurationNonce': after['account'][8],
            'gasConsumedDatoshi': int(execution['gasconsumed'])})


def validate(runtime, dotnet, artifacts, build_receipt, module_receipt, output):
    report = {'schema': 'smartaccount-native-multisig-private/v1', 'status': 'RUNNING', 'publicNetworksTouched': False,
              'scope': 'Shipped native composite with real P-256 and native witnesses; not key independence, arbitrary topology or compiler refinement.',
              'transactions': [], 'executions': [], 'rejectedWitnesses': [], 'modules': [], 'ownedNodesStopped': False}
    output.parent.mkdir(parents=True, exist_ok=True); output.write_text(json.dumps(report) + '\n'); stage = 'provenance'
    try:
        sources = [Path(__file__), *[Path(__file__).with_name(n) for n in ('neoexpress_validate.py', 'neoexpress_activation_validate.py',
            'neoexpress_native_service_validate.py', 'neoexpress_native_proxy_validate.py', 'neoexpress_native_configuration_validate.py',
            'neoexpress_native_recovery_validate.py', 'neoexpress_native_modules_validate.py', 'neoexpress_native_session_validate.py',
            'neoexpress_native_daily_validate.py', 'neoexpress_reproducible_build.py', 'native_module_profile.py', 'build_native_modules.py')]]
        report.update(sourceSha256={p.name: sha256(p) for p in sources}, sourceBuildReceiptSha256=sha256(build_receipt), moduleBuildReceiptSha256=sha256(module_receipt))
        build = json.loads(build_receipt.read_text()); check_runtime_receipt(build, runtime)
        compiled = json.loads(module_receipt.read_text()); pins = check_module_build(compiled, artifacts, Path(__file__).resolve().parent.parent / 'contracts')
        with tempfile.TemporaryDirectory(prefix='smartaccount-native-multisig-') as scratch:
            root = Path(scratch); chain = Chain(make_runner(runtime, dotnet, root), root)
            try:
                stage = 'setup'; chain.nx('create', '-o', str(chain.file)); config = json.loads(chain.file.read_text())
                config.setdefault('settings', {}).update({ACTIVATION_KEY: '0', 'chain.SecondsPerBlock': '1'})
                for field in ('rpc-port', 'tcp-port'):
                    with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); config['consensus-nodes'][0][field] = sock.getsockname()[1]
                chain.file.write_text(json.dumps(config)); chain.magic = config['magic']; chain.rpc_port = config['consensus-nodes'][0]['rpc-port']
                keys = {}
                for label in ('owner', 'relay', 'cosigner', 'recipient'):
                    chain.nx('wallet', 'create', label)
                    if label != 'recipient': chain.nx('transfer', '1000', 'GAS', 'genesis', label)
                    keys[label] = RawKey(root, 'private-' + label, chain.wallet_private_key(label))
                addresses = {name: '0x' + key.script_hash[::-1].hex() for name, key in keys.items()}
                session_key = P256Key(root, 'session'); attacker = P256Key(root, 'attacker'); modules = {}; bindings = {}
                for name in NAMES:
                    path = artifacts / (name + '.nef')
                    _, text = chain.nx('contract', 'deploy', str(path), 'genesis', '-j', '-d', '0x' + hash_le(CORE).hex())
                    deployed = chain.json_from(text); modules[name] = deployed['contract-hash']
                    manifest = json.loads(path.with_suffix('.manifest.json').read_text())
                    # This checked artifact subset has ASCII property keys and integral numbers.
                    def admissible(value):
                        if type(value) is dict: return all(k.isascii() and admissible(v) for k, v in value.items())
                        if type(value) is list: return all(admissible(v) for v in value)
                        return value is None or type(value) in (str, bool) or type(value) is int and abs(value) < 2**53
                    require(admissible(manifest), 'Manifest is outside the independent canonical JSON subset')
                    canonical = json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
                    bindings[name] = [hash_le(modules[name]), hashlib.sha256(path.read_bytes() + b'\0' + canonical).digest()]
                    report['modules'].append({'name': name, 'contractHash': modules[name], 'nefSha256': sha256(path), 'manifestSha256': sha256(path.with_suffix('.manifest.json'))})
                accounts = []
                for salt in (bytes([10]) * 32, bytes([11]) * 32):
                    account = persist(chain, report, 'register-' + str(len(accounts)), 'registerAccount',
                                      [H(addresses['owner']), B(salt), H(modules[NAMES[0]]), H(ZERO), H(ZERO)], 'AccountCreated')
                    accounts.append('0x' + account[::-1].hex())
                account, other = accounts; proxy = proxy_address(account)
                fund = chain.invoke_file(GAS_TOKEN, 'transfer', [H(addresses['owner']), H(proxy), I(2 * GAS), None])
                chain.nx('contract', 'invoke', str(fund), 'owner', '-j'); chain.start_node()
                check_native(chain.rpc('getcontractstate', [CORE])); require(chain.rpc('getversion', [])['protocol']['network'] == chain.magic, 'Wrong private network')
                def readback():
                    for row in report['modules']:
                        path = artifacts / (row['name'] + '.nef'); state = chain.rpc('getcontractstate', [row['contractHash']])
                        require(nef_from_rpc(state['nef']) == path.read_bytes(), 'Composite module NEF mismatch')
                        require(state['manifest'] == json.loads(path.with_suffix('.manifest.json').read_text()), 'Composite manifest mismatch')
                        row['fullNefAndManifestReadbackMatched'] = True
                readback(); driver = CompositeTransactions(chain, modules, account, other, addresses['recipient'], report)
                initial = driver.state(account); require(initial['account'][5] == bindings[NAMES[0]] and initial['dependencies'] == [bindings[NAMES[0]], [], []], 'Independent binding mismatch')
                def core(label, method, args, **kw): return driver.send(label, CORE, method, [H(account), *args], [keys['owner']], **kw)
                def wait_delay(): chain.stop_node(); chain.nx('fastfwd', '1', '-t', '86401'); chain.start_node()
                def configure(label, name, method, args, changed, events=(), fault=None):
                    child = name != NAMES[0]; call = 'callVerifierChild' if child else 'callVerifier'
                    parameters = ([H(modules[name])] if child else []) + [S(method), A(*args)]
                    def proposed(state, timestamp): state['pending'] = [1, hash_le(account), 0, bindings[NAMES[0]], bindings[name], method.encode(),
                        [hash_le(account), *[decode_arg(v) for v in args]], timestamp, timestamp + DAY, state['account'][8]]
                    core(label + '-propose', call, parameters, expected=False, change=proposed)
                    core(label + '-immature', call, parameters, fault='immature, changed or stale')
                    wait_delay()
                    if fault:
                        core(label + '-confirm', call, parameters, fault=fault)
                        core(label + '-cancel', 'cancelModuleCall', [S('verifier')], change=lambda s, t: s.update(pending=None))
                    else:
                        def confirmed(state, timestamp):
                            state['account'][8] += 1; state['pending'] = None
                            if child and bindings[name] not in state['dependencies'][1]: state['dependencies'][1].append(bindings[name])
                            changed(state, timestamp)
                        core(label + '-confirm', call, parameters, events=events, change=confirmed)
                now = chain.rpc('getblockheader', [chain.rpc('getbestblockhash', []), True])['time']; until = now + 25 * DAY
                cap = 3 * GAS
                session_args = [B(session_key.compressed), H(GAS_TOKEN), S('transfer'), I(until), I(cap), S('native composite validation')]
                def configured_session(state, timestamp):
                    state['session'] = [session_key.compressed, hash_le(GAS_TOKEN), b'transfer', until, cap]
                    state['metadata'] = [timestamp, 0, b'native composite validation']
                    state['raw'][NAMES[1]][0] = raw_entry(account, 1, record(*session_args[:5]))
                    state['raw'][NAMES[1]][1] = raw_entry(account, 2, record(I(timestamp), I(0), session_args[5]))
                    state['raw'][NAMES[1]][3] = raw_entry(account, 4, raw_integer(timestamp))
                stage = 'leaf-configuration'
                configure('session-child', NAMES[1], 'setSessionKey', session_args, configured_session, [(modules[NAMES[1]], 'SessionKeyGranted')])
                native_args = [A(H(addresses['cosigner'])), I(1)]
                def configured_native(state, timestamp):
                    state['native'] = [[hash_le(addresses['cosigner'])], 1]
                    state['raw'][NAMES[2]] = [raw_entry(account, 1, record(*native_args)), raw_entry(account, 2, raw_integer(1))]
                configure('witness-child', NAMES[2], 'setConfig', native_args, configured_native)
                children = [modules[NAMES[1]], modules[NAMES[2]]]
                def root_config(threshold):
                    def change(state, timestamp):
                        state['root'] = [[hash_le(x) for x in children], threshold]; state['dependencies'][2] = [hash_le(x) for x in children]
                        state['raw'][NAMES[0]][0] = raw_entry(account, 1, record(A(*[H(x) for x in children]), I(threshold)))
                    return change
                stage = 'root-configuration'
                configure('two-of-two', NAMES[0], 'setConfig', [A(*[H(x) for x in children]), I(2)], root_config(2))
                for label, roster, threshold, reason in [
                    ('duplicate-child', [children[0], children[0]], 2, 'Duplicate verifier'),
                    ('self-child', [modules[NAMES[0]]], 1, 'MultiSig verifier cannot contain itself'),
                    ('zero-threshold', children, 0, 'Invalid threshold')]:
                    configure(label, NAMES[0], 'setConfig', [A(*[H(x) for x in roster]), I(threshold)], None, fault=reason)
                stage = 'phase-denial'
                for name in NAMES:
                    for method, args in [('validateSignature', [transfer(proxy, addresses['recipient'], 0, 1)]),
                        ('postExecute', [transfer(proxy, addresses['recipient'], 0, 1), NULL]), ('clearAccount', [])]:
                        driver.send('direct-' + name + '-' + method, modules[name], method, [H(account), *args], [keys['owner']], fault=CONTEXT)
                for name in NAMES[1:]: driver.send('direct-' + name + '-post-validation', modules[name], 'validateSignatureForPostExecute',
                    [H(account), transfer(proxy, addresses['recipient'], 0, 1)], [keys['owner']], fault=CONTEXT)
                def signed(key=session_key, skipped=False, amount=1):
                    op = transfer(proxy, addresses['recipient'], driver.state(account)['nonce'], amount)
                    payload = signing_preimage(chain.magic, account, op)
                    require(driver.value(modules[NAMES[1]], 'getPayload', [H(account), *op['value'][:5]]) == payload, 'Child signing preimage mismatch')
                    require(driver.value(CORE, 'getOperationDigest', [H(account), op]) == hashlib.sha256(payload).digest(), 'Native signing digest mismatch')
                    op['value'][5] = B(bundle([None if skipped else key.sign(payload), b'']))
                    return op
                def execute(label, op, cosigner=True, **kw):
                    return driver.send(label, CORE, 'executeUserOp', [H(account), op], [keys['relay']] + ([keys['cosigner']] if cosigner else []), **kw)
                stage = 'threshold'
                for label, op, kw in [('foreign-key', signed(attacker), {}), ('skipped-child', signed(skipped=True), {}),
                                      ('missing-witness', signed(), {'cosigner': False}), ('wrong-witness-scope', signed(), {'scoped': False})]:
                    execute(label, op, fault='The verifier must return exactly Boolean true.', **kw)
                execute('bad-proxy-signature', signed(attacker), proxy=True, admission_rejection=True)
                for label, data, reason in [('short-bundle', bundle([b'']), 'Signature array length mismatch'),
                    ('struct-bundle', serialize_value({'type': 'Struct', 'value': [NULL, B(b'')]}), 'MultiSig signature bundle must be an Array'),
                    ('integer-child', serialize_value(A(I(1), B(b''))), 'Invalid child signature type'),
                    ('buffer-child', bytes.fromhex('40023001012800'), 'Invalid child signature type'),
                    ('empty-bundle', bytes.fromhex('4000'), 'Signature array length mismatch')]:
                    op = signed(); op['value'][5] = B(data); execute(label, op, fault=reason)
                def consumed(state, timestamp):
                    state['nonce'] += 1; state['balance'] -= 1; state['spent'] += 1; state['metadata'][1] = timestamp
                    state['raw'][NAMES[1]][1] = raw_entry(account, 2, record(I(state['metadata'][0]), I(timestamp), session_args[5]))
                    state['raw'][NAMES[1]][2] = raw_entry(account, 3, raw_integer(state['spent']))
                execute('heterogeneous-proxy-transfer', signed(), proxy=True, expected=True,
                        events=[(GAS_TOKEN, 'Transfer'), (CORE, 'UserOpExecuted')], change=consumed, recipient_delta=1)
                execute('post-false-transfer-rollback', signed(amount=2 * GAS), proxy=True, fault='Session transfer did not succeed')
                def remove_session(state, timestamp):
                    state['root'] = [[hash_le(children[1])], 1]
                    state['dependencies'][1] = [bindings[NAMES[2]]]; state['dependencies'][2] = [hash_le(children[1])]
                    state['raw'][NAMES[0]][0] = raw_entry(account, 1, record(A(H(children[1])), I(1)))
                    state.update(session=None, metadata=None, spent=0); state['raw'][NAMES[1]] = [{}] * 4
                configure('remove-session-from-active-roster', NAMES[0], 'setConfig', [A(H(children[1])), I(1)], remove_session,
                          [(modules[NAMES[1]], 'SessionKeyRevoked')])
                for method in ('validateSignature', 'validateSignatureForPostExecute'):
                    nonce = driver.state(account)['nonce']
                    operation = A(H(modules[NAMES[2]]), S(method), A(H(account), transfer(proxy, addresses['recipient'], nonce, 1)),
                                  I(nonce), I(until), B(bundle([b''])))
                    execute('target-frame-not-' + method, operation, fault=CONTEXT)
                configure('reenroll-inactive-session', NAMES[1], 'setSessionKey', session_args, configured_session,
                          [(modules[NAMES[1]], 'SessionKeyGranted')])
                require(driver.state(account)['dependencies'][2] == [hash_le(children[1])], 'Reenrollment unexpectedly activated a leaf')
                stage = 'cleanup'
                def proposal(state, timestamp): state['account'][9] = [hash_le(ZERO), bytes(32), timestamp, timestamp + DAY, state['account'][8]]
                core('remove-root-propose', 'proposeVerifier', [H(ZERO)], events=[(CORE, 'VerifierChangeProposed')], change=proposal)
                wait_delay()
                def removed(state, timestamp):
                    state['account'][5] = None; state['account'][8] += 1; state['account'][9:] = [None] * 4
                    state.update(dependencies=[None, [], []], root=None, native=None, session=None, metadata=None, spent=0)
                    state['raw'] = {NAMES[0]: [{}], NAMES[1]: [{}] * 4, NAMES[2]: [{}] * 2}
                core('remove-root-confirm', 'activateVerifier', [], events=[(modules[NAMES[1]], 'SessionKeyRevoked'), (CORE, 'VerifierChanged')], change=removed)
                readback(); report.update(networkMagic=chain.magic, finalOperationNonce=driver.state(account)['nonce'], cleanupOfAllEnrolledLeavesVerified=True)
            finally: chain.stop_node(); report['ownedNodesStopped'] = chain.node is None
        check_runtime_receipt(build, runtime)
        require(all(sha256(artifacts / n) == h for n, h in pins.items()), 'Native artifacts changed')
        require(all(sha256(p) == report['sourceSha256'][p.name] for p in sources), 'Composite harness changed')
        require(sha256(build_receipt) == report['sourceBuildReceiptSha256'] and sha256(module_receipt) == report['moduleBuildReceiptSha256'], 'Build receipts changed')
        report.update(status='PASS', runtimeFilesMatched=True)
    except Exception as error: report['failure'] = {'stage': stage, 'type': type(error).__name__}; raise
    finally:
        if report['status'] != 'PASS': report['status'] = 'FAIL'
        report['completedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat(); output.write_text(json.dumps(report, indent=2) + '\n')
    return report


def decode_arg(item):
    kind, value = item['type'], item.get('value')
    if kind == 'Array': return [decode_arg(v) for v in value]
    if kind == 'Hash160': return hash_le(value)
    if kind == 'ByteArray': return base64.b64decode(value)
    if kind == 'String': return value.encode()
    if kind == 'Integer': return int(value)
    if kind == 'Any': return None
    raise ValidationFailure('Unsupported configuration argument')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('runtime', 'artifacts', 'build-receipt', 'module-receipt', 'output'): parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--dotnet', type=Path, default=shutil.which('dotnet')); args = parser.parse_args()
    require(args.dotnet is not None, 'A local runtime is required')
    validate(args.runtime.resolve(), args.dotnet.resolve(), args.artifacts.resolve(), args.build_receipt.resolve(), args.module_receipt.resolve(), args.output.resolve())
