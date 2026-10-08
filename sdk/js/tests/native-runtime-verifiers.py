#!/usr/bin/env python3
"""Real native SDK verifier workflows on a disposable loopback chain; no public writes."""
import argparse
import base64
import datetime
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
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(repo / 'scripts'))
from neoexpress_validate import Chain, RawKey, H, I, hash_le, ValidationFailure
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require
from neoexpress_native_service_validate import CORE, check_native, check_account_record
from neoexpress_native_modules_validate import check_module_build, nef_from_rpc
from neoexpress_reproducible_build import check_runtime_receipt, sha256

TOKEN = '0xd2a4cff31913016155e38e474a2c06d08be276cf'
NAMES = ('NeoNativeVerifier', 'SessionKeyVerifier', 'MultiSigVerifier')
driver = Path(__file__).with_name('native-runtime-driver.mjs')
sources = [Path(__file__), driver, repo/'shared/nativeSmartAccount.mjs', repo/'shared/nativeSmartAccountClient.mjs',
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
try:
    build = json.loads(args.build_receipt.read_text())
    check_runtime_receipt(build, args.runtime)
    check_module_build(json.loads(args.module_receipt.read_text()), args.artifacts, repo/'contracts')
    with tempfile.TemporaryDirectory(prefix='native-sdk-verifiers-') as scratch:
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
            for name in ('sponsor', 'owner', 'cosigner', 'session', 'recipient', 'guardian'):
                chain.nx('wallet', 'create', name)
                raw = chain.wallet_private_key(name)
                key = RawKey(directory, 'fixture-'+name, raw)
                keys[name] = raw.hex(); addresses[name] = '0x'+key.script_hash[::-1].hex(); public[name] = key.compressed.hex()
            chain.nx('transfer', '1000', 'GAS', 'genesis', 'sponsor')
            modules = {}
            for name in NAMES:
                artifact = args.artifacts/(name+'.nef')
                _, text = chain.nx('contract', 'deploy', str(artifact), 'genesis', '-j', '-d', '0x'+hash_le(CORE).hex())
                deployed = chain.json_from(text)
                require(deployed['contract-name'] == name, 'Module deployment name mismatch')
                modules[name] = deployed['contract-hash']
                report['modules'].append({'name': name, 'contractHash': deployed['contract-hash'],
                    'deploymentTransaction': deployed['tx-hash'], 'nefSha256': sha256(artifact),
                    'manifestSha256': sha256(artifact.with_suffix('.manifest.json'))})
            chain.start_node(); check_native(chain.rpc('getcontractstate', [CORE]))
            require(chain.rpc('getversion', [])['protocol']['network'] == chain.magic, 'Wrong loopback network')
            for row in report['modules']:
                state = chain.rpc('getcontractstate', [row['contractHash']]); artifact = args.artifacts/(row['name']+'.nef')
                require(nef_from_rpc(state['nef']) == artifact.read_bytes(), 'Deployed full NEF mismatch')
                require(state['manifest'] == json.loads(artifact.with_suffix('.manifest.json').read_text()), 'Deployed manifest mismatch')
                row['fullArtifactReadbackMatched'] = True
            common = {'rpcUrl': f'http://127.0.0.1:{chain.rpc_port}', 'networkMagic': chain.magic}
            secrets = {'payerPrivateKey': keys['sponsor'], 'custodyPrivateKey': keys['owner']}
            def sdk(payload, expect_error=None):
                run = subprocess.run([shutil.which('node'), str(driver)], input=json.dumps(dict(common, **payload)),
                    capture_output=True, text=True, cwd=repo, timeout=100)
                require(all(key not in run.stdout and key not in run.stderr for key in keys.values()), 'SDK output contains fixture secret')
                if expect_error:
                    require(run.returncode != 0 and expect_error in run.stderr, 'Expected SDK rejection missing: '+expect_error)
                    report['rejections'].append({'step': stage, 'layer': 'SDK-before-broadcast', 'reason': expect_error})
                    return None
                if run.returncode: raise RuntimeError('SDK driver failed: '+run.stderr[-5000:])
                return json.loads(run.stdout)
            def record(label, result):
                require(result['preflight']['verification'] == 'Succeed' and result['preflight']['state'] == 'HALT', 'Exact signed preflight failed')
                require(result['receipt']['confirmed'] and result['receipt']['vmState'] == 'HALT', 'SDK exact bytes not confirmed')
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
            def executed(label, account, proxy, **auth):
                before = [balance(proxy), balance(addresses['recipient']), value(CORE, 'getNonce', [H(account), I(3)])]
                result = record(label, sdk(dict(secrets, mode='transfer', accountId=account, operation=operation(proxy), **auth)))
                after = [balance(proxy), balance(addresses['recipient']), value(CORE, 'getNonce', [H(account), I(3)])]
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
                probe = sdk({'mode': 'preflight-raw', 'rawTransaction': held['rawTransaction']})['preflight']
                require(probe['hash'] == held['txid'] and probe['verification'] != 'Succeed', 'Stale signed witness accepted')
                raw = base64.b64encode(bytes.fromhex(held['rawTransaction'])).decode()
                try: chain.rpc('sendrawtransaction', [raw])
                except ValidationFailure as error:
                    require('Inventory verification failed' in str(error), 'Wrong stale raw rejection')
                else: raise RuntimeError('Stale signed raw unexpectedly broadcast')
                require(account_state(account) == before and value(CORE, 'getNonce', [H(account), I(3)]) == nonce, 'Stale raw changed state')
                report['rejections'].append({'step': stage, 'layer': 'real-signed-native-witness', 'txid': held['txid'],
                    'rawTransaction': held['rawTransaction'], 'preflight': probe, 'unchangedAccountAndNonce': True})
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
            def session_args():
                now = chain.rpc('getblockheader', [chain.rpc('getbestblockhash', []), True])['time']
                return [{'type': 'ByteString', 'value': public['session']}, {'type': 'ByteString', 'value': hash_le(TOKEN).hex()},
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
            require(result['payloadEvidence']['sessionIndex'] == 0 and len(result['verifierContext']['modules']) == 3, 'Wrong exact child ordering/code pins')
            require(all(balance(addresses[name]) == 0 for name in ('owner', 'cosigner', 'session')), 'Authority key paid transaction fees')
            report.update(networkMagic=chain.magic, accounts=accounts, proxies=proxies, zeroGasAuthorities=True,
                privateKeyTransport='stdin-only; temporary files mode0600', exactSignedRawReadback=True)
        finally:
            chain.stop_node(); report['ownedNodesStopped'] = chain.node is None
    check_runtime_receipt(build, args.runtime)
    require(pins == {str(p.relative_to(repo)): sha256(p) for p in sources}, 'Source changed during private validation')
    require(report['sourceBuildReceiptSha256'] == sha256(args.build_receipt), 'Runtime receipt changed')
    report.update(status='PASS', runtimeFilesMatched=True)
except Exception as error:
    report.update(status='FAIL', failure={'stage': stage, 'type': type(error).__name__})
    raise
finally:
    report['completedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    args.output.write_text(json.dumps(report, indent=2)+'\n')
print('PASS: real native SDK NeoNative root, Session signature, active MultiSig leaf, stale raw and fresh raw')
