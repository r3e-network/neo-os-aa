#!/usr/bin/env python3
"""Uncapped scope and identical-signature regrant checks on a private native chain."""
import argparse
import base64
import datetime
import hashlib
import json
from pathlib import Path
import shutil
import socket
import tempfile

from neoexpress_validate import Chain, RawKey, P256Key, H, B, I, S, A, ZERO, hash_le, decode
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require
from neoexpress_native_service_validate import CORE, check_native, persist
from neoexpress_native_proxy_validate import GAS, GAS_TOKEN, proxy_address
from neoexpress_native_modules_validate import nef_from_rpc, check_module_build
from neoexpress_native_session_validate import SessionTransactions, serialize_value, native_session_signer_domain, session_last_used_change, NULL
from neoexpress_native_recovery_validate import equal_typed
from neoexpress_reproducible_build import check_runtime_receipt, sha256


def storage_value(item):
    return base64.b64encode(serialize_value(item)).decode()


def grant_change(state,timestamp,key,target,method,until,limit,description):
    state['account'][8]+=1;state['pending']=None
    domain=native_session_signer_domain(key)
    state['key']=[key,hash_le(target),method.encode(),until,limit]
    state['metadata']=[timestamp,0,description.encode()]
    state['raw'][0]=storage_value(A(B(key),H(target),S(method),I(until),I(limit)))
    state['raw'][1]=storage_value(A(I(timestamp),I(0),S(description)))
    state['raw'][3]=base64.b64encode(serialize_value(I(timestamp))[2:]).decode()
    state['raw'][4]=base64.b64encode(domain).decode()
    state['raw'][5]=''


def use_change(state,timestamp,amount):
    state['nonce']+=1;state['balance']-=amount;session_last_used_change(state,timestamp)


def revoke_change(state,timestamp):
    state['account'][8]+=1;state['pending']=None;state['key']=None;state['metadata']=None
    state['spent']=0;state['raw'][:3]=[None]*3;state['raw'][4:6]=[None,None]


def check_grant_notification(execution,verifier,expected):
    notices=execution.get('notifications',[])
    require(len(notices)==1,'Expected one complete session grant event')
    notice=notices[0]
    require(notice['contract']==verifier and notice['eventname']=='SessionKeyGranted','Wrong grant event identity')
    require(equal_typed(decode(notice['state']),expected),'Grant event scope or uncapped flag differs')


def validate(runtime,dotnet,artifacts,build_receipt,module_receipt,output):
    report={'schema':'smartaccount-native-session-scope-private/v1','status':'RUNNING','publicNetworksTouched':False,
            'scope':'Zero-cap/exact-method/wildcard scope and identical-signature rejection after explicit key regrant; fresh signatures succeed. Not a cryptographic or compiler soundness proof.',
            'transactions':[],'executions':[],'signingVectors':[],'rejectedWitnesses':[],'grantEvents':[],
            'retainedSignatures':[],'ownedNodesStopped':False}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report)+'\n');stage='provenance'
    try:
        sources=[Path(__file__),*[Path(__file__).with_name(n) for n in ('neoexpress_validate.py','neoexpress_activation_validate.py',
                 'neoexpress_native_service_validate.py','neoexpress_native_proxy_validate.py','neoexpress_native_configuration_validate.py',
                 'neoexpress_native_recovery_validate.py','neoexpress_native_modules_validate.py','neoexpress_reproducible_build.py',
                 'native_module_profile.py','build_native_modules.py','neoexpress_native_session_validate.py')]]
        report.update(sourceSha256={p.name:sha256(p) for p in sources},sourceBuildReceiptSha256=sha256(build_receipt),moduleBuildReceiptSha256=sha256(module_receipt))
        build=json.loads(build_receipt.read_text());check_runtime_receipt(build,runtime)
        compiled=json.loads(module_receipt.read_text());contracts=Path(__file__).resolve().parent.parent/'contracts'
        artifact_pins=check_module_build(compiled,artifacts,contracts)
        with tempfile.TemporaryDirectory(prefix='smartaccount-native-session-scope-') as scratch:
            root=Path(scratch);chain=Chain(make_runner(runtime,dotnet,root),root)
            try:
                stage='setup';chain.nx('create','-o',str(chain.file));config=json.loads(chain.file.read_text())
                config.setdefault('settings',{}).update({ACTIVATION_KEY:'0','chain.SecondsPerBlock':'1'})
                for field in ('rpc-port','tcp-port'):
                    with socket.socket() as sock:sock.bind(('127.0.0.1',0));config['consensus-nodes'][0][field]=sock.getsockname()[1]
                chain.file.write_text(json.dumps(config));chain.magic=config['magic'];chain.rpc_port=config['consensus-nodes'][0]['rpc-port']
                keys={}
                for label in ('owner','relay','recipient'):
                    chain.nx('wallet','create',label)
                    if label!='recipient':chain.nx('transfer','1000','GAS','genesis',label)
                    keys[label]=RawKey(root,'private-'+label,chain.wallet_private_key(label))
                addresses={n:'0x'+k.script_hash[::-1].hex() for n,k in keys.items()}
                session=P256Key(root,'session');attacker=P256Key(root,'attacker')
                path=artifacts/'SessionKeyVerifier.nef'
                _,text=chain.nx('contract','deploy',str(path),'genesis','-j','-d','0x'+hash_le(CORE).hex())
                deployed=chain.json_from(text);verifier=deployed['contract-hash'];report['module']={'contractHash':verifier,'deploymentTransaction':deployed['tx-hash'],'nefSha256':sha256(path),'manifestSha256':sha256(path.with_suffix('.manifest.json'))}
                accounts=[]
                for salt in (bytes([2])*32,bytes([3])*32):
                    account=persist(chain,report,'register-'+str(len(accounts)),'registerAccount',[H(addresses['owner']),B(salt),H(verifier),H(ZERO),H(ZERO)],'AccountCreated')
                    accounts.append('0x'+account[::-1].hex())
                account,other=accounts;proxy=proxy_address(account)
                fund=chain.invoke_file(GAS_TOKEN,'transfer',[H(addresses['owner']),H(proxy),I(2*GAS),None])
                chain.nx('contract','invoke',str(fund),'owner','-j')
                chain.start_node();check_native(chain.rpc('getcontractstate',[CORE]));require(chain.rpc('getversion',[])['protocol']['network']==chain.magic,'Wrong private network')
                def readback():
                    state=chain.rpc('getcontractstate',[verifier]);require(nef_from_rpc(state['nef'])==path.read_bytes(),'Session NEF readback mismatch')
                    require(state['manifest']==json.loads(path.with_suffix('.manifest.json').read_text()),'Session manifest readback mismatch')
                readback();driver=SessionTransactions(chain,account,other,verifier,keys['relay'],addresses['recipient'],report)
                initial=driver.state(account);require(initial['key'] is None and initial['nonce']==0 and initial['balance']==2*GAS and initial['raw']==[None]*6,'Unexpected initial session scope state')
                def core(label,method,args,**kw):return driver.send(label,CORE,method,[H(account),*args],key=keys['owner'],**kw)
                def wait_delay():chain.stop_node();chain.nx('fastfwd','1','-t','86401');chain.start_node()
                now=chain.rpc('getblockheader',[chain.rpc('getbestblockhash',[]),True])['time']
                until=now+29*86400000;deadline=now+40*86400000
                def operation(method,args,target=GAS_TOKEN,nonce=None):
                    return A(H(target),S(method),args,I(driver.state(account)['nonce'] if nonce is None else nonce),I(deadline),B(b''))
                def transfer(amount):return operation('transfer',A(H(proxy),H(addresses['recipient']),I(amount),NULL))
                def execute(label,payload,**kw):return driver.send(label,CORE,'executeUserOp',[H(account),payload],**kw)
                def configure(label,key,method,limit,fault=None):
                    args=[B(key.compressed),H(GAS_TOKEN),S(method),I(until),I(limit),S(label)]
                    def proposal(state,timestamp):
                        binding=state['account'][5];state['pending']=[1,hash_le(account),0,binding,binding,b'setSessionKey',
                            [hash_le(account),key.compressed,hash_le(GAS_TOKEN),method.encode(),until,limit,label.encode()],timestamp,timestamp+86400000,state['account'][8]]
                    core(label+'-propose','callVerifier',[S('setSessionKey'),A(*args)],expected=False,change=proposal)
                    core(label+'-immature','callVerifier',[S('setSessionKey'),A(*args)],fault='immature, changed or stale')
                    wait_delay()
                    if fault:
                        core(label+'-confirm','callVerifier',[S('setSessionKey'),A(*args)],fault=fault)
                        def cancel(state,timestamp):state['pending']=None
                        core(label+'-cancel','cancelModuleCall',[S('verifier')],change=cancel)
                    else:
                        def configured(state,timestamp):grant_change(state,timestamp,key.compressed,GAS_TOKEN,method,until,limit,label)
                        core(label+'-confirm','callVerifier',[S('setSessionKey'),A(*args)],events=[(verifier,'SessionKeyGranted')],change=configured)
                        record=report['executions'][-1];execution=chain.rpc('getapplicationlog',[record['txid']])['executions'][0]
                        expected=[hash_le(account),key.compressed,hash_le(GAS_TOKEN),method.encode(),until,limit,method=='*' or limit==0]
                        check_grant_notification(execution,verifier,expected)
                        report['grantEvents'].append({'step':label,'method':method,'limit':limit,'uncapped':expected[-1],'allFieldsMatched':True})
                def complete(amount):return lambda state,timestamp:use_change(state,timestamp,amount)
                def reject_both(label,payload,reason):
                    execute(label,payload,fault=reason)
                    execute(label+'-witness',payload,proxy=True,admission_rejection=True)
                def retain(label,payload):
                    fingerprint=hashlib.sha256(serialize_value(payload)).hexdigest()
                    report['retainedSignatures'].append({'case':label,'signedOperationSha256':fingerprint,'signature':base64.b64decode(payload['value'][5]['value']).hex()})
                    return fingerprint
                def replay_retained(label,payload,fingerprint):
                    require(hashlib.sha256(serialize_value(payload)).hexdigest()==fingerprint,'Retained signed operation changed')
                    reject_both(label,payload,'The verifier must return exactly Boolean true.')
                    report['retainedSignatures'][-1]['identicalBytesRejectedAfterRegrant']=True
                    execute(label+'-fresh-authority-signature',driver.signed(session,transfer(1)),proxy=True,expected=True,
                            events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=complete(1),recipient_delta=1)

                stage='invalid-cap-configuration'
                reason='Spending limit only enforceable on transfer session keys'
                configure('reject-capped-wildcard',session,'*',1,fault=reason)
                configure('reject-capped-read-method',session,'balanceOf',1,fault=reason)
                stage='uncapped-exact-method'
                configure('uncapped-transfer',session,'transfer',0)
                execute('uncapped-false-completes',driver.signed(session,transfer(3*GAS)),proxy=True,expected=False,
                        events=[(CORE,'UserOpExecuted')],change=complete(0))
                execute('uncapped-target-fault-rolls-back',driver.signed(session,transfer(-1)),proxy=True,fault='cannot be negative')
                execute('uncapped-actual-transfer',driver.signed(session,transfer(GAS//2)),proxy=True,expected=True,
                        events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=complete(GAS//2),recipient_delta=GAS//2)
                reject_both('exact-method-rejects-read',driver.signed(session,operation('balanceOf',A(H(proxy)))),'Method not permitted')
                stage='rotation-key-reuse'
                retained=driver.signed(session,transfer(1));fingerprint=retain('rotation-regrant',retained)
                configure('replace-key',attacker,'transfer',0)
                reject_both('retained-signature-key-replaced',retained,'The verifier must return exactly Boolean true.')
                configure('restore-key',session,'transfer',0)
                replay_retained('retained-signature-restored-key',retained,fingerprint)
                reject_both('consumed-signature-after-regrant',retained,'sequence is not current')
                stage='revocation-key-reuse'
                retained=driver.signed(session,transfer(1));fingerprint=retain('revocation-regrant',retained)
                def revoke_proposal(state,timestamp):
                    binding=state['account'][5];state['pending']=[1,hash_le(account),0,binding,binding,b'clearSessionKey',
                        [hash_le(account)],timestamp,timestamp+86400000,state['account'][8]]
                core('revoke-propose','callVerifier',[S('clearSessionKey'),A()],expected=False,change=revoke_proposal)
                wait_delay()
                core('revoke-confirm','callVerifier',[S('clearSessionKey'),A()],events=[(verifier,'SessionKeyRevoked')],change=revoke_change)
                reject_both('retained-signature-key-revoked',retained,'No session key active')
                configure('regrant-revoked-key',session,'transfer',0)
                replay_retained('retained-signature-regranted-key',retained,fingerprint)
                stage='wildcard-target-binding'
                configure('wildcard-target',session,'*',0)
                balance=driver.state(account)['balance']
                execute('wildcard-balance-query',driver.signed(session,operation('balanceOf',A(H(proxy)))),proxy=True,
                        expected=balance,events=[(CORE,'UserOpExecuted')],change=complete(0))
                execute('wildcard-symbol-query',driver.signed(session,operation('symbol',A())),proxy=True,
                        expected=b'GAS',events=[(CORE,'UserOpExecuted')],change=complete(0))
                reject_both('wildcard-cannot-change-target',driver.signed(session,operation('getNonce',A(H(account),I(0)),target=CORE)),'Target contract not permitted')
                execute('wildcard-whole-balance-transfer',driver.signed(session,transfer(balance)),proxy=True,expected=True,
                        events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=complete(balance),recipient_delta=balance)
                require(driver.state(account)['balance']==0 and driver.state(account)['spent']==0,'Uncapped transfer did not expose the complete balance')
                stage='capped-false-result-control'
                configure('restore-positive-cap',session,'transfer',10)
                execute('capped-false-still-rolls-back',driver.signed(session,transfer(1)),proxy=True,fault='Session transfer did not succeed')
                stage='cleanup'
                def propose_remove(state,timestamp):state['account'][9]=[hash_le(ZERO),bytes(32),timestamp,timestamp+86400000,state['account'][8]]
                core('propose-remove-session','proposeVerifier',[H(ZERO)],events=[(CORE,'VerifierChangeProposed')],change=propose_remove)
                wait_delay()
                def remove(state,timestamp):
                    state['account'][5]=None;state['account'][8]+=1;state['account'][9:13]=[None]*4;state['key']=None;state['metadata']=None;state['spent']=0;state['raw']=[None]*6
                core('activate-remove-session','activateVerifier',[],events=[(verifier,'SessionKeyRevoked'),(CORE,'VerifierChanged')],change=remove)
                require(driver.storage(account)==[None]*6,'Session cleanup left account-scoped storage')
                readback();report.update(networkMagic=chain.magic,accountId=account,otherAccountId=other,
                    finalOperationNonce=driver.state(account)['nonce'],finalConfigurationNonce=driver.state(account)['account'][8],
                    fullNefReadbackMatched=True,manifestReadbackMatched=True,allSixSessionStoragePrefixesCleared=True,
                    zeroCapFalseCompletionVerified=True,wildcardTargetBindingVerified=True,keyReuseRevivalRejected=True)
            finally:chain.stop_node();report['ownedNodesStopped']=chain.node is None
        check_runtime_receipt(build,runtime)
        require(all(sha256(p)==report['sourceSha256'][p.name] for p in sources),'Session scope harness source changed')
        require(all(sha256(artifacts/n)==h for n,h in artifact_pins.items()),'Native artifacts changed')
        require(sha256(build_receipt)==report['sourceBuildReceiptSha256'] and sha256(module_receipt)==report['moduleBuildReceiptSha256'],'Build receipt changed')
        report.update(status='PASS',runtimeFilesMatched=True)
    except Exception as error:report['failure']={'stage':stage,'type':type(error).__name__};raise
    finally:
        if report['status']!='PASS':report['status']='FAIL'
        report['completedAtUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();output.write_text(json.dumps(report,indent=2)+'\n')
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('runtime','artifacts','build-receipt','module-receipt','output'):parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--dotnet',type=Path,default=shutil.which('dotnet'));args=parser.parse_args()
    require(args.dotnet is not None,'A local dotnet runtime is required')
    validate(args.runtime.resolve(),args.dotnet.resolve(),args.artifacts.resolve(),args.build_receipt.resolve(),args.module_receipt.resolve(),args.output.resolve())
