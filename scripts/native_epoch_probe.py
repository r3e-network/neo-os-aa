#!/usr/bin/env python3
"""Compile actual native modules and execute the test-only epoch ABI VM probe.

This is an isolated module regression, not a release build or native recovery
integration gate. Compiler outputs are unmodified. Every module and test fixture
restores against its copied committed lock with RestoreLockedMode=true.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compiler', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    options = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    report = {'status': 'RUNNING', 'publicNetworksTouched': False, 'sourceSha256': {}, 'testSourceSha256': {},
              'lockSha256': {}, 'restoreLockedMode': True, 'recipeSha256': digest(Path(__file__)), 'compilerLauncherSha256': digest(options.compiler)}
    options.output.parent.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, 'RestoreLockedMode': 'true'}
    try:
        with tempfile.TemporaryDirectory(prefix='native-epoch-vm-') as temporary:
            scratch = Path(temporary)
            for name in ('Directory.Build.props', 'nuget.config'):
                shutil.copyfile(root / name, scratch / name)
                report['sourceSha256'][name] = digest(root / name)
            profiles = json.loads((root / 'contracts/native/profiles.json').read_text())
            for source in (root / 'contracts').rglob('*'):
                if not source.is_file() or (source.suffix not in ('.cs', '.csproj') and not source.name.endswith('.lock.json')) or any(part in ('obj', 'bin') for part in source.relative_to(root).parts):
                    continue
                destination = scratch / source.relative_to(root)
                destination.parent.mkdir(parents=True, exist_ok=True)
                data = source.read_bytes()
                report['sourceSha256'][str(source.relative_to(root))] = hashlib.sha256(data).hexdigest()
                if source.name.endswith('.lock.json'):
                    report['lockSha256'][str(source.relative_to(root))] = digest(source)
                destination.write_bytes(b'#define SMARTACCOUNT_NATIVE\n' + data if source.suffix == '.cs' else data)
            for source in (root / 'tests/NativeEpochProbe').rglob('*'):
                if source.is_file() and (source.suffix in ('.cs', '.csproj') or source.name.endswith('.lock.json')) and not any(part in ('obj', 'bin') for part in source.parts):
                    destination = scratch / source.relative_to(root)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
                    report['testSourceSha256'][str(source.relative_to(root))] = digest(source)
                    if source.name.endswith('.lock.json'):
                        report['lockSha256'][str(source.relative_to(root))] = digest(source)
            support = scratch / 'tests/AbstractAccount.Contracts.Tests/RuntimeTestSupport.cs'
            support.parent.mkdir(parents=True)
            shutil.copyfile(root / 'tests/AbstractAccount.Contracts.Tests/RuntimeTestSupport.cs', support)
            report['testSourceSha256']['tests/AbstractAccount.Contracts.Tests/RuntimeTestSupport.cs'] = digest(support)
            raw = scratch / 'artifacts'
            raw.mkdir()
            projects = [scratch / 'contracts/native' / spec['project'] for spec in profiles.values()]
            projects.append(scratch / 'tests/NativeEpochProbe/contracts/NativeEpochCore.csproj')
            host_project = scratch / 'tests/NativeEpochProbe/NativeEpochProbe.csproj'
            for project in [*projects, host_project]:
                siblings = list(project.parent.glob('*.csproj'))
                lock = project.parent / (f'packages.{project.stem}.lock.json' if len(siblings) > 1 else 'packages.lock.json')
                if not lock.is_file():
                    raise RuntimeError('Committed restore lock missing for ' + str(project.relative_to(scratch)))
            for project in projects:
                result = subprocess.run([str(options.compiler), str(project), '-o', str(raw)], cwd=scratch,
                                        env=environment, capture_output=True, text=True, timeout=180)
                if result.returncode:
                    raise RuntimeError('Compiler failed for ' + project.name + ':\n' + result.stdout + result.stderr)
            report['artifactsSha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(raw.iterdir())}
            result = subprocess.run(['dotnet', 'run', '--project', str(scratch / 'tests/NativeEpochProbe/NativeEpochProbe.csproj'),
                                     '--', str(raw)], cwd=scratch, env=environment, capture_output=True, text=True, timeout=180)
            start = result.stdout.find('{\n')
            if start < 0:
                raise RuntimeError('Probe did not emit its result:\n' + result.stdout + result.stderr)
            report['probe'] = json.loads(result.stdout[start:])
            report['status'] = 'PASS' if report['probe'].get('status') == 'PASS' and result.returncode == 0 else 'FAIL'
            report['exitCode'] = result.returncode
    except Exception as error:
        report.update(status='FAIL', error=str(error))
    finally:
        options.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ('status', 'probe', 'error') if key in report}, indent=2))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
