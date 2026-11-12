"""Exact helper CFG and rejecting, hash-pinned fee-source projection.

Source extraction/CFG enumeration are trusted frontends, NOT kernel proofs.
Runtime receipts are independent cross-checks, never the generated price oracle.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request
try:
    from . import nef_decode, verify
except ImportError:
    import nef_decode, verify

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
COMMIT = 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d'
NEF_SHA = '6c347dac40bd562edda3216e40c7007fad3a2bb24020013e730c58bd4ceed1c3'
MANIFEST_SHA = '8b6bd9623ab4ed293ad9b6fda27402aaf3100d0b2a9d5c44658edb7e83fb0c29'
START, END, INIT = 17762, 18043, 29415
SOURCES = {
 'ApplicationEngine.cs': '97b08bfe754bc51ed8418316b45d3805dccff76ef51fbd43ac9b663eacb4d5eb',
 'ApplicationEngine.OpCodePrices.cs': '9835961f56aacb0d4df903dad7b98ab33ee3a1e75ea98189228b000f7ed0a447',
 'ApplicationEngine.Storage.cs': 'adeb3ce69a7d04a3015de35884c0f0c6203ef2dfbfbe8056395f074d69e04083',
 'ApplicationEngine.Runtime.cs': 'b0f4fa6316d796e0b0aa1406a696395669311d5382600f3f83bad966c6d429e9',
 'ApplicationEngine.Contract.cs': '8958efff155cb407fef140dea11a516b9f08ab10feecf1b3c39d986d79801a96',
 'Native/StdLib.cs': '510dbd32f7896e99b0953096b6bc1df64fabfbee952ff4dc9f186789f084be05',
 'Native/NativeContract.cs': '3ceb1bd9c78e0683b81b2833e0c544a7a3b77778fb44676ec4cc9f76d863fcbf',
 'Native/ContractMethodAttribute.cs': '9c521cac926a61d7a1d6329d84a31808c233378fa4bf04bf240bc92f9820b5d1',
 'Native/ContractMethodMetadata.cs': '33aac77fd9353fa23f64cbcbd96cb3e751f2eda8517d4b17ca79c1026f8bbc19'
}

def require(condition, message):
    if not condition:
        raise ValueError(message)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def pinned_sources(cache=None):
    directory = Path(cache) if cache else Path(tempfile.gettempdir()) / 'aa-helper-gas-pinned-source'
    directory.mkdir(parents=True, exist_ok=True)
    sources = {}
    local = REPO.parent.parent / 'neo/neo'
    for name, sha in SOURCES.items():
        path = directory / name.replace('/', '-')
        if not path.exists():
            relative = 'src/Neo/SmartContract/' + name
            if (local / '.git').exists():
                raw = subprocess.check_output(['git', '-C', str(local), 'show', COMMIT + ':' + relative])
            else:
                with urllib.request.urlopen('https://raw.githubusercontent.com/neo-project/neo/' + COMMIT + '/' + relative, timeout=30) as response:
                    raw = response.read()
            require(digest(raw) == sha, 'Pinned source fetch mismatch: ' + name)
            path.write_bytes(raw)
        raw = path.read_bytes()
        require(digest(raw) == sha, 'Pinned source cache mismatch: ' + name)
        sources[name] = raw.decode('utf-8')
    return sources

def integer_price(expression):
    require(re.fullmatch(r'\d+(?:\s*<<\s*\d+)?', expression) is not None, 'Unsupported price expression: ' + expression)
    terms = re.split(r'\s*<<\s*', expression)
    result = int(terms[0]) << int(terms[1]) if len(terms) == 2 else int(terms[0])
    require(0 <= result < 2**63, 'Price outside Int64 domain')
    return result

def opcode_prices(source):
    marker = 'public static readonly IReadOnlyDictionary<OpCode, long> OpCodePrices = new Dictionary<OpCode, long>'
    require(source.count(marker) == 1, 'Opcode table declaration mismatch')
    tail = source.split(marker)[1]
    begin, end = tail.index('{'), tail.index('};')
    body = re.sub(r'//[^\n]*|/\*.*?\*/', '', tail[begin+1:end], flags=re.S)
    result = {}
    position = 0
    pattern = re.compile(r'\s*\[OpCode\.(\w+)\]\s*=\s*([^,]+),')
    while position < len(body) and body[position:].strip():
        match = pattern.match(body, position)
        require(match is not None, 'Unsupported opcode price declaration')
        name, expression = match.groups()
        require(name not in result, 'Duplicate opcode price')
        result[name] = integer_price(expression.strip())
        position = match.end()
    require(len(result) > 150, 'Incomplete opcode price table')
    return result

def compact(source):
    return re.sub(r'\s+', '', re.sub(r'//[^\n]*|/\*.*?\*/', '', source, flags=re.S))

def extract_fees(sources):
    require(set(sources) == set(SOURCES), 'Incomplete pinned pricing sources')
    for name, sha in SOURCES.items():
        require(digest(sources[name].encode()) == sha, 'Pinned price source drift: ' + name)
    prices = opcode_prices(sources['ApplicationEngine.OpCodePrices.cs'])
    factors = re.findall(r'public static readonly BigInteger FeeFactor = (\d+);', sources['ApplicationEngine.cs'])
    require(len(factors) == 1, 'FeeFactor declaration mismatch')
    syscalls = {}
    for name in ['ApplicationEngine.Runtime.cs', 'ApplicationEngine.Storage.cs', 'ApplicationEngine.Contract.cs']:
        pattern = r'public static readonly InteropDescriptor \w+ = Register\("([^"]+)", nameof\(\w+\), ([^,]+), CallFlags\.(\w+)(?:, Hardfork\.\w+)?\);'
        for call, price, flags in re.findall(pattern, sources[name]):
            require(call not in syscalls, 'Duplicate syscall fee')
            syscalls[call] = dict(fixed=integer_price(price.strip()), flags=flags,
                                 hash=int.from_bytes(hashlib.sha256(call.encode()).digest()[:4], 'little'))
    expected = {'System.Runtime.GetScriptContainer', 'System.Storage.GetContext', 'System.Storage.Get',
                'System.Storage.Put', 'System.Contract.CallNative'}
    require(expected <= set(syscalls), 'Required syscall declaration not extracted')
    native = {}
    for method in ['Serialize', 'Deserialize']:
        pattern = r'\[ContractMethod\(CpuFee = ([^\)]+)\)\]\s*private static (?:byte\[\]|StackItem) ' + method + r'\(ApplicationEngine engine, (?:StackItem item|byte\[\] data)\)\s*\{\s*return BinarySerializer\.' + method + r'\((?:item|data), engine.Limits\);\s*\}'
        matches = re.findall(pattern, sources['Native/StdLib.cs'])
        require(len(matches) == 1, 'Unsupported native codec body or fee')
        native[method.lower()] = integer_price(matches[0].strip())
    attributes = compact(sources['Native/ContractMethodAttribute.cs'])
    metadata = compact(sources['Native/ContractMethodMetadata.cs'])
    require(attributes.count('publiclongStorageFee{get;init;}') == 1 and
            attributes.count('publiclongCpuFee{get;init;}') == 1,
            'Unsupported native fee field defaults/types')
    require(metadata.count('CpuFee=attribute.CpuFee;StorageFee=attribute.StorageFee;') == 1,
            'Native fee metadata assignment mismatch')
    engine = compact(sources['ApplicationEngine.cs'])
    for expression in ['Diagnostic?.PreExecuteInstruction(instruction);AddFee(_execFeeFactor*OpCodePriceTable[(byte)instruction.OpCode],false);',
                       'ValidateCallFlags(descriptor.RequiredCallFlags);AddFee(descriptor.FixedPrice*_execFeeFactor,false);']:
        require(engine.count(expression) == 1, 'Opcode/syscall charge scheduling expression mismatch')
    native_body = compact(sources['Native/NativeContract.cs'])
    for shape in ['sb.EmitPush(0);methods.Add(sb.Length,method);sb.EmitSysCall(ApplicationEngine.System_Contract_CallNative);sb.Emit(OpCode.RET);',
                  'engine.AddFee((method.CpuFee*engine.ExecFeePicoFactor)+(method.StorageFee*engine.StoragePrice*ApplicationEngine.FeeFactor),false);']:
        require(native_body.count(shape) == 1, 'Native wrapper/fee expression mismatch')
    storage = compact(sources['ApplicationEngine.Storage.cs'])
    formula = 'if(itemisnull){newDataSize=key.Length+value.Length;SnapshotCache.Add(skey,item=newStorageItem());}else{if(value.Length==0)newDataSize=0;elseif(value.Length<=item.Value.Length)newDataSize=(value.Length-1)/4+1;elseif(item.Value.Length==0)newDataSize=value.Length;elsenewDataSize=(item.Value.Length-1)/4+1+value.Length-item.Value.Length;}AddFee(newDataSize*StoragePrice,true);item.Value=value;'
    require(storage.count(formula) == 1, 'Storage.Put fee/effect-order expression mismatch')
    return dict(opcodes=prices, syscalls=syscalls, nativeCpu=native, factor=int(factors[0]),
                nativeWrapper=['PUSH0', 'SYSCALL', 'RET'], nativeStorage={'serialize':0,'deserialize':0}, sourceCommit=COMMIT, sourceHashes=dict(SOURCES),
                sourceFrontendVerified=False)

def bind_artifact(nef=None, manifest=None):
    nef = Path(nef) if nef else REPO / 'contracts/bin/v3/SmartAccountV3.nef'
    manifest = Path(manifest) if manifest else nef.with_suffix('.manifest.json')
    raw, raw_manifest = nef.read_bytes(), manifest.read_bytes()
    require(digest(raw) == NEF_SHA and digest(raw_manifest) == MANIFEST_SHA, 'Unreviewed helper artifact identity')
    decoded = verify.decode_nef(raw)
    instructions = nef_decode.decode_script(decoded['script'], len(decoded['tokens']))
    selected = [i for i in instructions if START <= i['offset'] < END]
    require(len(selected) == 116 and selected[0]['offset'] == START and selected[-1]['offset'] == END-1,
            'Incorrect 281-byte/116-instruction helper boundary')
    for token, method in [(3, 'serialize'), (4, 'deserialize')]:
        entry = decoded['tokens'][token]
        require(entry['method'] == method and entry['hashLittleEndian'] == 'c0ef39ceE0e4e925c6c2a06A79e1440Dd86fceac'.lower()
                and entry['parametersCount'] == 1 and entry['hasReturnValue'] and entry['callFlags'] == 15,
                'Actual native codec token mismatch')
    abi = json.loads(raw_manifest)['abi']['methods']
    require(next(m for m in abi if m['name'] == '_initialize')['offset'] == INIT, 'Initializer ABI drift')
    return dict(instructions=selected, initializer=[i for i in instructions if INIT <= i['offset']],
                nefSha256=digest(raw), manifestSha256=digest(raw_manifest),
                helperSha256=digest(decoded['script'][START:END]), scriptSha256=digest(decoded['script']))

def enumerate_paths(instructions):
    nodes = {i['offset']: i for i in instructions}
    require(len(nodes) == len(instructions) and START in nodes, 'Duplicate/missing CFG nodes')
    result = []
    def visit(pc, pcs, decisions):
        require(pc in nodes and pc not in pcs, 'Unresolved edge/cycle in helper CFG')
        item = nodes[pc]; pcs = pcs + [pc]
        if item['name'] in ('RET', 'ABORTMSG'):
            require(not item['edges'], 'Terminal instruction has edges')
            result.append(dict(pcs=pcs, decisions=decisions, terminal=item['name']))
            return
        require(item['name'] not in ('CALL', 'CALL_L', 'CALLA', 'TRY', 'THROW', 'ENDTRY', 'ENDFINALLY'), 'Unsupported control/effect')
        edges = item['edges']
        require(1 <= len(edges) <= 2, 'Unsupported CFG fanout')
        for edge in edges:
            require(edge['kind'] in ('branch', 'fallthrough'), 'Unsupported CFG edge')
            visit(edge['target'], pcs, decisions + [(pc, edge['kind'])] if len(edges) == 2 else decisions)
    visit(START, [], [])
    # Four branch sites produce twelve paths: the settled>0 abort terminal ends
    # before the margin decision, so only its surviving branch is doubled.
    require(len(result) == 12, 'Unexpected helper CFG path count')
    require({pc for p in result for pc in p['pcs']} == set(nodes), 'Unreachable/unaccounted helper instructions')
    return result

def put_size(old, new):
    require(type(new) is int and new >= 0 and (old is None or type(old) is int and old >= 0), 'Invalid storage lengths')
    if old is None: return 1 + new
    if new == 0: return 0
    if new <= old: return (new-1)//4 + 1
    if old == 0: return new
    return (old-1)//4 + 1 + new - old

def derive(bound, fees):
    nodes = {i['offset']: i for i in bound['instructions']}
    syscall = {v['hash']: (k, v) for k, v in fees['syscalls'].items()}
    paths = enumerate_paths(bound['instructions'])
    for path in paths:
        events = []
        for pc in path['pcs']:
            i = nodes[pc]
            require(i['name'] in fees['opcodes'], 'Unpriced helper opcode')
            opcode_price = fees['opcodes'][i['name']]
            fixed_price = cpu_price = wrapper_price = 0
            coefficient = opcode_price
            if i['name'] == 'SYSCALL':
                ident = int.from_bytes(bytes.fromhex(i['operandHex']), 'little')
                require(ident in syscall, 'Unpriced helper syscall')
                name, metadata = syscall[ident]
                require(name in ('System.Runtime.GetScriptContainer', 'System.Storage.GetContext', 'System.Storage.Get', 'System.Storage.Put'), 'Unsupported helper syscall')
                fixed_price = metadata['fixed']
                coefficient += fixed_price
            elif i['name'] == 'CALLT':
                index = int.from_bytes(bytes.fromhex(i['operandHex']), 'little')
                require(index in (3, 4), 'Unpriced helper native token')
                method = 'serialize' if index == 3 else 'deserialize'
                wrapper_price = sum(fees['opcodes'][op] for op in fees['nativeWrapper'])
                fixed_price = fees['syscalls']['System.Contract.CallNative']['fixed']
                cpu_price = fees['nativeCpu'][method]
                coefficient += wrapper_price + fixed_price + cpu_price
            events.append(dict(pc=pc, execution=coefficient, storage=pc == 18034, opcode=opcode_price, fixed=fixed_price, native=cpu_price, wrapper=wrapper_price))
        path['events'] = events
        path['executionCoefficient'] = sum(e['execution'] for e in events)
        path['absent'] = dict(path['decisions'])[17789] == 'fallthrough'
        path['reset'] = dict(path['decisions'])[17840] == 'fallthrough'
    init = bound['initializer']
    require(len(init) == 182 and init[-1]['name'] == 'RET', 'Initializer path drift')
    require(all(i['name'] in fees['opcodes'] and i['name'] not in ('CALLT', 'SYSCALL') and
                (i['edges'] == [{'kind': 'fallthrough', 'target': i['offset']+i['size']}] or i == init[-1]) for i in init),
            'Initializer must be fully priced and branch-free')
    return dict(paths=paths, initializer=init, initializerCoefficient=sum(fees['opcodes'][i['name']] for i in init),
                maxExecutionCoefficient=max(p['executionCoefficient'] for p in paths), maxStorageBytes=71,
                artifact={k: v for k, v in bound.items() if k.endswith('Sha256')}, fees=fees)


def receipt_amount(value):
    require(isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]*', value) is not None,
            'Invalid runtime fee amount')
    return int(value)


def check_runtime_events(receipt, model, selected, nodes, billed, shape):
    """Check the complete finite trace, including each CALLT's native frame.

    This checks supplied historical observations, not their authenticity or a
    new engine execution. The price theorem is derived independently of them.
    """
    fees, rows = model['fees'], receipt['trace']
    native_hash = '0xacce6fd80d44e1796aa0c2c625e9e4e0ce39efc0'
    require(isinstance(rows, list) and rows and all(isinstance(r, dict) for r in rows), 'Invalid runtime trace')
    core_hash = rows[0].get('ScriptHash')
    require(isinstance(core_hash, str) and re.fullmatch(r'0x[0-9a-f]{40}', core_hash)
            and core_hash != native_hash, 'Invalid runtime core identity')
    e = receipt_amount(receipt['execPicoFactor'])
    s, f = receipt['storagePriceDatoshi'], receipt_amount(receipt['feeFactor'])
    require(type(s) is int and s >= 0 and f > 0, 'Invalid runtime fee configuration')
    expected = []

    def add(method, script_hash, instruction, additional=0, completed=True):
        expected.append((method, script_hash, instruction, additional, completed))

    for instruction in model['initializer']:
        add('_initialize', core_hash, instruction)
    by_hash = {v['hash']: v for v in fees['syscalls'].values()}
    native_syscall = '41' + fees['syscalls']['System.Contract.CallNative']['hash'].to_bytes(4, 'little').hex()
    for pc in selected['pcs']:
        instruction = nodes[pc]
        additional = 0
        if instruction['name'] == 'SYSCALL':
            syscall = int.from_bytes(bytes.fromhex(instruction['operandHex']), 'little')
            require(syscall in by_hash, 'Unpriced runtime syscall')
            additional = by_hash[syscall]['fixed'] * e
            if pc == 18034: additional += billed * s * f
        add('CapReimbursementToActualCost', core_hash, instruction, additional,
            instruction['name'] != 'ABORTMSG')
        if instruction['name'] == 'CALLT':
            token = int.from_bytes(bytes.fromhex(instruction['operandHex']), 'little')
            require(token in (3, 4), 'Unsupported runtime native token')
            method = 'serialize' if token == 3 else 'deserialize'
            # Native method offsets are observed, while the complete wrapper
            # instruction bytes/order and charges come from the pinned source.
            first = len(expected)
            require(first < len(rows) and type(rows[first].get('Pc')) is int and rows[first]['Pc'] >= 0,
                    'Missing native runtime frame')
            start = rows[first]['Pc']
            for offset, opcode, raw in [(0, 'PUSH0', '10'), (1, 'SYSCALL', native_syscall), (6, 'RET', '40')]:
                add(method, native_hash, dict(offset=start + offset, name=opcode, instructionHex=raw),
                    (fees['syscalls']['System.Contract.CallNative']['fixed'] + fees['nativeCpu'][method]) * e
                    if opcode == 'SYSCALL' else 0)
    if selected['terminal'] == 'RET':
        # The diagnostic harness resumes its single RET entry script.
        entry_hash = '0x' + hashlib.new('ripemd160', hashlib.sha256(b'\x40').digest()).digest()[::-1].hex()
        add('entry-script', entry_hash, dict(offset=0, name='RET', instructionHex='40'))
    require(len(rows) == len(expected), 'Missing or extra runtime instruction/native events')
    prior = 0
    for sequence, (row, (method, script_hash, instruction, additional, completed)) in enumerate(zip(rows, expected)):
        require(type(row.get('Sequence')) is int and row['Sequence'] == sequence,
                'Runtime trace sequence gap or duplicate')
        require(row.get('Method') == method and row.get('ScriptHash') == script_hash
                and type(row.get('Pc')) is int and row['Pc'] == instruction['offset']
                and row.get('OpCode') == instruction['name'] and row.get('InstructionHex') == instruction['instructionHex']
                and row.get('Completed') is completed, 'Runtime event identity/order/completion mismatch')
        opcode = fees['opcodes'][instruction['name']] * e
        before, after = receipt_amount(row.get('BeforePico')), receipt_amount(row.get('AfterPico'))
        require(before == prior and after == before + opcode + additional
                and receipt_amount(row.get('OpcodePico')) == opcode
                and receipt_amount(row.get('AdditionalPico')) == additional,
                'Runtime event charge or cumulative accounting mismatch')
        if method == 'CapReimbursementToActualCost' and instruction['offset'] == 18034:
            require(row.get('StorageKeyHex') == '21' and type(row.get('StorageValueLength')) is int
                    and row['StorageValueLength'] == 39, 'Runtime Put argument drift')
        else:
            require(row.get('StorageKeyHex') is None and row.get('StorageValueLength') is None,
                    'Unexpected runtime storage observation')
        prior = after
    require(prior == receipt_amount(receipt['rawConsumedPico']) and type(receipt.get('feeConsumedDatoshi')) is int
            and receipt['feeConsumedDatoshi'] == (prior + f - 1) // f, 'Runtime final fee accounting mismatch')
    require(receipt.get('fault') is (shape == 'exhausted'), 'Runtime fault coverage mismatch')
    require((isinstance(receipt.get('error'), str) and 'ABORTMSG' in receipt['error']) if shape == 'exhausted'
            else receipt.get('error') is None, 'Runtime error outcome mismatch')


def crosscheck_runtime(model, directory):
    """Check supplied pinned historical observations, not new engine execution."""
    checks = []
    fees = model['fees']
    nodes = {i['offset']: i for i in bind_artifact()['instructions']}
    for shape in ['absent', 'same', 'reset', 'exhausted', 'zero']:
        path = Path(directory) / ('aa-gas-runtime-helper-' + shape + '.json')
        raw = path.read_bytes(); receipt = json.loads(raw)
        require(receipt.get('scope') == 'actual-pinned-AE-instruction-fee-observation'
                and receipt.get('name') == 'helper-' + shape, 'Runtime receipt scope/shape mismatch')
        require(receipt['artifacts']['nefSha256'] == NEF_SHA and receipt['artifacts']['manifestSha256'] == MANIFEST_SHA, 'Runtime artifact mismatch')
        expected_runtime = {'neo': 'cb1b4db8076847dc23fda920ded773adaeeda07895effd350d2d8a99595a7f3a',
                            'vm': 'cea00a147add3c672bb23ffb5d98a4b1f31da135272efc258fee8fb7805bbfe9'}
        for assembly, sha in expected_runtime.items():
            require(receipt['runtime'][assembly]['sha256'] == sha, 'Runtime assembly identity mismatch')
        require(receipt['nativeCpuPrices'] == fees['nativeCpu'] and int(receipt['feeFactor']) == fees['factor'], 'Runtime native/factor metadata drift')
        for number, (name, _, _) in nef_decode.OPCODES.items():
            if name in fees['opcodes']:
                require(receipt['priceTable'][number] == fees['opcodes'][name], 'Runtime opcode metadata drift: ' + name)
        descriptors = {d['Name']: d for d in receipt['syscallMetadata']}
        for name in ['System.Runtime.GetScriptContainer', 'System.Storage.GetContext', 'System.Storage.Get', 'System.Storage.Put', 'System.Contract.CallNative']:
            require(descriptors[name]['FixedPrice'] == fees['syscalls'][name]['fixed'] and descriptors[name]['Hash'] == fees['syscalls'][name]['hash'] and descriptors[name]['requiredCallFlags'] == fees['syscalls'][name]['flags'], 'Runtime syscall metadata drift')
        rows = receipt['trace']
        helper = [r for r in rows if r['Method'] == 'CapReimbursementToActualCost']
        pcs = [r['Pc'] for r in helper]
        matches = [p for p in model['paths'] if p['pcs'] == pcs]
        require(len(matches) == 1, 'Runtime helper trace outside independent CFG')
        selected = matches[0]
        expected_shape = {'absent': (True, True, 'RET'), 'same': (False, False, 'RET'),
                          'reset': (False, True, 'RET'), 'exhausted': (False, False, 'ABORTMSG'),
                          'zero': (False, False, 'RET')}[shape]
        require((selected['absent'], selected['reset'], selected['terminal']) == expected_shape,
                'Runtime helper path does not cover declared shape')
        require([r['Pc'] for r in rows if r['Method'] == '_initialize'] == [i['offset'] for i in model['initializer']], 'Runtime initializer trace drift')
        e, s, f = int(receipt['execPicoFactor']), receipt['storagePriceDatoshi'], int(receipt['feeFactor'])
        require(e >= 0 and s >= 0, 'Negative runtime fee configuration')
        billed = 0
        put = [r for r in helper if r['Pc'] == 18034]
        if put:
            require(len(put) == 1 and put[0]['StorageKeyHex'] == '21', 'Runtime Put argument drift')
            billed = put_size(None if shape == 'absent' else 39, put[0]['StorageValueLength'])
        expected = (selected['executionCoefficient'] + model['initializerCoefficient']) * e + billed * s * f
        require(expected == int(receipt['rawConsumedPico']), 'Independent source price total disagrees with actual engine')
        check_runtime_events(receipt, model, selected, nodes, billed, shape)
        checks.append(dict(shape=shape, path=str(path.resolve()), sha256=digest(raw), rawPico=expected))
    return checks
