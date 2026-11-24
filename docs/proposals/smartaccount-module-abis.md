# SmartAccount module ABIs

Reference ABI for each [named profile](nep-smartaccount-module-profiles.mediawiki). Signatures and safe flags come from compiled manifests; each digest covers only the canonical profile bytes. The [interface](nep-smartaccount-module-interface.mediawiki) defines the common callbacks. A safe flag is not proof of authorization or behavior.

## ActionSessionValidator

Role: validator. Profile SHA-256: `5853c11f2bd8c6ab92c85433914a307236f7d05086d4bcff437a12bb37c93a62`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
safe getRecoveryAuthority(accountId: Hash160) -> Hash160
safe getRecoveryService(accountId: Hash160, moduleId: Integer) -> Hash160
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## DailyLimitHook

Role: hook. Profile SHA-256: `24637fcfc0c0b51584f622e953225bce1277f9c4a54147acf4a11eda6da2d19d`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAdminRotation() -> Void
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAdminRotation(newAdmin: Hash160) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getDailyLimit(accountId: Hash160, moduleId: Integer, token: Hash160) -> Integer
safe getLimitConfig(accountId: Hash160, moduleId: Integer, token: Hash160) -> Any
safe getModuleProfile() -> String
safe isRollingWindow(accountId: Hash160, moduleId: Integer, token: Hash160) -> Boolean
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
postCheck(accountId: Hash160, operation: Array, result: Any, hookData: ByteArray) -> Void
preCheck(accountId: Hash160, operation: Array) -> ByteArray
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
rotateAdmin(newAdmin: Hash160) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
```

## DelegatedIdentityValidator

Role: validator. Profile SHA-256: `5e908a6565ad1fe90bb757f5ea520c221317bb25b285bbad063fedbf5792102f`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=true`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getConfig(accountId: Hash160, moduleId: Integer) -> Array
safe getMasterNullifier(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getModuleProfile() -> String
safe getProvider(accountId: Hash160, moduleId: Integer) -> String
safe getPublicKey(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
safe getSigningDigest(accountId: Hash160, moduleId: Integer, operationDigest: ByteArray, actionNullifier: ByteArray) -> ByteArray
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## GovernanceModule

Role: validator. Profile SHA-256: `331fc570362ff2924f0de4d0de01a99b60981b1e749515f49634af5ea27be41c`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelConfiguration(accountId: Hash160, intentId: Integer) -> Void
safe configurationExpiryWindow() -> Integer
safe configurationMaturity() -> Integer
confirmConfiguration(accountId: Hash160, intentId: Integer, actions: Array) -> Void
safe getLastCompletion(accountId: Hash160) -> Array
safe getModuleProfile() -> String
safe getPendingConfiguration(accountId: Hash160, intentId: Integer) -> Array
safe getPendingConfigurationIntentIds(accountId: Hash160) -> Array
onInstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeConfiguration(accountId: Hash160, actions: Array, readSet: Array) -> Integer
setAuthorizedCore(coreContract: Hash160) -> Void
storeGovernedPolicy(accountId: Hash160, kind: Integer, policy: ByteArray) -> Void
unfreezeAccount(accountId: Hash160) -> Integer
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## HookOrchestratorModule

Role: validator. Profile SHA-256: `42c18e884852f9c59fdd2586def2af35eb68aa4ffde36d7ab2f71ad63aece1c2`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
safe getCredentialGeneration(accountId: Hash160, moduleId: Integer) -> Integer
safe getHookOrder(accountId: Hash160) -> Array
safe getModuleProfile() -> String
onInstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
revokeCredentials(accountId: Hash160, moduleId: Integer) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
setHookOrder(accountId: Hash160, hookIds: Array) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## MultiHook

Role: hook. Profile SHA-256: `907a08e86a1dfb99d70721c14f93f5f995ec1426b9b250ffe9fc1d0af2a3f8d4`.

Capabilities: `compositeLayer=1`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAdminRotation() -> Void
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAdminRotation(newAdmin: Hash160) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
postCheck(accountId: Hash160, operation: Array, result: Any, hookData: ByteArray) -> Void
preCheck(accountId: Hash160, operation: Array) -> ByteArray
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
rotateAdmin(newAdmin: Hash160) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
```

## MultiSigValidator

Role: validator. Profile SHA-256: `ef27e3ab7390229ce2617178cf2b6ce8445119befefa6f9136185c44b21c9ce8`.

Capabilities: `compositeLayer=0`, `instanceIsolation=true`, `messageCapability=false`, `thresholdMemberEligible=true`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getMemberDigest(accountId: Hash160, moduleId: Integer, operationDigest: ByteArray) -> ByteArray
safe getMemberKey(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getModuleProfile() -> String
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## NeoDIDCredentialHook

Role: hook. Profile SHA-256: `ab5a9e8e26672e8791c0fc66adc991c04f5cedcd7d518e57c1db1e661032b747`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAdminRotation() -> Void
cancelAuthorizedCoreChange() -> Void
cancelRegistryChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAdminRotation(newAdmin: Hash160) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmRegistry(registryContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
safe getRegistry() -> Hash160
safe getRequiredClaimType(accountId: Hash160, moduleId: Integer, targetContract: Hash160) -> String
safe getRequiredProvider(accountId: Hash160, moduleId: Integer, targetContract: Hash160) -> String
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
postCheck(accountId: Hash160, operation: Array, result: Any, hookData: ByteArray) -> Void
preCheck(accountId: Hash160, operation: Array) -> ByteArray
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeRegistry(registryContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
rotateAdmin(newAdmin: Hash160) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
setRegistry(registryContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
```

## NeoWitnessValidator

Role: validator. Profile SHA-256: `b2b644b0d0a488b326a462e338732b0a5ac6cf054f2664698da16bc67fee06a8`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=true`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getConfig(accountId: Hash160, moduleId: Integer) -> Array
safe getModuleProfile() -> String
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
safe getThreshold(accountId: Hash160, moduleId: Integer) -> Integer
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## P256Validator

Role: validator. Profile SHA-256: `15307d47b9ee7e68f88f5c85e8b400fa4f2c4463ec7920e0be3d43fcf819bffe`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=true`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
safe getPublicKey(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## RecoveryModule

Role: recovery. Profile SHA-256: `9e3aa360fd7b9bc1d04d368140639e44985a07045f338a3036df3e0859e536e6`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
beginRecovery(accountId: Hash160, newCustody: Hash160) -> Integer
cancelRecovery(accountId: Hash160) -> Void
cancelReviewedRecovery(accountId: Hash160, nonce: Integer, configurationNonce: Integer) -> Void
executeRecovery(accountId: Hash160) -> Void
executeReviewedRecovery(accountId: Hash160, nonce: Integer, configurationNonce: Integer) -> Void
safe getExecutedRecoveryNonce(accountId: Hash160) -> Integer
safe getModuleProfile() -> String
safe getRecoveryPolicySnapshot(accountId: Hash160) -> Array
safe getRecoveryStatus(accountId: Hash160) -> Array
onInstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, deInitData: Array) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
```

## SessionKeyValidator

Role: validator. Profile SHA-256: `514b6a9f92acbea2dba3fb54243d510370bd13bbd6af1528ffc9e0b393f978b2`.

Capabilities: `compositeLayer=0`, `instanceIsolation=true`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, moduleType: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getGrantDigest(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getModuleProfile() -> String
safe getSessionKey(accountId: Hash160, moduleId: Integer) -> Array
safe getSessionKeyMetadata(accountId: Hash160, moduleId: Integer) -> Array
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
safe getSpentAmount(accountId: Hash160, moduleId: Integer) -> Integer
onInstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## SigningModule

Role: validator. Profile SHA-256: `9249ca5e3f9e6c5ec39aa24b8aa6957ae7e9eacb90148909a770477d4253781a`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
safe getMessageSubjects(accountId: Hash160) -> Array
safe getModuleProfile() -> String
onInstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## SubscriptionValidator

Role: validator. Profile SHA-256: `2a5c7ef4be4400b522b7ec551dd94716f2aacd973e7177978be76fd9fc4e9a9b`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, moduleType: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getLastChargedPeriod(accountId: Hash160, moduleId: Integer, subId: ByteArray) -> Integer
safe getModuleProfile() -> String
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
safe getSubscription(accountId: Hash160, moduleId: Integer, subId: ByteArray) -> Array
onInstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## TeeKeyValidator

Role: validator. Profile SHA-256: `3324906394d93ec782900e2966443b8cb218eba16da5ca390bb9a311455c5757`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=true`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getKeyId(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getModuleProfile() -> String
safe getPublicKey(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## ThresholdPolicyModule

Role: validator. Profile SHA-256: `b84a2a4b342ca09ba6b460a207b8ada6bcafea06f0240bc952e873e7b0833370`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
safe getModuleProfile() -> String
safe getThresholdPolicy(accountId: Hash160, policyId: Integer) -> Array
onInstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, moduleType: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## TokenRestrictedHook

Role: hook. Profile SHA-256: `7a5158df19148c21148939f3e3fa203a9477ee45c3ee8f493ed6433c90fca471`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAdminRotation() -> Void
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAdminRotation(newAdmin: Hash160) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
safe isRestricted(accountId: Hash160, moduleId: Integer, token: Hash160) -> Boolean
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
postCheck(accountId: Hash160, operation: Array, result: Any, hookData: ByteArray) -> Void
preCheck(accountId: Hash160, operation: Array) -> ByteArray
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
rotateAdmin(newAdmin: Hash160) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
```

## Web3AuthValidator

Role: validator. Profile SHA-256: `0412eb33dbb4374e9b36b7bdec8d6461ae4ae4d51e48f2b27c147fbb44122ff8`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=true`, `thresholdMemberEligible=true`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
safe getPublicKey(accountId: Hash160, moduleId: Integer) -> ByteArray
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
safe getSigningPayload(accountId: Hash160, moduleId: Integer, operationDigest: ByteArray, operation: Array) -> ByteArray
safe isValidSignature(accountId: Hash160, originalSender: Hash160, validatorId: Integer, generation: Integer, hash: ByteArray, signatures: Array) -> Boolean
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```

## WhitelistHook

Role: hook. Profile SHA-256: `3d7413093315107b2dc8f2ffab4d0894394df39604eafdb5a84fc8117145d9da`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAdminRotation() -> Void
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAdminRotation(newAdmin: Hash160) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
safe isWhitelisted(accountId: Hash160, moduleId: Integer, targetContract: Hash160) -> Boolean
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
postCheck(accountId: Hash160, operation: Array, result: Any, hookData: ByteArray) -> Void
preCheck(accountId: Hash160, operation: Array) -> ByteArray
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
rotateAdmin(newAdmin: Hash160) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
```

## ZKEmailVerifier

Role: validator. Profile SHA-256: `abc52e25a21988490831f83df62f02014a4680e75467f68871d2c08163193a78`.

Capabilities: `compositeLayer=0`, `instanceIsolation=false`, `messageCapability=false`, `thresholdMemberEligible=false`.

```text
_deploy(data: Any, update: Boolean) -> Void
_initialize() -> Void
safe authorizedCore() -> Hash160
cancelAuthorizedCoreChange() -> Void
cancelUpdate() -> Void
configure(accountId: Hash160, moduleId: Integer, generation: Integer, configData: Array) -> Void
confirmAuthorizedCore(coreContract: Hash160) -> Void
confirmUpdate(nef: ByteArray, manifest: String) -> Void
safe getModuleProfile() -> String
safe getSignerDomains(accountId: Hash160, moduleId: Integer) -> Array
onInstall(accountId: Hash160, moduleId: Integer, generation: Integer, initData: Array) -> Void
onUninstall(accountId: Hash160, moduleId: Integer, generation: Integer, deInitData: Array) -> Void
onUserOpComplete(accountId: Hash160, operation: Array, result: Any) -> Void
proposeAuthorizedCore(coreContract: Hash160) -> Void
proposeUpdate(nefHash: Hash256, manifestHash: Hash256) -> Void
setAuthorizedCore(coreContract: Hash160) -> Void
update(nef: ByteArray, manifest: String) -> Void
safe validateUserOp(accountId: Hash160, operationDigest: ByteArray, operation: Array) -> Boolean
```
