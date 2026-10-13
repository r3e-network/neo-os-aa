#!/usr/bin/env python3
"""Real P-256 native session authorization, spending and rollback on a private chain."""
import argparse
import base64
import copy
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import tempfile
import time

from neoexpress_validate import (Chain, RawKey, P256Key, ValidationFailure, H, B, I, S, A, ZERO,
                                decode, hash_le, hash160, varint, serialize_unsigned, serialize_witnesses, aa_proxy_rules)
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require
from neoexpress_native_service_validate import CORE, check_native, persist, check_account_record, module_storage_key, transaction_system_fee, execution_arguments
from neoexpress_native_proxy_validate import (GAS, GAS_TOKEN, push_bytes, proxy_address, verification_script,
                                            application_script, check_transaction, check_fault)
from neoexpress_native_configuration_validate import call_script, pending_log
from neoexpress_native_recovery_validate import equal_typed
from neoexpress_native_modules_validate import nef_from_rpc, check_module_build, CONTEXT
from neoexpress_reproducible_build import check_runtime_receipt, sha256

NULL = {'type':'Any','value':None}


def native_session_signer_domain(public_key):
    """Canonical P-256 authority, shared with standard-account native witnesses."""
    require(type(public_key) is bytes and len(public_key)==33 and public_key[0] in (2,3),
            'Native session oracle requires a compressed P-256 public key')
    verification=b'\x0c\x21'+public_key+b'\x41\x56\xe7\xb3\x27'
    return hashlib.sha256(b'NeoSmartAccount/SignerDomain\x01\x03'+hash160(verification)).digest()


def serialize_value(item):
    """Independent exact scalar/container subset for these signing vectors, not an SDK."""
    kind=item['type'];value=item.get('value')
    if kind=='Any':
        require(value is None,'Any must be Null');return b'\x00'
    if kind=='Boolean':
        require(type(value) is bool,'Exact Boolean required');return b'\x20'+bytes([int(value)])
    if kind=='Integer':
        require(type(value) is int or type(value) is str and re.fullmatch(r'-?[0-9]+',value),'Exact Integer required')
        n=int(value);require(-(1<<255)<=n<(1<<255),'Integer range')
        size=0 if n==0 else 1
        while size and not -(1<<(8*size-1))<=n<(1<<(8*size-1)):size+=1
        data=n.to_bytes(size,'little',signed=True);return b'\x21'+varint(len(data))+data
    if kind in ('Array','Struct'):
        require(type(value) is list,'Container requires list');return (b'\x40' if kind=='Array' else b'\x41')+varint(len(value))+b''.join(serialize_value(v) for v in value)
    if kind=='Hash160':
        require(type(value) is str and re.fullmatch(r'0x[0-9a-fA-F]{40}',value),'Hash160 encoding');data=hash_le(value)
    elif kind=='ByteArray':data=base64.b64decode(value,validate=True)
    elif kind=='String':data=value.encode('utf-8',errors='strict')
    else:raise ValidationFailure('Unsupported signing value')
    return b'\x28'+varint(len(data))+data


def session_last_used_change(state, timestamp):
    """Project the native timestamp getter while preserving the stored metadata bytes."""
    require(type(timestamp) is int and 0 <= timestamp < 2**64, 'Last-used timestamp must be UInt64')
    state['metadata'][1]=timestamp
    state['raw'][5]=base64.b64encode(serialize_value(I(timestamp))[2:]).decode()


def signing_preimage(network, account, operation, core=CORE, *, authority_epoch=0, configuration_nonce=0):
    require(type(network) is int and 0<=network<2**32,'Network must be UInt32')
    require(operation['type']=='Array' and len(operation['value'])==6,'Six-field operation required')
    require(len(hash_le(account))==20 and len(hash_le(core))==20,'Signing identity width')
    for value in (authority_epoch, configuration_nonce):
        require(type(value) is int and 0<=value<2**64,'Authority epoch and configuration nonce must be UInt64')
    unsigned=A(*operation['value'][:5],B(b''))
    return b'NeoSmartAccount/UserOperation\x02'+network.to_bytes(4,'little')+hash_le(core)+hash_le(account)+authority_epoch.to_bytes(8,'little')+configuration_nonce.to_bytes(8,'little')+serialize_value(unsigned)


class SessionTransactions:
    def __init__(self, chain, account, other, verifier, payer, recipient, report):
        self.chain,self.account,self.other,self.verifier,self.payer,self.recipient,self.report=chain,account,other,verifier,payer,recipient,report
        self.proxy=proxy_address(account)

    def value(self,target,method,args):return self.chain.rpc_invoke(target,method,args)[0]

    def epoch(self,account):
        epoch=self.value(CORE,'getAuthorityEpoch',[H(account)])
        require(type(epoch) is int and 0<=epoch<2**64,'Authority epoch must be UInt64')
        return epoch

    def storage(self,account,*,authority_epoch=None):
        epoch=self.epoch(account) if authority_epoch is None else authority_epoch
        values=[]
        for prefix in (1,2,3,4,5,6):
            key=base64.b64encode(module_storage_key(account,prefix,epoch)).decode()
            try: data=self.chain.rpc('getstorage',[self.verifier,key])
            except ValidationFailure as error:
                require(str(error)=='rpc getstorage: Unknown storage item','Unexpected storage lookup failure');data=None
            values.append(data)
        return values

    def state(self,account):
        return {'account':self.value(CORE,'getAccount',[H(account)]),'nonce':self.value(CORE,'getNonce',[H(account),I(0)]),
                'pending':self.value(CORE,'getPendingModuleCall',[H(account),S('verifier')]),
                'key':self.value(self.verifier,'getSessionKey',[H(account)]),'metadata':self.value(self.verifier,'getSessionKeyMetadata',[H(account)]),
                'spent':self.value(self.verifier,'getSpentAmount',[H(account)]),'raw':self.storage(account),
                'balance':self.value(GAS_TOKEN,'balanceOf',[H(proxy_address(account))])}

    def send(self,label,target,method,args,*,key=None,proxy=False,fault=None,expected=None,events=(),change=None,raw_changes=(),recipient_delta=0,admission_rejection=False,witness_target=GAS_TOKEN):
        require(not admission_rejection or proxy and fault is None,'Admission rejection requires a proxy witness and no Application fault expectation')
        before=self.state(self.account);other=self.state(self.other)
        recipient=self.value(GAS_TOKEN,'balanceOf',[H(self.recipient)])
        payer=key or self.payer
        signers=[{'account':'0x'+payer.script_hash[::-1].hex(),'scopes':'CalledByEntry'}]
        if proxy:signers.append({'account':self.proxy,'scopes':'WitnessRules','rules':aa_proxy_rules(CORE,witness_target)})
        if target==CORE and method in ('executeUserOp','executeUserOps'):
            require(len(args)==2,'Fresh execution requires account and payload')
            args=execution_arguments(self.account,args[1],before['account'])
        script=application_script(self.account,args[1],batch=method=='executeUserOps',
            authority_epoch=before['account'][13],configuration_nonce=before['account'][8]) if proxy else call_script(target,method,args)
        sysfee,netfee=transaction_system_fee(self.chain,script,signers),2*GAS
        unsigned=serialize_unsigned(int.from_bytes(os.urandom(4),'little'),sysfee,netfee,self.chain.rpc('getblockcount',[])+50,signers,script)
        digest=hashlib.sha256(unsigned).digest();txid='0x'+digest[::-1].hex()
        witnesses=[(push_bytes(payer.sign(self.chain.magic.to_bytes(4,'little')+digest)),payer.verification)]
        if proxy:witnesses.append((b'',verification_script(self.account)))
        raw=base64.b64encode(unsigned+serialize_witnesses(witnesses)).decode()
        try: submitted=self.chain.rpc('sendrawtransaction',[raw])
        except ValidationFailure as error:
            if not admission_rejection:raise
            require(str(error)=='rpc sendrawtransaction: Inventory verification failed - Invalid','Unexpected admission failure')
            require(equal_typed(before,self.state(self.account)) and equal_typed(other,self.state(self.other)),
                    'Rejected witness changed account state or isolation')
            require(self.value(GAS_TOKEN,'balanceOf',[H(self.recipient)])==recipient,'Rejected witness changed recipient balance')
            self.report['rejectedWitnesses'].append({'step':label,'txid':txid,'persisted':False,'proxyWitnessIncluded':True,
                'rpcError':str(error),'observedStateAndIsolationMatched':True,
                'candidateTransactionSha256':hashlib.sha256(base64.b64decode(raw)).hexdigest()})
            print(label+': REJECTED at witness admission',flush=True)
            return
        require(not admission_rejection,'Invalid witness was unexpectedly admitted')
        require(submitted.get('hash')==txid,'Transaction hash mismatch')
        deadline=time.monotonic()+90;execution=None
        while time.monotonic()<deadline:
            try:execution=self.chain.rpc('getapplicationlog',[txid])['executions'][0];break
            except ValidationFailure as error:
                if not pending_log(error):raise
            time.sleep(0.5)
        require(execution is not None,'Session transaction not persisted')
        tx=self.chain.rpc('getrawtransaction',[txid,True]);check_transaction(tx,txid,script,signers,witnesses)
        print(label+': '+execution['vmstate']+(' '+str(execution.get('exception')) if execution['vmstate']!='HALT' else ''),flush=True)
        if fault:check_fault(execution,fault)
        else:
            require(execution['vmstate']=='HALT','Unexpected session fault')
            require(len(execution['stack'])==1 and equal_typed(decode(execution['stack'][0]),expected),'Incorrect exact session result')
            require([(n['contract'],n['eventname']) for n in execution['notifications']]==list(events),'Incorrect event sequence')
            for notification in execution['notifications']:
                values=decode(notification['state'])
                if notification['contract']==GAS_TOKEN:
                    require(equal_typed(values,[hash_le(self.proxy),hash_le(self.recipient),recipient_delta]),'Incorrect transfer event')
                else:require(values[0]==hash_le(self.account),'Incorrect event account')
        timestamp=self.chain.rpc('getblockheader',[tx['blockhash'],True])['time']
        desired=copy.deepcopy(before)
        if change:change(desired,timestamp)
        after=self.state(self.account)
        for index in raw_changes:desired['raw'][index]=after['raw'][index]
        if not equal_typed(desired,after):
            print('Expected state:',desired,'Actual state:',after,flush=True)
            raise ValidationFailure('Session account, nonce, pending intent, policy or storage differs')
        require(equal_typed(other,self.state(self.other)),'Session operation modified another account')
        require(self.value(GAS_TOKEN,'balanceOf',[H(self.recipient)])==recipient+recipient_delta,'Recipient balance delta mismatch')
        self.report['executions'].append({'step':label,'method':method,'txid':txid,'vmstate':execution['vmstate'],'persisted':True,
            'expectedFailure':fault,'proxyWitnessIncluded':proxy,'confirmedBlock':tx['blockhash'],'rawTransactionAndWitnessReadbackMatched':True,
            'observedStateAndIsolationMatched':True,'spentAmount':after['spent'],'operationNonce':after['nonce'],'configurationNonce':after['account'][8],
            'gasConsumedDatoshi':int(execution['gasconsumed']),'systemFeeDatoshi':sysfee,'networkFeeDatoshi':netfee,
            'committedAuthorityEpoch':before['account'][13] if method in ('executeUserOp','executeUserOps') else None,
            'committedConfigurationNonce':before['account'][8] if method in ('executeUserOp','executeUserOps') else None})
        return timestamp

    def signed(self,key,operation,*,network=None,account=None,core=CORE,double_hash=False):
        record=check_account_record(self.value(CORE,'getAccount',[H(self.account)]))
        require(record[13]==self.epoch(self.account),'Native epoch and account record disagree')
        counters={'authority_epoch':record[13],'configuration_nonce':record[8]}
        canonical=signing_preimage(self.chain.magic,self.account,operation,**counters)
        fields=operation['value']
        payload=self.value(self.verifier,'getPayload',[H(self.account),*fields[:5]])
        digest=self.value(CORE,'getOperationDigest',[H(self.account),operation])
        require(payload==canonical and digest==hashlib.sha256(canonical).digest(),'Independent/native/module signing mismatch')
        message=signing_preimage(self.chain.magic if network is None else network,self.account if account is None else account,operation,core,**counters)
        if double_hash:message=hashlib.sha256(message).digest()
        result=copy.deepcopy(operation);signature=key.sign(message);result['value'][5]=B(signature)
        self.report['signingVectors'].append({'operationDigest':digest.hex(),'signedMessageSha256':hashlib.sha256(message).hexdigest(),
            'publicKey':key.compressed.hex(),'signature':signature.hex(),'authorityEpoch':record[13],'configurationNonce':record[8],'nativeAndIndependentDigestMatched':True,'doubleHashControl':double_hash})
        return result


def validate(runtime,dotnet,artifacts,build_receipt,module_receipt,output):
    report={'schema':'smartaccount-native-session-private/v1','status':'RUNNING','publicNetworksTouched':False,
            'scope':'Actual P-256 session signatures and native GAS transfers; not a cryptographic or compiler soundness proof.',
            'transactions':[],'executions':[],'signingVectors':[],'rejectedWitnesses':[],'ownedNodesStopped':False}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report)+'\n');stage='provenance'
    try:
        sources=[Path(__file__),*[Path(__file__).with_name(n) for n in ('neoexpress_validate.py','neoexpress_activation_validate.py',
                 'neoexpress_native_service_validate.py','neoexpress_native_proxy_validate.py','neoexpress_native_configuration_validate.py',
                 'neoexpress_native_recovery_validate.py','neoexpress_native_modules_validate.py','neoexpress_reproducible_build.py',
                 'native_module_profile.py','build_native_modules.py')]]
        report.update(sourceSha256={p.name:sha256(p) for p in sources},sourceBuildReceiptSha256=sha256(build_receipt),moduleBuildReceiptSha256=sha256(module_receipt))
        build=json.loads(build_receipt.read_text());check_runtime_receipt(build,runtime)
        compiled=json.loads(module_receipt.read_text());contracts=Path(__file__).resolve().parent.parent/'contracts'
        artifact_pins=check_module_build(compiled,artifacts,contracts)
        with tempfile.TemporaryDirectory(prefix='smartaccount-native-session-') as scratch:
            root=Path(scratch);chain=Chain(make_runner(runtime,dotnet,root),root)
            try:
                stage='setup';chain.nx('create','-o',str(chain.file));config=json.loads(chain.file.read_text())
                config.setdefault('settings',{}).update({ACTIVATION_KEY:'0','chain.SecondsPerBlock':'1'})
                for field in ('rpc-port','tcp-port'):
                    with socket.socket() as sock:sock.bind(('127.0.0.1',0));config['consensus-nodes'][0][field]=sock.getsockname()[1]
                chain.file.write_text(json.dumps(config));chain.magic=config['magic'];chain.rpc_port=config['consensus-nodes'][0]['rpc-port']
                keys={}
                for label in ('owner','relay','recipient','guardian','replacement'):
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
                    account=persist(chain,report,'register-'+str(len(accounts)),'registerAccount',[H(addresses['owner']),B(salt),H(verifier),H(ZERO),H(addresses['guardian'])],'AccountCreated')
                    accounts.append('0x'+account[::-1].hex())
                account,other=accounts;proxy=proxy_address(account)
                fund=chain.invoke_file(GAS_TOKEN,'transfer',[H(addresses['owner']),H(proxy),I(2*GAS),None])
                chain.nx('contract','invoke',str(fund),'owner','-j')
                chain.start_node();check_native(chain.rpc('getcontractstate',[CORE]));require(chain.rpc('getversion',[])['protocol']['network']==chain.magic,'Wrong private network')
                def readback():
                    state=chain.rpc('getcontractstate',[verifier]);require(nef_from_rpc(state['nef'])==path.read_bytes(),'Session NEF readback mismatch')
                    require(state['manifest']==json.loads(path.with_suffix('.manifest.json').read_text()),'Session manifest readback mismatch')
                readback();driver=SessionTransactions(chain,account,other,verifier,keys['relay'],addresses['recipient'],report)
                initial=driver.state(account);require(initial['key'] is None and initial['nonce']==0 and initial['balance']==2*GAS and initial['raw']==[None]*6,'Unexpected initial session state')
                custodian=[keys['owner']]
                def core(label,method,args,**kw):return driver.send(label,CORE,method,[H(account),*args],key=custodian[0],**kw)
                def wait_delay():chain.stop_node();chain.nx('fastfwd','1','-t','86401');chain.start_node()
                now=chain.rpc('getblockheader',[chain.rpc('getbestblockhash',[]),True])['time'];until=now+29*86400000;deadline=until+14*86400000
                cap=3*GAS
                configuration=[B(session.compressed),H(GAS_TOKEN),S('transfer'),I(until),I(cap),S('native session validation')]
                def op(nonce,amount,source=proxy,target=GAS_TOKEN,method='transfer',recipient=addresses['recipient']):
                    return A(H(target),S(method),A(H(source),H(recipient),I(amount),NULL),I(nonce),I(deadline),B(b''))
                stage='configuration'
                driver.send('custody-cannot-configure-directly',verifier,'setSessionKey',[H(account),*configuration],key=keys['owner'],fault=CONTEXT)
                def propose(state,timestamp):
                    binding=state['account'][5];state['pending']=[1,hash_le(account),0,binding,binding,b'setSessionKey',
                        [hash_le(account),session.compressed,hash_le(GAS_TOKEN),b'transfer',until,cap,b'native session validation'],timestamp,timestamp+86400000,state['account'][8]]
                core('propose-session','callVerifier',[S('setSessionKey'),A(*configuration)],expected=False,change=propose)
                core('immature-session','callVerifier',[S('setSessionKey'),A(*configuration)],fault='immature, changed or stale')
                wait_delay()
                def configure(state,timestamp):
                    state['account'][8]+=1;state['pending']=None;state['key']=[session.compressed,hash_le(GAS_TOKEN),b'transfer',until,cap]
                    state['raw'][4]=base64.b64encode(native_session_signer_domain(session.compressed)).decode();state['raw'][5]=''
                    state['metadata']=[timestamp,0,b'native session validation']
                core('confirm-session','callVerifier',[S('setSessionKey'),A(*configuration)],events=[(verifier,'SessionKeyGranted')],change=configure,raw_changes=(0,1,3))
                require(driver.storage(account)[3] is not None,'Rotation state was not persisted')
                domains=driver.value(verifier,'getSignerDomains',[H(account)])
                require(domains==[native_session_signer_domain(session.compressed)],'Session signer domain mismatch')
                stage='authorization-negatives'
                def execute(label,payload,**kw):return driver.send(label,CORE,'executeUserOp',[H(account),payload],**kw)
                for label,options,key in [('foreign-key',{},attacker),('wrong-account',{'account':other},session),
                    ('wrong-network',{'network':chain.magic^1},session),('wrong-core',{'core':GAS_TOKEN},session),('double-hashed-message',{'double_hash':True},session)]:
                    invalid=driver.signed(key,op(0,GAS//2),**options)
                    execute(label,invalid,fault='The verifier must return exactly Boolean true.')
                    execute(label+'-witness',invalid,proxy=True,admission_rejection=True)
                tampered=driver.signed(session,op(0,GAS//2));tampered['value'][2]['value'][2]=I(GAS//2+1)
                execute('tampered-amount',tampered,fault='The verifier must return exactly Boolean true.')
                for label,operation,reason in [('wrong-target',op(0,1,target=CORE),'Target contract not permitted'),
                    ('wrong-method',op(0,1,method='balanceOf'),'Method not permitted'),('wrong-source',op(0,1,source=addresses['owner']),'Transfer source is not the account address'),
                    ('negative-amount',op(0,-1),'Invalid transfer amount'),('over-cap',op(0,4*GAS),'Session key spending limit exceeded')]:
                    execute(label,driver.signed(session,operation),fault=reason)
                wrong_type=op(0,1);wrong_type['value'][2]['value'][2]={'type':'Boolean','value':True}
                execute('boolean-amount',driver.signed(session,wrong_type),fault='Invalid transfer amount')
                for method,args in [('validateSignature',[H(account),driver.signed(session,op(0,1))]),('postExecute',[H(account),driver.signed(session,op(0,1)),{'type':'Boolean','value':True}]),('clearSessionKey',[H(account)]),('clearAccount',[H(account)])]:
                    driver.send('direct-'+method,verifier,method,args,key=keys['owner'],fault=CONTEXT)
                stage='real-asset-transfers'
                signed=driver.signed(session,op(0,GAS//2))
                def transfer_state(state,timestamp):
                    state['nonce']+=1;state['spent']+=GAS//2;state['balance']-=GAS//2;session_last_used_change(state,timestamp)
                execute('signed-proxy-transfer',signed,proxy=True,expected=True,events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=transfer_state,raw_changes=(2,),recipient_delta=GAS//2)
                execute('replay-operation',signed,fault='sequence is not current')
                # An actual GAS transfer with enough cap but insufficient balance returns false.
                # PostExecute must fault rather than consume nonce or spend allowance.
                execute('false-transfer-result',driver.signed(session,op(1,2*GAS)),proxy=True,fault='Session transfer did not succeed')
                execute('post-fault-transfer',driver.signed(session,op(1,GAS//2)),proxy=True,expected=True,events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=transfer_state,raw_changes=(2,),recipient_delta=GAS//2)
                stage='rotation-cap-and-revocation'
                def configure_session(label,key,limit):
                    args=[B(key.compressed),H(GAS_TOKEN),S('transfer'),I(until),I(limit),S(label)]
                    def proposal(state,timestamp):
                        binding=state['account'][5];state['pending']=[1,hash_le(account),0,binding,binding,b'setSessionKey',
                            [hash_le(account),key.compressed,hash_le(GAS_TOKEN),b'transfer',until,limit,label.encode()],timestamp,timestamp+86400000,state['account'][8]]
                    core(label+'-propose','callVerifier',[S('setSessionKey'),A(*args)],expected=False,change=proposal)
                    wait_delay()
                    def confirmed(state,timestamp):
                        state['account'][8]+=1;state['pending']=None
                        state['key']=[key.compressed,hash_le(GAS_TOKEN),b'transfer',until,limit]
                        state['raw'][4]=base64.b64encode(native_session_signer_domain(key.compressed)).decode();state['raw'][5]=''
                        state['metadata']=[timestamp,0,label.encode()]
                    core(label+'-confirm','callVerifier',[S('setSessionKey'),A(*args)],events=[(verifier,'SessionKeyGranted')],change=confirmed,raw_changes=(0,1,3))
                configure_session('rotate-preserve-spending',attacker,5*GAS//4)
                stale=driver.signed(session,op(2,1))
                execute('retired-session-key',stale,fault='The verifier must return exactly Boolean true.')
                execute('retired-session-key-witness',stale,proxy=True,admission_rejection=True)
                def quarter_transfer(state,timestamp):
                    state['nonce']+=1;state['spent']+=GAS//4;state['balance']-=GAS//4;session_last_used_change(state,timestamp)
                execute('rotated-key-exact-cap',driver.signed(attacker,op(2,GAS//4)),proxy=True,expected=True,
                    events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=quarter_transfer,raw_changes=(2,),recipient_delta=GAS//4)
                execute('rotated-key-cap-plus-one',driver.signed(attacker,op(3,1)),fault='Session key spending limit exceeded')
                configure_session('lower-cap-below-spent',attacker,GAS)
                zero=driver.signed(attacker,op(3,0))
                execute('zero-amount-overdrawn-cap',zero,fault='Session key spending limit exceeded')
                execute('zero-amount-overdrawn-cap-witness',zero,proxy=True,admission_rejection=True)
                configure_session('restore-exact-cap',attacker,5*GAS//4)
                def zero_transfer(state,timestamp):state['nonce']+=1;session_last_used_change(state,timestamp)
                execute('zero-amount-exact-cap',driver.signed(attacker,op(3,0)),proxy=True,expected=True,
                    events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=zero_transfer,raw_changes=())
                def revoke_proposal(state,timestamp):
                    binding=state['account'][5];state['pending']=[1,hash_le(account),0,binding,binding,b'clearSessionKey',
                        [hash_le(account)],timestamp,timestamp+86400000,state['account'][8]]
                core('revoke-propose','callVerifier',[S('clearSessionKey'),A()],expected=False,change=revoke_proposal)
                wait_delay()
                def revoked(state,timestamp):
                    state['account'][8]+=1;state['pending']=None;state['key']=None;state['metadata']=None
                    state['spent']=0;state['raw'][:3]=[None]*3;state['raw'][4:6]=[None,None]
                core('revoke-confirm','callVerifier',[S('clearSessionKey'),A()],events=[(verifier,'SessionKeyRevoked')],change=revoked)
                require(driver.storage(account)[3] is not None,'Ordinary revocation erased the rotation cooldown')
                revoked_signature=driver.signed(attacker,op(4,1))
                execute('revoked-session-key',revoked_signature,fault='No session key active')
                execute('revoked-session-key-witness',revoked_signature,proxy=True,admission_rejection=True)
                configure_session('grant-after-revocation',session,GAS//4)
                execute('fresh-allowance-after-revocation',driver.signed(session,op(4,GAS//4)),proxy=True,expected=True,
                    events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=quarter_transfer,raw_changes=(2,),recipient_delta=GAS//4)
                stage='recovery-epoch-and-reinstallation'
                prior=driver.state(account);old_epoch=prior['account'][13];binding=copy.deepcopy(prior['account'][5])
                old_raw=driver.storage(account,authority_epoch=old_epoch)
                require(old_raw[0] is not None and old_raw[2] is not None and old_raw[4] is not None and old_raw[5] is not None,'Recovery needs a configured and spent session')
                stale_before_recovery=driver.signed(session,op(prior['nonce'],1))
                def recovery_proposal(state,timestamp):
                    state['account'][12]=[hash_le(addresses['replacement']),timestamp,timestamp+604800000,state['account'][8]]
                driver.send('guardian-proposes-session-recovery',CORE,'proposeRecovery',[H(account),H(addresses['replacement'])],
                    key=keys['guardian'],events=[(CORE,'RecoveryProposed')],change=recovery_proposal)
                chain.stop_node();chain.nx('fastfwd','1','-t','604801');chain.start_node()
                def recovered(state,timestamp):
                    state['account'][3]=hash_le(addresses['replacement']);state['account'][5:7]=[None,None]
                    state['account'][8]+=1;state['account'][13]+=1;state['account'][9:13]=[None]*4
                    state['pending']=None;state['key']=None;state['metadata']=None;state['spent']=0;state['raw']=[None]*6
                driver.send('recover-session-authority-epoch',CORE,'executeRecovery',[H(account)],key=keys['relay'],
                    events=[(CORE,'RecoveryExecuted')],change=recovered)
                custodian[0]=keys['replacement'];recovered_state=driver.state(account)
                require(recovered_state['nonce']==prior['nonce'] and recovered_state['account'][7]==prior['account'][7],
                    'Recovery reset nonce or frozen state')
                require(driver.storage(account,authority_epoch=old_epoch)==old_raw,'Recovery must isolate old storage without trusting plugin cleanup')
                for role in ('verifier','hook'):
                    require(driver.value(CORE,'getPendingModuleCall',[H(account),S(role)]) is None,'Recovery retained pending module authority')
                    require(driver.value(CORE,'getModuleDependencies',[H(account),S(role)])==[None,[],[]],'Recovery retained module dependencies')
                def reinstall_proposal(state,timestamp):
                    state['account'][9]=[*binding,timestamp,timestamp+86400000,state['account'][8]]
                core('reinstall-same-session-propose','proposeVerifier',[H(verifier)],events=[(CORE,'VerifierChangeProposed')],change=reinstall_proposal)
                wait_delay()
                def reinstalled(state,timestamp):
                    state['account'][5]=binding;state['account'][8]+=1;state['account'][9:13]=[None]*4
                core('reinstall-same-session-confirm','activateVerifier',[],events=[(CORE,'VerifierChanged')],change=reinstalled)
                require(driver.state(account)['key'] is None and driver.storage(account)==[None]*6,'Old session configuration resurrected')
                execute('pre-recovery-session-signature-rejected',stale_before_recovery,fault='No session key active')
                execute('pre-recovery-session-witness-rejected',stale_before_recovery,proxy=True,admission_rejection=True)
                configure_session('configure-new-epoch-session',attacker,GAS)
                fresh_nonce=driver.state(account)['nonce']
                execute('retired-key-new-domain-rejected',driver.signed(session,op(fresh_nonce,1)),fault='The verifier must return exactly Boolean true.')
                execute('new-epoch-session-transfer',driver.signed(attacker,op(fresh_nonce,GAS//4)),proxy=True,expected=True,
                    events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')],change=quarter_transfer,raw_changes=(2,),recipient_delta=GAS//4)
                require(driver.storage(account,authority_epoch=old_epoch)==old_raw,'New authority modified old epoch storage')
                report['recoveryEpoch']={'before':old_epoch,'after':driver.epoch(account),'oldConfigurationDidNotResurrect':True,
                    'oldNamespaceUnchanged':True,'newAuthorityTransferSucceeded':True,'operationNoncePreservedAtRecovery':prior['nonce']}
                stage='expiry-and-cleanup'
                current_time=chain.rpc('getblockheader',[chain.rpc('getbestblockhash',[]),True])['time']
                chain.stop_node();chain.nx('fastfwd','1','-t',str(max(1,(until-current_time)//1000+1)));chain.start_node()
                next_nonce=driver.state(account)['nonce']
                execute('expired-session',driver.signed(attacker,op(next_nonce,1)),fault='Session key expired')
                execute('expired-session-witness',driver.signed(attacker,op(next_nonce,1)),proxy=True,admission_rejection=True)
                def propose_remove(state,timestamp):state['account'][9]=[hash_le(ZERO),bytes(32),timestamp,timestamp+86400000,state['account'][8]]
                core('propose-remove-session','proposeVerifier',[H(ZERO)],events=[(CORE,'VerifierChangeProposed')],change=propose_remove)
                wait_delay()
                def remove(state,timestamp):
                    state['account'][5]=None;state['account'][8]+=1;state['account'][9:13]=[None]*4;state['key']=None;state['metadata']=None;state['spent']=0;state['raw']=[None]*6
                core('activate-remove-session','activateVerifier',[],events=[(verifier,'SessionKeyRevoked'),(CORE,'VerifierChanged')],change=remove)
                require(driver.storage(account)==[None]*6,'Session cleanup left account-scoped storage')
                readback();report.update(networkMagic=chain.magic,accountId=account,otherAccountId=other,
                    finalOperationNonce=driver.state(account)['nonce'],finalConfigurationNonce=driver.state(account)['account'][8],
                    fullNefReadbackMatched=True,manifestReadbackMatched=True,currentEpochSessionStoragePrefixesCleared=True)
            finally:chain.stop_node();report['ownedNodesStopped']=chain.node is None
        check_runtime_receipt(build,runtime)
        require(all(sha256(p)==report['sourceSha256'][p.name] for p in sources),'Session harness source changed')
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
