"""Check the source binding of the normal evaluation-stack return projection."""
import argparse
import json
from pathlib import Path

from entry_dispatch_source import SOURCES, VM_COMMIT, download_pinned, mirror_source, require, sha, source_url

CONTROL = dict(repository="neo-vm", commit=VM_COMMIT,
               relativePath="src/Neo.VM/JumpTable/JumpTable.Control.cs",
               sha256="a0ac51ff220abbfcf8fb8c19bb0f2b8be4680169ba8ba33f6ededfc5e5e6a2ec")

# Pin complete files and check the transition steps in execution order.
# This is a source correspondence check, not a verified C# interpreter.
STEPS = {
    "vm/control": ("public virtual void Ret(", [
        "var context_pop = engine.InvocationStack.Pop();",
        "engine.InvocationStack.Count == 0 ? engine.ResultStack : engine.InvocationStack.Peek().EvaluationStack",
        "if (context_pop.EvaluationStack != stack_eval)",
        "if (context_pop.RVCount >= 0 && context_pop.EvaluationStack.Count != context_pop.RVCount)",
        "throw new InvalidOperationException(", "context_pop.EvaluationStack.CopyTo(stack_eval);",
        "if (engine.InvocationStack.Count == 0)", "engine.State = VMState.HALT;",
        "engine.ContextUnloaded(context_pop);", "engine.isJumping = true;"]),
    "vm/stack": ("internal void CopyTo(EvaluationStack stack, int count = -1)", [
        "if (count < -1 || count > _innerList.Count)", "if (count == 0) return;",
        "if (count == -1 || count == _innerList.Count)", "stack._innerList.AddRange(_innerList);"]),
    "vm/engine": ("internal protected virtual void ContextUnloaded(", [
        "if (InvocationStack.Count == 0)", "CurrentContext = null;", "EntryContext = null;", "else",
        "CurrentContext = InvocationStack.Peek();", "context.StaticFields.ClearReferences();",
        "context.LocalVariables?.ClearReferences();", "context.Arguments?.ClearReferences();"]),
    "core/engine": ("protected override void ContextUnloaded(", [
        "base.ContextUnloaded(context);", "if (context.Script != CurrentContext?.Script)",
        "if (UncaughtException is null)", "state.SnapshotCache?.Commit();", "if (CurrentContext != null)",
        "contextState.NotificationCount += state.NotificationCount;", "if (state.IsDynamicCall)",
        "if (context.EvaluationStack.Count == 0)", "Push(StackItem.Null);",
        "else if (context.EvaluationStack.Count > 1)", "throw new NotSupportedException(",
        "Diagnostic?.ContextUnloaded(context);", "if (contractTasks.Remove(context, out var awaiter))"]),
}


def project(text, header, ordered):
    require(text.count(header) == 1, "ambiguous method")
    before, after = text.split(header)
    indent = before.rsplit("\n", 1)[1]
    require(not indent.strip(), "unexpected method indentation")
    method, end, _ = after.partition("\n" + indent + "}")
    require(end, "unterminated method")
    for term in ordered:
        require(term in method, "return projection differs at: " + term)
        method = method.split(term, 1)[1]


def check():
    hashes = {}
    for key, (header, sequence) in STEPS.items():
        pin = CONTROL if key == "vm/control" else SOURCES[key]
        raw = mirror_source(key, pin) or download_pinned(source_url(pin))
        require(sha(raw) == pin["sha256"], "source hash mismatch: " + key)
        project(raw.decode("utf-8-sig"), header, sequence)
        hashes[key] = dict(commit=pin["commit"], path=pin["relativePath"], sha256=pin["sha256"])
    return hashes


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    dest = parser.parse_args().output
    dest.write_text('{"status":"INCOMPLETE"}\n')
    dest.write_text(json.dumps(dict(status="PASS_SOURCE_CHECK", sources=check(),
        scope="Source identity and order of projected operations; successful, noninterfering unload effects assumed."),
        indent=2)+"\n")
