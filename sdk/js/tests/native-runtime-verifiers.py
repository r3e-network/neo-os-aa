#!/usr/bin/env python3
"""Real native SDK verifier workflows on a disposable loopback chain; no public writes."""
import argparse
import base64
import datetime
import contextlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile

os.umask(0o077)
parser = argparse.ArgumentParser()
for name in ('runtime', 'build-receipt', 'artifacts', 'module-receipt', 'dotnet', 'output'):
    parser.add_argument('--' + name, type=Path, required=True)
parser.add_argument('--retain-on-failure', action='store_true')
parser.add_argument('--signed-artifact-transport', action='store_true',
                    help='Validate export, portable signature checks, exact signed preflight, submission and raw receipt')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo / 'scripts'))
from neoexpress_validate import Chain, RawKey, H, I, S, hash_le, ValidationFailure
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require
from neoexpress_native_service_validate import CORE, check_native, check_account_record
from neoexpress_native_modules_validate import check_module_build, nef_from_rpc
from neoexpress_reproducible_build import check_runtime_receipt, sha256

TOKEN = '0xd2a4cff31913016155e38e474a2c06d08be276cf'
NAMES = ('NeoNativeVerifier', 'SessionKeyVerifier', 'MultiSigVerifier')
driver = Path(__file__).with_name('native-runtime-driver.mjs')
sources = [Path(__file__), driver, repo/'shared/nativeSmartAccount.mjs', repo/'shared/nativeSmartAccountClient.mjs',
           repo/'shared/nativeTransactionArtifact.mjs', repo/'shared/nativeWalletWitness.mjs',
           repo/'sdk/js/src/native.js', repo/'sdk/js/src/neonCompat.js',
           *sorted((repo/'sdk/js/src/native').glob('*.js')),
           *[repo/'scripts'/n for n in ('neoexpress_validate.py', 'neoexpress_activation_validate.py',
             'neoexpress_native_service_validate.py', 'neoexpress_native_modules_validate.py',
             'neoexpress_native_proxy_validate.py', 'neoexpress_reproducible_build.py', 'build_native_modules.py', 'native_module_profile.py')]]
pins = {str(p.relative_to(repo)): sha256(p) for p in sources}
report = {'schema': 'smartaccount-native-sdk-verifiers-private/v1', 'status': 'RUNNING',
          'publicNetworksTouched': False, 'sourceSha256': pins, 'sourceBuildReceiptSha256': sha256(args.build_receipt),
          'moduleBuildReceiptSha256': sha256(args.module_receipt), 'transactions': [], 'rejections': [], 'modules': []}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(report, indent=2)+'\n')
stage = 'provenance'
retained = False
@contextlib.contextmanager
def private_directory():
    directory = tempfile.mkdtemp(prefix='native-sdk-verifiers-')
    try: yield directory
    finally:
        if not retained: shutil.rmtree(directory)
try:
    build = json.loads(args.build_receipt.read_text())
    check_runtime_receipt(build, args.runtime)
    check_module_build(json.loads(args.module_receipt.read_text()), args.artifacts, repo/'contracts')
    with private_directory() as scratch:
        directory = Path(scratch)
        chain = Chain(make_runner(args.runtime, args.dotnet, directory), directory)
        try:
            stage = 'setup'
            chain.nx('create', '-o', str(chain.file))
            config = json.loads(chain.file.read_text())
            config.setdefault('settings', {}).update({ACTIVATION_KEY: '0', 'chain.SecondsPerBlock': '1'})
            for field in ('rpc-port', 'tcp-port'):
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0)); config['consensus-nodes'][0][field] = sock.getsockname()[1]
            chain.file.write_text(json.dumps(config)); chain.magic = config['magic']
            chain.rpc_port = config['consensus-nodes'][0]['rpc-port']
            keys, addresses, public = {}, {}, {}
            for name in ('sponsor', 'owner', 'cosigner', 'session', 'session2', 'recipient', 'guardian'):
                chain.nx('wallet', 'create', name)
                raw = chain.wallet_private_key(name)
                key = RawKey(directory, 'fixture-'+name, raw)
                keys[name] = raw.hex(); addresses[name] = '0x'+key.script_hash[::-1].hex(); public[name] = key.compressed.hex()
            chain.nx('transfer', '1000', 'GAS', 'genesis', 'sponsor')
            modules = {}
            for name, deployer in [*( (name, 'genesis') for name in NAMES ), ('SessionKeyVerifier2', 'sponsor')]:
                artifact_name = 'SessionKeyVerifier' if name == 'SessionKeyVerifier2' else name
                artifact = args.artifacts/(artifact_name+'.nef')
                # A distinct deployer gives the second instance a distinct script hash.
                # The CLI name-collision guard must explicitly allow the shared manifest name.
                extra = ['--force'] if name == 'SessionKeyVerifier2' else []
                _, text = chain.nx('contract', 'deploy', str(artifact), deployer, '-j', '-d', '0x'+hash_le(CORE).hex(), *extra)
                deployed = chain.json_from(text)
                require(deployed['contract-name'] == artifact_name, 'Module deployment name mismatch')
                modules[name] = deployed['contract-hash']
                report['modules'].append({'name': name, 'artifactName': artifact_name, 'contractHash': deployed['contract-hash'],
                    'deploymentTransaction': deployed['tx-hash'], 'nefSha256': sha256(artifact),
                    'manifestSha256': sha256(artifact.with_suffix('.manifest.json'))})
            chain.start_node(); check_native(chain.rpc('getcontractstate', [CORE]))
            require(chain.rpc('getversion', [])['protocol']['network'] == chain.magic, 'Wrong loopback network')
            for row in report['modules']:
                state = chain.rpc('getcontractstate', [row['contractHash']]); artifact = args.artifacts/(row['artifactName']+'.nef')
                require(nef_from_rpc(state['nef']) == artifact.read_bytes(), 'Deployed full NEF mismatch')
                require(state['manifest'] == json.loads(artifact.with_suffix('.manifest.json').read_text()), 'Deployed manifest mismatch')
                row['fullArtifactReadbackMatched'] = True
            common = {'rpcUrl': f'http://127.0.0.1:{chain.rpc_port}', 'networkMagic': chain.magic, 'diagnosticOutput': str(directory/'sdk-fault.json'),
                      'signedArtifactTransport': args.signed_artifact_transport}
            secrets = {'payerPrivateKey': keys['sponsor'], 'custodyPrivateKey': keys['owner']}
            def sdk(payload, expect_error=None):
                run = subprocess.run([shutil.which('node'), str(driver)], input=json.dumps(dict(common, **payload)),
                    capture_output=True, text=True, cwd=repo, timeout=100)
                require(all(key not in run.stdout and key not in run.stderr for key in keys.values()), 'SDK output contains fixture secret')
                if expect_error:
                    require(run.returncode != 0 and expect_error in run.stderr, 'Expected SDK rejection missing: '+expect_error)
                    fault = json.loads((directory/'sdk-fault.json').read_text())
                    require(fault['result']['state'] == 'FAULT' and 'bounded contract call gas limit' not in fault['result'].get('exception', ''),
                            'Authorization negative was obscured by a bounded-gas failure')
                    report['rejections'].append({'step': stage, 'layer': 'SDK-before-broadcast', 'reason': expect_error,
                        'rpcException': fault['result'].get('exception'), 'script': fault['params'][0],
                        'gasConsumed': fault['result']['gasconsumed'], 'minimumRequiredFee': fault['result']['minimumrequiredfee']})
                    return None
                if run.returncode: raise RuntimeError('SDK driver failed: '+run.stderr[-5000:])
                return json.loads(run.stdout)
            def record(label, result):
                require(result['preflight']['verification'] == 'Succeed' and result['preflight']['state'] == 'HALT', 'Exact signed preflight failed')
                require(result['receipt']['confirmed'] and result['receipt']['vmState'] == 'HALT', 'SDK exact bytes not confirmed')
                if args.signed_artifact_transport:
                    artifact = result.get('artifactTransport', {})
                    require(artifact.get('exactBytesMatched') is True and artifact.get('walletSignaturesVerified') is True,
                            'Portable signed-artifact validation was not executed')
                    require(artifact['preflight']['verification'] == 'Succeed' and artifact['preflight']['state'] == 'HALT',
                            'Portable artifact signed preflight failed')
                    require(result['receipt'].get('succeeded') is True, 'Portable artifact receipt did not confirm success')
                report['transactions'].append(dict(step=label, **result))
                print(label+': SDK signed/preflight/broadcast/readback HALT', flush=True)
                return result
            def value(contract, method, params): return chain.rpc_invoke(contract, method, params)[0]
            def balance(address): return value(TOKEN, 'balanceOf', [H(address)])
            def account_state(account): return check_account_record(value(CORE, 'getAccount', [H(account)]))
            def wait_delay():
                chain.stop_node(); chain.nx('fastfwd', '1', '-t', '86401'); chain.start_node()
            def configure(label, account, method, arguments, child=None):
                call = {'role': 'verifier', 'method': method, 'args': arguments}
                if child: call['child'] = child
                before = account_state(account)[8]
                payload = dict(secrets, mode='configure', accountId=account, configuration=call)
                record(label+'-propose', sdk(payload)); wait_delay(); result = record(label+'-confirm', sdk(payload))
                require(int(result['account']['configurationNonce']) == before+1, 'Configuration nonce did not advance once')
                return result
            def register(name, salt):
                return record('register-'+name, sdk(dict(secrets, mode='register', salt=salt*32, verifier=modules[name], recoveryAddress=addresses['guardian'])))
            def operation(proxy):
                return {'targetContract': TOKEN, 'method': 'transfer', 'args': [
                    {'type': 'ByteString', 'value': hash_le(proxy).hex()},
                    {'type': 'ByteString', 'value': hash_le(addresses['recipient']).hex()},
                    {'type': 'Integer', 'value': '1000000'}, {'type': 'Null'}],
                    'channel': '3', 'deadline': '4102444800000'}
            def executed(label, account, proxy, operation_override=None, **auth):
                op = operation_override or operation(proxy); channel = int(op['channel'])
                before = [balance(proxy), balance(addresses['recipient']), value(CORE, 'getNonce', [H(account), I(channel)])]
                result = record(label, sdk(dict(secrets, mode='transfer', accountId=account, operation=op, **auth)))
                after = [balance(proxy), balance(addresses['recipient']), value(CORE, 'getNonce', [H(account), I(channel)])]
                require(after == [before[0]-1000000, before[1]+1000000, before[2]+1], 'Independent transfer balance/nonce mismatch')
                return result
            def witness_scope(result, selected):
                expected = selected.removeprefix('0x')
                context = result['verifierContext']
                require(context is not None and context['scopes'][addresses['cosigner'][2:]] == [expected], 'SDK did not pin exact witness leaf scope')
                rows = result['signers']; require(rows[0]['scopes'] == 'None' and rows[1]['scopes'] == 'CustomContracts', 'Wrong payer/proxy signer order')
                cosigner = next(row for row in rows if row['account'] == addresses['cosigner'])
                require(cosigner['scopes'] == 'CustomContracts' and cosigner['allowedcontracts'] == [selected], 'Signer scope expanded beyond exact verifier')
                require(all(row['scopes'] != 'Global' for row in rows), 'Global witness scope present')
            def stale_rejected(held, account):
                before = account_state(account); nonce = value(CORE, 'getNonce', [H(account), I(3)])
                valid_until = int.from_bytes(bytes.fromhex(held['rawTransaction'])[21:25], 'little')
                require(chain.rpc('getblockcount', []) <= valid_until, 'Retained raw expired; this is not an authority-counter negative control')
                probe = sdk({'mode': 'preflight-raw', 'rawTransaction': held['rawTransaction']})['preflight']
                require(probe['snapshot']['height'] < valid_until, 'Retained raw preflight used an expired height')
                require(probe['hash'] == held['txid'] and probe['verification'] != 'Succeed', 'Stale signed witness accepted')
                raw = base64.b64encode(bytes.fromhex(held['rawTransaction'])).decode()
                try: chain.rpc('sendrawtransaction', [raw])
                except ValidationFailure as error:
                    require('Inventory verification failed' in str(error), 'Wrong stale raw rejection')
                else: raise RuntimeError('Stale signed raw unexpectedly broadcast')
                require(account_state(account) == before and value(CORE, 'getNonce', [H(account), I(3)]) == nonce, 'Stale raw changed state')
                report['rejections'].append({'step': stage, 'layer': 'real-signed-native-witness', 'txid': held['txid'],
                    'rawTransaction': held['rawTransaction'], 'preflight': probe, 'unchangedAccountAndNonce': True,
                    'validUntilBlock': valid_until, 'unexpiredAtRejection': True})
            native = register('NeoNativeVerifier', 'f2'); session = register('SessionKeyVerifier', 'f3'); multi = register('MultiSigVerifier', 'f4')
            accounts = {name: row['accountId'] for name, row in zip(NAMES, (native, session, multi))}
            proxies = {name: '0x'+row['account']['accountAddress'] for name, row in zip(NAMES, (native, session, multi))}
            chain.stop_node()
            for proxy in proxies.values():
                funding = chain.invoke_file(TOKEN, 'transfer', [H(addresses['sponsor']), H(proxy), I(500000000), None])
                chain.nx('contract', 'invoke', str(funding), 'sponsor', '-j')
            chain.start_node()
            require(all(balance(proxy) == 500000000 for proxy in proxies.values()), 'Fixture proxy funding failed')
            native_args = [{'type': 'Array', 'value': [{'type': 'ByteString', 'value': hash_le(addresses['cosigner']).hex()}]}, {'type': 'Integer', 'value': '1'}]
            stage = 'native-root-config'; configure(stage, accounts[NAMES[0]], 'setConfig', native_args)
            auth = {'verifierPrivateKeys': [keys['cosigner']]}
            stage = 'native-root-missing-witness'; sdk(dict(secrets, mode='transfer', accountId=accounts[NAMES[0]], operation=operation(proxies[NAMES[0]])), expect_error='application preflight failed')
            stage = 'native-root-transfer'; first = executed(stage, accounts[NAMES[0]], proxies[NAMES[0]], **auth); witness_scope(first, modules[NAMES[0]])
            held = sdk(dict(secrets, mode='sign-only', accountId=accounts[NAMES[0]], operation=operation(proxies[NAMES[0]]), **auth))
            stage = 'native-root-reconfigure'; configure(stage, accounts[NAMES[0]], 'setConfig', native_args)
            stage = 'native-root-old-raw-after-config'; stale_rejected(held, accounts[NAMES[0]])
            stage = 'native-root-fresh-after-config'; witness_scope(executed(stage, accounts[NAMES[0]], proxies[NAMES[0]], **auth), modules[NAMES[0]])
            def session_args(key_name="session"):
                now = chain.rpc('getblockheader', [chain.rpc('getbestblockhash', []), True])['time']
                return [{'type': 'ByteString', 'value': public[key_name]}, {'type': 'ByteString', 'value': hash_le(TOKEN).hex()},
                    {'type': 'ByteString', 'value': b'transfer'.hex()}, {'type': 'Integer', 'value': str(now+25*86400000)},
                    {'type': 'Integer', 'value': '100000000'}, {'type': 'ByteString', 'value': b'SDK private integration'.hex()}]
            stage = 'session-root-config'; configure(stage, accounts[NAMES[1]], 'setSessionKey', session_args())
            session_auth = {'sessionPrivateKey': keys['session'], 'sessionVerifier': modules[NAMES[1]]}
            stage = 'session-root-transfer'; transferred = executed(stage, accounts[NAMES[1]], proxies[NAMES[1]], **session_auth)
            require(transferred['payloadEvidence']['chainPayloadMatched'] and transferred['verifierContext'] is None, 'Session authorization evidence mismatch')
            require(value(modules[NAMES[1]], 'getSpentAmount', [H(accounts[NAMES[1]])]) == 1000000, 'Session spending readback mismatch')
            stage = 'multisig-session-child-config'; configure(stage, accounts[NAMES[2]], 'setSessionKey', session_args(), modules[NAMES[1]])
            stage = 'multisig-native-child-config'; configure(stage, accounts[NAMES[2]], 'setConfig', native_args, modules[NAMES[0]])
            stage = 'multisig-root-config'; configure(stage, accounts[NAMES[2]], 'setConfig', [
                {'type': 'Array', 'value': [{'type': 'ByteString', 'value': hash_le(modules[name]).hex()} for name in (NAMES[1], NAMES[0])]},
                {'type': 'Integer', 'value': '2'}])
            stage = 'multisig-active-native-leaf-transfer'; result = executed(stage, accounts[NAMES[2]], proxies[NAMES[2]], **session_auth, **auth, multiSig=True)
            witness_scope(result, modules[NAMES[0]])
            require(value(modules[NAMES[1]], 'getSpentAmount', [H(accounts[NAMES[2]])]) == 1000000, 'Composite Session spending readback mismatch')
            require(result['payloadEvidence']['sessionIndex'] == 0 and len(result['verifierContext']['modules']) == 3, 'Wrong exact child ordering/code pins')
            # Enroll a second independently deployed Session instance/key, then prove
            # both a two-Session quorum and alternate quorums in a 2-of-3 topology.
            stage = 'multisig-second-session-child-config'; configure(stage, accounts[NAMES[2]], 'setSessionKey', session_args('session2'), modules['SessionKeyVerifier2'])
            def topology(label, children):
                configure(label, accounts[NAMES[2]], 'setConfig', [{'type': 'Array', 'value': [
                    {'type': 'ByteString', 'value': hash_le(child).hex()} for child in children]}, {'type': 'Integer', 'value': '2'}])
            two_sessions = {'multiSig': True, 'nativeVerifierLeaves': [], 'sessionSigners': [
                {'verifier': modules[NAMES[1]], 'privateKey': keys['session']},
                {'verifier': modules['SessionKeyVerifier2'], 'privateKey': keys['session2']}]}
            stage = 'two-session-two-of-two-config'; topology(stage, [modules[NAMES[1]], modules['SessionKeyVerifier2']])
            for label, op in [('two-session-two-of-two-transfer', operation(proxies[NAMES[2]])),
                              ('two-session-maximum-argument-bytes', operation(proxies[NAMES[2]])),
                              ('two-session-maximum-channel-and-depth', operation(proxies[NAMES[2]]))]:
                if 'argument-bytes' in label:
                    # Exact StdLib serialization length: Array header2 + hashes44 +
                    # amount Integer5 + ByteString length-prefix4 + payload4041 =4096.
                    op['args'][3] = {'type': 'ByteString', 'value': 'a5'*4041}
                if 'channel-and-depth' in label:
                    nested = {'type': 'Null'}
                    for _ in range(8): nested = {'type': 'Array', 'value': [nested]}
                    op['args'][3] = nested; op['channel'] = str((1 << 191)-1)
                stage = label; proved = executed(label, accounts[NAMES[2]], proxies[NAMES[2]], operation_override=op, **two_sessions)
                require(proved['payloadEvidence']['presentSlots'] == [True, True], 'Two-Session slot order changed')
            # Removing an active child intentionally clears its policy. Re-enroll
            # and configure it before adding it back to a later quorum.
            require(value(modules[NAMES[0]], 'getConfig', [H(accounts[NAMES[2]])]) is None,
                    'Removed native child policy was not cleared')
            stage = 'multisig-native-child-reenroll'; configure(stage, accounts[NAMES[2]], 'setConfig', native_args, modules[NAMES[0]])
            stage = 'two-of-three-config'; topology(stage, [modules[NAMES[1]], modules['SessionKeyVerifier2'], modules[NAMES[0]]])
            stage = 'two-of-three-insufficient-proof'
            sdk(dict(secrets, mode='transfer', accountId=accounts[NAMES[2]], operation=operation(proxies[NAMES[2]]),
                multiSig=True, nativeVerifierLeaves=[], sessionSigners=two_sessions['sessionSigners'][:1]), expect_error='application preflight failed')
            combinations = [
                ('two-of-three-both-sessions', two_sessions, [True, True, False]),
                ('two-of-three-session-one-and-native', {'multiSig':True, 'sessionSigners':two_sessions['sessionSigners'][:1], 'nativeVerifierLeaves':[modules[NAMES[0]]], **auth}, [True, False, True]),
                ('two-of-three-session-two-and-native', {'multiSig':True, 'sessionSigners':two_sessions['sessionSigners'][1:], 'nativeVerifierLeaves':[modules[NAMES[0]]], **auth}, [False, True, True]),
            ]
            for label, proofs, slots in combinations:
                before_spent = [value(module, 'getSpentAmount', [H(accounts[NAMES[2]])]) for module in (modules[NAMES[1]], modules['SessionKeyVerifier2'])]
                stage = label; proved = executed(label, accounts[NAMES[2]], proxies[NAMES[2]], **proofs)
                require(proved['payloadEvidence']['presentSlots'] == slots, 'Two-of-three proof slots shifted')
                after_spent = [value(module, 'getSpentAmount', [H(accounts[NAMES[2]])]) for module in (modules[NAMES[1]], modules['SessionKeyVerifier2'])]
                require(after_spent == [before_spent[i]+(1000000 if slots[i] else 0) for i in range(2)], 'Unapproved child post-effects or missing approved child spending')
                if slots[2]: witness_scope(proved, modules[NAMES[0]])
            stage = 'two-of-three-order-native-second'; topology(stage, [modules[NAMES[1]], modules[NAMES[0]], modules['SessionKeyVerifier2']])
            before_spent = [value(module, 'getSpentAmount', [H(accounts[NAMES[2]])]) for module in (modules[NAMES[1]], modules['SessionKeyVerifier2'])]
            stage = 'three-valid-proofs-select-first-two'
            all_valid = executed(stage, accounts[NAMES[2]], proxies[NAMES[2]], multiSig=True,
                sessionSigners=two_sessions['sessionSigners'], nativeVerifierLeaves=[modules[NAMES[0]]], **auth)
            require(all_valid['payloadEvidence']['presentSlots'] == [True, True, True], 'Expected three provided valid proof slots')
            after_spent = [value(module, 'getSpentAmount', [H(accounts[NAMES[2]])]) for module in (modules[NAMES[1]], modules['SessionKeyVerifier2'])]
            require(after_spent == [before_spent[0]+1000000, before_spent[1]], 'Post-effects were not limited to the first threshold approved children')
            all_valid['selectedQuorumEvidence'] = {'rosterOrder':[modules[NAMES[1]],modules[NAMES[0]],modules['SessionKeyVerifier2']],
                'threshold':2,'providedProofs':3,'selectedIndices':[0,1], 'unselectedSessionSpentUnchanged':True}
            report['transactions'][-1]['selectedQuorumEvidence'] = all_valid['selectedQuorumEvidence']
            if args.signed_artifact_transport:
                account = accounts[NAMES[0]]
                before = account_state(account)
                policy_before = value(modules[NAMES[0]], 'getConfig', [H(account)])
                stage = 'native-root-policy-cancel-propose'
                record(stage, sdk(dict(secrets, mode='configure', accountId=account,
                    configuration={'role': 'verifier', 'method': 'setConfig', 'args': native_args})))
                require(value(CORE, 'getPendingModuleCall', [H(account), S('verifier')]) is not None,
                        'Policy cancellation fixture has no pending verifier call')
                stage = 'native-root-policy-cancel-guarded'
                cancelled = record(stage, sdk(dict(secrets, mode='cancel-policy', accountId=account, role='verifier')))
                require(cancelled['artifactTransport']['guardedCancellation'] is True,
                        'Cancellation did not preserve the reviewed exact script')
                require(value(CORE, 'getPendingModuleCall', [H(account), S('verifier')]) is None,
                        'Guarded cancellation did not remove the pending call')
                require(account_state(account) == before and value(modules[NAMES[0]], 'getConfig', [H(account)]) == policy_before,
                        'Cancellation changed the account record or active policy')
                report['guardedCancellationReadback'] = {
                    'pendingPresentBefore': True, 'pendingAbsentAfter': True,
                    'accountRecordUnchanged': True, 'activePolicyUnchanged': True,
                }
            require(all(balance(addresses[name]) == 0 for name in ('owner', 'cosigner', 'session', 'session2')), 'Authority key paid transaction fees')
            report.update(networkMagic=chain.magic, accounts=accounts, proxies=proxies, zeroGasAuthorities=True,
                privateKeyTransport='stdin-only; temporary files mode0600', exactSignedRawReadback=True,
                signedArtifactTransport=args.signed_artifact_transport)
        finally:
            if args.retain_on_failure and sys.exc_info()[0] is not None:
                retained = True
                report['retainedPrivateChain'] = {'directory': str(directory), 'rpcUrl': f'http://127.0.0.1:{chain.rpc_port}',
                    'processId': chain.node.pid if chain.node else None, 'diagnostic': str(directory/'sdk-fault.json')}
            else:
                chain.stop_node()
            report['ownedNodesStopped'] = chain.node is None
    check_runtime_receipt(build, args.runtime)
    require(report['moduleBuildReceiptSha256'] == sha256(args.module_receipt), 'Module build receipt changed')
    check_module_build(json.loads(args.module_receipt.read_text()), args.artifacts, repo/'contracts')
    require(pins == {str(p.relative_to(repo)): sha256(p) for p in sources}, 'Source changed during private validation')
    require(report['sourceBuildReceiptSha256'] == sha256(args.build_receipt), 'Runtime receipt changed')
    report.update(status='PASS', runtimeFilesMatched=True)
except Exception as error:
    report.update(status='FAIL', failure={'stage': stage, 'type': type(error).__name__})
    raise
finally:
    report['completedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2)+'\n')
print('PASS: native SDK roots, mixed and two-Session quorums, 2-of-3, maximum inputs, stale/fresh raw')
