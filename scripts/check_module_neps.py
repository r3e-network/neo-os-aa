"""Verify the SmartAccount module proposals against source profiles and compiled ABIs."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from localchain.source_build import NefError, read_nef

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs/proposals"
INTERFACE = DOC / "nep-smartaccount-module-interface.mediawiki"
CATALOG = DOC / "nep-smartaccount-module-profiles.mediawiki"
GUIDE = DOC / "SMARTACCOUNT-MODULE-NEPS.zh-CN.md"
APPENDIX = DOC / "smartaccount-module-abis.md"
NAMED = DOC / "smartaccount-named-module-interfaces.json"
SCHEMA = DOC / "smartaccount-module-profile.schema.json"
TEMPLATE = ROOT / "tests/fixtures/sa-module-protocol/module-profile.template.json"
CONSTANT = re.compile(r'\bconst string ModuleProfileJson\s*=\s*("(?:\\.|[^"\\])*")\s*;')
# Unicode White_Space, matching the native string.IsNullOrWhiteSpace check.
# Python str.strip() additionally removes U+001C..U+001F.
PROFILE_WHITESPACE = frozenset(chr(i) for i in (
    *range(9, 14), 32, 0x85, 0xA0, 0x1680, *range(0x2000, 0x200B),
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000))
ROLES = {"validator": ["validateUserOp", "onUserOpComplete"], "hook": ["preCheck", "postCheck"], "recovery": []}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate key: {key}")
        result[key] = value
    return result


def profile(raw, name, role):
    p = json.loads(raw, object_pairs_hook=unique)
    require(0 < len(raw.encode()) <= 2048 and
            json.dumps(p, ensure_ascii=False, sort_keys=True, separators=(",", ":")) == raw,
            f"{name}: noncanonical or oversized profile")
    require(isinstance(p, dict) and set(p) == {"profileVersion", "moduleType", "contractName",
            "capabilities", "lifecycle", "callbacks"}, f"{name}: profile fields")
    require(isinstance(name, str) and any(c not in PROFILE_WHITESPACE for c in name) and
            type(p["profileVersion"]) is int and p["profileVersion"] == 1 and
            p["contractName"] == name and p["moduleType"] == role and role in ROLES, f"{name}: identity/role")
    caps = p["capabilities"]
    flags = {"instanceIsolation", "messageCapability", "thresholdMemberEligible"}
    require(isinstance(caps, dict) and set(caps) == flags | {"compositeLayer"} and
            all(type(caps[k]) is bool for k in flags) and type(caps["compositeLayer"]) is int and
            caps["compositeLayer"] in (0, 1), f"{name}: capability fields/types")
    require(role == "validator" or not (caps["messageCapability"] or caps["thresholdMemberEligible"]),
            f"{name}: invalid role capabilities")
    require(p["callbacks"] == ROLES[role] + (["isValidSignature"] if caps["messageCapability"] else []),
            f"{name}: callback list")
    require(p["lifecycle"] in (["onInstall", "onUninstall"], ["onInstall", "onUninstall", "configure"]),
            f"{name}: lifecycle list")
    return p


def discovery_schema():
    # Schema applies to parsed data. Canonical UTF-8 and manifest/role binding
    # must still be checked against the original bytes and the deployment.
    variants = []
    for role, callbacks in ROLES.items():
        for messages in ([False, True] if role == "validator" else [False]):
            flags = {"messageCapability": {"const": messages}}
            if role != "validator":
                flags["thresholdMemberEligible"] = {"const": False}
            variants.append({"properties": {"moduleType": {"const": role},
                             "callbacks": {"const": callbacks + (["isValidSignature"] if messages else [])},
                             "capabilities": {"properties": flags}}})
    caps = {k: {"type": "boolean"} for k in ("instanceIsolation", "messageCapability", "thresholdMemberEligible")}
    caps["compositeLayer"] = {"type": "integer", "enum": [0, 1]}
    properties = {
        "contractName": {"type": "string", "pattern": r"[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]"},
        "moduleType": {"enum": list(ROLES)}, "profileVersion": {"const": 1},
        "capabilities": {"type": "object", "additionalProperties": False, "required": list(caps), "properties": caps},
        "callbacks": {"type": "array"},
        "lifecycle": {"enum": [["onInstall", "onUninstall"], ["onInstall", "onUninstall", "configure"]]},
    }
    return {"$schema": "http://json-schema.org/draft-07/schema#", "title": "SmartAccount module discovery profile",
            "description": "Parsed discovery object only. Canonical encoding, byte length, manifest and installed role are checked separately.",
            "type": "object", "additionalProperties": False, "required": list(properties), "properties": properties, "oneOf": variants}


def check_project_coverage(contracts, projects):
    native_dir = contracts / "plugins/native-profile"
    native = json.loads((native_dir / "profiles.json").read_bytes(), object_pairs_hook=unique)
    covered = set(projects.values())
    for name, spec in native.items():
        require(name in projects and spec["project"] == f"{name}.Native.csproj",
                f"{name}: native build has no matching named module")
        covered.add(native_dir / spec["project"])
    covered.update(contracts / path for path in (
        "plugins/recovery/SocialRecoveryService.csproj", "plugins/templates/hook/HookTemplate.csproj",
        "plugins/templates/validator/ValidatorTemplate.csproj"))
    actual = set()
    for root in (contracts / "modules", contracts / "plugins"):
        for base, dirs, files in os.walk(root):
            dirs[:] = [d for d in dirs if d not in ("bin", "obj")]
            actual.update(Path(base) / f for f in files if f.endswith(".csproj"))
    require(actual == covered, f"module project inventory mismatch: {sorted(str(p.relative_to(contracts)) for p in actual ^ covered)}")


def check_core_envelope(proposal, protocol, native):
    # Never let the NEP or developer guide advertise a different signed layout.
    fields, = re.findall(r"<pre>\s*\[([^\[\]]+)\]\s*</pre>", proposal)
    documented = [s.strip() for s in fields.split(",")]
    table, = re.findall(r"### 4\.1 Wire shape.*?```\n(.*?)\n```", protocol, re.S)
    numbered = [(int(i), field) for i, field in re.findall(r"^\[(\d+)\]\s+(\w+)", table, re.M)]
    core = sorted((int(i), name[:1].lower() + name[1:]) for name, i in
                  re.findall(r"internal const int Op([A-Z]\w*) = (\d+);", native))
    count, = re.findall(r"internal const int UserOperationFieldCount = (\d+);", native)
    require(numbered == core == list(enumerate(documented)) and len(core) == int(count),
            "operation field order or count differs between core NEP, protocol and native core")


def sources():
    require(json.loads(SCHEMA.read_bytes(), object_pairs_hook=unique) == discovery_schema(), "stale discovery JSON Schema")
    check_core_envelope((DOC/"nep-smartaccount-entry-verifier.mediawiki").read_text(),
                        (DOC.parent/"SA-MODULE-PROTOCOL.md").read_text(),
                        (ROOT/"contracts/native/SmartAccount/SmartAccountModuleProtocol.cs").read_text())
    entries = re.findall(r"^=== (\w+) ===\nRole: (\w+)\.", CATALOG.read_text(), re.M)
    roles = unique(entries)
    links = re.findall(r"\[(\w+)\]\(nep-smartaccount-module-profiles\.mediawiki#(\w+)\)", GUIDE.read_text())
    require(unique(links) == {name: name for name in roles}, "Chinese module index differs from named clauses")
    paths = list((ROOT / "contracts/modules").glob("*/*.csproj"))
    files = [p.with_suffix(".cs") for p in paths]
    for directory in ("validators", "hooks", "recovery"):
        base = ROOT / "contracts/plugins" / directory
        # An unlisted project without a getter or sidecar must not disappear from coverage.
        for project in base.glob("*.csproj"):
            if (directory, project.stem) == ("recovery", "SocialRecoveryService"):
                continue
            require(project.stem in roles and project.with_suffix(".profile.json").is_file(),
                    f"{project.stem}: plugin project missing named clause or profile")
        for src in base.glob("*.cs"):
            sidecar = src.with_suffix(".profile.json")
            if "GetModuleProfile(" in src.read_text() or sidecar.exists():
                require(sidecar.is_file() and src.with_suffix(".csproj").is_file(), f"{src.stem}: missing sidecar/project")
                files.append(src)
        for sidecar in base.glob("*.profile.json"):
            require(sidecar.with_suffix("").with_suffix(".cs").is_file(), f"{sidecar}: missing implementation")
    names = {p.stem for p in files}
    require(len(names) == len(files) and names == roles.keys(),
            f"catalogue differs from implementations: {sorted(names ^ roles.keys())}")
    profiles = {}
    for src in sorted(files, key=lambda p: p.stem):
        name = src.stem
        source = src.read_text()
        values = CONSTANT.findall(source)
        require(len(values) == 1 and re.search(r"GetModuleProfile\(\)\s*=>\s*ModuleProfileJson\s*;", source),
                f"{name}: cannot verify profile getter")
        raw = json.loads(values[0])
        p = profile(raw, name, roles[name])
        sidecar = src.with_suffix(".profile.json")
        if sidecar.exists():
            require(sidecar.read_bytes() == raw.encode(), f"{name}: sidecar differs from getter")
        profiles[name] = (p, hashlib.sha256(raw.encode()).hexdigest())
    projects = {p.stem: p.with_suffix(".csproj") for p in files}
    check_project_coverage(ROOT / "contracts", projects)
    return profiles, projects


def signatures():
    pattern = r"^(?:all|optional|validator|message|hook)\s+(\w+)\(([^)]*)\) -> (\w+)( \[safe\])?$"
    return unique([(n, (args.split(",") if args else [], ret, bool(safe)))
                   for n, args, ret, safe in re.findall(pattern, INTERFACE.read_text(), re.M)])


def check_method(name, methods, key, types, ret, safe, script_length=None):
    matches = [m for m in methods if m["name"] == key and len(m["parameters"]) == len(types)]
    require(len(matches) == 1, f"{name}: missing or ambiguous {key}/{len(types)}")
    m = matches[0]
    offset = m.get("offset")
    require(type(offset) is int and offset >= 0 and (script_length is None or offset < script_length),
            f"{name}: invalid offset for {key}")
    require([arg["type"] for arg in m["parameters"]] == types and m["returntype"] == ret and
            type(m["safe"]) is bool and (safe is None or m["safe"] == safe), f"{name}: invalid signature for {key}")


def verify_manifest(p, manifest, specs, script_length=None):
    name = p["contractName"]
    require(manifest["name"] == name, f"{name}: manifest name")
    methods = manifest["abi"]["methods"]
    has_configure = any(m["name"] == "configure" and len(m["parameters"]) == 4 for m in methods)
    require(has_configure == ("configure" in p["lifecycle"]), f"{name}: configure/4 differs from lifecycle declaration")
    required = ["getModuleProfile", *p["lifecycle"], *p["callbacks"]]
    for key in required:
        types, ret, safe = specs[key]
        check_method(name, methods, key, types, ret, True if safe else None, script_length)
    return methods


def named_interfaces():
    return json.loads(NAMED.read_bytes(), object_pairs_hook=unique)


def check_command_clauses(named, prose):
    chapters = re.split(r"^=== (\w+) ===\nRole: \w+\.", prose, flags=re.M)
    for name, body in zip(chapters[1::2], chapters[2::2]):
        disabled = body.lstrip().startswith("Disabled ")
        require(named[name].get("disabled") is disabled, f"{name}: disabled flag differs from named clause")
        forms = [] if disabled else (["empty", "command"] if named[name]["commands"] else
                                      ["empty", "hookOrder"] if name == "HookOrchestratorModule" else ["empty"])
        require(named[name].get("installData") == forms, f"{name}: incorrect installation data forms")
        declared = {}
        for command, tail in re.findall(r'<code>\["(\w+)"([^\]]*)\]</code>', body):
            args = [a.strip() for a in tail.split(",")[1:]]
            require(command not in declared, f"{name}: duplicate command {command}")
            declared[command] = args
        expected = {}
        for cmd, fields in named[name]["commands"].items():
            require(all(re.fullmatch(r"\w+:(?:String|ByteArray|Integer|Boolean|Hash160(?:\[\])?)", f)
                        for f in fields), f"{name}.{cmd}: invalid field descriptor")
            expected[cmd] = [f.split(":")[0] for f in fields]
        require(declared == expected, f"{name}: command signatures differ between NEP and catalogue")
        require(not declared or "configure" in named[name]["lifecycle"], f"{name}: commands without configure")


def verify_named(p, methods, name, catalog, script_length=None):
    require(name in catalog, f"unknown named module: {name}")
    spec = catalog[name]
    for field in ("moduleType", "lifecycle", "capabilities"):
        require(p[field] == spec[field], f"{name}: named profile differs in {field}")
    for key, (types, ret, safe) in spec["methods"].items():
        check_method(name, methods, key, types, ret, safe, script_length)


def verify_native_packages(folder, profiles, projects):
    descriptor = json.loads((ROOT / "contracts/plugins/native-profile/profiles.json").read_bytes(), object_pairs_hook=unique)
    names = set(descriptor)
    for suffix in (".manifest.json", ".nef"):
        actual = {p.name.removesuffix(suffix) for p in folder.glob("*" + suffix)}
        require(actual == names, f"native package {suffix} inventory differs: {sorted(actual ^ names)}")
    receipt = json.loads((folder / "native-profile-packaging.json").read_bytes(), object_pairs_hook=unique)
    require(receipt["status"] == "PASS" and receipt["nefRewritten"] is False and receipt["artifacts"].keys() == names,
            "native packaging receipt is incomplete")
    common, named = signatures(), named_interfaces()
    for name in sorted(names):
        p, _ = profiles[name]
        manifest = folder / f"{name}.manifest.json"
        nef = folder / f"{name}.nef"
        manifest_bytes = manifest.read_bytes()
        nef_hash = hashlib.sha256(nef.read_bytes()).hexdigest()
        require(receipt["artifacts"][name] == {"nefSha256": nef_hash, "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest()},
                f"{name}: packaged bytes differ from build receipt")
        m = json.loads(manifest_bytes, object_pairs_hook=unique)
        require(m.get("extra", {}).get("SmartAccountProfile") == "native-smartaccount",
                f"{name}: missing native package marker")
        script_length = len(read_nef(nef)["script"])
        verify_named(p, verify_manifest(p, m, common, script_length), name, named, script_length)
        subprocess.run(["dotnet", "run", "--project", str(ROOT / "tests/NativeEpochProbe"), "--",
                        "--module-profile", str(nef.resolve()), str(manifest.resolve()),
                        str(projects[name].with_suffix(".profile.json"))], check=True, cwd=ROOT)
        print(f"{name}: named ABI and deployed native getter verified; NEF {nef_hash}", flush=True)


def appendix(profiles, folder):
    specs = signatures()
    named = named_interfaces()
    lines = ["# SmartAccount module ABIs", "",
             "Reference ABI for each [named profile](nep-smartaccount-module-profiles.mediawiki). "
             "Signatures and safe flags come from compiled manifests; each digest covers only the canonical profile bytes. "
             "The [interface](nep-smartaccount-module-interface.mediawiki) defines the common callbacks. "
             "A safe flag is not proof of authorization or behavior.", ""]
    for name, (p, digest) in profiles.items():
        path = folder / name / f"{name}.manifest.json"
        nef = path.with_name(f"{name}.nef")
        script_length = len(read_nef(nef)["script"]) if nef.exists() else None
        methods = verify_manifest(p, json.loads(path.read_bytes(), object_pairs_hook=unique), specs, script_length)
        verify_named(p, methods, name, named, script_length)
        lines.extend([f"## {name}", "", f"Role: {p['moduleType']}. Profile SHA-256: `{digest}`.", "",
                      "Capabilities: " + ", ".join(f"`{k}={json.dumps(v)}`" for k, v in p["capabilities"].items()) + ".", "",
                      "```text"])
        for m in sorted(methods, key=lambda m: (m["name"], len(m["parameters"]))):
            args = ", ".join(f"{a['name']}: {a['type']}" for a in m["parameters"])
            lines.append(f"{'safe ' if m['safe'] else ''}{m['name']}({args}) -> {m['returntype']}")
        lines.extend(["```", ""])
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifests", type=Path, help="read DIR/NAME/NAME.manifest.json for every module")
    parser.add_argument("--compiler", help="compile the module projects into a fresh directory with nccs")
    parser.add_argument("--vm-getters", action="store_true", help="deploy compiled modules locally and verify the exact profile bytes")
    parser.add_argument("--vm-commands", action="store_true", help="with --compiler, exercise named configuration commands in NeoVM")
    parser.add_argument("--write-abi", action="store_true", help="regenerate the reviewed ABI appendix")
    parser.add_argument("--profile", type=Path, help="canonical bytes returned by a third-party module")
    parser.add_argument("--manifest", type=Path, help="compiled manifest paired with --profile")
    parser.add_argument("--nef", type=Path, help="also deploy this NEF locally and compare the getter bytes with --profile")
    parser.add_argument("--named-profile", metavar="NAME", help="also check the selected named module interface")
    parser.add_argument("--native-packages", type=Path, metavar="DIR",
                        help="check the complete packaged native build against named interfaces and deployed getter bytes")
    args = parser.parse_args()
    if args.native_packages is not None:
        if any(v for k, v in vars(args).items() if k != "native_packages"):
            parser.error("--native-packages is a separate packaged-artifact check")
        verify_native_packages(args.native_packages, *sources())
        return
    if args.vm_commands and not args.compiler:
        parser.error("--vm-commands requires --compiler to build its test core")
    if args.profile or args.manifest or args.named_profile or args.nef:
        if not (args.profile and args.manifest) or args.manifests or args.compiler or args.write_abi or args.vm_getters:
            parser.error("use --profile FILE and --manifest FILE together, without catalogue options")
        raw = args.profile.read_bytes().decode("utf-8")
        manifest = json.loads(args.manifest.read_bytes(), object_pairs_hook=unique)
        p = profile(raw, manifest["name"], json.loads(raw, object_pairs_hook=unique)["moduleType"])
        script_length = len(read_nef(args.nef)["script"]) if args.nef else None
        methods = verify_manifest(p, manifest, signatures(), script_length)
        if args.named_profile:
            verify_named(p, methods, args.named_profile, named_interfaces(), script_length)
        if args.nef:
            subprocess.run(["dotnet", "run", "--project", str(ROOT / "tests/NativeEpochProbe"), "--",
                            "--module-profile", str(args.nef.resolve()), str(args.manifest.resolve()),
                            str(args.profile.resolve())], check=True, cwd=ROOT)
        print(f"{p['contractName']}: " + (f"{args.named_profile} and common" if args.named_profile else "common")
              + " module interface verified")
        if args.named_profile and named_interfaces()[args.named_profile]["disabled"]:
            print("Disabled named profile: wallets must not offer this feature.")
        return
    if args.compiler and args.manifests:
        parser.error("choose --compiler or --manifests")
    if args.write_abi and not (args.manifests or args.compiler):
        parser.error("--write-abi requires --compiler or --manifests")
    if args.vm_getters and not (args.manifests or args.compiler):
        parser.error("--vm-getters requires --compiler or --manifests with matching NEFs")
    profiles, projects = sources()
    named = named_interfaces()
    require(named.keys() == profiles.keys(), "named interface inventory differs from catalogue")
    check_command_clauses(named, CATALOG.read_text())
    for name, (p, _) in profiles.items():
        for field in ("moduleType", "lifecycle", "capabilities"):
            require(named[name][field] == p[field], f"{name}: stale {field} in named interface")
    profile(TEMPLATE.read_text().removesuffix("\n"), "ExampleValidator", "validator")
    example = re.search(r"<pre>\n(\{[^\n]+\})\n</pre>", INTERFACE.read_text()).group(1)
    require(profile(example, "RecoveryModule", "recovery") == profiles["RecoveryModule"][0], "stale recovery example")
    if args.compiler or args.manifests:
        def check_artifacts(folder):
            result = appendix(profiles, folder)
            if args.vm_getters:
                digests = {name: digest for name, (_, digest) in profiles.items()}
                subprocess.run(["dotnet", "run", "--project", str(ROOT / "tests/NativeEpochProbe"),
                                "--", "--module-profiles", str(folder.resolve()), json.dumps(digests)], check=True, cwd=ROOT)
            if args.vm_commands:
                probe = ROOT / "tests/NativeEpochProbe"
                fixture = folder / "_test_core"
                fixture.mkdir()
                subprocess.run([args.compiler, str(probe / "contracts/NativeEpochCore.csproj"), "-o", str(fixture)],
                               check=True, cwd=ROOT)
                subprocess.run(["dotnet", "run", "--project", str(probe), "--", "--module-commands",
                                str(folder.resolve()), str(fixture / "NativeEpochCore"), str(NAMED)], check=True, cwd=ROOT)
            return result
        if args.compiler:
            with tempfile.TemporaryDirectory(prefix="sa-nep-") as tmp:
                for name, project in sorted(projects.items()):
                    dest = Path(tmp) / name
                    dest.mkdir()
                    subprocess.run([args.compiler, str(project), "-o", str(dest)], check=True, cwd=ROOT)
                expected = check_artifacts(Path(tmp))
        else:
            expected = check_artifacts(args.manifests)
        if args.write_abi:
            APPENDIX.write_text(expected)
        else:
            require(APPENDIX.read_text() == expected, "ABI appendix differs from compiled manifests")
    else:
        recorded = re.findall(r"^## (\w+)\n\nRole: (\w+)\. Profile SHA-256: `([a-f0-9]{64})`\.", APPENDIX.read_text(), re.M)
        require(recorded == [(n, p["moduleType"], d) for n, (p, d) in profiles.items()], "stale ABI profile inventory")
    print(f"{len(profiles)} module profiles verified" + (" against compiled manifests" if args.manifests or args.compiler else " against source"))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError, NefError, subprocess.CalledProcessError) as exc:
        sys.exit(f"Module NEP check failed: {exc}")
