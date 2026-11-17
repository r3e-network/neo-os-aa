#!/usr/bin/env python3
"""Kernel-check numeric reference semantics, keeping VM correspondence open."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
COMMIT = '004cd6070a940405818d9357638277dd44407e2e'
SOURCE_HASHES = {
    'StackItem': '3f80a40ab7b98352a92788da018c1ff168a7251340b1410661f7bcbfeaadff95',
    'ByteString': '1f06948358fcb638bffd14429a3d0ea50916da88c68c2de8933dea734aec0f52',
    'Buffer': 'ca517919538c03e134c1c53b9ab6394ab0dab59738eab6352c15df97c43ea755',
    'Integer': 'cb8c7bf8eed392c59b0bf59e281fd8c39b1fa0ef3894fa86e88fa3e0e90a137c',
    'Boolean': '5cdcf7547ff3b1320ce3accdb867164d044a71d984e48ff066dd6360f66045c9',
    'Null': '359214cd37f9624d49131dd4b5a8596b5cf11023cf815248d7a803bf8d68c41a',
    'PrimitiveType': 'ba8e9cb00fbcedbe5ce67bb9b11e59e59c6cff9e676c08e17d611ca0469fae37',
    'Array': '6a100285b620ed1fca6eac4ebd91abecab5ddfa6b84ab1d65feaf50e463d6cf4',
    'Struct': '12cb52e04fe9aba281798d1997ec347c6bea789f053e7dc4b8ec017fffdf8eba',
    'Map': '40b8c32f1982850904121089c953365836431c1c969091d655902849c15a7412',
    'CompoundType': '045876c665f1c541856d2941862faf945bae327275593dc558f998c4da170f60',
    'Pointer': '697b01626ed7615eb52445e465f188600c65afa7c83e8534935baf090dd2413c',
    'InteropInterface': '8356efa9fea907b8d140f3d57858898d03e11aa01575e8708f56be4342bb9b94',
}
MODULES = ('IntegerSemantics.v', 'NumericCoercions.v')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def reference_signed_le(payload):
    """Independent host vector oracle, not the Coq algorithm or a proof."""
    require(isinstance(payload, bytes) and len(payload) <= 32, 'Payload must be <=32 physical bytes')
    return int.from_bytes(payload, 'little', signed=True)


def source_evidence(cache=None):
    cache = Path(cache) if cache else Path(tempfile.gettempdir()) / 'aa-pinned-neovm-numeric-004cd607'
    cache.mkdir(parents=True, exist_ok=True)
    evidence = {}
    for name, expected in SOURCE_HASHES.items():
        url = f'https://raw.githubusercontent.com/neo-project/neo-vm/{COMMIT}/src/Neo.VM/Types/{name}.cs'
        target = cache / (name + '.cs')
        if not target.exists():
            with urllib.request.urlopen(url, timeout=30) as response:
                data = response.read()
            require(hashlib.sha256(data).hexdigest() == expected, 'Pinned source download mismatch: ' + name)
            target.write_bytes(data)
        require(digest(target) == expected, 'Pinned source cache mismatch: ' + name)
        evidence[name] = dict(path=str(target.resolve()), sha256=expected, url=url)
    return evidence


def command(arguments, directory, log, success=True):
    # coqchk on IntegerSemantics+NumericCoercions measured ~86s wall on a
    # loaded host (2026-10-15); 60s caused spurious gate failures. Match the
    # 600s budget used by method_proofs.py kernel commands.
    result = subprocess.run(arguments, cwd=directory, capture_output=True, text=True, timeout=600)
    output = result.stdout + result.stderr
    Path(log).write_text(output)
    if success:
        require(result.returncode == 0, 'Kernel command failed: ' + ' '.join(arguments) + '\n' + output[-2500:])
    return result.returncode, output


def declarations(source):
    return re.findall(r'^(?:Lemma|Theorem|Example)\s+(\w+)\s*:', source, re.MULTILINE)


def setup(output_dir):
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    coqc, coqchk = shutil.which('coqc'), shutil.which('coqchk')
    require(coqc and coqchk, 'coqc and coqchk are required')
    hashes, names = {}, []
    for module in MODULES:
        source = ROOT / 'coq' / module
        raw = source.read_bytes()
        text = raw.decode('utf-8')
        require(not re.search(r'\b(?:Admitted|admit|Axiom|Parameter)\b', text), 'Unexplained axiom or admitted declaration')
        declared = declarations(text)
        require(set(re.findall(r'^Print Assumptions (\w+)\.', text, re.MULTILINE)) == set(declared),
                'Every declaration must have an assumption check')
        names.extend(declared)
        hashes[str(source.resolve())] = hashlib.sha256(raw).hexdigest()
        (directory / module).write_bytes(raw)
        _, output = command([coqc, '-q', module], directory, directory / (module + '.log'))
        require(output.count('Closed under the global context') == len(declared), 'Unexpected assumptions in kernel output')
    return directory, coqc, coqchk, hashes, names


def run_model_proofs(output_dir, cache=None):
    tool_hash = digest(__file__)
    sources = source_evidence(cache)
    directory, coqc, coqchk, hashes, names = setup(output_dir)
    command([coqchk, '-silent', 'IntegerSemantics', 'NumericCoercions'], directory, directory / 'coqchk.log')
    _, version = command([coqc, '--version'], directory, directory / 'coqc-version.log')
    require(all(digest(path) == expected for path, expected in hashes.items()), 'Model changed during proof')
    require(digest(__file__) == tool_hash, 'Proof runner changed during proof')
    require(all(digest(item['path']) == item['sha256'] for item in sources.values()), 'Pinned source changed during proof')
    return {
        'schema': 'neoos-aa-numeric-coercion-proof/v1', 'scope': 'numeric-coercions',
        'kernelChecked': True, 'vmCorrespondenceProven': False, 'fullImplementationVerified': False,
        'closedDeclarations': names, 'modelSha256': hashes, 'proverSha256': tool_hash,
        'sourceCommit': COMMIT, 'pinnedSource': sources, 'toolVersion': version.splitlines()[0],
        'toolSha256': {'coqc': digest(Path(coqc).resolve()), 'coqchk': digest(Path(coqchk).resolve())},
        'preconditions': ['Built-in NeoVM value tags, physical payload bytes in 0..255',
            'NInteger denotes an admissible signed-256 Integer object; unrepresentable abstract constructors reject',
            'ByteString GetInteger accepts at most 32 payload bytes; no canonical-encoding requirement'],
        'unproved': ['Neo.VM.dll / .NET BigInteger implements this reference decoding/coercion model',
            'NumericValue projection to existing ArithmeticVm.Value or reference heap',
            'Existing Integer-tag actual-region certificate is not widened by this standalone model',
            'ABI/caller admission, resource/gas bounds, heap mutation and all remaining helper behavior'],
        'publicNetworkWritesPerformed': False,
    }


MUTATIONS = {
    'unsigned-sign': ('Z.of_nat b - (if (128 <=? b)%nat then 256 else 0)', 'Z.of_nat b',
                      'get_integer (NByteString [128%nat]) = Some (-128)'),
    'big-endian': ('Z.of_nat b + 256 * signed_le rest', '256 * Z.of_nat b + signed_le rest',
                   'get_integer (NByteString [1%nat;0%nat]) = Some 1'),
    'oversized-33': ('(length bytes <=? 32)%nat && valid_bytesb bytes',
                    '(length bytes <=? 33)%nat && valid_bytesb bytes',
                    'byte_string_integer (repeat 0%nat 33) = None'),
    'boolean-inverted': ('Some (if b then 1 else 0)', 'Some (if b then 0 else 1)',
                        'get_integer (NBoolean true) = Some 1'),
    'buffer-coercion': ('| NBuffer _ => None', '| NBuffer bytes => byte_string_integer bytes',
                       'get_integer (NBuffer []) = None'),
    'null-zero': ('| NNull => None', '| NNull => Some 0', 'get_integer NNull = None'),
    'noncanonical-rejected': ('(length bytes <=? 32)%nat && valid_bytesb bytes',
                             '(length bytes <=? 32)%nat && valid_bytesb bytes && (length bytes <=? 1)%nat',
                             'get_integer (NByteString [255%nat;255%nat]) = Some (-1)'),
    'sign-extension-zero': ('if (128 <=? last bytes 0)%nat then 255 else 0', '0%nat',
                            'signed_le ([255%nat] ++ [extension_byte [255%nat]]) = signed_le [255%nat]'),
}


def run_semantic_controls(output_dir):
    tool_hash = digest(__file__)
    directory, coqc, _, hashes, _ = setup(output_dir)
    original = (directory / 'NumericCoercions.v').read_bytes().decode()
    prefix, suffix = re.split(r'^Lemma ', original, maxsplit=1, flags=re.MULTILINE)
    reports = {}
    for name, (old, new, counterexample) in MUTATIONS.items():
        require(prefix.count(old) == 1, 'Ambiguous definition mutation: ' + name)
        mutated = prefix.replace(old, new)
        subdir = directory / name; subdir.mkdir(exist_ok=True)
        shutil.copyfile(directory / 'IntegerSemantics.v', subdir / 'IntegerSemantics.v')
        command([coqc, '-q', 'IntegerSemantics.v'], subdir, subdir / 'integer.log')
        definition_file = subdir / 'NumericDefinitions.v'; definition_file.write_bytes(mutated.encode())
        command([coqc, '-q', definition_file.name], subdir, subdir / 'definitions.log')
        assertion = subdir / 'NumericCounterexample.v'
        assertion.write_bytes(('From Coq Require Import ZArith List.\nRequire Import NumericDefinitions.\n'
            'Import ListNotations. Open Scope Z_scope.\nExample original_semantics : ' + counterexample +
            '.\nProof. vm_compute. reflexivity. Qed.\n').encode())
        rc, text = command([coqc, '-q', assertion.name], subdir, subdir / 'counterexample.log', False)
        require(rc != 0 and 'Error:' in text and 'Syntax error' not in text, 'Semantic counterexample escaped: ' + name)
        full = subdir / 'NumericCoercions.v'; full.write_bytes((mutated + 'Lemma ' + suffix).encode())
        rc, text = command([coqc, '-q', full.name], subdir, subdir / 'full-proof.log', False)
        require(rc != 0 and 'Error:' in text and 'Syntax error' not in text, 'Mutated model theorem escaped: ' + name)
        reports[name] = {'definitionsCompiled': True, 'counterexampleRejected': True,
                         'fullProofRejected': True, 'definitionSha256': digest(definition_file)}
    require(all(digest(path) == expected for path, expected in hashes.items()), 'Model changed during semantic controls')
    require(digest(__file__) == tool_hash, 'Proof runner changed during semantic controls')
    return {'definitionsCompiled': True, 'rejected': list(reports), 'controls': reports, 'modelSha256': hashes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--json-report', type=Path, required=True)
    parser.add_argument('--source-cache', type=Path)
    args = parser.parse_args()
    report = {'kernelChecked': False, 'vmCorrespondenceProven': False, 'fullImplementationVerified': False}
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(json.dumps(report) + '\n')
    try:
        report = run_model_proofs(args.output_dir, args.source_cache)
        report['semanticControls'] = run_semantic_controls(args.output_dir / 'semantic-controls')
        args.json_report.write_text(json.dumps(report, indent=2) + '\n')
        return 0
    except Exception as error:
        report['failure'] = str(error)
        args.json_report.write_text(json.dumps(report, indent=2) + '\n')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
