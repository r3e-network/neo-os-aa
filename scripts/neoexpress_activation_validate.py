#!/usr/bin/env python3
"""Validate bounded-call activation on disposable, loopback-only NeoExpress chains."""
import argparse
import base64
import datetime
import hashlib
import json
import shutil
import socket
import tempfile
import time
from pathlib import Path

from neoexpress_validate import Chain, ValidationFailure, varint

RUNTIME_FILES = ("neoxp.dll", "Neo.dll", "Neo.Extensions.dll", "Neo.IO.dll",
                 "Neo.Json.dll", "Neo.VM.dll")
ACTIVATION_KEY = "protocol.Hardforks.HF_SmartAccountV1"
PROBE_BUDGET = 10_000_000


def require(condition, message):
    if not condition:
        raise ValidationFailure(message)


def push(value):
    if isinstance(value, bytes):
        require(len(value) < 256, "Probe push exceeds PUSHDATA1")
        return b"\x0c" + bytes([len(value)]) + value
    require(isinstance(value, int) and 0 <= value < 2**255, "Invalid probe integer")
    if value <= 16:
        return bytes([16 + value])
    for opcode, width in enumerate((1, 2, 4, 8, 16, 32)):
        if value < 1 << (8 * width - 1):
            return bytes([opcode]) + value.to_bytes(width, "little", signed=True)
    raise ValidationFailure("Unencodable probe integer")


def bounded_script(limit):
    # StdLib.serialize([Integer(0)]); only the syscall gate is under test.
    stdlib_wire_hash = bytes.fromhex("acce6fd80d44e1796aa0c2c625e9e4e0ce39efc0")[::-1]
    return (push(0) + push(1) + b"\xc0" + push(limit) + push(5) +
            push(b"serialize") + push(stdlib_wire_hash) + b"\x41" +
            hashlib.sha256(b"System.Contract.CallWithGasLimit").digest()[:4])


def probe():
    script = bounded_script(PROBE_BUDGET) + b"\x45\x08\x40"  # DROP, PUSHT, RET
    body = (b"NEF3" + b"Native activation probe".ljust(64, b"\x00") +
            bytes(5) + varint(len(script)) + script)
    nef = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    manifest = {
        "name": "NativeActivationProbe", "groups": [], "features": {}, "supportedstandards": [],
        "abi": {"methods": [{"name": "verify", "parameters": [], "returntype": "Boolean",
                             "offset": 0, "safe": True}], "events": []},
        "permissions": [{"contract": "*", "methods": ["serialize"]}], "trusts": [], "extra": None,
    }
    return script, nef, manifest


def check_readback(state, script, nef, manifest):
    require(base64.b64decode(state["nef"]["script"], validate=True) == script, "Probe script mismatch")
    require(state["nef"]["checksum"] == int.from_bytes(nef[-4:], "little"), "Probe checksum mismatch")
    require(state["manifest"] == manifest, "Probe manifest mismatch")


def check_verification(result, expected):
    require(result.get("state") == expected, "Unexpected Verification state")
    if expected == "HALT":
        stack = result.get("stack", [])
        require(len(stack) == 1 and stack[0].get("type") == "Boolean" and
                stack[0].get("value") is True, "Verification did not return exactly Boolean true")


def sample_boundary(chain, contract, activation, timeout, clock=time.monotonic, sleep=time.sleep):
    require(2 <= activation < 2**32 and timeout > 0, "Invalid activation boundary or timeout")
    samples = {}
    deadline = clock() + timeout
    while clock() < deadline:
        before = chain.rpc("getblockcount", []) - 1
        result = chain.rpc("invokecontractverify", [contract, []])
        after = chain.rpc("getblockcount", []) - 1
        if before == after:
            check_verification(result, "HALT" if before >= activation else "FAULT")
            samples[before] = {"ledgerIndex": before, "verificationState": result["state"],
                               "gasConsumedDatoshi": result["gasconsumed"]}
            if activation - 1 in samples and activation in samples:
                return list(samples.values())
            require(before <= activation, "Missed exact activation boundary")
        sleep(0.1)
    raise ValidationFailure("Timed out before observing both sides of the activation boundary")


def runtime_hashes(directory):
    require(all((directory / name).is_file() for name in RUNTIME_FILES), "Incomplete NeoExpress runtime")
    return {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in RUNTIME_FILES}


def make_runner(directory, dotnet, target):
    """Execute the selected assembly directly; do not trust an opaque shell wrapper."""
    runner = target / "neoxp"
    runner.write_text("#!/usr/bin/env python3\nimport os, sys\n" +
                      f"os.execv({str(dotnet)!r}, [{str(dotnet)!r}, {str(directory / 'neoxp.dll')!r}, *sys.argv[1:]])\n")
    runner.chmod(0o700)
    return str(runner)


def run_case(label, runner, height, expected, boundary_timeout=None):
    script, nef, manifest = probe()
    with tempfile.TemporaryDirectory(prefix="smartaccount-activation-") as scratch:
        chain = Chain(runner, scratch)
        try:
            chain.nx("create", "-o", str(chain.file))
            config = json.loads(chain.file.read_text())
            settings = config.setdefault("settings", {})
            settings.pop(ACTIVATION_KEY, None)
            if height is not None:
                settings[ACTIVATION_KEY] = str(height)
            for field in ("rpc-port", "tcp-port"):
                with socket.socket() as sock:
                    sock.bind(("127.0.0.1", 0))
                    config["consensus-nodes"][0][field] = sock.getsockname()[1]
            chain.file.write_text(json.dumps(config))
            chain.magic = config["magic"]
            chain.rpc_port = config["consensus-nodes"][0]["rpc-port"]
            file = Path(scratch) / "probe.nef"
            file.write_bytes(nef)
            file.with_suffix(".manifest.json").write_text(json.dumps(manifest))
            _, output = chain.nx("contract", "deploy", str(file), "genesis", "-j")
            deployed = chain.json_from(output)
            chain.start_node()
            version = chain.rpc("getversion", [])
            require(version["protocol"]["network"] == chain.magic, "Wrong private network")
            natives = chain.rpc("getnativecontracts", [])
            native_present = any(c["manifest"]["name"] == "AccountManagement" for c in natives)
            contract = deployed["contract-hash"]
            check_readback(chain.rpc("getcontractstate", [contract]), script, nef, manifest)
            case = {"name": label, "activationHeight": height, "networkMagic": chain.magic,
                    "nodeVersion": version["useragent"], "deploymentTransaction": deployed["tx-hash"],
                    "contractHash": contract, "readbackScriptAndManifestMatched": True,
                    "readbackChecksumMatched": True, "nativeAccountManagementPresent": native_present}
            if boundary_timeout is not None:
                case["samples"] = sample_boundary(chain, contract, height, boundary_timeout)
                case["pollTimeoutSeconds"] = boundary_timeout
            else:
                verification = chain.rpc("invokecontractverify", [contract, []])
                check_verification(verification, expected)
                application = chain.rpc("invokescript", [base64.b64encode(bounded_script(PROBE_BUDGET)).decode()])
                require(application["state"] == ("HALT" if height == 0 else "FAULT"), "Unexpected Application state")
                case.update(verificationState=verification["state"], applicationState=application["state"],
                            verificationGasConsumedDatoshi=verification["gasconsumed"])
                if height == 0:
                    exhausted = chain.rpc("invokescript", [base64.b64encode(bounded_script(1)).decode()])
                    require(exhausted["state"] == "FAULT" and "bounded contract call gas limit" in exhausted.get("exception", ""),
                            "Active bounded call did not exhaust its safety budget")
                    case["boundedExhaustionState"] = exhausted["state"]
            case["blockCount"] = chain.rpc("getblockcount", [])
            return case
        finally:
            chain.stop_node()


def validate(runtime, historical_runtime, dotnet, output, boundary_height=8, timeout=180):
    report = {
        "schema": "smartaccount-private-activation-regression/v2", "status": "RUNNING",
        "scope": "Ordinary diagnostic probe and RPC simulations; not native AccountManagement conformance or native internal helper invocation.",
        "publicNetworksTouched": False, "nativeAccountManagementVerified": False, "cases": [],
        "runtimeMode": "Direct execution of the selected local NeoExpress assembly; supplied runtime may be an isolated assembly overlay, not a reproducible runner rebuild.",
        "sourceSha256": {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                         for name in ("neoexpress_activation_validate.py", "neoexpress_validate.py")},
    }
    # Invalidate stale success before any runtime or chain work. A killed process
    # may leave RUNNING evidence, but can never leave a previous PASS in place.
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    stage = "runtime-validation"
    try:
        require(2 <= boundary_height < 2**32 and timeout > 0, "Invalid activation boundary or timeout")
        current_hashes = runtime_hashes(runtime)
        historical_hashes = runtime_hashes(historical_runtime) if historical_runtime else None
        report["currentRuntimeSha256"] = current_hashes
        report["historicalRuntimeSha256"] = historical_hashes
        script, nef, manifest = probe()
        report["probe"] = {"scriptHex": script.hex(), "nefSha256": hashlib.sha256(nef).hexdigest(), "manifest": manifest}
        with tempfile.TemporaryDirectory(prefix="smartaccount-activation-runners-") as scratch:
            root = Path(scratch)
            current = root / "current"
            current.mkdir()
            runner = make_runner(runtime, dotnet, current)
            cases = []
            if historical_runtime:
                previous = root / "historical"
                previous.mkdir()
                cases.append(("historical-future", make_runner(historical_runtime, dotnet, previous), 2**32 - 1, "HALT", None))
            cases.extend((("current-future", runner, 2**32 - 1, "FAULT", None),
                          ("current-disabled", runner, None, "FAULT", None),
                          ("current-active", runner, 0, "HALT", None),
                          ("current-live-boundary", runner, boundary_height, None, timeout)))
            for stage, selected, height, expected, boundary_timeout in cases:
                case = run_case(stage, selected, height, expected, boundary_timeout)
                report["cases"].append(case)
                print(stage + ": PASS", flush=True)
        stage = "runtime-stability"
        require(current_hashes == runtime_hashes(runtime), "Current runtime changed during validation")
        if historical_runtime:
            require(historical_hashes == runtime_hashes(historical_runtime), "Historical runtime changed during validation")
        report["runtimeHashesUnchanged"] = True
        report["diagnosticDeploymentsPersisted"] = len(report["cases"])
        report["protocolExecutionTransactionsPersisted"] = 0
        report["historicalRegressionReproduced"] = historical_runtime is not None
        report["ownedNodesStopped"] = True
        report["status"] = "PASS"
    except Exception as error:
        # Do not copy subprocess messages: they may contain wallet material or paths.
        report["failure"] = {"stage": stage, "type": type(error).__name__}
        raise
    finally:
        if report["status"] != "PASS":
            report["status"] = "FAIL"
        report["completedAtUtc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--historical-runtime", type=Path)
    parser.add_argument("--dotnet", type=Path, default=shutil.which("dotnet"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--boundary-height", type=int, default=8)
    parser.add_argument("--timeout", type=float, default=180)
    args = parser.parse_args()
    require(args.dotnet is not None, "A local dotnet executable is required")
    validate(args.runtime.resolve(), args.historical_runtime.resolve() if args.historical_runtime else None,
             Path(args.dotnet).resolve(), args.output, args.boundary_height, args.timeout)


if __name__ == "__main__":
    main()
