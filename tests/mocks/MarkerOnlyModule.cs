using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using System.ComponentModel;

namespace SmartAccount.Mocks
{
    /// <summary>
    /// Deliberately incomplete module: it deploys and answers calls but exposes none
    /// of the protocol v4 module surface (no canonical profile, no lifecycle trio, no
    /// validator or hook callbacks). The core must reject it at bind time.
    /// </summary>
    /// <remarks>
    /// Protocol v4 removed the <c>supportsV3</c>/<c>supportsComposition</c> markers:
    /// a module is bound by its canonical profile digest plus the callback ABI of its
    /// module type (docs/SA-MODULE-PROTOCOL.md §9/§12), so a marker-only contract has
    /// nothing left to declare.
    /// </remarks>
    [DisplayName("MarkerOnlyModule")]
    [ContractPermission("*", "*")]
    [ManifestExtra("Description", "Test-only module without the v4 module surface")]
    public class MarkerOnlyModule : SmartContract
    {
        // Any exported method keeps the manifest non-empty; nothing here is part of
        // the module ABI.
        [Safe]
        public static string ProtocolLabel() => "no-module-surface";
    }
}
