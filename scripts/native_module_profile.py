#!/usr/bin/env python3
"""Check and package native module metadata without changing compiler NEF bytes."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import re


def validate_descriptor(profiles):
    if type(profiles) is not dict or not profiles:
        raise ValueError("Native descriptor must be a nonempty object")
    for name, spec in profiles.items():
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", name) or type(spec) is not dict:
            raise ValueError("Invalid native artifact descriptor")
        if set(spec) != {"project", "role", "configurationMethods"} or spec["role"] not in ("verifier", "hook"):
            raise ValueError("Invalid native role or descriptor fields")
        if type(spec["project"]) is not str or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*\.csproj", spec["project"]):
            raise ValueError("Invalid native project name")
        names = spec["configurationMethods"]
        if type(names) is not list or not names or any(type(n) is not str or not n for n in names) or len(set(names)) != len(names):
            raise ValueError("Configuration capabilities must be a nonempty unique name array")
    return profiles


def prepare_native_source(source, destination):
    destination.write_text("#define SMARTACCOUNT_NATIVE\n" + source.read_text(encoding="utf-8-sig"))


def package_manifest(original, role, capabilities):
    if role not in ("verifier", "hook") or original.get("extra", {}).get("SmartAccountProfile") != "native-v1":
        raise ValueError("Explicit native profile marker and role required")
    methods = original.get("abi", {}).get("methods", [])
    def require(name, result, types, safe=None):
        found = [m for m in methods if m["name"] == name and len(m["parameters"]) == len(types)]
        if len(found) != 1 or found[0]["returntype"] != result or [p["type"] for p in found[0]["parameters"]] != types:
            raise ValueError("Incorrect native lifecycle ABI: " + name)
        if safe is not None and found[0].get("safe") is not safe:
            raise ValueError("Incorrect native lifecycle safety: " + name)
    require("supportsComposition", "Boolean", [], True)
    require("clearAccount", "Void", ["Hash160"], False)
    require("postExecute", "Void", ["Hash160", "Array", "Any"])
    require("validateSignature" if role == "verifier" else "preExecute", "Boolean" if role == "verifier" else "Void", ["Hash160", "Array"])
    if role == "verifier": require("getSignerDomains", "Array", ["Hash160"], True)
    forbidden = {"validateSignature", "preExecute", "postExecute", "clearAccount", "supportsComposition", "getSignerDomains"}
    if type(capabilities) is not list or not capabilities or any(type(n) is not str or not n or n.startswith("_") or n in forbidden for n in capabilities) or len(set(capabilities)) != len(capabilities):
        raise ValueError("Invalid native configuration capabilities")
    for name in capabilities:
        found = [m for m in methods if m["name"] == name]
        if len(found) != 1 or found[0].get("safe") is not False or not found[0]["parameters"] or found[0]["parameters"][0]["type"] != "Hash160":
            raise ValueError("Configuration method must be unique, non-safe and account scoped")
    manifest = copy.deepcopy(original)
    if "smartAccount" in manifest["extra"]:
        raise ValueError("Compiler metadata already contains a native capability declaration")
    manifest["extra"]["smartAccount"] = {"configurationMethods": list(capabilities)}
    return manifest


def package(raw, output, descriptor):
    output.mkdir(parents=True, exist_ok=True)
    report = {"status": "RUNNING", "nefRewritten": False, "artifacts": {}}
    target = output / "native-profile-packaging.json"
    target.write_text(json.dumps(report) + "\n")
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    try:
        report["descriptorSha256"] = digest(descriptor)
        report["recipeSha256"] = digest(Path(__file__))
        if raw.resolve() == output.resolve():
            raise ValueError("Packaging output must differ from compiler input")
        for name, spec in validate_descriptor(json.loads(descriptor.read_text())).items():
            nef = raw / (name + ".nef"); original = raw / (name + ".manifest.json")
            m = json.loads(original.read_text())
            if m["name"] != name: raise ValueError("Manifest name mismatch")
            final = package_manifest(m, spec["role"], spec["configurationMethods"])
            data = nef.read_bytes()
            if len(data) < 79 or data[:4] != b"NEF3" or data[-4:] != hashlib.sha256(hashlib.sha256(data[:-4]).digest()).digest()[:4]:
                raise ValueError("Invalid compiler NEF checksum")
            destination = output / nef.name; shutil.copyfile(nef, destination)
            manifest = output / original.name
            manifest.write_text(json.dumps(final, ensure_ascii=False, separators=(",", ":")) + "\n")
            report["artifacts"][name] = {"nefSha256": digest(destination), "rawManifestSha256": digest(original), "packagedManifestSha256": digest(manifest)}
        report["status"] = "PASS"
    finally:
        if report["status"] != "PASS": report["status"] = "FAIL"
        target.write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("raw", "output", "descriptor"): parser.add_argument("--" + key, type=Path, required=True)
    args = parser.parse_args(); package(args.raw, args.output, args.descriptor)
