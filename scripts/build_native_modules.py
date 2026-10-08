#!/usr/bin/env python3
"""Reproduce native module builds from explicit linked sources and capability data."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from native_module_profile import package, prepare_native_source, validate_descriptor


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_input(root, path):
    lexical = Path(os.path.abspath(path))
    if not lexical.is_relative_to(root) or any(p.is_symlink() for p in [lexical, *lexical.parents] if p.is_relative_to(root)):
        raise ValueError("Native input must remain in the source tree without symbolic links")
    if not lexical.is_file():
        raise ValueError("Native input must be an existing regular file")
    return lexical


def build(contracts, compiler, cache, output, receipt):
    report={"schema":"smartaccount-native-module-build/v1","status":"RUNNING","publicNetworksTouched":False,"nefRewritten":False}
    receipt.parent.mkdir(parents=True,exist_ok=True);receipt.write_text(json.dumps(report)+"\n")
    try:
        if output.exists():raise ValueError("Native output must be a new directory")
        descriptor=checked_input(contracts,contracts/"native/profiles.json");profiles=validate_descriptor(json.loads(descriptor.read_text()))
        inputs={"Directory.Build.props","native/profiles.json"}
        for name,spec in profiles.items():
            project=checked_input(contracts,contracts/"native"/spec["project"]);inputs.add(project.relative_to(contracts).as_posix())
            for item in ET.parse(project).findall(".//Compile"):
                path=checked_input(contracts,project.parent/item.attrib["Include"])
                inputs.add(path.relative_to(contracts).as_posix())
        pins={str(path):digest(checked_input(contracts,contracts/path)) for path in sorted(inputs)}
        version=subprocess.check_output([str(compiler),"--version"],text=True).strip()
        versions=ET.parse(contracts/"Directory.Build.props").findall(".//NeoSmartContractFrameworkVersion")
        if len(versions)!=1 or not versions[0].text:raise ValueError("A single explicit framework version is required")
        framework=versions[0].text.lower()
        if any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in framework):raise ValueError("Invalid framework version")
        archive=cache/"neo.smartcontract.framework"/framework/f"neo.smartcontract.framework.{framework}.nupkg"
        report.update(compilerVersion=version,compilerLauncherSha256=digest(compiler),frameworkArchiveSha256=digest(archive),sourceSha256=pins,
                      recipeSha256=digest(Path(__file__)),packagingRecipeSha256=digest(Path(__file__).with_name("native_module_profile.py")))
        artifacts=[];prepared=[]
        with tempfile.TemporaryDirectory(prefix="smartaccount-native-build-") as temp:
            for index in (1,2):
                root=Path(temp)/f"build-{index}";root.mkdir()
                for name in pins:
                    src=contracts/name;dest=root/name;dest.parent.mkdir(parents=True,exist_ok=True)
                    if src.suffix==".cs":prepare_native_source(src,dest)
                    else:shutil.copyfile(src,dest)
                prepared.append({name:digest(root/name) for name in pins})
                config=ET.Element("configuration");feeds=ET.SubElement(config,"packageSources");ET.SubElement(feeds,"clear")
                ET.SubElement(feeds,"add",key="offline",value=str(cache));ET.ElementTree(config).write(root/"NuGet.Config")
                raw=root/"raw";raw.mkdir()
                for spec in profiles.values():
                    result=subprocess.run([str(compiler),str(root/"native"/spec["project"]),"-o",str(raw)],capture_output=True,text=True,timeout=180)
                    if result.returncode:
                        raise RuntimeError("Native compiler failed: "+result.stdout[-1000:]+result.stderr[-1000:])
                packaged=root/"packaged";package(raw,packaged,root/"native/profiles.json")
                files={p.name:digest(p) for p in packaged.iterdir() if p.suffix in (".nef",".json")}
                artifacts.append(files)
                if index==1:
                    candidate=root/"retained";shutil.copytree(packaged,candidate)
                    retained=candidate;raw_retained=raw
            if artifacts[0]!=artifacts[1] or prepared[0]!=prepared[1]:raise ValueError("Native artifacts are not reproducible")
            for name,pin in pins.items():
                if digest(contracts/name)!=pin:raise ValueError("Native build input changed")
            output.parent.mkdir(parents=True,exist_ok=True);shutil.copytree(retained,output);shutil.copytree(raw_retained,output/"raw")
        report.update(status="PASS",builds=artifacts,preparedSourceSha256=prepared[0],reproducible=True)
    finally:
        if report["status"]!="PASS":report["status"]="FAIL"
        report["completedAtUtc"]=datetime.now(timezone.utc).isoformat();receipt.write_text(json.dumps(report,indent=2)+"\n")
    return report


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("contracts","compiler","cache","output","receipt"):parser.add_argument("--"+name,type=Path,required=True)
    a=parser.parse_args();build(a.contracts.resolve(),a.compiler.resolve(),a.cache.resolve(),a.output.resolve(),a.receipt.resolve())
