"""Pinned projection of load-time manifest and method-token admission.

Three dispatch lanes start from an *already resolved* `ContractMethodDescriptor`
and an *already loaded* `ContractState`. None of them records what a manifest or
a nef token is allowed to declare before that point, so a caller cannot tell
which declarations the loader rejects from which it silently accepts and fails
on later.

This lane reads the two admission surfaces out of the pinned sources:

* `NefFile.Deserialize` fixes the read order (magic, compiler, source, reserve,
  tokens, reserve, script, checksum) and therefore which structural check fires
  before integrity is even considered;
* `MethodToken.Deserialize` bounds the method name, forbids the reserved `_`
  prefix and masks the flag byte against the declared flag set;
* `ContractManifest.FromJson` rejects an empty name, a non-empty `features`
  field and repeated standards, permission subjects or trusts;
* `ContractAbi` requires at least one method and resolves an exact call through
  a table keyed by (name, arity), while the wildcard lookup ignores the arity;
* `ContractMethodDescriptor.FromJson` rejects an empty name, repeated parameter
  names, an undefined return type and a negative offset.

Every field below is *derived* from the pinned declarations, not restated.
"""

import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request

# Shared with the exception-identity lane rather than copied: the rule is a
# property of C#, not of one lane. None of this lane's five files carries a
# conditional region today, which is exactly why the rule has to come from one
# place — the day one does, both lanes read it the same way.
from csharp_directives import strip_directives

CORE_COMMIT = 'd10e9ceecdabe3fcff719ee68ea5b76ba7e62c3d'
SCOPE = 'load-time-manifest-and-token-admission'
ENTRY_BOUNDARY = 'manifest-parse-and-nef-deserialize-admission-to-exact-arity-resolution'

SOURCES = {
    'core/nef': dict(repository='neo', commit=CORE_COMMIT,
                     sha256='89184d41d9860835edb4edf0fa35936ece240307c4e9766e12c44ee4b301f698',
                     relativePath='src/Neo/SmartContract/NefFile.cs'),
    'core/token': dict(repository='neo', commit=CORE_COMMIT,
                       sha256='310d91742a751ed2d285bbf153cbaa838b8ee3433a0b58f68fadd62a77b2946b',
                       relativePath='src/Neo/SmartContract/MethodToken.cs'),
    'core/manifest': dict(repository='neo', commit=CORE_COMMIT,
                          sha256='1268364da65127dd25a33549f776719795722d2b66760767cf76def916f1b170',
                          relativePath='src/Neo/SmartContract/Manifest/ContractManifest.cs'),
    'core/abi': dict(repository='neo', commit=CORE_COMMIT,
                     sha256='9313d6709261c83ce19371d3e46dc29adee143c2032433d2b607e84b95865ed2',
                     relativePath='src/Neo/SmartContract/Manifest/ContractAbi.cs'),
    'core/method': dict(repository='neo', commit=CORE_COMMIT,
                        sha256='8b0c93a42e2cde4dcc81dd3b75115728fe049dec107b0e8e6b07c3f8d8594fa4',
                        relativePath='src/Neo/SmartContract/Manifest/ContractMethodDescriptor.cs'),
}

SIGNATURES = {
    'nefDeserialize': ('core/nef',
                       'public void Deserialize(ref MemoryReader reader, bool verify = true)'),
    'tokenDeserialize': ('core/token', 'void ISerializable.Deserialize(ref MemoryReader reader)'),
    'manifestFromJson': ('core/manifest', 'public static ContractManifest FromJson(JObject json)'),
    'manifestParse': ('core/manifest',
                      'public static ContractManifest Parse(ReadOnlySpan<byte> json)'),
    'abiFromJson': ('core/abi', 'public static ContractAbi FromJson(JObject json)'),
    'abiGetMethod': ('core/abi', 'public ContractMethodDescriptor? GetMethod(string name, int pcount)'),
    'methodFromJson': ('core/method', 'public new static ContractMethodDescriptor FromJson(JObject json)'),
}

PRECONDITIONS = [
    'The bytes handed to `NefFile.Deserialize` are supplied as an input; this lane records the '
    'check order and the admitted shapes, not the transport that produced the bytes.',
    '`NefFile.Parse` is read with the default `verify: true`; the lane records that the checksum '
    'comparison is guarded by the flag and what the declared default is, not how a host overrides it.',
    'The manifest JSON is supplied as an input; this lane records which declarations are refused, '
    'not the JSON reader or the length accounting of the enclosing envelope.',
    'Contract deployment, storage of an admitted manifest and its update path are out of scope: the '
    'lane stops at the value `FromJson` returns.',
    'The permission table and its runtime decision are modelled by the contract-handoff lane; this '
    'lane only records that a permission entry is a subject plus a method selector.',
    'Exact-arity resolution is recorded as a table keyed by (name, arity); the dictionary '
    'implementation that throws on a repeated key is a stated consequence, not a modelled throw.'
]
UNPROVED = [
    'Whether the deployment path ever stores a manifest whose ABI declares two methods with the same '
    'name and arity; the loader admits it and the exact lookup is where it stops being resolvable.',
    'Every rejection message and any client-visible diagnostic derived from it.',
    'The wildcard container reader that turns the JSON string `*` into a wildcard; only the selector '
    'that consumes it is recorded.',
    'Gas, storage growth and every resource limit on the admission path; no cost is modelled.',
    'Trusted C# extraction and compiler/CLR correspondence; all 109 public entrypoints.'
]
TCB = ['Strict complete-method C# grammar and field/symbol binding.',
       'The tokenizer keeps string and character literals opaque; preprocessor lines carry no '
       'state and are dropped before projection.',
       'Externally supplied nef bytes, manifest JSON and the JSON reader that produced them.']


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


# The tokenizer is the one every other refinement lane uses, so all lanes
# normalize C# identically; a divergence would make projections incomparable.
from csharp_tokens import TOKENIZER as TOKEN

def normalize(text):
    """Join the tokens of a fragment the way a whole body is joined."""
    items = []
    position = 0
    while position < len(text):
        match = TOKEN.match(text, position)
        require(match is not None, 'Unsupported fragment token')
        position = match.end()
        token = match.group()
        if token.isspace() or token.startswith(('//', '/*')):
            continue
        items.append(token)
    return ''.join(items)


def body(text, header):
    require(text.count(header) == 1, 'Missing/ambiguous complete method declaration: ' + header)
    tail = text[text.index(header) + len(header):]
    position = depth = 0
    items = []
    while position < len(tail):
        match = TOKEN.match(tail, position)
        require(match is not None, 'Unsupported source token')
        position = match.end()
        token = match.group()
        if token.isspace() or token.startswith(('//', '/*')):
            continue
        require(items or token == '{', 'Expected complete method block')
        items.append(token)
        depth += int(token == '{') - int(token == '}')
        if depth == 0:
            return ''.join(items)
    raise ValueError('Unterminated method body')


def int_constant(expression):
    """Read a declared integer bound, so a raised bound is a different value."""
    text = normalize(expression)
    for name, value in (('ushort.MaxValue', 65535), ('byte.MaxValue', 255)):
        text = text.replace(name, str(value))
    require(re.fullmatch(r'[0-9+*() ]+', text) is not None,
            'Unsupported integer constant: ' + expression)
    # Only digits, `+`, `*` and parentheses survive the guard above, so the
    # declaration is evaluated as written instead of being guessed.
    return eval(text, {'__builtins__': {}}, {})


def declared_int(text, pattern, label):
    match = re.search(pattern, text)
    require(match is not None, 'Missing declared bound: ' + label)
    return int_constant(match.group(1))


# The ordered reads of one nef deserialization. Each anchor keeps the shape of
# its statement but not the value it compares against, so a weakened comparison
# or a raised bound moves a field without moving the order.
STEP_ANCHORS = [
    ('read-magic', 'if(reader.ReadUInt32()!='),
    ('read-compiler', 'Compiler=reader.ReadFixedString('),
    ('read-source', 'Source=reader.ReadVarString('),
    ('read-reserve-byte', 'reader.ReadByte()!='),
    ('read-tokens', 'Tokens=reader.ReadSerializableArray<MethodToken>('),
    ('read-reserve-short', 'reader.ReadUInt16()!='),
    ('read-script', 'Script=reader.ReadVarMemory('),
    ('verify-checksum', 'ComputeChecksum(this)'),
]

# name -> (source key, before, after), applied to the raw pinned text. Every
# mutation must move exactly one projected field; the tests assert that.
CONTROL_MUTATIONS = {
    'accept-a-foreign-magic':
        ('core/nef', 'if (reader.ReadUInt32() != Magic) throw', 'if (reader.ReadUInt32() != 0) throw'),
    'accept-a-nonzero-reserve-byte':
        ('core/nef', 'if (reader.ReadByte() != 0) throw', 'if (reader.ReadByte() != 1) throw'),
    'accept-a-nonzero-reserve-short':
        ('core/nef', 'if (reader.ReadUInt16() != 0) throw', 'if (reader.ReadUInt16() != 1) throw'),
    'raise-the-token-array-cap':
        ('core/nef', 'reader.ReadSerializableArray<MethodToken>(128)',
         'reader.ReadSerializableArray<MethodToken>(256)'),
    'accept-an-empty-script':
        ('core/nef', '            if (Script.Length == 0) throw new ArgumentException("Script cannot be empty.");\n',
         ''),
    'compare-the-checksum-for-equality':
        ('core/nef', 'if (CheckSum != ComputeChecksum(this)) throw',
         'if (CheckSum == ComputeChecksum(this)) throw'),
    'verify-past-the-declared-flag':
        ('core/nef', '            if (verify)\n', '            if (true)\n'),
    'allow-a-underscore-method':
        ('core/token', "if (Method.StartsWith('_')) throw", "if (Method.StartsWith('#')) throw"),
    'raise-the-method-name-limit':
        ('core/token', 'Method = reader.ReadVarString(32);', 'Method = reader.ReadVarString(64);'),
    'mask-the-flag-byte-against-one-flag':
        ('core/token', '(CallFlags & ~CallFlags.All) != 0', '(CallFlags & ~CallFlags.ReadStates) != 0'),
    'accept-an-empty-manifest-name':
        ('core/manifest', 'if (string.IsNullOrEmpty(manifest.Name))',
         'if (manifest.Name is null)'),
    'accept-a-populated-features-field':
        ('core/manifest', 'features.Count != 0', 'features.Count < 0'),
    'accept-repeated-standards':
        ('core/manifest', '_ = manifest.SupportedStandards.ToDictionary(p => p);',
         '_ = manifest.SupportedStandards.ToList();'),
    'accept-repeated-permission-subjects':
        ('core/manifest', '_ = manifest.Permissions.ToDictionary(p => p.Contract);',
         '_ = manifest.Permissions.ToList();'),
    'accept-repeated-trusts':
        ('core/manifest', '_ = manifest.Trusts.ToDictionary(p => p);',
         '_ = manifest.Trusts.ToList();'),
    'raise-the-manifest-length-cap':
        ('core/manifest', 'public const int MaxLength = ushort.MaxValue;',
         'public const int MaxLength = ushort.MaxValue * 2;'),
    'accept-an-empty-abi':
        ('core/abi', 'if (abi.Methods.Length == 0) throw', 'if (abi.Methods.Length < 0) throw'),
    'key-the-exact-lookup-by-the-name-only':
        ('core/abi', 'Methods.ToDictionary(p => (p.Name, p.Parameters.Length))',
         'Methods.ToDictionary(p => (p.Name, 0))'),
    'drop-the-arity-range-check':
        ('core/abi', 'if (pcount < -1 || pcount > ushort.MaxValue)', 'if (pcount > ushort.MaxValue)'),
    'make-the-wildcard-respect-the-arity':
        ('core/abi', 'Methods.FirstOrDefault(p => p.Name == name)',
         'Methods.FirstOrDefault(p => p.Name == name && p.Parameters.Length == 0)'),
    'accept-an-empty-method-name':
        ('core/method', 'if (string.IsNullOrEmpty(descriptor.Name))',
         'if (descriptor.Name is null)'),
    'accept-repeated-parameter-names':
        ('core/method', '_ = descriptor.Parameters.ToDictionary(p => p.Name);',
         '_ = descriptor.Parameters.ToList();'),
    'accept-an-undeclared-return-type':
        ('core/method', 'if (!Enum.IsDefined(typeof(ContractParameterType), descriptor.ReturnType))',
         'if (Enum.IsDefined(typeof(ContractParameterType), descriptor.ReturnType))'),
    'read-the-reserve-before-the-source':
        ('core/nef',
         '            Source = reader.ReadVarString(256);\n'
         '            if (reader.ReadByte() != 0) throw new FormatException("Reserved bytes must be 0");\n',
         '            if (reader.ReadByte() != 0) throw new FormatException("Reserved bytes must be 0");\n'
         '            Source = reader.ReadVarString(256);\n'),
    'accept-a-zero-length-manifest':
        ('core/manifest', 'json.Length > MaxLength', 'json.Length > 0'),
    'hand-back-a-method-when-the-lookup-misses':
        ('core/abi', '                return null;\n', '                throw new InvalidOperationException();\n'),
    'accept-a-negative-offset':
        ('core/method', 'if (descriptor.Offset < 0)', 'if (descriptor.Offset < -1)'),
}
EXPECTED_CONTROLS = tuple(CONTROL_MUTATIONS)


def step_order(nef_deserialize):
    """Return the ordered step names, read from where each anchor sits."""
    placed = []
    for name, anchor in STEP_ANCHORS:
        require(anchor in nef_deserialize, 'Missing step anchor: ' + anchor)
        placed.append((nef_deserialize.index(anchor), name))
    return [name for _, name in sorted(placed)]


def project_sources(contents, *, enforce_identity=True):
    require(set(contents) == set(SOURCES), 'Incomplete/extra load admission source set')
    if enforce_identity:
        for key, text in contents.items():
            require(sha(text.encode()) == SOURCES[key]['sha256'], 'Pinned source mismatch: ' + key)

    nef = strip_directives(contents['core/nef'])
    token = strip_directives(contents['core/token'])
    manifest = strip_directives(contents['core/manifest'])
    abi = strip_directives(contents['core/abi'])
    method = strip_directives(contents['core/method'])

    nef_deserialize = body(nef, SIGNATURES['nefDeserialize'][1])
    token_deserialize = body(token, SIGNATURES['tokenDeserialize'][1])
    manifest_from_json = body(manifest, SIGNATURES['manifestFromJson'][1])
    manifest_parse = body(manifest, SIGNATURES['manifestParse'][1])
    abi_from_json = body(abi, SIGNATURES['abiFromJson'][1])
    abi_get_method = body(abi, SIGNATURES['abiGetMethod'][1])
    method_from_json = body(method, SIGNATURES['methodFromJson'][1])

    program = dict(
        step_order=step_order(nef_deserialize),
        magic_is_the_declared_nef3_constant='reader.ReadUInt32()!=Magic' in nef_deserialize,
        the_reserved_fields_must_be_zero=(
            nef_deserialize.count('if(reader.ReadByte()!=0)thrownewFormatException('
                                  '"Reserved bytes must be 0");') == 1
            and nef_deserialize.count('if(reader.ReadUInt16()!=0)thrownewFormatException('
                                      '"Reserved bytes must be 0");') == 1),
        token_array_cap=declared_int(nef_deserialize,
                                     r'Tokens=reader\.ReadSerializableArray<MethodToken>\(([^)]+)\)',
                                     'token array cap'),
        the_script_cannot_be_empty=(
            'if(Script.Length==0)thrownewArgumentException("Script cannot be empty.");'
            in nef_deserialize),
        the_checksum_is_compared_for_inequality=(
            'if(CheckSum!=ComputeChecksum(this))' in nef_deserialize),
        the_checksum_check_is_guarded_by_the_verify_flag=('if(verify)' in nef_deserialize),
        a_token_method_cannot_start_with_underscore=(
            "if(Method.StartsWith('_'))thrownewFormatException(" in token_deserialize),
        token_method_name_limit=declared_int(token_deserialize,
                                             r'Method=reader\.ReadVarString\(([^)]+)\);',
                                             'token method name limit'),
        a_token_flag_byte_must_be_a_declared_flag=(
            '(CallFlags&~CallFlags.All)!=0' in token_deserialize),
        the_manifest_name_cannot_be_empty=(
            'if(string.IsNullOrEmpty(manifest.Name))thrownewFormatException(' in manifest_from_json),
        the_features_field_must_be_empty=('features.Count!=0' in manifest_from_json),
        the_manifest_names_cannot_repeat=(
            '_=manifest.SupportedStandards.ToDictionary(p=>p);' in manifest_from_json
            and '_=manifest.Permissions.ToDictionary(p=>p.Contract);' in manifest_from_json
            and '_=manifest.Trusts.ToDictionary(p=>p);' in manifest_from_json),
        manifest_length_cap=declared_int(
            manifest, r'public const int MaxLength = ([^;]+);', 'manifest length cap'),
        the_manifest_length_cap_is_enforced_before_parsing=(
            'json.Length>MaxLength' in manifest_parse),
        the_abi_needs_at_least_one_method=('if(abi.Methods.Length==0)throw' in abi_from_json),
        the_exact_lookup_is_keyed_by_name_and_arity=(
            'Methods.ToDictionary(p=>(p.Name,p.Parameters.Length))' in abi_get_method),
        the_arity_is_range_checked=(
            'if(pcount<-1||pcount>ushort.MaxValue)' in abi_get_method),
        the_wildcard_lookup_ignores_the_arity=(
            'Methods.FirstOrDefault(p=>p.Name==name)' in abi_get_method),
        the_exact_lookup_returns_null_when_absent=(
            'returnnull;' in abi_get_method and 'TryGetValue' in abi_get_method),
        a_method_name_cannot_be_empty=(
            'if(string.IsNullOrEmpty(descriptor.Name))thrownewFormatException(' in method_from_json),
        a_method_parameter_name_cannot_repeat=(
            '_=descriptor.Parameters.ToDictionary(p=>p.Name);' in method_from_json),
        a_method_return_type_must_be_defined=(
            'if(!Enum.IsDefined(typeof(ContractParameterType),descriptor.ReturnType))throw'
            in method_from_json),
        a_method_offset_cannot_be_negative=(
            'if(descriptor.Offset<0)throw' in method_from_json),
    )
    return dict(schema='neoos-sa-load-admission-source/v1', scope=SCOPE,
                entryBoundary=ENTRY_BOUNDARY, coreCommit=CORE_COMMIT,
                sourceHashes={k: sha(v.encode()) for k, v in contents.items()},
                methods=dict(nefDeserialize=nef_deserialize,
                             tokenDeserialize=token_deserialize,
                             manifestFromJson=manifest_from_json, manifestParse=manifest_parse,
                             abiFromJson=abi_from_json, abiGetMethod=abi_get_method,
                             methodFromJson=method_from_json),
                program=program,
                reasonOnlyGuards=['exact-lookup-key-is-(name,arity)',
                                  'the-checksum-is-last-and-optional'],
                preconditions=PRECONDITIONS, unproved=UNPROVED, tcb=TCB,
                sourceFrontendVerified=False)


def mutated_projection(contents, name):
    require(name in CONTROL_MUTATIONS, 'Unknown semantic mutant')
    key, before, after = CONTROL_MUTATIONS[name]
    changed = dict(contents)
    require(changed[key].count(before) == 1, 'Missing/ambiguous semantic mutation: ' + before)
    changed[key] = changed[key].replace(before, after)
    return project_sources(changed, enforce_identity=False), sha(changed[key].encode())


def source_url(row):
    return ('https://raw.githubusercontent.com/neo-project/' + row['repository'] + '/'
            + row['commit'] + '/' + row['relativePath'])


DOWNLOAD_ATTEMPT_TIMEOUTS = (30, 45, 60, 90)


def download_pinned(url):
    last_error = None
    for timeout in DOWNLOAD_ATTEMPT_TIMEOUTS:
        try:
            return urllib.request.urlopen(url, timeout=timeout).read()
        except urllib.error.HTTPError:
            raise
        except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
            last_error = exc
    raise last_error


def mirror_source(key, row):
    """Return pinned bytes from a local mirror directory, or None.

    The pin, not the transport, is the evidence: mirror bytes must hash to the
    same pinned value a download would have to reach, so a mirror cannot launder
    a different artifact. This only substitutes for a stalled network.
    """
    mirror = os.environ.get('SA_LOAD_ADMISSION_SOURCE_MIRROR')
    if not mirror:
        return None
    candidate = Path(mirror) / (key.replace('/', '-') + '.cs')
    if not candidate.is_file():
        return None
    raw = candidate.read_bytes()
    require(sha(raw) == row['sha256'], 'Offline mirror source mismatch')
    return raw


def project_production(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    contents = {}
    rows = {}
    for key, row in SOURCES.items():
        path = directory / (key.replace('/', '-') + '.cs')
        if not path.exists():
            raw = mirror_source(key, row)
            if raw is None:
                raw = download_pinned(source_url(row))
            require(sha(raw) == row['sha256'], 'Downloaded pinned source mismatch')
            path.write_bytes(raw)
        raw = path.read_bytes()
        require(sha(raw) == row['sha256'], 'Pinned source file drift')
        contents[key] = raw.decode('utf-8')
        rows[key] = dict(path=str(path.resolve()), url=source_url(row), sha256=sha(raw))
    return project_sources(contents), rows


def project_captured(rows):
    require(isinstance(rows, dict) and set(rows) == set(SOURCES),
            'Missing/extra pinned source dependencies')
    paths = []
    contents = {}
    for key, expected in SOURCES.items():
        row = rows[key]
        require(set(row) == {'path', 'url', 'sha256'}, 'Malformed pinned source identity')
        path = Path(row['path'])
        require(path.is_absolute(), 'Relative pinned source path')
        paths.append(str(path.resolve()))
        require(row['url'] == source_url(expected) and row['sha256'] == expected['sha256'],
                'Swapped/unpinned source URL/hash')
        raw = path.read_bytes()
        require(sha(raw) == expected['sha256'], 'Pinned source bytes mismatch')
        contents[key] = raw.decode()
    require(len(paths) == len(set(paths)), 'Duplicate pinned source paths')
    return project_sources(contents)
