"""v4 hook argument view: byte identity binding plus the retired certificate record.

The byte-level certificate this module used to emit covered
`BuildHookOperationParams(UserOperation, object[])`, the private six-field tuple
builder every v3 hook callback received. Protocol v4 deleted that constructor: a
hook is now a module callback reached through `CallHookPreCheck` /
`CallHookPostCheck`, and every callback receives
`BuildCanonicalOperationView(operation)` — the 13 protocol fields with the two
array fields deep-copied. The view calls `CloneOperationArguments`, so the old
certificate's single-region source/VM theorem does not carry over, and no Coq
artefact models the v4 callbacks yet.

What remains here is honest and tool-free: the helper's complete byte region is
bound to the fresh inventory, its opcode vocabulary is pinned, and the typed
source projection is produced by `hook_params_source`. `run_proofs` refuses to
emit a receipt instead of presenting the retired certificate as current.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
try:
    from . import hook_params_source, nef_decode
except ImportError:
    import hook_params_source, nef_decode

ROOT = Path(__file__).resolve().parent

RETIRED = ('The private hook tuple certificate covered the retired BuildHookOperationParams '
           'constructor. The v4 hook view (BuildCanonicalOperationView) calls '
           'CloneOperationArguments and has no byte-level certificate; only the source '
           'projection is maintained.')

# Every opcode the canonical-view helper may contain: PUSH0..PUSH13, CALL_L (the
# argument clone), INITSLOT, LDARG0, PACK, PICKITEM and RET.
HELPER_OPCODES = {16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 34, 53, 64, 87, 120, 192, 206}


def require(ok, message):
    if not ok: raise ValueError(message)


def sha(raw): return hashlib.sha256(raw).hexdigest()


def bind_method(inventory):
    snapshots = {name:Path(name).read_bytes() for name in inventory['inputs']}
    require(all(sha(snapshots[name]) == expected for name,expected in inventory['inputs'].items()), 'Inventory input drift')
    nef_names = [n for n,h in inventory['inputs'].items() if n.endswith('SmartAccount.nef') and h == inventory['nef']['sha256']]
    manifest_names = [n for n,h in inventory['inputs'].items() if n.endswith('SmartAccount.manifest.json') and h == inventory['manifest']['sha256']]
    require(len(nef_names) == len(manifest_names) == 1, 'Ambiguous artifact inputs')
    raw = snapshots[nef_names[0]]
    require(sha(raw) == inventory['nef']['sha256'], 'Actual NEF container identity mismatch')
    spec = importlib.util.spec_from_file_location('hook_nef_binding', ROOT/'verify.py')
    gate = importlib.util.module_from_spec(spec);spec.loader.exec_module(gate)
    decoded = gate.decode_nef(raw); script = decoded['script']
    require(script.hex() == inventory['nef']['scriptHex'] and sha(script) == inventory['nef']['scriptSha256'], 'Actual script differs')
    require(json.loads(snapshots[manifest_names[0]])['abi']['methods'] == inventory['manifest']['methods'], 'Actual manifest differs')
    instructions = nef_decode.decode_script(script,len(decoded['tokens']))
    require(len(instructions)==len(inventory['nef']['instructions']) and
            all(all(record.get(k)==v for k,v in actual.items()) for actual,record in zip(instructions,inventory['nef']['instructions'])),
            'Actual decoded instructions differ')
    require(inventory['sourceMap']['exactByteMatch'] is True and inventory['sourceMap']['exactManifestMatch'] is True,
            'Source rebuild correspondence unavailable')
    projection = hook_params_source.project_method(inventory)
    matches = [m for m in inventory['sourceMap']['debug']['methods'] if m['id'] == projection['displayName']]
    require(len(matches)==1 and 'abi' not in matches[0], 'Canonical view source/debug binding mismatch')
    start,last=map(int,matches[0]['range'].split('-'));end=last+1
    region=[i for i in instructions if start<=i['offset']<end]
    require(region and region[0]['offset']==start and region[-1]['offset']+region[-1]['size']==end and region[-1]['opcode']==64,
            'Complete helper boundary unavailable')
    require(all(i['opcode'] in HELPER_OPCODES for i in region),
            'Unsupported helper opcode or effect dependency')
    return dict(start=start,end=end,bytes=list(script[start:end]),instructionCount=len(region),
                opcodes=sorted({i['opcode'] for i in region}),
                methodSha256=sha(script[start:end]),nefSha256=sha(raw),scriptSha256=sha(script),projection=projection)


def run_proofs(inventory, output_dir):
    raise ValueError(RETIRED)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory',type=Path,required=True);parser.add_argument('--output-dir',type=Path,required=True)
    parser.add_argument('--json-report',type=Path,required=True);args=parser.parse_args()
    failure=dict(schema='neoos-sa-hook-params-refinement/v1',scope='private-hook-params-reference-refinement',kernelChecked=False,
                 referenceRefinementVerified=False,fullImplementationVerified=False,error='Verification has not completed')
    args.json_report.parent.mkdir(parents=True,exist_ok=True);args.json_report.write_text(json.dumps(failure,indent=2)+'\n')
    try:
        raw=args.inventory.read_bytes();run_proofs(json.loads(raw),args.output_dir)
        require(args.inventory.read_bytes()==raw,'Inventory drift during proof');return 0
    except Exception as exc:
        failure['error']=str(exc);args.json_report.write_text(json.dumps(failure,indent=2)+'\n');print(str(exc),file=sys.stderr);return 1


if __name__=='__main__': sys.exit(main())
