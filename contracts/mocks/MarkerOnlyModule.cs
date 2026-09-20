using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using System.ComponentModel;

namespace AbstractAccount.Mocks
{
    /// <summary>
    /// Deliberately incomplete V3 module used to prove that the wallet checks the
    /// lifecycle ABI instead of trusting the SupportsV3 marker alone.
    /// </summary>
    [DisplayName("MarkerOnlyModule")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only incomplete AA module")]
    public class MarkerOnlyModule : SmartContract
    {
        [Safe]
        public static bool SupportsV3() => true;
    }
}
