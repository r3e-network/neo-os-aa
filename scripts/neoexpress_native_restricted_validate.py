#!/usr/bin/env python3
"""Restricted-token native policy, indirect effects and raw-storage rollback locally."""
import argparse
import base64
import datetime
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from neoexpress_validate import Chain, RawKey, H, B, I, S, A, ZERO, hash_le
from neoexpress_activation_validate import ACTIVATION_KEY, make_runner, require
from neoexpress_native_service_validate import CORE, check_native, persist
from neoexpress_native_proxy_validate import GAS, GAS_TOKEN, DEADLINE, proxy_address, transfer
from neoexpress_native_modules_validate import nef_from_rpc, check_module_build, CONTEXT
from neoexpress_native_session_validate import SessionTransactions, NULL
from neoexpress_native_daily_validate import storage_prefix, stored, raw_integer, check_balance_observation
from neoexpress_reproducible_build import check_runtime_receipt, sha256

DAY=86400000

class RestrictedTransactions(SessionTransactions):
    def storage(self,account):
        return [storage_prefix(self.chain,self.verifier,bytes([p])+hash_le(account)) for p in (1,2)]

    def state(self,account):
        # The shared transaction driver requires a spent field; this hook has no counter.
        result={'account':self.value(CORE,'getAccount',[H(account)]),'nonce':self.value(CORE,'getNonce',[H(account),I(0)]),
                'pending':self.value(CORE,'getPendingModuleCall',[H(account),S('hook')]),'raw':self.storage(account),
                'spent':0,'balance':self.value(GAS_TOKEN,'balanceOf',[H(proxy_address(account))])}
        addresses=[proxy_address(account)]+([self.recipient] if account==self.account else [])
        values=[storage_prefix(self.chain,self.diagnostic_token,bytes([prefix])+hash_le(address)) for address in addresses for prefix in (1,2)]
        def number(rows):
            require(len(rows)<=1,'Unexpected diagnostic storage suffix')
            return int.from_bytes(base64.b64decode(next(iter(rows.values()),'')),'little',signed=True)
        result.update(tokenRaw=values,tokenBalances=[number(values[i]) for i in range(0,len(values),2)],
                      tokenModes=[number(values[i]) for i in range(1,len(values),2)])
        return result


def change_mode(state,account,mode):
    state['tokenModes'][0]=mode;state['tokenRaw'][1]=stored(proxy_address(account),2,raw_integer(mode),token=None)


def change_move(state,account,recipient,amount,outward,mode):
    delta=-amount if outward else amount
    state['nonce']+=1;state['tokenBalances'][0]+=delta;state['tokenBalances'][1]-=delta
    for index,address in [(0,proxy_address(account)),(1,recipient)]:
        state['tokenRaw'][index*2]=stored(address,1,raw_integer(state['tokenBalances'][index]),token=None)
    index=0 if outward else 1;address=proxy_address(account) if outward else recipient
    state['tokenModes'][index]=mode;state['tokenRaw'][index*2+1]=stored(address,2,raw_integer(mode),token=None)


def build_diagnostic(compiler,cache,root):
    source=Path(__file__).resolve().parent.parent/'tests/fixtures/restricted-outflow'
    receipts=[];retained=None
    for index in (1,2):
        project=root/('diagnostic-'+str(index));shutil.copytree(source,project)
        shutil.copyfile(Path(__file__).resolve().parent.parent/'contracts/Directory.Build.props',project/'Directory.Build.props')
        config=ET.Element('configuration');feeds=ET.SubElement(config,'packageSources');ET.SubElement(feeds,'clear')
        ET.SubElement(feeds,'add',key='offline',value=str(cache));ET.ElementTree(config).write(project/'NuGet.Config')
        output=project/'out'
        result=subprocess.run([str(compiler),str(project/'RestrictedOutflow.csproj'),'-o',str(output)],capture_output=True,text=True,timeout=180)
        require(result.returncode==0,'Diagnostic compilation failed: '+result.stdout[-1500:]+result.stderr[-500:])
        pins={p.name:sha256(p) for p in output.iterdir() if p.suffix in ('.nef','.json')}
        require(set(pins)=={n+s for n in ('RestrictedOutflowToken','RestrictedOutflowRouter') for s in ('.nef','.manifest.json')},'Unexpected diagnostic artifacts')
        receipts.append(pins)
        if retained is None:retained=output
    require(receipts[0]==receipts[1],'Diagnostic builds differ')
    return retained,receipts


def validate(runtime,dotnet,artifacts,build_receipt,module_receipt,output,compiler,cache):
    report={'schema':'smartaccount-native-restricted-private/v1','status':'RUNNING','publicNetworksTouched':False,
            'scope':'Native restricted-token direct and indirect policy, hostile queries and rollback; test-only router delegation, not arbitrary-token honesty.',
            'spentAmountMeaning':'Always zero: shared-driver compatibility field, not a spending counter.',
            'transactions':[],'executions':[],'rejectedWitnesses':[],'balanceQueryVectors':[],'ownedNodesStopped':False}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report)+'\n');stage='provenance'
    try:
        sources=[Path(__file__),*[Path(__file__).with_name(n) for n in ('neoexpress_validate.py','neoexpress_activation_validate.py',
            'neoexpress_native_service_validate.py','neoexpress_native_proxy_validate.py','neoexpress_native_configuration_validate.py',
            'neoexpress_native_recovery_validate.py','neoexpress_native_modules_validate.py','neoexpress_native_session_validate.py',
            'neoexpress_native_daily_validate.py','neoexpress_reproducible_build.py','native_module_profile.py','build_native_modules.py')]]
        sources.extend(sorted((Path(__file__).resolve().parent.parent/'tests/fixtures/restricted-outflow').glob('*')))
        require(len(sources)==16,'Exactly three diagnostic source/project files required')
        report.update(sourceSha256={p.name:sha256(p) for p in sources},sourceBuildReceiptSha256=sha256(build_receipt),moduleBuildReceiptSha256=sha256(module_receipt))
        build=json.loads(build_receipt.read_text());check_runtime_receipt(build,runtime)
        compiled=json.loads(module_receipt.read_text());artifact_pins=check_module_build(compiled,artifacts,Path(__file__).resolve().parent.parent/'contracts')
        with tempfile.TemporaryDirectory(prefix='smartaccount-native-restricted-') as scratch:
            root=Path(scratch);chain=Chain(make_runner(runtime,dotnet,root),root)
            stage='diagnostic-build';diagnostic,builds=build_diagnostic(compiler,cache,root)
            report['diagnosticBuild']={'builds':builds,'compilerSha256':sha256(compiler),
                'frameworkArchiveSha256':sha256(cache/'neo.smartcontract.framework/3.10.2-ci00384/neo.smartcontract.framework.3.10.2-ci00384.nupkg')}
            require(report['diagnosticBuild']['compilerSha256']==compiled['compilerLauncherSha256'] and
                    report['diagnosticBuild']['frameworkArchiveSha256']==compiled['frameworkArchiveSha256'],'Diagnostic toolchain mismatch')
            try:
                stage='setup';chain.nx('create','-o',str(chain.file));config=json.loads(chain.file.read_text())
                config.setdefault('settings',{}).update({ACTIVATION_KEY:'0','chain.SecondsPerBlock':'1'})
                for field in ('rpc-port','tcp-port'):
                    with socket.socket() as sock:sock.bind(('127.0.0.1',0));config['consensus-nodes'][0][field]=sock.getsockname()[1]
                chain.file.write_text(json.dumps(config));chain.magic=config['magic'];chain.rpc_port=config['consensus-nodes'][0]['rpc-port']
                for name in ('owner','recipient'):chain.nx('wallet','create',name)
                chain.nx('transfer','2000','GAS','genesis','owner')
                owner=RawKey(root,'private-owner',chain.wallet_private_key('owner'));recipient=RawKey(root,'private-recipient',chain.wallet_private_key('recipient'))
                owner_address='0x'+owner.script_hash[::-1].hex();recipient_address='0x'+recipient.script_hash[::-1].hex()
                deployed=[]
                def deploy(nef,payer,data):
                    _,text=chain.nx('contract','deploy',str(nef),payer,'-j','-d','0x'+hash_le(data).hex())
                    result=chain.json_from(text);address=result['contract-hash'];deployed.append((address,nef))
                    report.setdefault('deployedContracts',[]).append({'contractHash':address,'deploymentTransaction':result['tx-hash'],
                        'nefSha256':sha256(nef),'manifestSha256':sha256(nef.with_suffix('.manifest.json'))})
                    return address
                hook=deploy(artifacts/'TokenRestrictedHook.nef','genesis',CORE)
                accounts=[]
                for salt in (bytes([6])*32,bytes([7])*32):
                    account=persist(chain,report,'register-'+str(len(accounts)),'registerAccount',[H(owner_address),B(salt),H(ZERO),H(hook),H(ZERO)],'AccountCreated')
                    accounts.append('0x'+account[::-1].hex())
                account,other=accounts;proxy=proxy_address(account)
                token=deploy(diagnostic/'RestrictedOutflowToken.nef','owner',proxy)
                router=deploy(diagnostic/'RestrictedOutflowRouter.nef','owner',token)
                fund=chain.invoke_file(GAS_TOKEN,'transfer',[H(owner_address),H(proxy),I(2*GAS),None]);chain.nx('contract','invoke',str(fund),'owner','-j')
                chain.start_node();check_native(chain.rpc('getcontractstate',[CORE]));require(chain.rpc('getversion',[])['protocol']['network']==chain.magic,'Wrong private network')
                def readback():
                    for address,nef in deployed:
                        state=chain.rpc('getcontractstate',[address]);require(nef_from_rpc(state['nef'])==nef.read_bytes(),'NEF readback mismatch')
                        require(state['manifest']==json.loads(nef.with_suffix('.manifest.json').read_text()),'Manifest readback mismatch')
                readback();driver=RestrictedTransactions(chain,account,other,hook,owner,recipient_address,report);driver.diagnostic_token=token
                initial=driver.state(account);require(initial['raw']==[{},{}] and initial['balance']==2*GAS and initial['tokenBalances']==[1000,0],'Unexpected initial restricted state')
                def seed(state,timestamp):
                    state['tokenBalances'][1]=1000;state['tokenRaw'][2]=stored(recipient_address,1,raw_integer(1000),token=None)
                    state['tokenRaw'][3]=stored(recipient_address,2,b'',token=None)
                driver.send('configure-diagnostic-router',token,'configureRouter',[H(router),H(recipient_address)],change=seed)
                def delegation():
                    for contract,prefix,value in [(token,b'\xf0',hash_le(owner_address)),(token,b'\xf1',hash_le(router)),(router,b'\xf0',hash_le(token))]:
                        require(storage_prefix(chain,contract,prefix)=={base64.b64encode(prefix).decode():base64.b64encode(value).decode()},'Diagnostic delegation changed')
                delegation()
                def core(label,method,args,**kw):return driver.send(label,CORE,method,[H(account),*args],**kw)
                def wait_delay():chain.stop_node();chain.nx('fastfwd','1','-t','86401');chain.start_node()
                def configure(label,restricted,value,fault=None):
                    args=[H(restricted),{'type':'Boolean','value':value}]
                    def proposed(state,timestamp):
                        binding=state['account'][6];state['pending']=[1,hash_le(account),1,binding,binding,b'setRestrictedToken',
                            [hash_le(account),hash_le(restricted),value],timestamp,timestamp+DAY,state['account'][8]]
                    core(label+'-propose','callHook',[S('setRestrictedToken'),A(*args)],expected=False,change=proposed)
                    core(label+'-immature','callHook',[S('setRestrictedToken'),A(*args)],fault='immature, changed or stale')
                    wait_delay()
                    if fault:
                        core(label+'-confirm','callHook',[S('setRestrictedToken'),A(*args)],fault=fault)
                        def cancel(state,timestamp):state['pending']=None
                        core(label+'-cancel','cancelModuleCall',[S('hook')],change=cancel)
                    else:
                        def confirmed(state,timestamp):
                            state['account'][8]+=1;state['pending']=None
                            if value:state['raw'][0].update(stored(account,1,b'\x01',token=restricted))
                            else:
                                for index in (0,1):state['raw'][index].pop(next(iter(stored(account,index+1,b'',token=restricted))),None)
                        core(label+'-confirm','callHook',[S('setRestrictedToken'),A(*args)],change=confirmed)
                def execute(label,operation,**kw):return core(label,'executeUserOp',[operation],proxy=True,**kw)
                def gas(label,amount=1,**kw):return execute(label,transfer(proxy,recipient_address,driver.state(account)['nonce'],amount),**kw)
                def gas_change(state,timestamp):state['nonce']+=1;state['balance']-=1
                events=[(GAS_TOKEN,'Transfer'),(CORE,'UserOpExecuted')]
                def routed(label,amount=1,mode=0,result=True,outward=True,**kw):
                    source,dest=(proxy,recipient_address) if outward else (recipient_address,proxy)
                    op=A(H(router),S('move'),A(H(source),H(dest),I(amount),I(mode),{'type':'Boolean','value':result}),I(driver.state(account)['nonce']),I(DEADLINE),B(b''))
                    return execute(label,op,witness_target=router,**kw)
                stage='phase-and-configuration'
                for method,args in [('setRestrictedToken',[H(account),H(GAS_TOKEN),{'type':'Boolean','value':True}]),
                    ('preExecute',[H(account),transfer(proxy,recipient_address,0)]),('postExecute',[H(account),transfer(proxy,recipient_address,0),NULL]),('clearAccount',[H(account)])]:
                    driver.send('direct-'+method,hook,method,args,fault=CONTEXT)
                configure('invalid-token',ZERO,True,fault='Invalid restricted token')
                configure('restrict-diagnostic',token,True)
                stage='direct-and-indirect-effects'
                op=A(H(token),S('balanceOf'),A(H(proxy)),I(0),I(DEADLINE),B(b''))
                execute('direct-restricted-read',op,witness_target=token,fault='Interaction with restricted token is forbidden')
                driver.send('diagnostic-undelegated-move',token,'moveFromRouter',[H(proxy),H(recipient_address),I(1),I(0)],fault='Diagnostic router required')
                gas('unrestricted-gas-transfer',expected=True,events=events,change=gas_change,recipient_delta=1)
                for result in (True,False):routed('indirect-outflow-'+str(result).lower(),result=result,fault='Restricted token outflow (incl. via intermediary) is forbidden')
                routed('zero-net-false-completes',amount=0,result=False,expected=False,events=[(CORE,'UserOpExecuted')],
                       change=lambda state,t:change_move(state,account,recipient_address,0,True,0))
                routed('indirect-inflow-allowed',amount=3,outward=False,expected=True,events=[(CORE,'UserOpExecuted')],
                       change=lambda state,t:change_move(state,account,recipient_address,3,False,0))
                stage='invalid-query-rollback'
                def set_mode(label,mode):driver.send(label,token,'setBalanceMode',[H(proxy),I(mode)],change=lambda state,t:change_mode(state,account,mode))
                for mode,label in ((1,'negative'),(2,'bytes'),(3,'boolean'),(4,'null'),(5,'array'),(6,'fault'),(7,'gas')):
                    reason='Invalid restricted token balance' if mode<6 else ('Diagnostic balance query failed' if mode==6 else 'The bounded contract call gas limit has been exhausted.')
                    set_mode('set-balance-'+label,mode)
                    if mode<6:report['balanceQueryVectors'].append(check_balance_observation(chain,token,proxy,mode))
                    gas('pre-balance-'+label,fault=reason)
                    set_mode('reset-balance-'+label,0)
                    routed('post-balance-'+label,mode=mode,result=False,fault=reason)
                set_mode('keep-gas-burning-query',7)
                configure('remove-faulting-restriction',token,False)
                gas('gas-after-faulting-token-removal',expected=True,events=events,change=gas_change,recipient_delta=1)
                set_mode('restore-honest-query',0)
                routed('outflow-after-removal',expected=True,events=[(CORE,'UserOpExecuted')],change=lambda state,t:change_move(state,account,recipient_address,1,True,0))
                configure('restrict-gas',GAS_TOKEN,True)
                gas('direct-restricted-gas-transfer',fault='Interaction with restricted token is forbidden')
                configure('restore-diagnostic-restriction',token,True)
                routed('two-token-no-outflow',amount=0,expected=True,events=[(CORE,'UserOpExecuted')],change=lambda state,t:change_move(state,account,recipient_address,0,True,0))
                stage='cleanup'
                def proposal(state,timestamp):state['account'][10]=[hash_le(ZERO),bytes(32),timestamp,timestamp+DAY,state['account'][8]]
                core('remove-hook-propose','proposeHook',[H(ZERO)],events=[(CORE,'HookChangeProposed')],change=proposal)
                wait_delay()
                def removed(state,timestamp):state['account'][6]=None;state['account'][8]+=1;state['account'][9:]=[None]*4;state['raw']=[{},{}]
                core('remove-hook-confirm','activateHook',[],events=[(CORE,'HookChanged')],change=removed)
                require(driver.storage(account)==[{},{}],'Restricted cleanup left account state');readback();delegation()
                report.update(networkMagic=chain.magic,accountId=account,otherAccountId=other,finalOperationNonce=driver.state(account)['nonce'],
                    fullNefReadbackMatched=True,manifestReadbackMatched=True,diagnosticDelegationReadbackMatched=True,allTwoStoragePrefixesCleared=True,
                    indirectOutflowRollbackVerified=True,invalidBalancePreAndPostVerified=True,faultingTokenRemovalVerified=True)
            finally:chain.stop_node();report['ownedNodesStopped']=chain.node is None
        check_runtime_receipt(build,runtime)
        require(all(sha256(p)==report['sourceSha256'][p.name] for p in sources),'Restricted harness changed')
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
    for name in ('runtime','artifacts','build-receipt','module-receipt','output','compiler','cache'):parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--dotnet',type=Path,default=shutil.which('dotnet'));args=parser.parse_args()
    require(args.dotnet is not None,'A local dotnet runtime is required')
    validate(args.runtime.resolve(),args.dotnet.resolve(),args.artifacts.resolve(),args.build_receipt.resolve(),args.module_receipt.resolve(),args.output.resolve(),args.compiler,args.cache)
