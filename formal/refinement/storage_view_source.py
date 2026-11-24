"""Bind the storage view used by the presence certificate to the Neo 3.10.1 sources."""
import re
import subprocess

from ordinary_entry_proofs import digest
from syscall_dispatch_source import CORE_COMMIT, SIGNATURES, TEMPLATES, body, require


def load(repo):
    def read(path):
        raw = subprocess.check_output(["git", "-C", str(repo), "show", CORE_COMMIT+":"+path])
        hashes[path] = digest(raw)
        return raw.decode("utf-8-sig")

    hashes = {}
    handlers = read("src/Neo/SmartContract/ApplicationEngine.Storage.cs")
    cache = read("src/Neo/Persistence/DataCache.cs")
    engine = read("src/Neo/SmartContract/ApplicationEngine.cs")
    flags = read("src/Neo/SmartContract/CallFlags.cs")
    require(body(handlers, "protected internal StorageContext GetStorageContext()") ==
            '{ContractStatecontract=NativeContract.ContractManagement.GetContract(SnapshotCache,CurrentScriptHash!)'
            '??thrownewInvalidOperationException("This method can only be called by a deployed contract.");'
            'returnnewStorageContext{Id=contract.Id,IsReadOnly=false};}', "unexpected context resolution")
    require(body(handlers, "protected internal ReadOnlyMemory<byte>? Get(StorageContext context, byte[] key)") ==
            "{returnSnapshotCache.TryGet(newStorageKey{Id=context.Id,Key=key})?.Value;}", "unexpected storage key")
    require(body(cache, "public StorageItem? TryGet(StorageKey key)") ==
            "{lock(_dictionary){if(_dictionary.TryGetValue(key,outvartrackable)){"
            "if(trackable.State==TrackState.Deleted||trackable.State==TrackState.NotFound)returnnull;"
            "returntrackable.Item;}varvalue=TryGetInternalWrapper(key);if(value==null)returnnull;"
            "_dictionary.Add(key,newTrackable(value,TrackState.None));returnvalue;}}", "unexpected overlay lookup")
    require(body(cache, "private StorageItem? TryGetInternalWrapper(StorageKey key)") ==
            "{varitem=TryGetInternal(key);if(item==null)returnnull;OnRead?.Invoke(this,key,item);returnitem;}",
            "unexpected backing lookup")
    for name in ("OnSysCall", "ValidateCallFlags"):
        require(body(engine, SIGNATURES[name][1]) == TEMPLATES[name], "unexpected dispatch: "+name)
    prices = {}
    for name, handler in (("GetContext","GetStorageContext"), ("Get","Get")):
        pat = (rf'public static readonly InteropDescriptor System_Storage_{name} = '
               rf'Register\("System\.Storage\.{name}", nameof\({handler}\), 1 << (\d+), CallFlags.ReadStates\);')
        shift, = re.findall(pat, handlers)
        prices[name] = 1 << int(shift)
    require(re.findall(r"\bReadStates\s*=\s*0b([01]+),", flags) == ["00000001"], "unexpected read flag")
    return dict(commit=CORE_COMMIT, sourceSha256=hashes, fixedPrice=prices)
