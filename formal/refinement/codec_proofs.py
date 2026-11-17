#!/usr/bin/env python3
"""Reproducible kernel certificate and native-vector join for ledger wire bytes."""
import argparse
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

import ledger_codec as codec
import native_codec_source

ROOT = Path(__file__).resolve().parent
MODULES = ('IntegerSemantics', 'NumericCoercions', 'CapArithmetic', 'CapMethodVm', 'LedgerCodec', 'NativeCodecSource')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


@dataclass(frozen=True)
class FileSnapshot:
    path: str
    raw: bytes

    @property
    def sha256(self):
        return hashlib.sha256(self.raw).hexdigest()

    @property
    def text(self):
        return self.raw.decode('utf-8')


def snapshot_input(path):
    path = Path(path).resolve()
    return FileSnapshot(str(path), path.read_bytes())


def stage_snapshot(snapshot, path):
    codec.require(type(snapshot) is FileSnapshot, 'Immutable input snapshot required')
    Path(path).write_bytes(snapshot.raw)


def command(args, directory, logfile, *, success=True):
    result = subprocess.run(args, cwd=directory, text=True, capture_output=True, timeout=600)
    output = result.stdout + result.stderr
    Path(logfile).write_text(output)
    if success:
        codec.require(result.returncode == 0, 'Kernel command failed: ' + ' '.join(args) + '\n' + output[-3000:])
    return result.returncode, output


def declarations(text):
    return re.findall(r'^(?:Lemma|Theorem|Example)\s+(\w+)\s*:', text, re.M)


def definitions_only(text):
    pattern = r'^(?:Lemma|Theorem|Example)\s+\w+\s*:.*?\bProof\..*?\bQed\.'
    result = re.sub(pattern, '', text, flags=re.M | re.S)
    return re.sub(r'^Print Assumptions .*\n?', '', result, flags=re.M)


ZERO_LEDGER = 'ledger ArrayKind false (repeat 0%nat 32) 0'
MUTATIONS = {
    'zero-not-empty': ('if z =? 0 then [] else positive_payload 32 z', 'if z =? 0 then [0%nat] else positive_payload 32 z', 'encode_integer 0 = []'),
    'missing-positive-sign-byte': ('if z <? 128 then [Z.to_nat z]', 'if z <? 256 then [Z.to_nat z]', 'encode_integer 128 = [128%nat;0%nat]'),
    'array-tag-changed': ('ArrayKind => 64%nat', 'ArrayKind => 65%nat', f'firstn 1 (encode_ledger ({ZERO_LEDGER})) = [64%nat]'),
    'buffer-byte-string-collapsed': ('if is_buffer then 48%nat else 40%nat', 'if is_buffer then 40%nat else 40%nat', 'hash_tag true = 48%nat'),
    'integer-payload-33': ('if (size <=? 32)%nat then', 'if (size <=? 33)%nat then', 'decode_ledger_prefix ([64%nat;2%nat;40%nat;32%nat] ++ repeat 0%nat 32 ++ [33%nat;33%nat] ++ repeat 0%nat 33) = None'),
    'nonminimal-varint-rejected': ('then read_extended 2 rest', 'then None', 'read_varint [253%nat;2%nat;0%nat] = Some (2%nat,[])'),
    'trailing-bytes-discarded': ('Some (ledger kind is_buffer hash z,tail)', 'Some (ledger kind is_buffer hash z,[])', f'decode_ledger_prefix (encode_ledger ({ZERO_LEDGER}) ++ [99%nat]) = Some ({ZERO_LEDGER},[99%nat])'),
    'integer-sign-ignored': ('let z := signed_le payload in', 'let z := unsigned_le payload in', 'decode_ledger_prefix ([64%nat;2%nat;40%nat;32%nat] ++ repeat 0%nat 32 ++ [33%nat;1%nat;255%nat]) = None'),
}


def native_join(snapshot, source_projection=None):
    """Exact finite correspondence checks; negative domain is not silently widened."""
    codec.require(type(snapshot) is FileSnapshot, 'Native join requires immutable input snapshot')
    receipt = json.loads(snapshot.raw)
    runtime = receipt['runtime']
    expected_runtime = {
        'neo': ('Neo', codec.NEO_COMMIT, 'cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a'),
        'vm': ('Neo.VM', codec.VM_COMMIT, 'cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9')}
    for key, (name, commit, sha) in expected_runtime.items():
        codec.require(runtime[key] == dict(fullName=name+', Version=3.10.1.0, Culture=neutral, PublicKeyToken=null',
                                          informationalVersion='3.10.1+'+commit, sha256=sha), 'Native loaded assembly identity differs: '+key)
    codec.require(runtime['neoSourceCommit'] == codec.NEO_COMMIT and runtime['vmSourceCommit'] == codec.VM_COMMIT, 'Native source commits differ')
    matched, rejected, normalized, ledger_normalized = 0, 0, 0, 0
    seen, positive_cases = set(), set()
    for item in receipt['vectors']:
        identity = json.dumps(item, sort_keys=True)
        codec.require(identity not in seen, 'Duplicate native evidence vector')
        seen.add(identity)
        if 'shape' in item:
            ledger = codec.Ledger(item['shape'], bytes.fromhex(item.get('hash', '00'*32)), int(item['number']), item.get('hashKind', 'ByteString'))
            wire = bytes.fromhex(item['wire'])
            if ledger.reserved < 0:
                try:
                    codec.decode_ledger_prefix(wire)
                except codec.CodecError:
                    rejected += 1
                else:
                    raise codec.CodecError('Negative native ledger escaped typed-domain guard')
                if source_projection:
                    try:
                        codec.source_deserialize_ledger(source_projection, wire)
                    except codec.CodecError:
                        pass
                    else:
                        raise codec.CodecError('Source AST accepted outside-domain native ledger')
            else:
                codec.require(codec.encode_ledger(ledger) == wire, 'Native canonical byte vector differs')
                codec.require(codec.decode_ledger_prefix(wire) == (ledger, b''), 'Native ledger decode differs')
                matched += 1
                positive_cases.add((ledger.kind, ledger.reserved))
                if source_projection:
                    codec.require(codec.source_serialize_ledger(source_projection, ledger) == wire, 'Source AST/native serializer differs')
                    codec.require(codec.source_deserialize_ledger(source_projection, wire) == (ledger,b''), 'Source AST/native decoder differs')
        elif 'input' in item and 'canonical' in item:
            original, canonical = bytes.fromhex(item['input']), bytes.fromhex(item['canonical'])
            if original[:1] in (b'\x40', b'\x41'):
                ledger, tail = codec.decode_ledger_prefix(original)
                codec.require(codec.encode_ledger(ledger) == canonical, 'Native ledger normalization differs')
                if source_projection:
                    codec.require(codec.source_deserialize_ledger(source_projection, original) == (ledger,tail), 'Source AST/native normalization decode differs')
                    codec.require(codec.source_serialize_ledger(source_projection, ledger) == canonical, 'Source AST/native normalization encoding differs')
                if tail:
                    codec.require(tail == bytes.fromhex('deadbeef'), 'Unexpected native normalization suffix')
                ledger_normalized += 1
                continue
            codec.require(original[:1] == b'\x21' and canonical[:1] == b'\x21', 'Unknown native normalization vector')
            size, pos = codec.decode_varint(original, 1, 32)
            codec.require(pos + size == len(original), 'Unexpected normalization suffix')
            try:
                value = codec.decode_integer(original[pos:])
            except codec.CodecError:
                rejected += 1
                if source_projection:
                    try:
                        codec.source_deserialize_ledger(source_projection, bytes([64,2,40,32])+bytes(32)+original)
                    except codec.CodecError:
                        pass
                    else:
                        raise codec.CodecError('Source AST accepted outside-domain native Integer')
            else:
                payload = codec.encode_integer(value)
                codec.require(b'\x21' + codec.encode_varint(len(payload)) + payload == canonical, 'Native Integer normalization differs')
                normalized += 1
                if source_projection:
                    prefix = bytes([64,2,40,32])+bytes(32)
                    expected = codec.Ledger('Array', bytes(32), value)
                    codec.require(codec.source_deserialize_ledger(source_projection, prefix+original) == (expected,b''), 'Source AST/native Integer decode differs')
                    codec.require(codec.source_serialize_ledger(source_projection, expected) == prefix+canonical, 'Source AST/native Integer normalization differs')
        else:
            raise codec.CodecError('Unknown native vector shape')
    required_positive = {(kind, value) for kind in ('Array', 'Struct') for value in (0, 1, 127, 128, (1 << 63)-1, codec.LIMIT-1)}
    codec.require(required_positive <= positive_cases and normalized >= 3 and ledger_normalized >= 9, 'Native receipt omitted required boundary vectors')
    return dict(path=snapshot.path, sha256=snapshot.sha256, runtime=runtime,
                canonicalLedgerVectors=matched, integerNormalizationVectors=normalized, ledgerNormalizationVectors=ledger_normalized, outsideDomainRejections=rejected,
                typedSourceInterpreterJoined=source_projection is not None,
                limits='Finite native correspondence only; negative ledger values remain excluded from this codec proof')


def native_certificate(snapshot):
    """Put the actual native receipt bytes, not Python-derived output, in Coq."""
    codec.require(type(snapshot) is FileSnapshot, 'Native certificate requires immutable input snapshot')
    receipt = json.loads(snapshot.raw)
    def bytes_term(raw):
        return '[' + ';'.join(str(b)+'%nat' for b in raw) + ']'
    def ledger_term(item):
        kind = {'Array': 'ArrayKind', 'Struct': 'StructKind'}[item['shape']]
        is_buffer = 'true' if item.get('hashKind') == 'Buffer' else 'false'
        return '(ledger ' + kind + ' ' + is_buffer + ' ' + bytes_term(bytes.fromhex(item.get('hash', '00'*32))) + ' (' + item['number'] + ')%Z)'
    header = """From Coq Require Import ZArith List Bool.
Require Import NumericCoercions CapMethodVm LedgerCodec.
Import ListNotations. Open Scope Z_scope.
Definition normalize_nonnegative_integer_wire input :=
  match input with 33%nat::rest =>
    match read_varint rest with Some (size,after_size) =>
      if (size <=? 32)%nat then match take_exact size after_size with
      | Some (payload,[]) => let z := signed_le payload in
          if (0 <=? z) && (z <? IntegerSemantics.integer_limit) then
            Some ([33%nat;length (encode_integer z)] ++ encode_integer z) else None
      | _ => None end else None
    | None => None end
  | _ => None end.
"""
    examples, names = [], []
    for index, item in enumerate(receipt['vectors']):
        name = 'native_vector_' + str(index)
        names.append(name)
        if 'shape' in item:
            raw = bytes_term(bytes.fromhex(item['wire']))
            proposition = ('decode_ledger_prefix ' + raw + ' = None' if int(item['number']) < 0 else
                           'encode_ledger ' + ledger_term(item) + ' = ' + raw)
        else:
            original, canonical = bytes.fromhex(item['input']), bytes.fromhex(item['canonical'])
            if original[0] in (64, 65):
                proposition = "option_map (fun '(l,_) => encode_ledger l) (decode_ledger_prefix " + bytes_term(original) + ') = Some ' + bytes_term(canonical)
            else:
                size, offset = codec.decode_varint(original, 1, 32)
                negative = int.from_bytes(original[offset:offset+size], 'little', signed=True) < 0
                proposition = 'normalize_nonnegative_integer_wire ' + bytes_term(original) + ' = ' + ('None' if negative else 'Some '+bytes_term(canonical))
        examples.append('Example '+name+' : '+proposition+'.\nProof. vm_compute. reflexivity. Qed.\nPrint Assumptions '+name+'.\n')
    return header + '\n'.join(examples), names


def run_proofs(output_dir, native_vectors=None, source_cache=None, native_source_inventory=None):
    output = Path(output_dir).resolve()
    codec.require(not output.exists() or not any(output.iterdir()), 'Output directory must be new or empty')
    output.mkdir(parents=True, exist_ok=True)
    coqc, coqchk = shutil.which('coqc'), shutil.which('coqchk')
    codec.require(coqc and coqchk, 'Coq kernel tools are required')
    snapshots = {str(path.resolve()): snapshot_input(path) for path in
                 [*(ROOT / name for name in ('ledger_codec.py', 'codec_proofs.py','native_codec_source.py','native_export/Program.cs','native_export/NativeCodecExport.csproj')),
                  *(ROOT / 'coq' / (module + '.v') for module in MODULES)]}
    native_snapshot = snapshot_input(native_vectors) if native_vectors else None
    if native_snapshot:
        snapshots[native_snapshot.path] = native_snapshot
    input_hashes = {path: snapshot.sha256 for path, snapshot in snapshots.items()}
    for module in MODULES:
        path = ROOT / 'coq' / (module + '.v')
        snapshot = snapshots[str(path.resolve())]
        source = snapshot.text
        codec.require(not re.search(r'\b(?:Admitted|Axiom|Axioms|admit|Parameter|Parameters|Abort)\b', source), 'Untrusted proof escape in ' + module)
        stage_snapshot(snapshot, output / path.name)
        command([coqc, '-q', path.name], output, output / (module + '.log'))
    source_checks = codec.source_evidence(source_cache)
    source_facts = codec.validate_sources(source_checks)
    source_receipt = {name: {k: v for k, v in item.items() if k != 'source'} for name, item in source_checks.items()}
    for item in source_receipt.values():
        input_hashes[item['path']] = item['sha256']
    if native_source_inventory:
        native_source_snapshot = snapshot_input(native_source_inventory)
        native_source_raw = native_source_snapshot.raw
        native_source_input = json.loads(native_source_raw)
        source_projection = native_codec_source.project_inventory(native_source_input)
        input_hashes[native_source_snapshot.path] = native_source_snapshot.sha256
        stage_snapshot(native_source_snapshot, output / 'native-source-inventory.json')
    else:
        staged_source = output / 'BinarySerializer.cs'
        staged_source.write_bytes(source_checks['BinarySerializer']['source'].encode())
        native_source_raw, native_source_input, source_projection = native_codec_source.export_inventory(staged_source, output / 'native-source-inventory.json')
    codec.require(native_source_input['source']['sha256'] == source_receipt['BinarySerializer']['sha256'], 'Native AST/source snapshots differ')
    for path, sha256 in native_source_input['inputs'].items():
        codec.require(path not in input_hashes or input_hashes[path] == sha256, 'Conflicting input identities')
        input_hashes[path] = sha256
    (output / 'native-source-projection.json').write_text(json.dumps(source_projection,indent=2)+'\n')
    source_controls, source_control_projections = native_codec_source.source_semantic_controls(source_checks['BinarySerializer']['source'],output/'source-controls',include_projections=True)
    source_certificate = native_codec_source.source_kernel_certificate(source_projection)
    (output/'ActualNativeCodecSource.v').write_bytes(source_certificate.encode())
    _, source_kernel_log = command([coqc,'-q','ActualNativeCodecSource.v'],output,output/'actual-native-source.log')
    source_kernel_names = declarations(source_certificate)
    codec.require(source_kernel_log.count('Closed under the global context') == len(source_kernel_names), 'Native source execution assumptions differ')
    control_order_certificate = native_codec_source.source_kernel_certificate(source_projection,counterexample_first=True)
    (output/'ActualNativeCodecSourceControlOrder.v').write_bytes(control_order_certificate.encode())
    _, control_order_log = command([coqc,'-q','ActualNativeCodecSourceControlOrder.v'],output,output/'actual-native-source-control-order.log')
    codec.require(control_order_log.count('Closed under the global context') == len(source_kernel_names), 'Source mutation proof strategy failed on baseline')
    for name in ('array-field-order','array-field-count','struct-constructor','pending-item-count'):
        projection = source_control_projections[name]
        definitions = native_codec_source.coq_program(projection)
        module = 'MutatedNativeSource_'+name.replace('-','_')
        (output/(module+'Definitions.v')).write_bytes(definitions.encode())
        command([coqc,'-q',module+'Definitions.v'],output,output/(name+'-definitions.log'))
        (output/(module+'Proof.v')).write_bytes(native_codec_source.source_kernel_certificate(projection,counterexample_first=True).encode())
        rc, rejected = command([coqc,'-q',module+'Proof.v'],output,output/(name+'-kernel.log'),success=False)
        codec.require(rc != 0 and 'Error:' in rejected and 'Syntax error' not in rejected, 'Actual source semantic mutation escaped execution kernel: '+name)
        source_controls[name]['definitionsKernelCompiled'] = True
        source_controls[name][('serializer' if name.startswith('array-') else 'deserializer')+'UniversalTheoremRejected'] = True
    source = snapshots[str((ROOT / 'coq' / 'LedgerCodec.v').resolve())].text
    names = declarations(source)
    codec.require(set(re.findall(r'^Print Assumptions (\w+)\.', source, re.M)) == set(names), 'Missing theorem assumption check')
    codec.require((output / 'LedgerCodec.log').read_text().count('Closed under the global context') == len(names), 'Unexpected theorem assumptions')
    controls = {}
    for name, (old, new, theorem) in MUTATIONS.items():
        codec.require(source.count(old) == 1, 'Ambiguous semantic mutation: ' + name)
        modified = source.replace(old, new)
        work = output / 'controls' / name
        work.mkdir(parents=True)
        for module in MODULES[:4]:
            for suffix in ('.vo', '.vos', '.vok'):
                candidate = output / (module + suffix)
                if candidate.exists():
                    shutil.copyfile(candidate, work / candidate.name)
        (work / 'CodecDefinitions.v').write_bytes(definitions_only(modified).encode())
        command([coqc, '-q', 'CodecDefinitions.v'], work, work / 'definitions.log')
        (work / 'Counterexample.v').write_bytes(('From Coq Require Import ZArith List.\nRequire Import CapMethodVm CodecDefinitions.\nImport ListNotations. Open Scope Z_scope.\nExample preserved_native_behavior : ' + theorem + '.\nProof. vm_compute. reflexivity. Qed.\n').encode())
        rc, log = command([coqc, '-q', 'Counterexample.v'], work, work / 'counterexample.log', success=False)
        codec.require(rc != 0 and 'Error:' in log and 'Syntax error' not in log, 'Mutant semantic counterexample escaped: ' + name)
        (work / 'LedgerCodec.v').write_bytes(modified.encode())
        rc, log = command([coqc, '-q', 'LedgerCodec.v'], work, work / 'full-proof.log', success=False)
        codec.require(rc != 0 and 'Error:' in log and 'Syntax error' not in log, 'Mutated theorem suite escaped: ' + name)
        controls[name] = dict(definitionsCompiled=True, originalBehaviorRejected=True, theoremSuiteRejected=True)
    joined = native_join(native_snapshot, source_projection) if native_snapshot else None
    checked_modules = [*MODULES,'ActualNativeCodecSource','ActualNativeCodecSourceControlOrder']
    native_kernel = None
    if joined:
        input_hashes[joined['path']] = joined['sha256']
        certificate, native_names = native_certificate(native_snapshot)
        (output / 'NativeLedgerVectors.v').write_bytes(certificate.encode())
        stage_snapshot(native_snapshot, output / 'native-vectors.json')
        _, log = command([coqc, '-q', 'NativeLedgerVectors.v'], output, output / 'native-vectors.log')
        codec.require(log.count('Closed under the global context') == len(native_names), 'Native byte certificate assumptions differ')
        checked_modules.append('NativeLedgerVectors')
        first = re.search(r'^Example native_vector_0 : (.*)\.$', certificate, re.M)
        codec.require(first is not None and '= [64%nat;' in first.group(0), 'Native mutation anchor absent')
        corrupted = certificate.replace(first.group(0), first.group(0).replace('= [64%nat;', '= [65%nat;', 1), 1)
        (output / 'CorruptedNativeVectors.v').write_bytes(corrupted.encode())
        rc, rejected = command([coqc, '-q', 'CorruptedNativeVectors.v'], output, output / 'corrupted-native-vector.log', success=False)
        codec.require(rc != 0 and 'Error:' in rejected and 'Syntax error' not in rejected, 'Corrupted native artifact byte escaped kernel')
        native_kernel = dict(kernelChecked=True, closedDeclarations=native_names,
                             certificateSha256=hashlib.sha256(certificate.encode()).hexdigest(), corruptedArtifactByteRejected=True)
    command([coqchk, '-silent', *checked_modules], output, output / 'coqchk.log')
    _, version = command([coqc, '--version'], output, output / 'coqc-version.log')
    codec.require(all(digest(p) == expected for p, expected in input_hashes.items()), 'Input changed during proof')
    result = dict(schema='neoos-aa-ledger-codec-proof/v1', scope='ledger-codec', kernelChecked=True,
                  fullImplementationVerified=False, runtimeSourceSimulationProven=False,
                  outputDirectory=str(output), inputSha256=input_hashes,
                  closedDeclarations=names, semanticControls=controls, pinnedSource=source_receipt,
                  sourceFacts=source_facts, nativeVectorJoin=joined, nativeVectorKernel=native_kernel,
                  immutableInputSnapshots=True,
                  typedNativeSource=dict(inventorySha256=hashlib.sha256(native_source_raw).hexdigest(),
                    projectionSha256=source_projection['projectionSha256'], operationCount=source_projection['operationCount'],
                    resolvedExternalSymbols=source_projection['resolvedExternalSymbols'],
                    externalContracts=source_projection['externalContracts'], kernelChecked=True,
                    scope='Resolved core source AST for a two-field ledger, canonical framing, hash length 32, payload length at most 32, arbitrary suffix; fixed 2048-item/131070-byte core arguments and explicit VM/.NET primitive contracts',
                    closedDeclarations=source_kernel_names,
                    certificateSha256=hashlib.sha256(source_certificate.encode()).hexdigest(),
                    sourceModelSha256=snapshots[str((ROOT/'coq'/'NativeCodecSource.v').resolve())].sha256,
                    semanticControlBaseline=dict(kernelChecked=True,certificateSha256=hashlib.sha256(control_order_certificate.encode()).hexdigest()),
                    serializerKernel=dict(kernelChecked=True,closedDeclarations=source_kernel_names[:3],
                      certificateSha256=hashlib.sha256(source_certificate.encode()).hexdigest(),
                      scope='Actual resolved serializer AST, legal 32-byte hash and signed-256 payload, standard 2048-item/131070-byte limits; explicit VM/.NET primitive contracts'),
                    deserializerKernel=dict(kernelChecked=True,closedDeclarations=source_kernel_names[3:5],
                      certificateSha256=hashlib.sha256(source_certificate.encode()).hexdigest(),
                      scope='Actual resolved deserializer core AST, canonical varint framing, all payloads of length at most 32, all 32-byte hashes, both container/hash tags, arbitrary suffix; fixed 2048-item/131070-byte arguments'),
                    sourceRoundtripKernel=dict(kernelChecked=True,closedDeclarations=source_kernel_names[5:],
                      certificateSha256=hashlib.sha256(source_certificate.encode()).hexdigest(),
                      scope='Actual core serializer then actual core deserializer reconstruct every legal ledger and preserve any suffix'),
                    finiteNativeCorrespondence=joined is not None, fullSourceSimulationProven=False,
                    semanticControls=source_controls),
                  toolVersion=version.splitlines()[0],
                  toolSha256={'coqc': digest(Path(coqc).resolve()), 'coqchk': digest(Path(coqchk).resolve())},
                  proven=['Nonnegative signed-256 Integer canonical encode/decode reconstruction and injectivity',
                          'Array/Struct and ByteString/Buffer real tag/varint framing roundtrip with arbitrary trailing suffix',
                          'Deterministic prefix parsing, canonical ledger injectivity and 38..70 byte bound',
                          'Framing projection into existing structured wire and its reference codec roundtrip',
                          'Execution of actual resolved core serializer/deserializer ASTs in the explicit source machine reconstructs every legal two-field ledger'],
                  unproved=['General simulation of pinned C#/.NET native BinarySerializer/BigInteger execution by the reference algorithms',
                            'Source-kernel decoding of nonminimal varint widths and native wrapper argument admission remain outside the universal core certificate; finite native/source vectors cover selected cases',
                            'Arbitrary nested or malformed StackItem codecs, engine gas/resource admission and global rollback',
                            'Buffer-hash inputs are distinguished by codec; existing helper theorem remains ByteString-hash scoped'],
                  publicNetworkWritesPerformed=False)
    (output / 'result.json').write_text(json.dumps(result, indent=2)+'\n')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--json-report', required=True)
    parser.add_argument('--native-vectors')
    parser.add_argument('--source-cache')
    parser.add_argument('--native-source-inventory')
    args = parser.parse_args()
    try:
        codec.require(not Path(args.json_report).exists(), 'JSON report already exists')
        result = run_proofs(args.output_dir, args.native_vectors, args.source_cache, args.native_source_inventory)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error)+'\n')
    Path(args.json_report).write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps({'scope': result['scope'], 'kernelChecked': result['kernelChecked'], 'closedDeclarations': len(result['closedDeclarations']), 'negativeControls': len(result['semanticControls']), 'fullImplementationVerified': False}))


if __name__ == '__main__':
    main()
