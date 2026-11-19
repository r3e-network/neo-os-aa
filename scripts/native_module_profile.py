#!/usr/bin/env python3
"""Admit ABI v4 native modules without changing compiler NEF bytes.

Protocol v4 replaced the manifest-rewriting admission gate: a module declares
its capabilities through `getModuleProfile()` and the core verifies the profile
digest at install time, so packaging must never graft an `extra.smartAccount`
declaration onto the compiler manifest. What remains here is the read-only
admission check: the native-v4 marker, the v4 lifecycle ABI, the exact native
service permission allowlist and the NEF checksum. Anything else fails closed.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import re

MARKER = "native-v4"
ABI_VERSION = 4


def validate_descriptor(profiles):
    if type(profiles) is not dict or not profiles:
        raise ValueError("Native descriptor must be a nonempty object")
    for name, spec in profiles.items():
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name) or type(spec) is not dict:
            raise ValueError("Invalid native artifact descriptor")
        if set(spec) != {"project", "role", "configurationMethods", "compositeVerifier", "compositeProfile"} or spec["role"] not in ("verifier", "hook"):
            raise ValueError("Invalid native role or descriptor fields")
        if type(spec["compositeVerifier"]) is not bool or spec["role"] == "hook" and spec["compositeVerifier"]:
            raise ValueError("Native compositeVerifier must be an explicit verifier-only Boolean")
        # v4 replaced composite verifiers with the core threshold policy; the
        # descriptor keeps the fields so an old descriptor cannot be silently
        # reinterpreted, but only the "not composite" value is admissible.
        if spec["compositeVerifier"]:
            raise ValueError("Protocol v4 replaced composite verifiers with the core threshold policy")
        if type(spec["compositeProfile"]) is not str or spec["compositeProfile"]:
            raise ValueError("Protocol v4 replaced composite verifiers with the core threshold policy")
        if type(spec["project"]) is not str or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*\.csproj", spec["project"]):
            raise ValueError("Invalid native project name")
        names = spec["configurationMethods"]
        if type(names) is not list or not names or any(type(n) is not str or not n for n in names) or len(set(names)) != len(names):
            raise ValueError("Configuration capabilities must be a nonempty unique name array")
    return profiles


def prepare_native_source(source, destination):
    data = source.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        data = data[3:]
    destination.write_bytes(b"#define SMARTACCOUNT_NATIVE\n" + data)


def profile_digest(parameters):
    value = json.loads(parameters.read_text())
    if type(value) is not dict or type(value.get("profileVersion")) is not int or value["profileVersion"] != ABI_VERSION:
        raise ValueError("Explicit ABI 4 profile parameters are required")
    if value.get("abiVersion") != ABI_VERSION:
        raise ValueError("Explicit ABI 4 profile parameters are required")
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(b"NeoSmartAccount/Profile" + bytes([ABI_VERSION]) + canonical).hexdigest()


NATIVE_CONTRACT = "398dc3f0227d7efac5533ed5ce9937390c158084"
NATIVE_CONTRACT_METHODS = {
    "NeoWitnessValidator": {"getAuthorizedModuleId", "getModule"},
    "WhitelistHook": {"getAuthorizedModuleId"},
    "SessionKeyValidator": {"getAuthorizedModuleId", "getAccountAddress", "getModule"},
    "DailyLimitHook": {"getAccountAddress", "getAuthorizedModuleId"},
    "TokenRestrictedHook": {"getAccountAddress", "getAuthorizedModuleId"},
    "MultiSigValidator": {"getAuthorizedModuleId", "getModule"},
}
# Lifecycle callbacks are invoked only through an authenticated native module
# context, so the manifest must publish them as non-safe ABI methods.
LIFECYCLE = (
    ("getModuleProfile", [], True),
    ("onInstall", ["Hash160", "Integer", "Integer", "Array"], False),
    ("configure", ["Hash160", "Integer", "Integer", "Array"], False),
    ("onUninstall", ["Hash160", "Integer", "Integer", "Array"], False),
)
ROLE_CALLBACKS = {
    "verifier": (("validateUserOp", "Boolean", ["Hash160", "ByteString", "Array"], False),
                 ("onUserOpComplete", "Void", ["Hash160", "Array", "Any"], False),
                 ("getSignerDomains", "Array", ["Hash160", "Integer"], True)),
    "hook": (("preCheck", "ByteString", ["Hash160", "Array"], False),
             ("postCheck", "Void", ["Hash160", "Array", "Any", "ByteString"], False)),
}


def package_manifest(original, role, capabilities, composite_verifier, parameter_digest, composite_profile=""):
    """Validate one compiler manifest against the v4 native module admission rules."""
    if role not in ("verifier", "hook") or original.get("extra", {}).get("SmartAccountProfile") != MARKER:
        raise ValueError("Explicit native-v4 profile marker and role required")
    if type(composite_verifier) is not bool or role == "hook" and composite_verifier:
        raise ValueError("Explicit verifier-only compositeVerifier Boolean required")
    if composite_verifier or composite_profile:
        raise ValueError("Protocol v4 replaced composite verifiers with the core threshold policy")
    if type(parameter_digest) is not str or not re.fullmatch(r"[0-9a-f]{64}", parameter_digest):
        raise ValueError("Explicit canonical profile digest required")
    name = original.get("name")
    expected_contract_methods = NATIVE_CONTRACT_METHODS.get(name)
    if expected_contract_methods is None:
        raise ValueError("Native-v4 module has no permission profile: " + str(name))
    permissions = original.get("permissions", [])
    native_contract_entries = [
        p for p in permissions
        if isinstance(p, dict) and isinstance(p.get("contract"), str)
        and p["contract"].lower().removeprefix("0x") == NATIVE_CONTRACT
    ] if isinstance(permissions, list) else []
    if len(native_contract_entries) != 1 or not isinstance(native_contract_entries[0].get("methods"), list):
        raise ValueError("Native-v4 requires one exact native contract permission entry")
    native_contract_methods = native_contract_entries[0]["methods"]
    if (any(not isinstance(method, str) for method in native_contract_methods)
            or set(native_contract_methods) != expected_contract_methods
            or len(native_contract_methods) != len(expected_contract_methods)):
        raise ValueError("Native-v4 native contract permission allowlist mismatch for " + name)
    methods = original.get("abi", {}).get("methods", [])

    def require(method, result, types, safe=None, result_any=()):
        found = [m for m in methods if m["name"] == method and len(m["parameters"]) == len(types)]
        accepted = (result, *result_any) if result_any else (result,)
        if len(found) != 1 or found[0]["returntype"] not in accepted or [p["type"] for p in found[0]["parameters"]] != types:
            raise ValueError("Incorrect native lifecycle ABI: " + method)
        if safe is not None and found[0].get("safe") is not safe:
            raise ValueError("Incorrect native lifecycle safety: " + method)

    require("getModuleProfile", "String", [], True, result_any=("ByteString",))
    for method, types, safe in LIFECYCLE[1:]:
        require(method, "Void", types, safe)
    for method, result, types, safe in ROLE_CALLBACKS[role]:
        require(method, result, types, safe)
    # `configure` is the declared instance configuration entrypoint, so only
    # the read-only profile getter and the install/uninstall callbacks are
    # reserved against capability declarations.
    forbidden = {"getModuleProfile", "onInstall", "onUninstall"} | {method for method, _, _, _ in ROLE_CALLBACKS[role]}
    if type(capabilities) is not list or not capabilities or any(type(n) is not str or not n or n.startswith("_") or n in forbidden for n in capabilities) or len(set(capabilities)) != len(capabilities):
        raise ValueError("Invalid native configuration capabilities")
    for capability in capabilities:
        found = [m for m in methods if m["name"] == capability]
        if len(found) != 1 or found[0].get("safe") is not False or not found[0]["parameters"] or found[0]["parameters"][0]["type"] != "Hash160":
            raise ValueError("Configuration method must be unique, non-safe and account scoped")
    return copy.deepcopy(original)


def package(raw, output, descriptor, parameters):
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "RUNNING", "nefRewritten": False, "artifacts": {}}
    target = output / "native-profile-packaging.json"
    target.write_text(json.dumps(report) + "\n")
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    try:
        report["descriptorSha256"] = digest(descriptor)
        report["profileParametersSha256"] = digest(parameters)
        report["profileDigest"] = profile_digest(parameters)
        report["recipeSha256"] = digest(Path(__file__))
        if raw.resolve() == output.resolve():
            raise ValueError("Packaging output must differ from compiler input")
        for name, spec in validate_descriptor(json.loads(descriptor.read_text())).items():
            nef = raw / (name + ".nef"); original = raw / (name + ".manifest.json")
            m = json.loads(original.read_text())
            if m["name"] != name: raise ValueError("Manifest name mismatch")
            package_manifest(m, spec["role"], spec["configurationMethods"], spec["compositeVerifier"], report["profileDigest"], spec["compositeProfile"])
            data = nef.read_bytes()
            if len(data) < 79 or data[:4] != b"NEF3" or data[-4:] != hashlib.sha256(hashlib.sha256(data[:-4]).digest()).digest()[:4]:
                raise ValueError("Invalid compiler NEF checksum")
            destination = output / nef.name; shutil.copyfile(nef, destination)
            manifest = output / original.name
            shutil.copyfile(original, manifest)
            report["artifacts"][name] = {"nefSha256": digest(destination), "manifestSha256": digest(manifest)}
        report["status"] = "PASS"
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        target.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("raw", "output", "descriptor", "parameters"): parser.add_argument("--" + key, type=Path, required=True)
    args = parser.parse_args(); package(args.raw, args.output, args.descriptor, args.parameters)
