#!/usr/bin/env python3
"""Actual native GAS and full-prefix daily-limit lifecycle checks on a private chain."""
import argparse
import base64
import datetime
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile

from neoexpress_validate import Chain, RawKey, H, B, I, S, A, ZERO, hash_le, decode
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require
from neoexpress_native_service_validate import CORE, check_native, persist
from neoexpress_native_proxy_validate import GAS, GAS_TOKEN, DEADLINE, proxy_address, transfer
from neoexpress_native_modules_validate import nef_from_rpc, check_module_build, CONTEXT
from neoexpress_native_session_validate import SessionTransactions, serialize_value, NULL
from neoexpress_native_recovery_validate import equal_typed
from neoexpress_reproducible_build import check_runtime_receipt, sha256

DAY = 86400000


def storage_prefix(chain, contract, prefix):
    found={};start=0
    for _ in range(64):
        page=chain.rpc('findstorage',[contract,base64.b64encode(prefix).decode(),start])
        rows=page.get('results');next_index=page.get('next');truncated=page.get('truncated')
        require(type(rows) is list and type(next_index) is int and type(truncated) is bool,
                'Invalid storage enumeration shape')
        require(next_index==start+len(rows) and (not truncated or next_index>start),'Invalid storage pagination')
        for row in rows:
            key=row['key'];value=row['value']
            require(base64.b64decode(key,validate=True).startswith(prefix) and key not in found,'Foreign or duplicate storage key')
            base64.b64decode(value,validate=True);found[key]=value
        if not truncated:return found
        start=next_index
    raise ValueError('Storage enumeration exceeded the diagnostic page bound')


def raw_integer(value):
    if value==0:return b''
    size=1
    while not -(1<<(8*size-1))<=value<(1<<(8*size-1)):size+=1
    return value.to_bytes(size,'little',signed=True)


def stored(account,prefix,value,token=GAS_TOKEN,suffix=b''):
    key=bytes([prefix])+hash_le(account)+(hash_le(token) if token else b'')+suffix
    return {base64.b64encode(key).decode():base64.b64encode(value).decode()}


class DailyTransactions(SessionTransactions):
    def storage(self,account):
        return [storage_prefix(self.chain,self.verifier,bytes([p])+hash_le(account)) for p in range(1,7)]

    def state(self,account):
        raw=self.storage(account)
        fixed=raw[1].get(next(iter(stored(account,2,b''))))
        result={'account':self.value(CORE,'getAccount',[H(account)]),
                'nonce':self.value(CORE,'getNonce',[H(account),I(0)]),
                'pending':self.value(CORE,'getPendingModuleCall',[H(account),S('hook')]),
                'config':self.value(self.verifier,'getLimitConfig',[H(account),H(GAS_TOKEN)]),
                'spent':0 if fixed is None else int.from_bytes(base64.b64decode(fixed),'little',signed=True),
                'raw':raw,'balance':self.value(GAS_TOKEN,'balanceOf',[H(proxy_address(account))])}
        if getattr(self,'diagnostic_token',None):
            raw_token=[storage_prefix(self.chain,self.diagnostic_token,bytes([prefix])+hash_le(proxy_address(account))) for prefix in (1,2)]
            if account==self.account:raw_token.append(storage_prefix(self.chain,self.diagnostic_token,b'\x01'+hash_le(self.recipient)))
            def number(values):
                require(len(values)<=1,'Unexpected diagnostic storage suffix')
                return int.from_bytes(base64.b64decode(next(iter(values.values()),'')),'little',signed=True)
            result['diagnosticRaw']=raw_token
            result['diagnosticBalances']=[number(raw_token[0])]
            if account==self.account:result['diagnosticBalances'].append(number(raw_token[2]))
            result['diagnosticMode']=number(raw_token[1])
        return result


def check_balance_fixture(manifest):
    methods=manifest['abi']['methods']
    for name,args,result,safe in (
        ('balanceOf',['Hash160'],'Any',True),
        ('storedBalanceOf',['Hash160'],'Integer',True),
        ('setBalanceMode',['Hash160','Integer'],'Void',False),
        ('moveAndSpoof',['Hash160','Hash160','Integer','Integer'],'Boolean',False)):
        found=[m for m in methods if m['name']==name]
        require(len(found)==1,'Diagnostic method missing or duplicated')
        method=found[0]
        require([p['type'] for p in method['parameters']]==args and method['returntype']==result and method['safe'] is safe,
                'Diagnostic method ABI differs')


def check_balance_observation(chain,token,account,mode):
    expected={1:-1,2:b'\x01',3:True,4:None,5:[0]}
    require(mode in expected,'Unknown balance observation mode')
    result=chain.rpc('invokefunction',[token,'balanceOf',[H(account)],[]])
    stack=result.get('stack',[])
    require(result.get('state')=='HALT' and len(stack)==1,'Diagnostic balance query did not produce one value')
    require(equal_typed(decode(stack[0]),expected[mode]),'Diagnostic balance query produced the wrong exact value')
    return {'mode':mode,'stack':stack,'gasConsumedDatoshi':int(result['gasconsumed'])}


def build_diagnostic(compiler,cache,root):
    source=Path(__file__).resolve().parent.parent/'tests/fixtures/daily-outflow'
    receipts=[];retained=None
    for index in (1,2):
        project=root/('diagnostic-'+str(index));shutil.copytree(source,project)
        shutil.copyfile(Path(__file__).resolve().parent.parent/'contracts/Directory.Build.props',project/'Directory.Build.props')
        import xml.etree.ElementTree as ET
        config=ET.Element('configuration');feeds=ET.SubElement(config,'packageSources');ET.SubElement(feeds,'clear')
        ET.SubElement(feeds,'add',key='offline',value=str(cache));ET.ElementTree(config).write(project/'NuGet.Config')
        output=project/'out'
        result=subprocess.run([str(compiler),str(project/'DailyOutflowToken.csproj'),'-o',str(output)],capture_output=True,text=True,timeout=180)
        require(result.returncode==0,'Diagnostic compilation failed: '+result.stdout[-1500:]+result.stderr[-500:])
        pins={p.name:sha256(p) for p in output.iterdir() if p.suffix in ('.nef','.json')}
        require(set(pins)=={'DailyOutflowToken.nef','DailyOutflowToken.manifest.json'},'Unexpected diagnostic artifacts')
        receipts.append(pins)
        if retained is None:retained=output
    require(receipts[0]==receipts[1],'Diagnostic builds differ')
    return retained,receipts


def validate(runtime,dotnet,artifacts,build_receipt,module_receipt,output,adversarial=False,compiler=None,cache=None):
    report={'schema':'smartaccount-native-daily-private/v1','status':'RUNNING','publicNetworksTouched':False,
            'scope':'Actual native GAS, fixed/rolling accounting, full-prefix cleanup and rollback; not arbitrary-token honesty or complete compiler refinement.',
            'spentAmountMeaning':'Raw fixed-window storage counter; rolling records are separately compared byte-for-byte.',
            'adversarialMatrix':adversarial,'balanceQueryVectors':[],'transactions':[],'executions':[],'rejectedWitnesses':[],'ownedNodesStopped':False}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report)+'\n');stage='provenance'
    try:
        sources=[Path(__file__),*[Path(__file__).with_name(n) for n in ('neoexpress_validate.py','neoexpress_activation_validate.py',
            'neoexpress_native_service_validate.py','neoexpress_native_proxy_validate.py','neoexpress_native_configuration_validate.py',
            'neoexpress_native_recovery_validate.py','neoexpress_native_modules_validate.py','neoexpress_native_session_validate.py',
            'neoexpress_reproducible_build.py','native_module_profile.py','build_native_modules.py')]]
        if adversarial:
            require(compiler is not None and cache is not None,'Adversarial matrix requires explicit compiler and cache')
            sources.extend(sorted((Path(__file__).resolve().parent.parent/'tests/fixtures/daily-outflow').glob('*')))
            require(len(sources)==14,'Diagnostic source and project are required')
        report.update(sourceSha256={p.name:sha256(p) for p in sources},sourceBuildReceiptSha256=sha256(build_receipt),moduleBuildReceiptSha256=sha256(module_receipt))
        build=json.loads(build_receipt.read_text());check_runtime_receipt(build,runtime)
        artifact_pins=check_module_build(json.loads(module_receipt.read_text()),artifacts,Path(__file__).resolve().parent.parent/'contracts')
        with tempfile.TemporaryDirectory(prefix='smartaccount-native-daily-') as scratch:
            root=Path(scratch);chain=Chain(make_runner(runtime,dotnet,root),root)
            if adversarial:
                stage='diagnostic-build';diagnostic_artifacts,diagnostic_builds=build_diagnostic(compiler,cache,root)
                check_balance_fixture(json.loads((diagnostic_artifacts/'DailyOutflowToken.manifest.json').read_text()))
                report['diagnosticBuild']={'builds':diagnostic_builds,'compilerSha256':sha256(compiler),
                    'frameworkArchiveSha256':sha256(cache/'neo.smartcontract.framework/3.10.2-ci00384/neo.smartcontract.framework.3.10.2-ci00384.nupkg')}
                require(report['diagnosticBuild']['frameworkArchiveSha256']==json.loads(module_receipt.read_text())['frameworkArchiveSha256'],'Diagnostic framework mismatch')
            try:
                stage='setup';chain.nx('create','-o',str(chain.file));config=json.loads(chain.file.read_text())
                config.setdefault('settings',{}).update({ACTIVATION_KEY:'0','chain.SecondsPerBlock':'1'})
                for field in ('rpc-port','tcp-port'):
                    with socket.socket() as sock:sock.bind(('127.0.0.1',0));config['consensus-nodes'][0][field]=sock.getsockname()[1]
                chain.file.write_text(json.dumps(config));chain.magic=config['magic'];chain.rpc_port=config['consensus-nodes'][0]['rpc-port']
                for name in ('owner','recipient'):chain.nx('wallet','create',name)
                chain.nx('transfer','2000','GAS','genesis','owner')
                owner=RawKey(root,'private-owner',chain.wallet_private_key('owner'))
                recipient=RawKey(root,'private-recipient',chain.wallet_private_key('recipient'))
                owner_address='0x'+owner.script_hash[::-1].hex();recipient_address='0x'+recipient.script_hash[::-1].hex()
                nef=artifacts/'DailyLimitHook.nef'
                _,text=chain.nx('contract','deploy',str(nef),'genesis','-j','-d','0x'+hash_le(CORE).hex())
                deployed=chain.json_from(text);hook=deployed['contract-hash']
                report['module']={'contractHash':hook,'deploymentTransaction':deployed['tx-hash'],'nefSha256':sha256(nef),'manifestSha256':sha256(nef.with_suffix('.manifest.json'))}
                accounts=[]
                for salt in (bytes([4])*32,bytes([5])*32):
                    account=persist(chain,report,'register-'+str(len(accounts)),'registerAccount',[H(owner_address),B(salt),H(ZERO),H(hook),H(ZERO)],'AccountCreated')
                    accounts.append('0x'+account[::-1].hex())
                account,other=accounts;proxy=proxy_address(account)
                if adversarial:
                    token_nef=diagnostic_artifacts/'DailyOutflowToken.nef'
                    _,text=chain.nx('contract','deploy',str(token_nef),'owner','-j','-d','0x'+hash_le(proxy).hex())
                    deployed=chain.json_from(text);token=deployed['contract-hash']
                    report['diagnosticToken']={'contractHash':token,'deploymentTransaction':deployed['tx-hash'],
                        'nefSha256':sha256(token_nef),'manifestSha256':sha256(token_nef.with_suffix('.manifest.json'))}
                fund=chain.invoke_file(GAS_TOKEN,'transfer',[H(owner_address),H(proxy),I(2*GAS),None]);chain.nx('contract','invoke',str(fund),'owner','-j')
                chain.start_node();check_native(chain.rpc('getcontractstate',[CORE]))
                require(chain.rpc('getversion',[])['protocol']['network']==chain.magic,'Wrong private network')
                def readback():
                    state=chain.rpc('getcontractstate',[hook]);require(nef_from_rpc(state['nef'])==nef.read_bytes(),'Daily NEF readback mismatch')
                    require(state['manifest']==json.loads(nef.with_suffix('.manifest.json').read_text()),'Daily manifest readback mismatch')
                    if adversarial:
                        state=chain.rpc('getcontractstate',[token])
                        require(nef_from_rpc(state['nef'])==token_nef.read_bytes(),'Diagnostic NEF mismatch')
                        require(state['manifest']==json.loads(token_nef.with_suffix('.manifest.json').read_text()),'Diagnostic manifest mismatch')
                readback();driver=DailyTransactions(chain,account,other,hook,owner,recipient_address,report)
                if adversarial:driver.diagnostic_token=token
                require(driver.state(account)['raw']==[{}]*6 and driver.state(account)['balance']==2*GAS,'Unexpected initial daily state')
                def fast_forward(seconds):chain.stop_node();chain.nx('fastfwd','1','-t',str(seconds));chain.start_node()
                def core(label,method,args,**kw):return driver.send(label,CORE,method,[H(account),*args],**kw)
                def configure(label,limit,rolling,limited_token=GAS_TOKEN):
                    args=[H(limited_token),I(limit),{'type':'Boolean','value':rolling}]
                    def proposal(state,timestamp):
                        binding=state['account'][6];state['pending']=[1,hash_le(account),1,binding,binding,b'setDailyLimit',
                            [hash_le(account),hash_le(limited_token),limit,rolling],timestamp,timestamp+DAY,state['account'][8]]
                    core(label+'-propose','callHook',[S('setDailyLimit'),A(*args)],expected=False,change=proposal)
                    core(label+'-immature','callHook',[S('setDailyLimit'),A(*args)],fault='immature, changed or stale')
                    fast_forward(86401)
                    def confirmed(state,timestamp):
                        state['account'][8]+=1;state['pending']=None
                        if limited_token==GAS_TOKEN:state['config']=[limit,rolling] if limit else None
                        value=serialize_value(A(I(limit),{'type':'Boolean','value':rolling}))
                        state['raw'][0].update(stored(account,1,value,token=limited_token))
                        if limit==0:
                            for index in (0,1,2,3,5):
                                prefix=bytes([index+1])+hash_le(account)+hash_le(limited_token)
                                state['raw'][index]={k:v for k,v in state['raw'][index].items() if not base64.b64decode(k).startswith(prefix)}
                    core(label+'-confirm','callHook',[S('setDailyLimit'),A(*args)],change=confirmed)
                stage='direct-context-rejection'
                for method,args in [('setDailyLimit',[H(account),H(GAS_TOKEN),I(GAS),{'type':'Boolean','value':False}]),
                    ('preExecute',[H(account),transfer(proxy,recipient_address,0)]),('postExecute',[H(account),transfer(proxy,recipient_address,0),NULL]),('clearAccount',[H(account)])]:
                    driver.send('direct-'+method,hook,method,args,fault=CONTEXT)
                stage='fixed-window';configure('fixed-limit',4*GAS,False)
                def execute(label,amount,nonce,**kw):return core(label,'executeUserOp',[transfer(proxy,recipient_address,nonce,amount)],proxy=True,**kw)
                def false_result(state,timestamp):state['nonce']+=1
                execute('insufficient-balance-false',3*GAS,0,expected=False,events=[(CORE,'UserOpExecuted')],change=false_result)
                anchor=[None]
                def payment(amount,reset=False,rolling=False):
                    def changed(state,timestamp):
                        state['nonce']+=1;state['balance']-=amount
                        if rolling:
                            counter=int.from_bytes(base64.b64decode(next(iter(state['raw'][4].values()))),'little',signed=True) if state['raw'][4] else 0
                            counter+=1;state['raw'][4]=stored(account,5,raw_integer(counter),token=None)
                            if reset:state['raw'][3]={}
                            value=serialize_value(A(I(timestamp),I(amount)))
                            state['raw'][3].update(stored(account,4,value,suffix=serialize_value(I(counter))))
                        else:
                            state['spent']=(0 if reset else state['spent'])+amount
                            state['raw'][1]=stored(account,2,raw_integer(state['spent']))
                            if reset:anchor[0]=timestamp
                            state['raw'][2]=stored(account,3,raw_integer(anchor[0]))
                    return changed
                events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')]
                execute('first-fixed-transfer',GAS//2,1,expected=True,events=events,change=payment(GAS//2,reset=True),recipient_delta=GAS//2)
                execute('fixed-over-limit',5*GAS,2,fault='Daily limit exceeded')
                fast_forward(43200)
                execute('same-fixed-window-transfer',GAS//2,2,expected=True,events=events,change=payment(GAS//2),recipient_delta=GAS//2)
                fast_forward(43202)
                execute('fixed-window-reset',GAS//4,3,expected=True,events=events,change=payment(GAS//4,reset=True),recipient_delta=GAS//4)
                execute('second-insufficient-balance-false',3*GAS,4,expected=False,events=[(CORE,'UserOpExecuted')],change=false_result)
                extra_nonce=0
                if adversarial:
                    stage='adversarial-outflow';configure('diagnostic-limit',5,False,token)
                    def diagnostic_op(label,method,amount,mode=None,**kw):
                        nonce=driver.state(account)['nonce']
                        args=[H(proxy),H(recipient_address),I(amount)]
                        if mode is not None:args.append(I(mode))
                        op=A(H(token),S(method),A(*args),I(nonce),I(DEADLINE),B(b''))
                        return core(label,'executeUserOp',[op],proxy=True,witness_target=token,**kw)
                    token_anchor=[None]
                    def token_payment(amount,reset=False):
                        def changed(state,timestamp):
                            state['nonce']+=1;state['diagnosticBalances'][0]-=amount;state['diagnosticBalances'][1]+=amount
                            state['diagnosticRaw'][0]=stored(proxy,1,raw_integer(state['diagnosticBalances'][0]),token=None)
                            state['diagnosticRaw'][2]=stored(recipient_address,1,raw_integer(state['diagnosticBalances'][1]),token=None)
                            key=next(iter(stored(account,2,b'',token=token)))
                            prior=int.from_bytes(base64.b64decode(state['raw'][1][key]),'little',signed=True) if key in state['raw'][1] else 0
                            state['raw'][1].update(stored(account,2,raw_integer(prior+amount),token=token))
                            if reset:token_anchor[0]=timestamp
                            state['raw'][2].update(stored(account,3,raw_integer(token_anchor[0]),token=token))
                        return changed
                    require(driver.state(account)['diagnosticBalances']==[1000,0],'Diagnostic balances not initialized')
                    driver.send('diagnostic-direct-write-denied',token,'moveThenFalse',[H(proxy),H(recipient_address),I(1)],fault='Source witness required')
                    execute('gas-with-two-limited-tokens',1,driver.state(account)['nonce'],expected=True,events=events,change=payment(1,reset=True),recipient_delta=1)
                    diagnostic_op('false-with-actual-outflow','moveThenFalse',3,expected=False,events=[(CORE,'UserOpExecuted')],change=token_payment(3,True))
                    diagnostic_op('false-outflow-over-cap','moveThenFalse',3,fault='Daily limit exceeded')
                    diagnostic_op('nested-gas-no-inherited-witness','forwardGas',1,fault='Nested GAS transfer failed')
                    diagnostic_op('false-outflow-exact-cap','moveThenFalse',2,expected=False,events=[(CORE,'UserOpExecuted')],change=token_payment(2))
                    stage='invalid-balance-observations'
                    def set_mode(label,mode):
                        def changed(state,timestamp):
                            state['diagnosticMode']=mode
                            state['diagnosticRaw'][1]=stored(proxy,2,raw_integer(mode),token=None)
                        driver.send(label,token,'setBalanceMode',[H(proxy),I(mode)],change=changed)
                    driver.send('diagnostic-negative-mode-rejected',token,'setBalanceMode',[H(proxy),I(-1)],fault='Invalid diagnostic balance mode')
                    for mode,label in ((1,'negative'),(2,'bytes'),(3,'boolean'),(4,'null'),(5,'array'),(6,'fault'),(7,'gas')):
                        reason='Invalid token balance' if mode<6 else ('Diagnostic balance query failed' if mode==6 else 'The bounded contract call gas limit has been exhausted.')
                        set_mode('set-balance-'+label,mode)
                        if mode<6:report['balanceQueryVectors'].append(check_balance_observation(chain,token,proxy,mode))
                        execute('pre-balance-'+label,1,driver.state(account)['nonce'],fault=reason)
                        set_mode('reset-balance-'+label,0)
                        diagnostic_op('post-balance-'+label,'moveAndSpoof',1,mode=mode,fault=reason)
                    set_mode('keep-gas-burning-query',7)
                    configure('remove-diagnostic-limit',0,False,token)
                    execute('gas-after-faulting-limit-removal',1,driver.state(account)['nonce'],expected=True,events=events,
                            change=payment(1,reset=True),recipient_delta=1)
                    report['invalidBalancePreAndPostVerified']=True
                    report['faultingTokenLimitRemovalVerified']=True
                    extra_nonce=4
                stage='rolling-window';configure('rolling-limit',GAS//2,True)
                execute('first-rolling-transfer',GAS//4,5+extra_nonce,expected=True,events=events,change=payment(GAS//4,rolling=True),recipient_delta=GAS//4)
                execute('rolling-exact-cap',GAS//4,6+extra_nonce,expected=True,events=events,change=payment(GAS//4,rolling=True),recipient_delta=GAS//4)
                execute('rolling-cap-plus-one',1,7+extra_nonce,fault='Daily limit exceeded')
                fast_forward(86401)
                execute('rolling-window-expiry',GAS//8,7+extra_nonce,expected=True,events=events,change=payment(GAS//8,reset=True,rolling=True),recipient_delta=GAS//8)
                if adversarial:
                    stage='rolling-saturation'
                    for index in range(2,51):
                        execute('rolling-record-'+str(index),1,driver.state(account)['nonce'],expected=True,events=events,
                                change=payment(1,rolling=True),recipient_delta=1)
                    execute('rolling-record-51-rejected',1,driver.state(account)['nonce'],fault='Daily limit history full')
                    fast_forward(86401)
                    execute('rolling-full-expiry-pruned',1,driver.state(account)['nonce'],expected=True,events=events,
                            change=payment(1,rolling=True,reset=True),recipient_delta=1)
                    report['fiftyRecordCapacityVerified']=True
                stage='cleanup'
                def proposal(state,timestamp):state['account'][10]=[hash_le(ZERO),bytes(32),timestamp,timestamp+DAY,state['account'][8]]
                core('remove-hook-propose','proposeHook',[H(ZERO)],events=[(CORE,'HookChangeProposed')],change=proposal)
                fast_forward(86401)
                def removed(state,timestamp):
                    state['account'][6]=None;state['account'][8]+=1;state['account'][9:]=[None]*4
                    state['raw']=[{}]*6;state['config']=None;state['spent']=0
                core('remove-hook-confirm','activateHook',[],events=[(CORE,'HookChanged')],change=removed)
                require(driver.storage(account)==[{}]*6,'Daily cleanup left account-scoped state');readback()
                report.update(networkMagic=chain.magic,accountId=account,otherAccountId=other,finalOperationNonce=driver.state(account)['nonce'],
                    fullNefReadbackMatched=True,manifestReadbackMatched=True,allSixStoragePrefixesCleared=True)
            finally:chain.stop_node();report['ownedNodesStopped']=chain.node is None
        check_runtime_receipt(build,runtime)
        require(all(sha256(p)==report['sourceSha256'][p.name] for p in sources),'Daily harness changed')
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
    parser.add_argument('--adversarial',action='store_true')
    parser.add_argument('--compiler',type=Path);parser.add_argument('--cache',type=Path)
    parser.add_argument('--dotnet',type=Path,default=shutil.which('dotnet'));args=parser.parse_args()
    require(args.dotnet is not None,'A local dotnet runtime is required')
    validate(args.runtime.resolve(),args.dotnet.resolve(),args.artifacts.resolve(),args.build_receipt.resolve(),args.module_receipt.resolve(),args.output.resolve(),args.adversarial,args.compiler,args.cache)
