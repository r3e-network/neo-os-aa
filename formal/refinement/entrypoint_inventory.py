"""Exact-byte entrypoint dependency inventory, deliberately not a proof checker.

Explicit edges use the independently attested Neo.VM 3.10.1 decoder. Compiler
debug ranges and typed Roslyn identities are bound data, not trusted theorems.
No structural candidate or graph result establishes source/VM correspondence.
"""
import argparse
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
NEO_CORE_COMMIT = 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d'


def module(name):
    spec = importlib.util.spec_from_file_location('entrypoint_' + name, HERE / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def reachable(graph, seeds):
    seen, pending = set(), list(seeds)
    while pending:
        node = pending.pop()
        if node not in seen:
            seen.add(node)
            pending.extend(graph.get(node, ()))
    return seen


def cyclic_components(graph):
    """Iterative Kosaraju; large scripts must not depend on Python recursion limit."""
    nodes = set(graph)
    nodes.update(target for targets in graph.values() for target in targets)
    visited, order = set(), []
    for seed in sorted(nodes):
        if seed in visited:
            continue
        visited.add(seed)
        stack = [(seed, iter(sorted(graph.get(seed, ())))) ]
        while stack:
            node, iterator = stack[-1]
            child = next(iterator, None)
            if child is None:
                order.append(node)
                stack.pop()
            elif child not in visited:
                visited.add(child)
                stack.append((child, iter(sorted(graph.get(child, ())))))
    reverse = defaultdict(set)
    for node, targets in graph.items():
        for target in targets:
            reverse[target].add(node)
    seen, components = set(), []
    for seed in reversed(order):
        if seed in seen:
            continue
        component, pending = set(), [seed]
        seen.add(seed)
        while pending:
            node = pending.pop()
            component.add(node)
            for child in reverse.get(node, ()):
                if child not in seen:
                    seen.add(child)
                    pending.append(child)
        if len(component) > 1 or seed in graph.get(seed, ()):
            components.append(sorted(component))
    return sorted(components)


def source_inventory(methods, inputs):
    rows, by_display, ids = [], defaultdict(list), set()
    for method in methods:
        require(isinstance(method, dict) and isinstance(method.get('id'), str), 'invalid typed source method')
        require(method['id'] not in ids, 'duplicate typed source identity')
        ids.add(method['id'])
        by_display[method.get('displayName')].append(method)
        calls, symbols, loops, unexported = set(), set(), 0, set()
        unresolved_invocations = 0
        pending = list(method.get('operations', []))
        while pending:
            node = pending.pop()
            require(isinstance(node, dict), 'invalid typed operation')
            loops += node.get('kind') == 'Loop'
            pending.extend(node.get('children', []))
            unexported.update(node.get('unexportedMetadata', []))
            unexported.update('semanticCollections.' + key + ':incomplete'
                              for key, value in node.get('semanticCollections', {}).items()
                              if isinstance(value, dict) and value.get('complete') is False)
            node_calls = set()
            # Bound details include invocation, constructor, conversion/operator
            # methods and property/field references. Do not infer compiler calls
            # from spelling or equate source calls with byte CALL instructions.
            values = [node.get('details', {}), node.get('boundMetadata', {}), node.get('semanticCollections', {})]
            while values:
                value = values.pop()
                if isinstance(value, dict):
                    values.extend(value.values())
                elif isinstance(value, list):
                    values.extend(value)
                elif isinstance(value, str):
                    if value.startswith('M:'):
                        calls.add(value)
                        node_calls.add(value)
                    elif value.startswith(('P:', 'F:')):
                        symbols.add(value)
            unresolved_invocations += node.get('kind') in {'Invocation', 'DynamicInvocation'} and not node_calls
        location = method.get('location') or {}
        rows.append({'id': method['id'], 'displayName': method.get('displayName'), 'location': location,
                     'origin': method.get('origin'), 'operationsSha256': digest(method.get('operations', [])),
                     'exportIssue': method.get('exportIssue'), 'calls': sorted(calls), 'symbolReferences': sorted(symbols),
                     'loopCount': loops, 'sourceInputBound': location.get('path') in inputs,
                     'unexportedMetadata': sorted(unexported), 'unresolvedInvocationCount': unresolved_invocations})
    for row in rows:
        row['externalSourceReferences'] = [name for name in row['calls'] if name not in ids]
    return rows, by_display


def reference_decoder_profile():
    """Textual recognition profile only, not semantics or Coq proof extraction.

    Read the current reference model rather than maintaining a second manual
    opcode allowlist. A changed syntax fails closed instead of accepting more
    opcodes. Values, faults, frame effects and termination still need proofs.
    """
    path = HERE / 'coq/CapMethodVm.v'
    raw = path.read_bytes()
    text = raw.decode('utf-8')
    match = re.search(r'Definition decode .*?(?=Inductive Outcome)', text, re.S)
    require(match is not None, 'reference decoder definition missing')
    body = match.group()
    fixed = {int(number) for number in re.findall(r'\| (\d+)%nat(?:::| =>)', body)}
    ranges = re.findall(r'\((\d+) <=\? byte\)%nat && \(byte <=\? (\d+)\)%nat', body)
    require(fixed and ranges and '| _ => None' in body, 'unrecognized reference decoder syntax')
    for first, last in ranges:
        fixed.update(range(int(first), int(last) + 1))
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
            'recognizedOpcodeBytes': sorted(fixed), 'scope': 'Textual byte recognition only; no semantics theorem inferred'}


def build_entrypoint_inventory(inventory):
    target = inventory.get('nef', {})
    try:
        script = bytes.fromhex(target['scriptHex'])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError('invalid script bytes') from exc
    require(hashlib.sha256(script).hexdigest() == target.get('scriptSha256'), 'script identity mismatch')
    require(isinstance(target.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', target['sha256']), 'missing NEF identity')
    tokens = target.get('tokens', [])
    require(isinstance(tokens, list) and all(isinstance(t, dict) for t in tokens), 'invalid token descriptors')
    decoder = module('nef_decode')
    decoded = decoder.decode_script(script, len(tokens))
    exported = target.get('instructions', [])
    require(len(exported) == len(decoded) and all(isinstance(e, dict) and all(e.get(k) == v for k, v in d.items())
            for d, e in zip(decoded, exported)), 'independent instruction metadata mismatch')
    mapping = inventory.get('sourceMap', {})
    require(mapping.get('exactByteMatch') is True and mapping.get('exactManifestMatch') is True, 'missing exact artifact mapping')
    inputs = inventory.get('inputs', {})
    require(isinstance(inputs, dict), 'invalid source input snapshot')
    sources, by_display = source_inventory(inventory.get('source', {}).get('methods', []), inputs)
    boundaries = {row['offset'] for row in decoded} | {len(script)}
    methods, debug_abi, method_ids = [], {}, set()
    for debug in mapping.get('debug', {}).get('methods', []):
        text = debug.get('range')
        require(isinstance(text, str) and re.fullmatch(r'\d+-\d+', text), 'invalid debug range')
        start, last = map(int, text.split('-'))
        end = last + 1
        require(start in boundaries and end in boundaries and 0 <= start < end <= len(script), 'partial instruction range')
        require(debug.get('id') not in method_ids, 'duplicate byte method identity')
        method_ids.add(debug.get('id'))
        matching = by_display.get(debug.get('id'), [])
        require(len(matching) == 1, 'missing or ambiguous typed source binding')
        source = matching[0]
        require(source.get('origin') == 'repository-source' and (source.get('location') or {}).get('path') in inputs,
                'missing source input membership')
        require(not source.get('exportIssue'), 'typed source export issue')
        methods.append({'start': start, 'endExclusive': end, 'byteCount': end-start, 'debugId': debug['id'],
                        'sourceMethod': source['id'], 'sourceLocation': source.get('location'),
                        'methodBytesSha256': hashlib.sha256(script[start:end]).hexdigest()})
        if 'abi' in debug:
            descriptor = debug['abi']
            require(isinstance(descriptor, dict), 'invalid debug ABI descriptor')
            key = descriptor.get('name'), len(descriptor.get('parameters', []))
            require(key not in debug_abi and descriptor.get('offset') == start, 'ambiguous debug ABI entry')
            debug_abi[key] = descriptor
    methods.sort(key=lambda row: row['start'])
    require(all(a['endExclusive'] <= b['start'] for a, b in zip(methods, methods[1:])), 'overlapping byte methods')
    descriptors, keys = inventory.get('manifest', {}).get('methods', []), set()
    for descriptor in descriptors:
        require(isinstance(descriptor, dict) and isinstance(descriptor.get('name'), str)
                and isinstance(descriptor.get('parameters'), list), 'invalid ABI descriptor')
        key = descriptor['name'], len(descriptor['parameters'])
        require(key not in keys, 'duplicate ABI entry')
        keys.add(key)
        require(type(descriptor.get('offset')) is int and descriptor['offset'] in boundaries
                and descriptor['offset'] < len(script), 'invalid ABI instruction entry')
        if key in debug_abi:
            require(descriptor == debug_abi[key], 'manifest/debug ABI mismatch')
        else:
            # No source proof is invented for compiler-generated manifest entries.
            require(not any(m['start'] <= descriptor['offset'] < m['endExclusive'] for m in methods),
                    'ABI entry lacks matching debug descriptor')
    require(set(debug_abi) <= keys, 'debug ABI omitted by manifest')
    owners, method_by_start = {}, {row['start']: row for row in methods}
    for method in methods:
        for row in decoded:
            if method['start'] <= row['offset'] < method['endExclusive']:
                owners[row['offset']] = method['start']
    graph = {row['offset']: {edge['target'] for edge in row['edges'] if edge['target'] is not None} for row in decoded}
    pointers = sorted({row['offset'] + int.from_bytes(bytes.fromhex(row['operandHex']), 'little', signed=True)
                       for row in decoded if row['name'] == 'PUSHA'})
    indirect = [{'offset': row['offset'], **edge} for row in decoded for edge in row['edges']
                if edge['kind'] == 'unresolved-indirect-call']
    seeds = {d['offset'] for d in descriptors} | set(pointers)
    reached = reachable(graph, seeds)
    # Split uncovered intervals on roots/transfer targets, preserving instruction
    # boundaries. No uncovered suffix is silently absorbed by a source method.
    split = seeds | {e['target'] for row in decoded for e in row['edges']
                     if e['target'] is not None and e['kind'] != 'fallthrough'}
    gaps, current = [], None
    for row in decoded:
        pc = row['offset']
        if pc in owners:
            current = None
            continue
        if current is None or pc in split:
            current = {'start': pc, 'endExclusive': pc, 'byteCount': 0, 'sourceMethod': None,
                       'classification': 'compiler-generated-or-unmapped', 'offsets': []}
            gaps.append(current)
        current['offsets'].append(pc)
        current['endExclusive'] = pc + row['size']
        current['byteCount'] += row['size']
    for gap in gaps:
        any_reached = any(pc in reached for pc in gap['offsets'])
        gap['reachability'] = ('structurallyReachable' if any_reached else
                               'unknown-indirect-call' if indirect else 'structurallyUnreachable')
        gap['semanticDead'] = False
        gap['methodBytesSha256'] = hashlib.sha256(script[gap['start']:gap['endExclusive']]).hexdigest()
        gap['structurallyReachedOffsets'] = [pc for pc in gap['offsets'] if pc in reached]
        for pc in gap['offsets']:
            owners[pc] = gap['start']
    nodes = methods + gaps
    by_start = {row['start']: row for row in nodes}
    require(len(owners) == len(decoded), 'instruction accounting incomplete')
    call_graph = {row['start']: set() for row in nodes}
    dependency_graph = {row['start']: set() for row in nodes}
    external, calls, transfers, static = [], [], [], []
    by_pc = {row['offset']: row for row in decoded}
    for row in decoded:
        pc, owner, name = row['offset'], owners[row['offset']], row['name']
        for edge in row['edges']:
            if edge['target'] is None:
                continue
            dest = owners[edge['target']]
            if dest != owner:
                dependency_graph[owner].add(dest)
            if edge['kind'] == 'call':
                call_graph[owner].add(dest)
                calls.append({'offset': pc, 'sourceStart': owner, 'target': edge['target'], 'targetStart': dest,
                              'targetAtRangeStart': edge['target'] == dest})
            elif dest != owner:
                transfers.append({'offset': pc, 'sourceStart': owner, **edge, 'targetStart': dest})
        if name == 'CALLT':
            index = int.from_bytes(bytes.fromhex(row['operandHex']), 'little')
            external.append({'offset': pc, 'sourceStart': owner, 'kind': 'token-call', 'tokenIndex': index, 'token': tokens[index]})
        elif name == 'SYSCALL':
            external.append({'offset': pc, 'sourceStart': owner, 'kind': 'syscall', 'identifierHex': row['operandHex']})
        if name == 'INITSSLOT' or name.startswith(('LDSFLD', 'STSFLD')):
            static.append({'offset': pc, 'sourceStart': owner, 'name': name, 'operandHex': row['operandHex']})
    # Intraprocedural explicit CFG excludes call edges; recursion is separately
    # accounted. Handler edges are structural, not implicit exception semantics.
    local_graph = {pc: {edge['target'] for edge in row['edges'] if edge['target'] is not None
                       and edge['kind'] != 'call' and owners[edge['target']] == owners[pc]}
                   for pc, row in by_pc.items()}
    loops, call_cycles = cyclic_components(local_graph), cyclic_components(call_graph)
    loop_owners = {owners[pc] for component in loops for pc in component}
    recursive_owners = {pc for component in call_cycles for pc in component}
    obligations = {}
    source_by_id = {row['id']: row for row in sources}
    source_graph = {row['id']: set(row['calls']) for row in sources}
    initialization_roots = {owners[d['offset']] for d in descriptors if d['name'] == '_initialize'}
    initialization_dependencies = reachable(dependency_graph, initialization_roots)
    profile = reference_decoder_profile()
    recognized = set(profile['recognizedOpcodeBytes'])

    def obligation(key, category, **details):
        obligations.setdefault(key, {'id': key, 'category': category, 'status': 'OPEN', **details})
        return key

    common = [obligation('entry:' + key, key) for key in (
        'typed-ABI-conversion', 'contract-initialization-source-correspondence', 'VM-ApplicationEngine-correspondence',
        'gas-resource-termination', 'caller-frame-state-and-rollback', 'compiler-and-debug-correspondence')]
    entries, candidates, helper_candidates, conditional_candidates = [], [], [], []
    for descriptor in descriptors:
        start = owners[descriptor['offset']]
        closure = reachable(dependency_graph, [start])
        dependencies = set(common)
        source_roots = {by_start[dependency]['sourceMethod'] for dependency in closure | initialization_dependencies
                        if by_start[dependency].get('sourceMethod')}
        source_closure = reachable(source_graph, source_roots)
        for source_id in sorted(source_closure):
            dependencies.add(obligation('source:' + source_id, 'typed-source-byte-correspondence'
                                        if source_id in source_by_id else 'external-source-member-correspondence'))
            if source_id in source_by_id:
                if source_by_id[source_id]['unexportedMetadata'] or source_by_id[source_id]['unresolvedInvocationCount']:
                    dependencies.add(obligation('source-export-gap:' + source_id, 'source-metadata-or-indirect-invocation-gap'))
                for symbol in source_by_id[source_id]['symbolReferences']:
                    dependencies.add(obligation('symbol:' + symbol, 'source-property-field-correspondence'))
        for dependency in sorted(closure | initialization_dependencies):
            node = by_start[dependency]
            dependencies.add(obligation(f'byte:{dependency}', 'complete-byte-method-semantics-and-faults', start=dependency))
            source = node.get('sourceMethod')
            dependencies.add(obligation('source:' + (source or f'unmapped:{dependency}'),
                                        'typed-source-byte-correspondence' if source else 'unmapped-source-correspondence'))
            if dependency in loop_owners or dependency in recursive_owners:
                dependencies.add(obligation(f'invariant:{dependency}', 'loop-or-recursion-invariant'))
        effects = [row for row in external if row['sourceStart'] in closure]
        fields = [row for row in static if row['sourceStart'] in closure]
        indirect_rows = [row for row in indirect if owners[row['offset']] in closure]
        full_effects = [row for row in external if row['sourceStart'] in closure | initialization_dependencies]
        full_fields = [row for row in static if row['sourceStart'] in closure | initialization_dependencies]
        full_indirect = [row for row in indirect if owners[row['offset']] in closure | initialization_dependencies]
        for effect in full_effects:
            dependencies.add(obligation(f'handler:{effect["offset"]}', 'external-handler-correspondence', effect=effect))
        for field in full_fields:
            dependencies.add(obligation(f'static:{field["offset"]}', 'static-field-and-initializer-correspondence', instruction=field))
        for row in full_indirect:
            dependencies.add(obligation(f'indirect:{row["offset"]}', 'unresolved-indirect-target-set', instruction=row))
        if any(row['sourceStart'] in closure | initialization_dependencies for row in calls):
            dependencies.add(obligation(f'call-return:{start}', 'internal-call-return-frame-correspondence'))
        rows = [row for row in decoded if owners[row['offset']] in closure]
        entry = {'key': descriptor['name'] + '/' + str(len(descriptor['parameters'])), 'abi': descriptor,
                 'byteStart': start, 'sourceMethod': by_start[start].get('sourceMethod'),
                 'byteDependencyStarts': sorted(closure), 'instructionCount': len(rows),
                 'initializationDependencyStarts': sorted(initialization_dependencies),
                 'sourceDependencyMethods': sorted(source_closure),
                 'byteCount': sum(row['size'] for row in rows), 'opcodeCounts': dict(sorted(Counter(row['name'] for row in rows).items())),
                 'externalEffects': full_effects, 'staticFieldEffects': full_fields, 'indirectCalls': full_indirect,
                 'bodyExternalEffects': effects, 'bodyStaticFieldEffects': fields, 'bodyIndirectCalls': indirect_rows,
                 'initializationExternalEffects': [r for r in external if r['sourceStart'] in initialization_dependencies],
                 'initializationStaticFieldEffects': [r for r in static if r['sourceStart'] in initialization_dependencies],
                 'initializationIndirectCalls': [r for r in indirect if owners[r['offset']] in initialization_dependencies],
                 'hasLoopOrRecursion': bool(closure & (loop_owners | recursive_owners)),
                 'unclosedDependencies': sorted(dependencies), 'bodyScopedEvidence': [], 'fullEntrypointVerified': False}
        entries.append(entry)
        if entry['sourceMethod'] and not (effects or fields or indirect_rows or entry['hasLoopOrRecursion']):
            candidates.append({'entrypoint': entry['key'], 'sourceMethod': entry['sourceMethod'],
                               'start': descriptor['offset'], 'endExclusive': by_start[start]['endExclusive'],
                               'byteDependencyStarts': sorted(closure), 'opcodeCounts': entry['opcodeCounts'],
                               'classification': 'structural-no-external-effect-candidate', 'proved': False})
        elif entry['sourceMethod'] and effects and not (fields or indirect_rows or entry['hasLoopOrRecursion']):
            conditional_candidates.append({'entrypoint': entry['key'], 'sourceMethod': entry['sourceMethod'],
                                           'start': descriptor['offset'], 'endExclusive': by_start[start]['endExclusive'],
                                           'byteDependencyStarts': sorted(closure), 'externalEffects': effects,
                                           'classification': 'external-environment-specification-required', 'proved': False})
    for node in nodes:
        rows = [row for row in decoded if owners[row['offset']] == node['start']]
        node['instructionCount'] = len(rows)
        node['opcodeCounts'] = dict(sorted(Counter(row['name'] for row in rows).items()))
        node['outgoingDependencyStarts'] = sorted(dependency_graph[node['start']])
        node['staticCallTargets'] = sorted(call_graph[node['start']])
        closure = reachable(dependency_graph, [node['start']])
        closure_rows = [row for row in decoded if owners[row['offset']] in closure]
        has_effects = (any(row['sourceStart'] in closure for row in external + static)
                       or any(owners[row['offset']] in closure for row in indirect)
                       or bool(closure & (loop_owners | recursive_owners)))
        if node.get('sourceMethod') and not has_effects:
            helper_candidates.append({'sourceMethod': node['sourceMethod'], 'sourceLocation': node['sourceLocation'],
                                      'start': node['start'], 'endExclusive': node['endExclusive'],
                                      'byteDependencyStarts': sorted(closure), 'byteCount': sum(r['size'] for r in closure_rows),
                                      'instructionCount': len(closure_rows),
                                      'missingReferenceDecoderOpcodes': sorted({r['name'] for r in closure_rows if r['opcode'] not in recognized}),
                                      'referenceDecoderRecognizesAllBytes': all(r['opcode'] in recognized for r in closure_rows),
                                      'classification': 'structural-no-external-effect-candidate', 'proved': False})
    return {'schema': 'neoos-sa-entrypoint-closure-inventory/v1', 'status': 'STRUCTURAL_INVENTORY_ONLY',
            'nefSha256': target['sha256'], 'scriptSha256': target['scriptSha256'], 'scriptByteCount': len(script),
            'instructionCount': len(decoded), 'abiEntryCount': len(entries), 'fullUnprovedCount': len(entries),
            'implementationVerified': False, 'fullImplementationVerified': False,
            'sourceMethods': sources, 'byteMethods': methods, 'unmappedRanges': gaps,
            'sourceInitializers': [{'location': row.get('location'), 'origin': row.get('origin'),
                                    'operationsSha256': digest(row.get('operations', [])),
                                    'sourceInputBound': (row.get('location') or {}).get('path') in inputs}
                                   for row in inventory.get('source', {}).get('initializers', [])],
            'unmappedByteCount': sum(row['byteCount'] for row in gaps), 'staticCalls': calls,
            'nonlocalControlTransfers': transfers, 'indirectCalls': indirect, 'externalEffects': external,
            'addressTakenRoots': pointers, 'reachabilityRoots': sorted(seeds), 'structurallyReachableInstructionCount': len(reached),
            'controlFlowLoops': loops, 'callCycles': call_cycles, 'sourceCallCycles': cyclic_components(source_graph),
            'entrypoints': entries, 'pureCandidates': candidates, 'pureMethodCandidates': helper_candidates,
            'conditionalEntrypointCandidates': conditional_candidates, 'referenceDecoderProfile': profile,
            'unclosedDependencyRegistry': sorted(obligations.values(), key=lambda r: r['id']),
            'neoCoreSourceCommit': NEO_CORE_COMMIT, 'neoVmSourceCommit': decoder.NEO_VM_SOURCE_COMMIT,
            'opcodeTableSha256': decoder.OPCODE_TABLE_SHA256,
            'scope': 'Explicit structural edges only; implicit exception/unwind and environment effects are open. Source/debug metadata is not compiler correctness proof.'}


def require_closed_entrypoint(report, key):
    entries = [row for row in report['entrypoints'] if row['key'] == key]
    require(len(entries) == 1, 'unknown or ambiguous entrypoint')
    # Editing a list/boolean or attaching a region receipt cannot authenticate a
    # full source/runtime certificate. This tool has no full-certificate verifier.
    raise ValueError('unclosed entrypoint: structural inventory cannot authenticate a full certificate')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--nef', type=Path, default=HERE.parent.parent / 'contracts/bin/v3/SmartAccountV3.nef')
    parser.add_argument('--manifest', type=Path, default=HERE.parent.parent / 'contracts/bin/v3/SmartAccountV3.manifest.json')
    parser.add_argument('--source-root', type=Path, default=HERE.parent.parent)
    parser.add_argument('--json-report', type=Path, required=True)
    args = parser.parse_args()
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    try:
        raw = args.inventory.read_bytes()
        inventory = json.loads(raw)
        verifier = module('verify')
        tool_paths = [Path(__file__), HERE / 'test_entrypoint_inventory.py', HERE / 'nef_decode.py', HERE / 'verify.py', HERE / 'coq/CapMethodVm.v']
        tools = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in tool_paths}
        source_before = verifier.project_snapshot(args.source_root)
        require(all(inventory.get('inputs', {}).get(path) == value for path, value in source_before.items()),
                'compilation source membership mismatch')
        verifier.validate_inventory(inventory, args.nef, args.manifest, args.source_root)
        report = build_entrypoint_inventory(inventory)
        verifier.validate_inventory(inventory, args.nef, args.manifest, args.source_root)
        require(source_before == verifier.project_snapshot(args.source_root), 'compilation membership changed')
        require(raw == args.inventory.read_bytes(), 'inventory changed')
        require(all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == value for path, value in tools.items()), 'tool changed')
        report.update(inventorySha256=hashlib.sha256(raw).hexdigest(), sourceMembershipSha256=digest(source_before), toolInputSha256=tools,
                      inputSha256=inventory['inputs'], actualArtifactBinding=True)
        args.json_report.write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({key: report[key] for key in ('status', 'abiEntryCount', 'fullUnprovedCount', 'unmappedByteCount')}))
        return 0
    except Exception as exc:
        args.json_report.write_text(json.dumps({'status': 'FAIL', 'implementationVerified': False, 'failure': str(exc)}, indent=2) + '\n')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
