"""Whether the project's own graph covers the bytes the engine actually ran.

`abi_dispatch` asks one question: did the engine enter the offset the manifest
declares? That is a fact about a dispatcher. A contract can dispatch perfectly
and then execute instructions no model of it accounts for, and the dispatch face
would report zero problems.

This module asks the other question. For every ABI method the engine called, it
takes the set of instruction offsets the engine actually executed inside the
contract and compares it with the project's own static byte-dependency inventory:
`byteDependencyStarts` for the entry, plus `initializationDependencyStarts` for
the initializer that runs ahead of it. Those are the project's statement about
which byte methods a call to that entry can reach.

Four questions are asked of the pair, and nothing else:

    bytes       the dump carries the script it ran. That script decodes, its
                sha256 is the sha256 the dump claims, and it is the sha256 the
                static inventory is about. A footprint measured against other
                bytes is a footprint of another contract.
    boundaries  every executed offset is an instruction start of the script as
                this repository decodes it. An offset the decoder does not know
                is a disagreement about what the bytes are, not a rounding error.
    ranges      every executed offset belongs to exactly one byte range the
                inventory accounts for, and those ranges partition the decoded
                instruction set with no overlap and no hole. The inventory
                claims complete accounting; this is where that claim meets the
                artifact it describes.
    reach       for a dispatched method, the byte methods the engine entered are
                among the ones the static graph reaches from that entry. This is
                the direction that has to hold: the engine cannot run what the
                model says is unreachable.

The other direction is deliberately not required and is never a failure.
`reachable` is a may-set: it lists every method some path could reach, and a
zero-argument call takes one path. `closureNotEntered` therefore counts a fact
about the call, not a disagreement about the graph, and it is reported with a
sample rather than quietly summed into the pass.

What this module will never report: that the contract is correct, that these
bodies do what the source says, that a call with real arguments behaves as
intended, or that the static graph is complete. Containment is one empirical
witness per entry point, on one engine version, with all-zero arguments.
`fullImplementationVerified` stays false.
"""

import hashlib
import importlib.util
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

SCHEMA = 'aa-dispatch-footprint/v1'
SCOPE = 'actual-vm-execution-footprint-against-static-byte-dependency-closure'

# The two names the engine dispatches itself. A named call to either is refused,
# so their footprint is empty by construction and is not asked about.
RESERVED_ENTRY_POINTS = ('_deploy', '_initialize')


def _load(name):
    spec = importlib.util.spec_from_file_location('footprint_' + name,
                                                  os.path.join(HERE, name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DECODER = _load('nef_decode')


def _sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _key(row):
    return str(row.get('name', '?')) + '/' + str(row.get('parameters', '?'))


def byte_ranges(entry_report):
    """Every byte range the inventory accounts for, sorted, as (start, end)."""
    rows = [[int(row['start']), int(row['endExclusive'])]
            for row in entry_report.get('byteMethods') or []]
    rows += [[int(row['start']), int(row['endExclusive'])]
             for row in entry_report.get('unmappedRanges') or []]
    rows.sort()
    return rows


def owner_index(ranges, script_length):
    """Check that the ranges partition the script, and return a lookup.

    The inventory says every decoded instruction has an owner. A hole, an
    overlap, or a range that starts after byte 0 is that accounting failing on
    the artifact, so it is a problem in its own right rather than a detail the
    offset lookup is allowed to swallow.
    """
    problems = []
    if not ranges:
        return [], [['ranges', 'empty', 'the inventory accounts for no bytes']]
    if ranges[0][0] != 0:
        problems.append(['ranges', 'starts-late', str(ranges[0][0])])
    for (start, end), (next_start, next_end) in zip(ranges, ranges[1:]):
        if end > next_start:
            problems.append(['ranges', 'overlap',
                             str(start) + '-' + str(end), str(next_start) + '-' + str(next_end)])
        elif end < next_start:
            problems.append(['ranges', 'hole', str(end), str(next_start)])
    if ranges[-1][1] != script_length:
        problems.append(['ranges', 'ends-early', str(ranges[-1][1]), str(script_length)])
    return ranges, problems


def _owner(ranges, offset):
    """The range start owning `offset`, or None. Ranges are sorted and disjoint."""
    best = None
    low, high = 0, len(ranges)
    while low < high:
        middle = (low + high) // 2
        if ranges[middle][0] <= offset:
            best = middle
            low = middle + 1
        else:
            high = middle
    if best is None:
        return None
    start, end = ranges[best]
    return start if offset < end else None


def _face(dump, entry_report, token_count):
    """Compare one footprint against one static inventory. Returns (summary, problems)."""
    summary = {
        'entrypoints': len(entry_report.get('entrypoints') or []),
        'methods': 0, 'methodsMatched': 0, 'methodsCompared': 0,
        'bytesMatch': False, 'reportShaMatches': False, 'nefShaMatches': None,
        'scriptLength': 0, 'decodedInstructions': 0, 'ranges': 0, 'partitioned': False,
        'executedOffsets': 0, 'distinctExecuted': 0, 'foreignOffsets': 0,
        'unknownOffsets': 0, 'unowned': 0,
        'enteredStarts': 0, 'closureStarts': 0, 'insideClosure': 0, 'outsideClosure': 0,
        'closureNotEntered': 0, 'entryNotEntered': 0, 'noFootprint': 0,
        'initializerEntered': 0, 'reservedSkipped': 0,
        'largestIdenticalFootprint': 0,
    }
    problems = []
    script = dump.get('script') or {}
    text = script.get('hex')
    if not isinstance(text, str) or not text:
        problems.append(['dump', 'no-script', 'the dump does not carry the bytes it ran'])
        return summary, problems
    try:
        raw = bytes.fromhex(text)
    except ValueError:
        problems.append(['dump', 'bad-script', 'the dump script is not hex'])
        return summary, problems
    summary['scriptLength'] = len(raw)
    digest = _sha256(raw)
    summary['bytesMatch'] = (digest == script.get('sha256')
                             and len(raw) == script.get('length'))
    if not summary['bytesMatch']:
        problems.append(['dump', 'script-hash', digest, str(script.get('sha256'))])
    summary['reportShaMatches'] = digest == entry_report.get('scriptSha256')
    if not summary['reportShaMatches']:
        problems.append(['dump', 'other-script', digest,
                         str(entry_report.get('scriptSha256'))])
    nef_sha = (dump.get('nef') or {}).get('sha256')
    summary['nefShaMatches'] = nef_sha == entry_report.get('nefSha256')
    if summary['nefShaMatches'] is not True:
        problems.append(['dump', 'nef-hash', str(nef_sha), str(entry_report.get('nefSha256'))])

    try:
        decoded = DECODER.decode_script(raw, token_count)
    except ValueError as error:
        problems.append(['script', 'undecodable', str(error)[:120]])
        return summary, problems
    summary['decodedInstructions'] = len(decoded)
    boundaries = {row['offset'] for row in decoded}

    ranges, range_problems = owner_index(byte_ranges(entry_report), len(raw))
    problems.extend(range_problems)
    summary['ranges'] = len(ranges)
    summary['partitioned'] = not range_problems

    entries = {row['key']: row for row in entry_report.get('entrypoints') or []}
    rows = {_key(row): row for row in dump.get('methods') or []}
    summary['methods'] = len(rows)
    summary['methodsMatched'] = len(set(rows) & set(entries))
    if set(rows) != set(entries):
        problems.append(['inventory', 'entrypoints',
                         'only in the inventory: ' + str(sorted(set(entries) - set(rows))[:3]),
                         'only in the dump: ' + str(sorted(set(rows) - set(entries))[:3])])

    initialize_offset = dump.get('initializeOffset')
    distinct, fingerprints = set(), []
    for key in sorted(set(rows) & set(entries)):
        row, entry = rows[key], entries[key]
        reserved = str(row.get('name')) in RESERVED_ENTRY_POINTS
        summary['foreignOffsets'] += int(row.get('executedForeign') or 0)
        if reserved:
            summary['reservedSkipped'] += 1
            continue
        executed = row.get('executedInContract')
        if not isinstance(executed, list) or not executed:
            summary['noFootprint'] += 1
            problems.append([key, 'no-footprint',
                             'the dump records no executed offset' if isinstance(executed, list)
                             else 'the dump carries no cumulative offset set'])
            continue
        summary['methodsCompared'] += 1
        fingerprints.append(sorted(executed))
        known, entered = [], set()
        for offset in executed:
            summary['executedOffsets'] += 1
            if offset not in boundaries:
                summary['unknownOffsets'] += 1
                problems.append([key, 'not-an-instruction', str(offset)])
                continue
            known.append(offset)
            distinct.add(offset)
            owner = _owner(ranges, offset)
            if owner is None:
                summary['unowned'] += 1
                problems.append([key, 'unowned-instruction', str(offset)])
                continue
            entered.add(owner)
        closure = set(entry.get('byteDependencyStarts') or []) | \
            set(entry.get('initializationDependencyStarts') or [])
        summary['closureStarts'] += len(closure)
        summary['enteredStarts'] += len(entered)
        inside = entered & closure
        outside = sorted(entered - closure)
        summary['insideClosure'] += len(inside)
        summary['outsideClosure'] += len(outside)
        for start in outside:
            problems.append([key, 'outside-closure', str(start)])
        summary['closureNotEntered'] += len(closure - entered)
        if initialize_offset is not None and initialize_offset in known:
            summary['initializerEntered'] += 1
        entry_start = entry.get('byteStart')
        # The declared entry instruction itself, not its owner: an owner set says
        # "this method ran", and the question here is "the offset the manifest
        # points at ran". A footprint that starts three instructions in is a
        # dispatch that landed inside the body, and an owner-set test cannot see
        # the difference.
        if entry_start not in known:
            summary['entryNotEntered'] += 1
            problems.append([key, 'entry-not-entered', str(entry_start)])
    summary['distinctExecuted'] = len(distinct)
    # A footprint that is byte-identical for every method is not a measurement of
    # dispatch; it is one trace reported under many names. Counted, not refused,
    # because two methods can legitimately share a body.
    if fingerprints:
        summary['largestIdenticalFootprint'] = max(fingerprints.count(group)
                                                    for group in fingerprints)
    return summary, problems


def _agrees_core(receipt):
    stats = receipt['stats']
    return (receipt['schema'] == SCHEMA
            and stats['bytesMatch']
            and stats['reportShaMatches']
            and stats['nefShaMatches'] is True
            and stats['partitioned']
            and stats['methods'] > 0
            and stats['methodsMatched'] == stats['methods'] == stats['entrypoints']
            and stats['methodsCompared'] > 0
            and stats['executedOffsets'] > 0
            and stats['enteredStarts'] > 0
            and stats['closureStarts'] > 0
            and stats['insideClosure'] > 0
            and stats['unknownOffsets'] == 0
            and stats['unowned'] == 0
            and stats['outsideClosure'] == 0
            and stats['entryNotEntered'] == 0
            and stats['noFootprint'] == 0
            # Without this the initializer half of every closure is vacuous: no
            # call entered it, so containing nothing about it proves nothing.
            and stats['initializerEntered'] > 0
            and not receipt['problems'])


def correspond(dump_path, entry_report_path, token_count):
    """Build the receipt for one footprint and one static inventory.

    `entry_report_path` is the `entrypoint_inventory` output the gate builds.
    It is read as data: its `byteDependencyStarts`, `byteMethods` and
    `unmappedRanges` are the claims under test here, so this module never
    re-derives them from the source tree.

    `token_count` is the NEF token-table size, needed by the independent decoder
    to bound CALLT indices. It is not a claim about execution.
    """
    if not os.path.isfile(dump_path):
        raise ValueError('no dispatch footprint dump at ' + str(dump_path))
    if not os.path.isfile(entry_report_path):
        raise ValueError('no static entrypoint inventory at ' + str(entry_report_path))
    with open(dump_path, encoding='utf-8') as handle:
        dump = json.load(handle)
    with open(entry_report_path, encoding='utf-8') as handle:
        entry_report = json.load(handle)
    summary, problems = _face(dump, entry_report, token_count)
    rows, skipped = self_test(dump, entry_report, token_count)
    failed = [label for label, ok, _ in rows if not ok]
    script = dump.get('script') or {}
    receipt = {
        'schema': SCHEMA,
        'scope': SCOPE,
        'engine': dump.get('engine', {}),
        'script': {'sha256': script.get('sha256'), 'length': script.get('length'),
                   'decodedInstructions': summary['decodedInstructions']},
        'inventory': {'entrypoints': summary['entrypoints'],
                      'nefSha256': entry_report.get('nefSha256'),
                      'scriptSha256': entry_report.get('scriptSha256'),
                      'byteRanges': summary['ranges']},
        'stats': summary,
        'problems': problems[:40],
        'selfTest': {'checks': len(rows), 'failed': failed, 'skipped': skipped, 'rows': rows},
        'claims': {
            'executionFootprintMeasured': True,
            'staticClosureProven': False,
            'semanticsProven': False,
            'fullImplementationVerified': False,
        },
    }
    receipt['receiptSha256'] = _sha256(
        json.dumps(receipt, sort_keys=True, separators=(',', ':')).encode())
    return receipt


def agrees(receipt):
    """True when the engine ran only what the static graph reaches, and this can tell."""
    return (_agrees_core(receipt)
            and not receipt['selfTest']['failed']
            # A mutant that could not even be built is not a mutant the face
            # caught, so it fails the run rather than shrinking the self test.
            and not receipt['selfTest']['skipped'])


def _entry_for(report, row):
    key = _key(row)
    for entry in report.get('entrypoints') or []:
        if entry['key'] == key:
            return entry
    raise AssertionError('no entrypoint for ' + key)


def _dispatchable(dump):
    for row in dump.get('methods') or []:
        if (str(row.get('name')) not in RESERVED_ENTRY_POINTS
                and row.get('executedInContract')):
            return row
    raise AssertionError('no dispatched method with a footprint to mutate')


def self_test(dump, entry_report, token_count):
    """Mutate the measurement and the model, and require the face to notice.

    Eight ways the pair can disagree. Both sides are mutated on purpose: a face
    that only checks the dump would pass a closure that forgot a method the
    engine demonstrably entered, and that is exactly the defect worth catching.

    Returns (rows, skipped). A mutant that cannot be built on this pair is
    reported as skipped rather than dropped: a self test that silently shrinks
    to nothing on a broken input would certify the input it did not examine.
    """
    rows, skipped = [], []
    base, _ = _face(dump, entry_report, token_count)

    def check(label, mutate_dump=None, mutate_report=None):
        dump_copy = json.loads(json.dumps(dump))
        report_copy = json.loads(json.dumps(entry_report))
        try:
            if mutate_dump is not None:
                mutate_dump(dump_copy)
            if mutate_report is not None:
                mutate_report(report_copy)
        except AssertionError as error:
            skipped.append([label, str(error)[:80]])
            return
        summary, problems = _face(dump_copy, report_copy, token_count)
        caught = bool(problems) or summary != base
        rows.append([label, caught, summary['outsideClosure']])

    def _shift_offset(copy):
        text = (copy.get('script') or {}).get('hex')
        if not isinstance(text, str):
            raise AssertionError('the dump carries no script bytes to move inside')
        _dispatchable(copy)['executedInContract'].append(len(bytes.fromhex(text)))

    check('an offset that is not an instruction', _shift_offset)

    def _move_outside(copy):
        row = _dispatchable(copy)
        entry = _entry_for(entry_report, row)
        closure = set(entry.get('byteDependencyStarts') or []) | \
            set(entry.get('initializationDependencyStarts') or [])
        outside = [int(item['start']) for item in entry_report.get('byteMethods') or []
                   if int(item['start']) not in closure]
        if not outside:
            raise AssertionError('every byte method is reachable; nothing to move to')
        row['executedInContract'] = [outside[-1]]

    check('a footprint in bytes the entry cannot reach', _move_outside)

    def _drop_entry(copy):
        row = _dispatchable(copy)
        entry = _entry_for(entry_report, row)
        kept = [offset for offset in row['executedInContract']
                if offset != entry.get('byteStart')]
        row['executedInContract'] = kept or [row['executedInContract'][0]]

    check('an entry offset that never ran', _drop_entry)

    def _other_bytes(copy):
        if not isinstance(copy.get('script'), dict):
            raise AssertionError('the dump carries no script block to rebind')
        copy['script']['sha256'] = '0' * 64

    check('a dump of other bytes', _other_bytes)

    def _empty_footprint(copy):
        _dispatchable(copy)['executedInContract'] = []

    check('a method with no footprint', _empty_footprint)

    def _forget_entered(report):
        for entry in report.get('entrypoints') or []:
            if entry['key'].split('/')[0] in RESERVED_ENTRY_POINTS:
                continue
            if entry.get('byteDependencyStarts'):
                entry['byteDependencyStarts'] = entry['byteDependencyStarts'][1:]
                return
        raise AssertionError('no entrypoint closure to shorten')

    check('a closure that forgot a method the engine entered', mutate_report=_forget_entered)

    def _hole(report):
        if not report.get('byteMethods'):
            raise AssertionError('no byte method to shorten')
        report['byteMethods'][0]['endExclusive'] = int(report['byteMethods'][0]['endExclusive']) - 1

    check('an inventory with a hole between two ranges', mutate_report=_hole)

    def _other_inventory(report):
        report['scriptSha256'] = '0' * 64

    check('an inventory bound to other bytes', mutate_report=_other_inventory)
    return rows, skipped
