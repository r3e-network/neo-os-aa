#!/usr/bin/env python3
"""Run unchanged native module NEF against a provenance-checked local runtime."""
import argparse
import datetime
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from neoexpress_native_modules_validate import check_module_build
from neoexpress_reproducible_build import check_runtime_receipt, sha256


def check_result(observed):
    required_flags = ('staleSnapshotRemovalAndIsolation', 'staleSnapshotCleanupAndIsolation',
                      'administrationAndIdenticalArtifactUpdate', 'allVmTypesPreAndPostVerified',
                      'directPhaseAndMalformedCallbacksVerified')
    if (observed.get('status') != 'PASS' or observed.get('publicNetworksTouched') is not False
            or observed.get('faultInjectionCount') != 1 or not all(observed.get(k) is True for k in required_flags)):
        raise ValueError('Probe did not establish every required local check')
    if set(observed.get('productionArtifacts', {})) != {'TokenRestrictedHook.nef', 'TokenRestrictedHook.manifest.json'}:
        raise ValueError('Incomplete production artifact roster')
    if set(observed.get('collectorControls', [])) != {'both-directions', 'fault-before-completion', 'coincident-successor', 'all-conditional-opcodes'}:
        raise ValueError('Missing coverage collector controls')
    expected_types = {'zero', 'positive', 'negative', 'boolean', 'bytes', 'null', 'array', 'struct', 'map', 'buffer', 'pointer', 'interop'}
    vm_types = {'zero': 'Integer', 'positive': 'Integer', 'negative': 'Integer', 'boolean': 'Boolean',
                'bytes': 'ByteString', 'null': 'Any', 'array': 'Array', 'struct': 'Struct', 'map': 'Map',
                'buffer': 'Buffer', 'pointer': 'Pointer', 'interop': 'InteropInterface'}
    for field in ['balanceTypes', 'postBalanceTypes']:
        values = observed.get(field, [])
        if len(values) != 12 or {v.get('kind') for v in values} != expected_types:
            raise ValueError('Incomplete diagnostic balance vector roster')
        if any(v.get('vmType') != vm_types[v['kind']] for v in values):
            raise ValueError('Incorrect observed balance VM type')
        if field == 'postBalanceTypes' and any(type(v.get('injections')) is not int or v['injections'] != 1 for v in values):
            raise ValueError('Post-phase injection must occur exactly once per vector')
    shapes = observed.get('malformedCallbackCases', [])
    expected_shapes = {'short-array', 'integer-target', 'short-target', 'buffer-target'}
    if (len(shapes) != len(expected_shapes) or {v.get('kind') for v in shapes} != expected_shapes
            or any(type(v.get('injections')) is not int or v['injections'] != 1 for v in shapes)):
        raise ValueError('Incomplete or repeated callback shape injections')
    cases = observed.get('cases', [])
    labels = {case.get('label') for case in cases}
    required_cases = {'missing-snapshot-injection', 'positive-after-snapshot-fault', 'remove-hook-confirm', 'update-confirm-same-artifact'}
    required_cases.update('pre-balance-' + kind for kind in expected_types)
    required_cases.update('post-balance-' + kind for kind in expected_types)
    required_cases.update('callback-' + kind for kind in expected_shapes)
    required_cases.update(['direct-config-denied', 'direct-pre-denied', 'direct-post-denied', 'direct-cleanup-denied',
                           'positive-after-post-type-faults', 'positive-after-callback-faults'])
    if not required_cases.issubset(labels):
        raise ValueError('Incomplete execution matrix')
    for label in required_cases:
        matching = [case for case in cases if case.get('label') == label]
        reason = None
        if label == 'missing-snapshot-injection':
            reason = 'Missing restricted balance snapshot'
        elif label.startswith('direct-'):
            reason = 'Missing native module invocation context'
        elif label.startswith('callback-'):
            reason = 'Invalid native operation shape'
        elif label == 'post-balance-zero':
            reason = 'Restricted token outflow (incl. via intermediary) is forbidden'
        elif ((label.startswith('pre-balance-') and label not in ('pre-balance-zero', 'pre-balance-positive'))
              or (label.startswith('post-balance-') and label != 'post-balance-positive')):
            reason = 'Invalid restricted token balance'
        rejected = reason is not None
        if len(matching) != 1 or matching[0].get('vmState') != ('FAULT' if rejected else 'HALT'):
            raise ValueError('A required semantic case has the wrong outcome')
        if rejected and matching[0].get('expectedFault') != reason:
            raise ValueError('A required rejection occurred for the wrong reason')
    for case in cases:
        if case.get('vmState') not in ('HALT', 'FAULT') or bool(case.get('expectedFault')) != (case['vmState'] == 'FAULT'):
            raise ValueError('Inconsistent expected VM state')
        if case['vmState'] == 'FAULT' and case.get('wholeStoreRollbackChecked') is not True:
            raise ValueError('Unchecked fault rollback')
    coverage = observed.get('coverage', {})
    for total, hit, missing in [('instructionCount', 'attemptedInstructions', 'missingInstructionOffsets'),
                                ('conditionalEdges', 'completedConditionalEdges', 'missingConditionalEdges')]:
        if not (type(coverage.get(total)) is int and type(coverage.get(hit)) is int
                and 0 < coverage[hit] <= coverage[total] and isinstance(coverage.get(missing), list)
                and coverage[total] - coverage[hit] == len(coverage[missing])):
            raise ValueError('Invalid coverage denominator or incomplete missing-edge list')
    if coverage.get('sourceLineCoverageMeasured') is not False or coverage.get('fullRefinementProven') is not False:
        raise ValueError('Bytecode probes cannot claim source coverage or refinement')


def validate(runtime, artifacts, runtime_receipt, module_receipt, output):
    report = {'schema': 'smartaccount-native-nef-probe-validation/v1', 'status': 'RUNNING',
              'publicNetworksTouched': False}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report) + '\n')
    root = Path(__file__).resolve().parent.parent
    stage = 'provenance'
    try:
        runtime_build = json.loads(runtime_receipt.read_text())
        module_build = json.loads(module_receipt.read_text())
        check_runtime_receipt(runtime_build, runtime)
        pins = check_module_build(module_build, artifacts, root / 'contracts')
        source = root / 'tests/NativeModuleProbe'
        files = sorted([*source.glob('*.cs'), *source.glob('*.csproj')])
        if len(files) != 5:
            raise ValueError('Expected four probe source files and one project')
        inputs = files + [Path(__file__), Path(__file__).with_name('neoexpress_native_modules_validate.py'),
                          Path(__file__).with_name('neoexpress_reproducible_build.py'),
                          Path(__file__).with_name('native_module_profile.py'),
                          Path(__file__).with_name('build_native_modules.py')]
        report.update(sourceSha256={p.resolve().relative_to(root).as_posix(): sha256(p) for p in inputs},
                      runtimeReceiptSha256=sha256(runtime_receipt), moduleReceiptSha256=sha256(module_receipt))
        dotnet = shutil.which('dotnet')
        if not dotnet:
            raise RuntimeError('A local dotnet SDK is required')
        with tempfile.TemporaryDirectory(prefix='native-nef-probe-') as temporary:
            scratch = Path(temporary).resolve()
            project = scratch / 'source'
            project.mkdir()
            for path in files:
                shutil.copyfile(path, project / path.name)
            (project / 'NuGet.Config').write_text('<configuration><packageSources><clear /></packageSources></configuration>')
            build_output = scratch / 'out'
            stage = 'build'
            built = subprocess.run([dotnet, 'build', str(project / 'NativeModuleProbe.csproj'), '-c', 'Release',
                                    '-o', str(build_output), '-p:NativeRuntimeDirectory=' + str(runtime),
                                    '-p:PathMap=' + str(scratch) + '=/_/native-module-probe'],
                                   capture_output=True, text=True, timeout=120)
            if built.returncode:
                raise RuntimeError('Probe build failed: ' + built.stdout[-2000:] + built.stderr[-500:])
            stage = 'execution'
            result_path = scratch / 'probe.json'
            executed = subprocess.run([dotnet, str(build_output / 'NativeModuleProbe.dll'), str(artifacts), str(result_path)],
                                      capture_output=True, text=True, timeout=120)
            if executed.returncode:
                raise RuntimeError('Probe execution failed: ' + executed.stdout[-1000:] + executed.stderr[-2000:])
            observed = json.loads(result_path.read_text())
            check_result(observed)
            for name, digest in observed['productionArtifacts'].items():
                if pins.get(name) != digest:
                    raise ValueError('Probe production artifact differs from native build')
            loaded = observed['loadedAssemblies']
            if not {'Neo.dll', 'Neo.VM.dll', 'NativeModuleProbe.dll'}.issubset(loaded):
                raise ValueError('Missing loaded assembly identity')
            for name, digest in loaded.items():
                expected = build_output / name if name == 'NativeModuleProbe.dll' else runtime / name
                if Path(name).name != name or sha256(expected) != digest:
                    raise ValueError('Loaded assembly differs from checked runtime')
            report.update(probe=observed, probeAssemblySha256=loaded['NativeModuleProbe.dll'],
                          loadedRuntimeAssembliesMatched=True)
        stage = 'final-provenance'
        check_runtime_receipt(runtime_build, runtime)
        check_module_build(module_build, artifacts, root / 'contracts')
        if any(sha256(root / name) != digest for name, digest in report['sourceSha256'].items()):
            raise ValueError('Probe inputs changed during validation')
        if sha256(runtime_receipt) != report['runtimeReceiptSha256'] or sha256(module_receipt) != report['moduleReceiptSha256']:
            raise ValueError('Build receipts changed during validation')
        report['status'] = 'PASS'
    except Exception as error:
        report['failure'] = {'stage': stage, 'type': type(error).__name__}
        raise
    finally:
        if report['status'] != 'PASS':
            report['status'] = 'FAIL'
        report['completedAtUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.write_text(json.dumps(report, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('runtime', 'artifacts', 'runtime-receipt', 'module-receipt', 'output'):
        parser.add_argument('--' + option, type=Path, required=True)
    args = parser.parse_args()
    validate(args.runtime.resolve(), args.artifacts.resolve(), args.runtime_receipt.resolve(),
             args.module_receipt.resolve(), args.output.resolve())
