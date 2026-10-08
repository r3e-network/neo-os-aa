const { codeIdentityTools } = require("./moduleIdentity");
const { validateNativeModuleProfile, NATIVE_COMPOSITE_MAX_CHILDREN } = require("./client");
const fail = (message) => {
  throw new Error(`Native verifier witness: ${message}`);
};
function createVerifierWitnessTools(c) {
  const { moduleCodeHash } = codeIdentityTools(c);
  async function read(client, plan, signerAccounts) {
    if (!signerAccounts.length) return null;
    if (plan.kind !== "execution")
      fail("verifier signers are only valid for UserOperations");
    const state = plan.preparedOperations[0].account;
    if (!state?.verifier)
      fail("native custody fallback has no verifier witness authority");
    const registry = await client.getModuleDependencies(
      plan.accountId,
      "verifier",
    );
    if (JSON.stringify(registry.root) !== JSON.stringify(state.verifier))
      fail("verifier registry root changed");
    if (
      registry.cleanupBindings.length > NATIVE_COMPOSITE_MAX_CHILDREN ||
      registry.activeChildren.length > NATIVE_COMPOSITE_MAX_CHILDREN ||
      registry.cleanupBindings.some((x) => !x) ||
      new Set(registry.cleanupBindings.map((x) => x.contract)).size !==
        registry.cleanupBindings.length ||
      new Set(registry.activeChildren).size !==
        registry.activeChildren.length ||
      registry.activeChildren.some(
        (h) => !registry.cleanupBindings.some((x) => x.contract === h),
      ) ||
      registry.cleanupBindings.some(
        (x) => x.contract === registry.root.contract,
      )
    )
      fail("malformed native verifier registry");
    const pins = [
      registry.root,
      ...registry.activeChildren.map((h) =>
        registry.cleanupBindings.find((x) => x.contract === h),
      ),
    ];
    const scopes = Object.fromEntries(signerAccounts.map((a) => [a, []])),
      modules = [];
    for (const [index, pin] of pins.entries()) {
      const deployed = await client.rpc.send("getcontractstate", [
        "0x" + pin.contract,
      ]);
      if (
        !Number.isSafeInteger(deployed?.id) ||
        deployed.id < 0 ||
        c.hex(deployed.hash, 20) !== pin.contract ||
        moduleCodeHash(deployed) !== pin.codeHash ||
        deployed.manifest.extra?.SmartAccountProfile !== "native-v2"
      )
        fail("deployed verifier code does not match pinned identity");
      const metadata = validateNativeModuleProfile(
        deployed,
        client.profileParameterDigest,
      );
      const composition = await client._read(
        "supportsComposition",
        [],
        pin.contract,
      );
      if (composition !== metadata.compositeVerifier)
        fail(
          "module composition capability does not match its profile metadata",
        );
      if (typeof composition !== "boolean" || (index > 0 && composition))
        fail("unsupported recursive verifier topology");
      if (
        index === 0 &&
        ((composition && deployed.manifest.name !== "MultiSigVerifier") ||
          (!composition && registry.activeChildren.length))
      )
        fail("unsupported native verifier root topology");
      const entry = { ...pin, name: deployed.manifest.name, composition };
      if (deployed.manifest.name === "NeoNativeVerifier") {
        if (composition) fail("native witness verifier must be a leaf");
        const config = await client._read(
          "getConfig",
          [c.hashValue(plan.accountId)],
          pin.contract,
        );
        if (
          !config ||
          !["Array", "Struct"].includes(config.type) ||
          config.value.length !== 2 ||
          config.value[0]?.type !== "Array" ||
          typeof config.value[1] !== "bigint"
        )
          fail("malformed NeoNativeVerifier configuration");
        const signers = config.value[0].value.map((v) => {
          if (!(v instanceof Uint8Array) || v.length !== 20)
            fail("malformed witness signer");
          return Buffer.from(v).reverse().toString("hex");
        });
        const threshold = config.value[1];
        if (
          !signers.length ||
          signers.length > 10 ||
          new Set(signers).size !== signers.length ||
          signers.some((h) => /^0+$/.test(h)) ||
          threshold < 1n ||
          threshold > BigInt(signers.length)
        )
          fail("invalid native witness threshold or roster");
        entry.signers = signers;
        entry.threshold = threshold.toString();
        for (const account of signerAccounts)
          if (signers.includes(account)) scopes[account].push(pin.contract);
      }
      modules.push(entry);
    }
    if (Object.values(scopes).some((list) => !list.length))
      fail(
        "explicit verifier signer is not configured in a native witness leaf",
      );
    return { registry, modules, scopes };
  }
  async function revalidate(client, prepared) {
    if (
      prepared.verifierContext &&
      JSON.stringify(
        await read(client, prepared.plan, prepared.verifierAccounts),
      ) !== JSON.stringify(prepared.verifierContext)
    )
      fail("verifier configuration, roster or code identity changed");
  }
  return { read, revalidate };
}
module.exports = { createVerifierWitnessTools };
