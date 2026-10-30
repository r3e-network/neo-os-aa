#!/usr/bin/env python3
"""Kernel certificates for the exact helper CFG's parameterized gas bound.

The frontend/source-to-runtime mapping is explicit TCB; finite runtime joins do
not constitute a universal ApplicationEngine refinement proof.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
try:
    from . import gas_trace as trace
except ImportError:
    import gas_trace as trace

HERE = Path(__file__).resolve().parent
MODEL = HERE / 'coq/HelperGasBound.v'
GAS = HERE / 'coq/GasSemantics.v'

def event(e):
    return '(helper_event %d %d %s)' % (e['pc'], e['execution'], 'true' if e['storage'] else 'false')

def events(items):
    return '[' + ';'.join(event(e) for e in items) + ']'

def certificate(model, mutation=None):
    nodes = {}
    for path in model['paths']:
        for e in path['events']: nodes[e['pc']] = e
    original_nodes = {k: dict(v) for k,v in nodes.items()}
    cfg_inputs = trace.bind_artifact()['instructions']
    cfg = {i['offset']: [edge['target'] for edge in i['edges']] for i in cfg_inputs}
    maximum = model['maxExecutionCoefficient']
    storage = 71
    # Control targets are resolved from the bound artifact, not from offsets that a
    # helper edit can silently move: the native-codec calls are the CALLT sites whose
    # token selects serialize/deserialize, and the storage write is the one event the
    # price projection marks as a put.
    def native_site(index):
        return next(i['offset'] for i in cfg_inputs if i['name'] == 'CALLT'
                    and int.from_bytes(bytes.fromhex(i['operandHex']), 'little') == index)
    def storage_site():
        return next(e['pc'] for e in nodes.values() if e['storage'])
    if mutation == 'lower-execution-bound': maximum -= 1
    if mutation == 'omit-native-cpu':
        pc = native_site(3)
        nodes[pc] = dict(nodes[pc], execution=nodes[pc]['execution']-model['fees']['nativeCpu']['serialize'])
    if mutation == 'omit-native-wrapper-opcode':
        pc = native_site(4)
        nodes[pc] = dict(nodes[pc], execution=nodes[pc]['execution']-1)
    if mutation == 'omit-storage-price':
        pc = storage_site()
        nodes[pc] = dict(nodes[pc], storage=False)
    if mutation == 'omit-hash-equal-branch': cfg[13635] = [13637]
    if mutation == 'lower-storage-bound': storage = 70
    actual_cfg = '[' + ';'.join('(gas_node %s [%s])' % (event(nodes[pc]), ';'.join(map(str,cfg[pc]))) for pc in sorted(nodes)) + ']'
    paths = '[' + ';'.join(events(p['events']) for p in model['paths']) + ']'
    successes = '[' + ';'.join(events(p['events']) for p in model['paths'] if p['terminal']=='RET') + ']'
    # These price sums retain independently projected components from source,
    # rather than treating the emitted aggregate as its own oracle.
    prices = '[' + ';'.join('(helper_event %d (%d + %d + %d + %d) %s)' %
        (e['pc'],e['opcode'],e['fixed'],e['native'],e['wrapper'],'true' if e['storage'] else 'false')
        for _,e in sorted(original_nodes.items())) + ']'
    init = [{'pc':i['offset'], 'execution':model['fees']['opcodes'][i['name']], 'storage':False} for i in model['initializer']]
    return '''From Coq Require Import ZArith List Bool Lia.
Require Import GasSemantics HelperGasBound.
Import ListNotations.
Open Scope Z_scope.
Definition actual_cfg : list GasNode := %s.
Definition actual_source_prices : list HelperEvent := %s.
Definition actual_paths : list (list HelperEvent) := %s.
Definition actual_success_paths : list (list HelperEvent) := %s.
Definition actual_initializer : list HelperEvent := %s.
Definition actual_maximum : Z := %d.
Definition actual_initializer_maximum : Z := %d.
Definition actual_helper_bound exec storage factor := actual_maximum * exec + %d * storage * factor.
Definition actual_initialized_bound exec storage factor :=
 (actual_maximum + actual_initializer_maximum) * exec + %d * storage * factor.
Theorem actual_cfg_prices_agree_with_extracted_source :
 map node_event actual_cfg = actual_source_prices.
Proof. vm_compute. reflexivity. Qed.
Theorem actual_cfg_enumeration_complete :
 enumerate_cfg %d actual_cfg 13557 = Some actual_paths.
Proof. vm_compute. reflexivity. Qed.
Theorem actual_path_price_checks : forallb (safe_path actual_maximum) actual_paths = true.
Proof. vm_compute. reflexivity. Qed.
Theorem actual_success_path_price_checks : forallb (safe_path actual_maximum) actual_success_paths = true.
Proof. vm_compute. reflexivity. Qed.
Theorem actual_initialized_path_checks :
 forallb (safe_path (actual_maximum + actual_initializer_maximum))
   (map (fun path => actual_initializer ++ path) actual_paths) = true.
Proof. vm_compute. reflexivity. Qed.
Theorem actual_bound_equals_price_model : forall exec storage factor,
 actual_helper_bound exec storage factor = helper_bound actual_maximum exec storage factor.
Proof. reflexivity. Qed.
Theorem actual_initialized_bound_equals_price_model : forall exec storage factor,
 actual_initialized_bound exec storage factor =
 helper_bound (actual_maximum + actual_initializer_maximum) exec storage factor.
Proof. reflexivity. Qed.
Theorem actual_successful_helper_price_bound : forall Store effects path exec storage factor absent old new,
 In path actual_success_paths -> 0 <= exec -> 0 <= storage -> 0 <= factor -> 0 <= old -> 38 <= new <= 70 ->
 total_charge Store (priced_helper Store effects path exec storage factor absent old new) <= actual_helper_bound exec storage factor.
Proof. intros. rewrite actual_bound_equals_price_model.
 apply successful_path_price_bound; try assumption.
 pose proof actual_success_path_price_checks as P.
 apply forallb_forall with (x:=path) in P; assumption. Qed.
Theorem actual_successful_helper_sufficient_budget : forall Store effects path exec storage factor absent old new budget consumed state,
 In path actual_success_paths -> 0 <= exec -> 0 <= storage -> 0 <= factor -> 0 <= old -> 38 <= new <= 70 ->
 consumed + actual_helper_bound exec storage factor <= budget ->
 metered Store (priced_helper Store effects path exec storage factor absent old new) budget consumed state =
 TraceHalt Store (consumed + total_charge Store (priced_helper Store effects path exec storage factor absent old new))
 (unmetered Store (priced_helper Store effects path exec storage factor absent old new) state).
Proof. intros. apply (sufficient_helper_budget_erases_metering Store effects actual_maximum); try assumption.
 - pose proof actual_success_path_price_checks as P. apply forallb_forall with (x:=path) in P; assumption.
Qed.
Theorem actual_initialized_helper_sufficient_budget : forall Store effects path exec storage factor absent old new budget consumed state,
 In path actual_success_paths -> 0 <= exec -> 0 <= storage -> 0 <= factor -> 0 <= old -> 38 <= new <= 70 ->
 consumed + actual_initialized_bound exec storage factor <= budget ->
 metered Store (priced_helper Store effects (actual_initializer ++ path) exec storage factor absent old new) budget consumed state =
 TraceHalt Store (consumed + total_charge Store (priced_helper Store effects (actual_initializer ++ path) exec storage factor absent old new))
 (unmetered Store (priced_helper Store effects (actual_initializer ++ path) exec storage factor absent old new) state).
Proof. intros. apply (sufficient_helper_budget_erases_metering Store effects (actual_maximum + actual_initializer_maximum)); try assumption.
 - assert (In path actual_paths) as A.
   { unfold actual_success_paths, actual_paths in *. repeat (destruct H as [H|H]; [subst; simpl; tauto|]); contradiction. }
   pose proof actual_initialized_path_checks as P.
   apply forallb_forall with (x:=actual_initializer ++ path) in P; [exact P|].
   apply in_map. exact A.
Qed.
''' % (actual_cfg,prices,paths,successes,events(init),maximum,model['initializerCoefficient'],
        storage,storage,max(len(path['pcs']) for path in model['paths']) + 4)

def declarations(source):
    return re.findall(r'^(?:Definition|Fixpoint|Record|Inductive|Lemma|Theorem)\s+(\w+)', source, re.M)

def command(args, directory, log, required=True):
    result = subprocess.run(args, cwd=directory, capture_output=True, text=True, timeout=600)
    output = result.stdout + result.stderr
    Path(log).write_text(output)
    trace.require(not required or result.returncode == 0, 'Kernel/tool failure: ' + str(log) + '\n' + output[-2000:])
    return result.returncode, output

def run_proofs(directory, runtime_receipts, controls=True):
    directory = Path(directory).resolve(); directory.mkdir(parents=True, exist_ok=True)
    trace.require(not any(directory.iterdir()), 'Proof directory must be empty')
    inputs = [Path(__file__), HERE/'gas_trace.py', HERE/'test_gas_trace.py', MODEL, GAS, HERE/'nef_decode.py', HERE/'verify.py']
    raw = {p:p.read_bytes() for p in inputs}
    hashes = {str(p):trace.digest(b) for p,b in raw.items()}
    model = trace.derive(trace.bind_artifact(), trace.extract_fees(trace.pinned_sources()))
    joined = trace.crosscheck_runtime(model, runtime_receipts)
    (directory/'projection.json').write_text(json.dumps(model,indent=2)+'\n')
    coqc,coqchk = shutil.which('coqc'),shutil.which('coqchk')
    trace.require(coqc and coqchk,'Real coqc/coqchk required')
    sources = {'GasSemantics':raw[GAS].decode(), 'HelperGasBound':raw[MODEL].decode(), 'HelperGasArtifact':certificate(model)}
    names={}
    for name,text in sources.items():
        trace.require(re.search(r'\b(?:Admitted|Axiom|Parameter|admit|Abort)\b',text) is None,'Unsupported proof declaration')
        (directory/(name+'.v')).write_text(text)
        command([coqc,'-q',name+'.v'],directory,directory/(name+'.log'))
        names[name]=declarations(text)
    command([coqchk,'-silent',*sources],directory,directory/'coqchk.log')
    audit='Require Import '+ ' '.join(sources)+'.\n'+'\n'.join('Print Assumptions '+m+'.'+n+'.' for m,items in names.items() for n in items)+'\n'
    (directory/'Assumptions.v').write_text(audit)
    _,audit_result=command([coqc,'-q','Assumptions.v'],directory,directory/'assumptions.log')
    count=sum(map(len,names.values()))
    trace.require(audit_result.count('Closed under the global context')==count and 'Axioms:' not in audit_result,'Assumption audit failed')
    mutants=[]
    if controls:
        for mutation in ['lower-execution-bound','omit-native-cpu','omit-native-wrapper-opcode','omit-storage-price','omit-hash-equal-branch','lower-storage-bound']:
            case=directory/mutation; case.mkdir()
            for module in ['GasSemantics','HelperGasBound']:
                for suffix in ['.v','.vo']: shutil.copyfile(directory/(module+suffix),case/(module+suffix))
            mutated=certificate(model,mutation)
            defs=mutated.split('Theorem actual_cfg_prices_agree_with_extracted_source')[0]
            (case/'Definitions.v').write_text(defs)
            command([coqc,'-q','Definitions.v'],case,case/'definitions.log')
            (case/'HelperGasArtifact.v').write_text(mutated)
            rc,output=command([coqc,'-q','HelperGasArtifact.v'],case,case/'rejection.log',False)
            trace.require(rc!=0 and 'Error:' in output and 'Syntax error' not in output,'Semantic price/CFG control escaped: '+mutation)
            mutants.append(dict(name=mutation,definitionsCompiled=True,certificateRejected=True))
    trace.require(all(trace.digest(p.read_bytes())==trace.digest(data) for p,data in raw.items()),'Proof input drift')
    trace.require(trace.derive(trace.bind_artifact(),trace.extract_fees(trace.pinned_sources()))==model,'Pricing/artifact drift')
    trace.require(all(trace.digest(Path(j['path']).read_bytes())==j['sha256'] for j in joined),'Runtime receipt drift')
    return dict(schema='neoos-aa-helper-gas-bound/v1',kernelChecked=True,scope='exact-CFG-parameterized-helper-price-bound',
        applicationEngineVerified=False,fullImplementationVerified=False,sourceFrontendVerified=False,
        sourcePricingPinned=True,modelPriceBoundProved=True,actualRuntimeCrossChecked=True,
        runtimeObservationSource='supplied-runtime-receipts',runtimeReexecuted=False,
        checkerExecutesApplicationEngine=False,
        runtimeReceiptAuthenticityVerified=False,
        artifacts=model['artifact'],sourceCommit=trace.COMMIT,sourceHashes=trace.SOURCES,
        maximumExecutionCoefficient=model['maxExecutionCoefficient'],initializerCoefficient=model['initializerCoefficient'],maximumPutBytes=71,
        domain=dict(newSerializedLedgerLength=[38,70],existingLength='nonnegative; typed accepted wire separately >=38 and <=65535',
                    executionPicoFactor='nonnegative BigInteger',storagePrice='nonnegative; actual uint32',feeFactor=model['fees']['factor'],
                    semanticPreconditions='successful helper/codec/callflags/context/activation/no-overflow/resource domain separately required'),
        paths=[dict(absent=p['absent'],reset=p['reset'],terminal=p['terminal'],instructionCount=len(p['pcs']),executionCoefficient=p['executionCoefficient']) for p in model['paths']],
        closedDeclarations=names,closedAssumptionCount=count,semanticControls=mutants,runtimeReceiptJoins=joined,
        inputSha256=hashes,certificateSha256=trace.digest(sources['HelperGasArtifact'].encode()),outputDirectory=str(directory),
        unproved=['C# and Python frontend correctness','actual VM pricing/scheduling universal correspondence','runtime native wrapper/source linkage universal proof',
                  'full helper semantic/domain/resource safety','public sponsored caller fees/callbacks/block persistence'])

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--runtime-receipts',type=Path,required=True)
    parser.add_argument('--json-report',type=Path,required=True)
    args=parser.parse_args(argv)
    receipt=dict(scope='exact-CFG-parameterized-helper-price-bound',kernelChecked=False,applicationEngineVerified=False,fullImplementationVerified=False)
    args.json_report.parent.mkdir(parents=True,exist_ok=True); args.json_report.write_text(json.dumps(receipt)+'\n')
    try:
        receipt=run_proofs(args.output_dir,args.runtime_receipts)
        args.json_report.write_text(json.dumps(receipt,indent=2)+'\n');return 0
    except Exception as error:
        receipt['failure']=type(error).__name__+': '+str(error)
        args.json_report.write_text(json.dumps(receipt,indent=2)+'\n');return 1

if __name__=='__main__': raise SystemExit(main())
