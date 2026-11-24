From Coq Require Import List String NArith PeanoNat Bool.
Require Import EntryDispatch ContractHandoff OrdinaryEntry.
Import ListNotations. Open Scope string_scope.
Definition hp := (handoff_program true 10%N true true 1 true true true true true true true true true true true 0 true).
Definition dp := (dispatch_program true true true true 15%N 10%N true 1 0 0 true true true 0 true true 65535).
Definition abi := [(descriptor "computeRegistrationAccountId" 5 0 true true);(descriptor "registerAccount" 6 420 false false);(descriptor "registerAccounts" 6 2317 false false);(descriptor "updateHook" 2 2528 false false);(descriptor "confirmHookUpdate" 1 3352 false false);(descriptor "updateVerifier" 3 3830 false false);(descriptor "confirmVerifierUpdate" 1 4307 false false);(descriptor "callVerifier" 3 5094 false true);(descriptor "callHook" 3 5335 false true);(descriptor "_deploy" 2 5517 false false);(descriptor "proposeUpdate" 2 5555 false false);(descriptor "cancelUpdate" 0 5920 false false);(descriptor "update" 2 5983 false false);(descriptor "confirmUpdate" 2 6391 false false);(descriptor "getContractAdmin" 0 6402 true true);(descriptor "proposeAdminTransfer" 1 6462 false false);(descriptor "cancelAdminTransfer" 0 6694 false false);(descriptor "confirmAdminTransfer" 0 6760 false false);(descriptor "getPendingContractAdmin" 0 7041 true true);(descriptor "getAdminTransferAvailableAt" 0 7101 true true);(descriptor "isOwnerOnlyRecovery" 1 7142 true true);(descriptor "finalizeEscapeToOwner" 1 7422 false false);(descriptor "initiateEscape" 1 8259 false false);(descriptor "finalizeEscape" 2 8514 false false);(descriptor "finalizeEscape" 3 8526 false false);(descriptor "executeUserOp" 2 9394 false true);(descriptor "previewUserOpValidation" 2 11676 true true);(descriptor "executeUserOps" 2 11753 false true);(descriptor "isExecutionActive" 1 7396 true true);(descriptor "enterMarketEscrow" 3 11921 false false);(descriptor "cancelMarketEscrow" 2 12136 false false);(descriptor "settleMarketEscrow" 3 12534 false false);(descriptor "initiateMarketEscrowCancel" 1 13116 false false);(descriptor "forceCancelMarketEscrow" 1 13260 false false);(descriptor "hasMarketEscrowOwnerCancel" 1 13514 true true);(descriptor "getMarketEscrowOwnerCancelTime" 1 13525 true true);(descriptor "executeSponsoredUserOp" 5 13765 false true);(descriptor "executeSponsoredUserOps" 5 14110 false true);(descriptor "computePlatformAccountId" 3 14754 true true);(descriptor "computeStablePlatformAccountId" 2 14907 true true);(descriptor "registerPlatformAccount" 4 15018 false false);(descriptor "registerStablePlatformAccount" 4 15519 false false);(descriptor "rotatePlatformAccountOwner" 3 15701 false false);(descriptor "proposePlatformAccountOwnerRotation" 3 15710 false false);(descriptor "confirmPlatformAccountOwnerRotation" 2 16144 false false);(descriptor "cancelPlatformAccountOwnerRotation" 2 16612 false false);(descriptor "getPendingPlatformAccountOwnerRotation" 1 16987 true true);(descriptor "getPlatformAccountOwnerRotationAvailableAt" 1 17043 true true);(descriptor "proposePlatformRegistrar" 1 17064 false false);(descriptor "confirmPlatformRegistrar" 0 17314 false false);(descriptor "cancelPlatformRegistrar" 0 17583 false false);(descriptor "getPlatformRegistrar" 0 15211 true true);(descriptor "getAccountIdByProxy" 1 17661 true true);(descriptor "getPendingPlatformRegistrar" 0 17805 true true);(descriptor "getPlatformRegistrarAvailableAt" 0 17865 true true);(descriptor "getProxyScriptHash" 1 15373 true true);(descriptor "getAccountImplementationId" 0 17906 true true);(descriptor "supportsExecutionMode" 1 17949 true true);(descriptor "supportsModuleType" 1 18000 true true);(descriptor "isModuleInstalled" 3 18049 true true);(descriptor "isValidSignature" 3 18156 true true);(descriptor "getVerifier" 1 18389 true true);(descriptor "getHook" 1 18403 true true);(descriptor "getBackupOwner" 1 18417 true true);(descriptor "getEscapeTimelock" 1 18431 true true);(descriptor "getEscapeTriggeredAt" 1 18445 true true);(descriptor "getMarketEscrowContract" 1 3226 true true);(descriptor "getMarketEscrowListingId" 1 3291 true true);(descriptor "isMarketEscrowActive" 1 3184 true true);(descriptor "isEscapeActive" 1 18459 true true);(descriptor "getNonce" 2 18475 true true);(descriptor "computeArgsHash" 1 18569 true true);(descriptor "hasPendingVerifierUpdate" 1 18645 true true);(descriptor "hasPendingHookUpdate" 1 18671 true true);(descriptor "getPendingVerifierUpdate" 1 18696 true true);(descriptor "getPendingHookUpdate" 1 18766 true true);(descriptor "getPendingVerifierUpdateTime" 1 18827 true true);(descriptor "getPendingHookUpdateTime" 1 18871 true true);(descriptor "hasPendingVerifierCall" 1 18950 true true);(descriptor "hasPendingHookCall" 1 18963 true true);(descriptor "getPendingVerifierCallModule" 1 18976 true true);(descriptor "getPendingHookCallModule" 1 19020 true true);(descriptor "getPendingVerifierCallHash" 1 19064 true true);(descriptor "getPendingHookCallHash" 1 19093 true true);(descriptor "getPendingVerifierCallTime" 1 19122 true true);(descriptor "getPendingHookCallTime" 1 19151 true true);(descriptor "cancelVerifierUpdate" 1 19180 false false);(descriptor "cancelHookUpdate" 1 19307 false false);(descriptor "setMetadataUri" 2 19425 false false);(descriptor "getMetadataUri" 1 19540 true true);(descriptor "callVerifierChild" 4 19576 false true);(descriptor "verify" 1 21023 true true);(descriptor "getVerifyScopeTarget" 1 21400 true true);(descriptor "setVerifyScopeTarget" 2 24202 false false);(descriptor "setVerifyScopeTargets" 2 24462 false false);(descriptor "canConfigureVerifier" 2 24592 true true);(descriptor "canConfigureHook" 2 24661 true true);(descriptor "canExecuteVerifier" 3 24731 true true);(descriptor "canExecuteHook" 3 24817 true true);(descriptor "_initialize" 0 24903 false false)].
Definition init : option nat := Some 24903.
Example init_lookup : init = option_map D.descriptor_offset (D.abi_select abi "_initialize" 0).
Proof. vm_compute. reflexivity. Qed.
Definition d0 := (descriptor "computeRegistrationAccountId" 5 0 true true).
Example lookup0 : D.abi_select abi "computeRegistrationAccountId" 5 = Some d0.
Proof. vm_compute. reflexivity. Qed.
Theorem entry0 : forall args flags caller tail ids b a s w fee count,
List.length args = 5 -> D.valid_flags flags ->
enter hp dp abi "computeRegistrationAccountId" args flags caller tail ids init b a s w fee count = specification d0 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup0]. Qed.
Definition d1 := (descriptor "registerAccount" 6 420 false false).
Example lookup1 : D.abi_select abi "registerAccount" 6 = Some d1.
Proof. vm_compute. reflexivity. Qed.
Theorem entry1 : forall args flags caller tail ids b a s w fee count,
List.length args = 6 -> D.valid_flags flags ->
enter hp dp abi "registerAccount" args flags caller tail ids init b a s w fee count = specification d1 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup1]. Qed.
Definition d2 := (descriptor "registerAccounts" 6 2317 false false).
Example lookup2 : D.abi_select abi "registerAccounts" 6 = Some d2.
Proof. vm_compute. reflexivity. Qed.
Theorem entry2 : forall args flags caller tail ids b a s w fee count,
List.length args = 6 -> D.valid_flags flags ->
enter hp dp abi "registerAccounts" args flags caller tail ids init b a s w fee count = specification d2 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup2]. Qed.
Definition d3 := (descriptor "updateHook" 2 2528 false false).
Example lookup3 : D.abi_select abi "updateHook" 2 = Some d3.
Proof. vm_compute. reflexivity. Qed.
Theorem entry3 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "updateHook" args flags caller tail ids init b a s w fee count = specification d3 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup3]. Qed.
Definition d4 := (descriptor "confirmHookUpdate" 1 3352 false false).
Example lookup4 : D.abi_select abi "confirmHookUpdate" 1 = Some d4.
Proof. vm_compute. reflexivity. Qed.
Theorem entry4 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "confirmHookUpdate" args flags caller tail ids init b a s w fee count = specification d4 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup4]. Qed.
Definition d5 := (descriptor "updateVerifier" 3 3830 false false).
Example lookup5 : D.abi_select abi "updateVerifier" 3 = Some d5.
Proof. vm_compute. reflexivity. Qed.
Theorem entry5 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "updateVerifier" args flags caller tail ids init b a s w fee count = specification d5 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup5]. Qed.
Definition d6 := (descriptor "confirmVerifierUpdate" 1 4307 false false).
Example lookup6 : D.abi_select abi "confirmVerifierUpdate" 1 = Some d6.
Proof. vm_compute. reflexivity. Qed.
Theorem entry6 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "confirmVerifierUpdate" args flags caller tail ids init b a s w fee count = specification d6 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup6]. Qed.
Definition d7 := (descriptor "callVerifier" 3 5094 false true).
Example lookup7 : D.abi_select abi "callVerifier" 3 = Some d7.
Proof. vm_compute. reflexivity. Qed.
Theorem entry7 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "callVerifier" args flags caller tail ids init b a s w fee count = specification d7 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup7]. Qed.
Definition d8 := (descriptor "callHook" 3 5335 false true).
Example lookup8 : D.abi_select abi "callHook" 3 = Some d8.
Proof. vm_compute. reflexivity. Qed.
Theorem entry8 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "callHook" args flags caller tail ids init b a s w fee count = specification d8 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup8]. Qed.
Definition d9 := (descriptor "_deploy" 2 5517 false false).
Example lookup9 : D.abi_select abi "_deploy" 2 = Some d9.
Proof. vm_compute. reflexivity. Qed.
Theorem entry9 : forall args flags caller tail ids b a s w fee count,
enter hp dp abi "_deploy" args flags caller tail ids init b a s w fee count = NotCallable.
Proof. intros. apply private_name. reflexivity. Qed.
Definition d10 := (descriptor "proposeUpdate" 2 5555 false false).
Example lookup10 : D.abi_select abi "proposeUpdate" 2 = Some d10.
Proof. vm_compute. reflexivity. Qed.
Theorem entry10 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "proposeUpdate" args flags caller tail ids init b a s w fee count = specification d10 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup10]. Qed.
Definition d11 := (descriptor "cancelUpdate" 0 5920 false false).
Example lookup11 : D.abi_select abi "cancelUpdate" 0 = Some d11.
Proof. vm_compute. reflexivity. Qed.
Theorem entry11 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "cancelUpdate" args flags caller tail ids init b a s w fee count = specification d11 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup11]. Qed.
Definition d12 := (descriptor "update" 2 5983 false false).
Example lookup12 : D.abi_select abi "update" 2 = Some d12.
Proof. vm_compute. reflexivity. Qed.
Theorem entry12 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "update" args flags caller tail ids init b a s w fee count = specification d12 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup12]. Qed.
Definition d13 := (descriptor "confirmUpdate" 2 6391 false false).
Example lookup13 : D.abi_select abi "confirmUpdate" 2 = Some d13.
Proof. vm_compute. reflexivity. Qed.
Theorem entry13 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "confirmUpdate" args flags caller tail ids init b a s w fee count = specification d13 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup13]. Qed.
Definition d14 := (descriptor "getContractAdmin" 0 6402 true true).
Example lookup14 : D.abi_select abi "getContractAdmin" 0 = Some d14.
Proof. vm_compute. reflexivity. Qed.
Theorem entry14 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "getContractAdmin" args flags caller tail ids init b a s w fee count = specification d14 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup14]. Qed.
Definition d15 := (descriptor "proposeAdminTransfer" 1 6462 false false).
Example lookup15 : D.abi_select abi "proposeAdminTransfer" 1 = Some d15.
Proof. vm_compute. reflexivity. Qed.
Theorem entry15 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "proposeAdminTransfer" args flags caller tail ids init b a s w fee count = specification d15 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup15]. Qed.
Definition d16 := (descriptor "cancelAdminTransfer" 0 6694 false false).
Example lookup16 : D.abi_select abi "cancelAdminTransfer" 0 = Some d16.
Proof. vm_compute. reflexivity. Qed.
Theorem entry16 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "cancelAdminTransfer" args flags caller tail ids init b a s w fee count = specification d16 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup16]. Qed.
Definition d17 := (descriptor "confirmAdminTransfer" 0 6760 false false).
Example lookup17 : D.abi_select abi "confirmAdminTransfer" 0 = Some d17.
Proof. vm_compute. reflexivity. Qed.
Theorem entry17 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "confirmAdminTransfer" args flags caller tail ids init b a s w fee count = specification d17 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup17]. Qed.
Definition d18 := (descriptor "getPendingContractAdmin" 0 7041 true true).
Example lookup18 : D.abi_select abi "getPendingContractAdmin" 0 = Some d18.
Proof. vm_compute. reflexivity. Qed.
Theorem entry18 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "getPendingContractAdmin" args flags caller tail ids init b a s w fee count = specification d18 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup18]. Qed.
Definition d19 := (descriptor "getAdminTransferAvailableAt" 0 7101 true true).
Example lookup19 : D.abi_select abi "getAdminTransferAvailableAt" 0 = Some d19.
Proof. vm_compute. reflexivity. Qed.
Theorem entry19 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "getAdminTransferAvailableAt" args flags caller tail ids init b a s w fee count = specification d19 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup19]. Qed.
Definition d20 := (descriptor "isOwnerOnlyRecovery" 1 7142 true true).
Example lookup20 : D.abi_select abi "isOwnerOnlyRecovery" 1 = Some d20.
Proof. vm_compute. reflexivity. Qed.
Theorem entry20 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "isOwnerOnlyRecovery" args flags caller tail ids init b a s w fee count = specification d20 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup20]. Qed.
Definition d21 := (descriptor "finalizeEscapeToOwner" 1 7422 false false).
Example lookup21 : D.abi_select abi "finalizeEscapeToOwner" 1 = Some d21.
Proof. vm_compute. reflexivity. Qed.
Theorem entry21 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "finalizeEscapeToOwner" args flags caller tail ids init b a s w fee count = specification d21 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup21]. Qed.
Definition d22 := (descriptor "initiateEscape" 1 8259 false false).
Example lookup22 : D.abi_select abi "initiateEscape" 1 = Some d22.
Proof. vm_compute. reflexivity. Qed.
Theorem entry22 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "initiateEscape" args flags caller tail ids init b a s w fee count = specification d22 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup22]. Qed.
Definition d23 := (descriptor "finalizeEscape" 2 8514 false false).
Example lookup23 : D.abi_select abi "finalizeEscape" 2 = Some d23.
Proof. vm_compute. reflexivity. Qed.
Theorem entry23 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "finalizeEscape" args flags caller tail ids init b a s w fee count = specification d23 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup23]. Qed.
Definition d24 := (descriptor "finalizeEscape" 3 8526 false false).
Example lookup24 : D.abi_select abi "finalizeEscape" 3 = Some d24.
Proof. vm_compute. reflexivity. Qed.
Theorem entry24 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "finalizeEscape" args flags caller tail ids init b a s w fee count = specification d24 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup24]. Qed.
Definition d25 := (descriptor "executeUserOp" 2 9394 false true).
Example lookup25 : D.abi_select abi "executeUserOp" 2 = Some d25.
Proof. vm_compute. reflexivity. Qed.
Theorem entry25 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "executeUserOp" args flags caller tail ids init b a s w fee count = specification d25 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup25]. Qed.
Definition d26 := (descriptor "previewUserOpValidation" 2 11676 true true).
Example lookup26 : D.abi_select abi "previewUserOpValidation" 2 = Some d26.
Proof. vm_compute. reflexivity. Qed.
Theorem entry26 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "previewUserOpValidation" args flags caller tail ids init b a s w fee count = specification d26 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup26]. Qed.
Definition d27 := (descriptor "executeUserOps" 2 11753 false true).
Example lookup27 : D.abi_select abi "executeUserOps" 2 = Some d27.
Proof. vm_compute. reflexivity. Qed.
Theorem entry27 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "executeUserOps" args flags caller tail ids init b a s w fee count = specification d27 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup27]. Qed.
Definition d28 := (descriptor "isExecutionActive" 1 7396 true true).
Example lookup28 : D.abi_select abi "isExecutionActive" 1 = Some d28.
Proof. vm_compute. reflexivity. Qed.
Theorem entry28 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "isExecutionActive" args flags caller tail ids init b a s w fee count = specification d28 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup28]. Qed.
Definition d29 := (descriptor "enterMarketEscrow" 3 11921 false false).
Example lookup29 : D.abi_select abi "enterMarketEscrow" 3 = Some d29.
Proof. vm_compute. reflexivity. Qed.
Theorem entry29 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "enterMarketEscrow" args flags caller tail ids init b a s w fee count = specification d29 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup29]. Qed.
Definition d30 := (descriptor "cancelMarketEscrow" 2 12136 false false).
Example lookup30 : D.abi_select abi "cancelMarketEscrow" 2 = Some d30.
Proof. vm_compute. reflexivity. Qed.
Theorem entry30 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "cancelMarketEscrow" args flags caller tail ids init b a s w fee count = specification d30 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup30]. Qed.
Definition d31 := (descriptor "settleMarketEscrow" 3 12534 false false).
Example lookup31 : D.abi_select abi "settleMarketEscrow" 3 = Some d31.
Proof. vm_compute. reflexivity. Qed.
Theorem entry31 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "settleMarketEscrow" args flags caller tail ids init b a s w fee count = specification d31 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup31]. Qed.
Definition d32 := (descriptor "initiateMarketEscrowCancel" 1 13116 false false).
Example lookup32 : D.abi_select abi "initiateMarketEscrowCancel" 1 = Some d32.
Proof. vm_compute. reflexivity. Qed.
Theorem entry32 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "initiateMarketEscrowCancel" args flags caller tail ids init b a s w fee count = specification d32 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup32]. Qed.
Definition d33 := (descriptor "forceCancelMarketEscrow" 1 13260 false false).
Example lookup33 : D.abi_select abi "forceCancelMarketEscrow" 1 = Some d33.
Proof. vm_compute. reflexivity. Qed.
Theorem entry33 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "forceCancelMarketEscrow" args flags caller tail ids init b a s w fee count = specification d33 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup33]. Qed.
Definition d34 := (descriptor "hasMarketEscrowOwnerCancel" 1 13514 true true).
Example lookup34 : D.abi_select abi "hasMarketEscrowOwnerCancel" 1 = Some d34.
Proof. vm_compute. reflexivity. Qed.
Theorem entry34 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "hasMarketEscrowOwnerCancel" args flags caller tail ids init b a s w fee count = specification d34 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup34]. Qed.
Definition d35 := (descriptor "getMarketEscrowOwnerCancelTime" 1 13525 true true).
Example lookup35 : D.abi_select abi "getMarketEscrowOwnerCancelTime" 1 = Some d35.
Proof. vm_compute. reflexivity. Qed.
Theorem entry35 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getMarketEscrowOwnerCancelTime" args flags caller tail ids init b a s w fee count = specification d35 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup35]. Qed.
Definition d36 := (descriptor "executeSponsoredUserOp" 5 13765 false true).
Example lookup36 : D.abi_select abi "executeSponsoredUserOp" 5 = Some d36.
Proof. vm_compute. reflexivity. Qed.
Theorem entry36 : forall args flags caller tail ids b a s w fee count,
List.length args = 5 -> D.valid_flags flags ->
enter hp dp abi "executeSponsoredUserOp" args flags caller tail ids init b a s w fee count = specification d36 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup36]. Qed.
Definition d37 := (descriptor "executeSponsoredUserOps" 5 14110 false true).
Example lookup37 : D.abi_select abi "executeSponsoredUserOps" 5 = Some d37.
Proof. vm_compute. reflexivity. Qed.
Theorem entry37 : forall args flags caller tail ids b a s w fee count,
List.length args = 5 -> D.valid_flags flags ->
enter hp dp abi "executeSponsoredUserOps" args flags caller tail ids init b a s w fee count = specification d37 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup37]. Qed.
Definition d38 := (descriptor "computePlatformAccountId" 3 14754 true true).
Example lookup38 : D.abi_select abi "computePlatformAccountId" 3 = Some d38.
Proof. vm_compute. reflexivity. Qed.
Theorem entry38 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "computePlatformAccountId" args flags caller tail ids init b a s w fee count = specification d38 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup38]. Qed.
Definition d39 := (descriptor "computeStablePlatformAccountId" 2 14907 true true).
Example lookup39 : D.abi_select abi "computeStablePlatformAccountId" 2 = Some d39.
Proof. vm_compute. reflexivity. Qed.
Theorem entry39 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "computeStablePlatformAccountId" args flags caller tail ids init b a s w fee count = specification d39 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup39]. Qed.
Definition d40 := (descriptor "registerPlatformAccount" 4 15018 false false).
Example lookup40 : D.abi_select abi "registerPlatformAccount" 4 = Some d40.
Proof. vm_compute. reflexivity. Qed.
Theorem entry40 : forall args flags caller tail ids b a s w fee count,
List.length args = 4 -> D.valid_flags flags ->
enter hp dp abi "registerPlatformAccount" args flags caller tail ids init b a s w fee count = specification d40 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup40]. Qed.
Definition d41 := (descriptor "registerStablePlatformAccount" 4 15519 false false).
Example lookup41 : D.abi_select abi "registerStablePlatformAccount" 4 = Some d41.
Proof. vm_compute. reflexivity. Qed.
Theorem entry41 : forall args flags caller tail ids b a s w fee count,
List.length args = 4 -> D.valid_flags flags ->
enter hp dp abi "registerStablePlatformAccount" args flags caller tail ids init b a s w fee count = specification d41 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup41]. Qed.
Definition d42 := (descriptor "rotatePlatformAccountOwner" 3 15701 false false).
Example lookup42 : D.abi_select abi "rotatePlatformAccountOwner" 3 = Some d42.
Proof. vm_compute. reflexivity. Qed.
Theorem entry42 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "rotatePlatformAccountOwner" args flags caller tail ids init b a s w fee count = specification d42 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup42]. Qed.
Definition d43 := (descriptor "proposePlatformAccountOwnerRotation" 3 15710 false false).
Example lookup43 : D.abi_select abi "proposePlatformAccountOwnerRotation" 3 = Some d43.
Proof. vm_compute. reflexivity. Qed.
Theorem entry43 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "proposePlatformAccountOwnerRotation" args flags caller tail ids init b a s w fee count = specification d43 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup43]. Qed.
Definition d44 := (descriptor "confirmPlatformAccountOwnerRotation" 2 16144 false false).
Example lookup44 : D.abi_select abi "confirmPlatformAccountOwnerRotation" 2 = Some d44.
Proof. vm_compute. reflexivity. Qed.
Theorem entry44 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "confirmPlatformAccountOwnerRotation" args flags caller tail ids init b a s w fee count = specification d44 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup44]. Qed.
Definition d45 := (descriptor "cancelPlatformAccountOwnerRotation" 2 16612 false false).
Example lookup45 : D.abi_select abi "cancelPlatformAccountOwnerRotation" 2 = Some d45.
Proof. vm_compute. reflexivity. Qed.
Theorem entry45 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "cancelPlatformAccountOwnerRotation" args flags caller tail ids init b a s w fee count = specification d45 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup45]. Qed.
Definition d46 := (descriptor "getPendingPlatformAccountOwnerRotation" 1 16987 true true).
Example lookup46 : D.abi_select abi "getPendingPlatformAccountOwnerRotation" 1 = Some d46.
Proof. vm_compute. reflexivity. Qed.
Theorem entry46 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingPlatformAccountOwnerRotation" args flags caller tail ids init b a s w fee count = specification d46 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup46]. Qed.
Definition d47 := (descriptor "getPlatformAccountOwnerRotationAvailableAt" 1 17043 true true).
Example lookup47 : D.abi_select abi "getPlatformAccountOwnerRotationAvailableAt" 1 = Some d47.
Proof. vm_compute. reflexivity. Qed.
Theorem entry47 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPlatformAccountOwnerRotationAvailableAt" args flags caller tail ids init b a s w fee count = specification d47 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup47]. Qed.
Definition d48 := (descriptor "proposePlatformRegistrar" 1 17064 false false).
Example lookup48 : D.abi_select abi "proposePlatformRegistrar" 1 = Some d48.
Proof. vm_compute. reflexivity. Qed.
Theorem entry48 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "proposePlatformRegistrar" args flags caller tail ids init b a s w fee count = specification d48 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup48]. Qed.
Definition d49 := (descriptor "confirmPlatformRegistrar" 0 17314 false false).
Example lookup49 : D.abi_select abi "confirmPlatformRegistrar" 0 = Some d49.
Proof. vm_compute. reflexivity. Qed.
Theorem entry49 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "confirmPlatformRegistrar" args flags caller tail ids init b a s w fee count = specification d49 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup49]. Qed.
Definition d50 := (descriptor "cancelPlatformRegistrar" 0 17583 false false).
Example lookup50 : D.abi_select abi "cancelPlatformRegistrar" 0 = Some d50.
Proof. vm_compute. reflexivity. Qed.
Theorem entry50 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "cancelPlatformRegistrar" args flags caller tail ids init b a s w fee count = specification d50 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup50]. Qed.
Definition d51 := (descriptor "getPlatformRegistrar" 0 15211 true true).
Example lookup51 : D.abi_select abi "getPlatformRegistrar" 0 = Some d51.
Proof. vm_compute. reflexivity. Qed.
Theorem entry51 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "getPlatformRegistrar" args flags caller tail ids init b a s w fee count = specification d51 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup51]. Qed.
Definition d52 := (descriptor "getAccountIdByProxy" 1 17661 true true).
Example lookup52 : D.abi_select abi "getAccountIdByProxy" 1 = Some d52.
Proof. vm_compute. reflexivity. Qed.
Theorem entry52 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getAccountIdByProxy" args flags caller tail ids init b a s w fee count = specification d52 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup52]. Qed.
Definition d53 := (descriptor "getPendingPlatformRegistrar" 0 17805 true true).
Example lookup53 : D.abi_select abi "getPendingPlatformRegistrar" 0 = Some d53.
Proof. vm_compute. reflexivity. Qed.
Theorem entry53 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "getPendingPlatformRegistrar" args flags caller tail ids init b a s w fee count = specification d53 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup53]. Qed.
Definition d54 := (descriptor "getPlatformRegistrarAvailableAt" 0 17865 true true).
Example lookup54 : D.abi_select abi "getPlatformRegistrarAvailableAt" 0 = Some d54.
Proof. vm_compute. reflexivity. Qed.
Theorem entry54 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "getPlatformRegistrarAvailableAt" args flags caller tail ids init b a s w fee count = specification d54 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup54]. Qed.
Definition d55 := (descriptor "getProxyScriptHash" 1 15373 true true).
Example lookup55 : D.abi_select abi "getProxyScriptHash" 1 = Some d55.
Proof. vm_compute. reflexivity. Qed.
Theorem entry55 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getProxyScriptHash" args flags caller tail ids init b a s w fee count = specification d55 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup55]. Qed.
Definition d56 := (descriptor "getAccountImplementationId" 0 17906 true true).
Example lookup56 : D.abi_select abi "getAccountImplementationId" 0 = Some d56.
Proof. vm_compute. reflexivity. Qed.
Theorem entry56 : forall args flags caller tail ids b a s w fee count,
List.length args = 0 -> D.valid_flags flags ->
enter hp dp abi "getAccountImplementationId" args flags caller tail ids init b a s w fee count = specification d56 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup56]. Qed.
Definition d57 := (descriptor "supportsExecutionMode" 1 17949 true true).
Example lookup57 : D.abi_select abi "supportsExecutionMode" 1 = Some d57.
Proof. vm_compute. reflexivity. Qed.
Theorem entry57 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "supportsExecutionMode" args flags caller tail ids init b a s w fee count = specification d57 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup57]. Qed.
Definition d58 := (descriptor "supportsModuleType" 1 18000 true true).
Example lookup58 : D.abi_select abi "supportsModuleType" 1 = Some d58.
Proof. vm_compute. reflexivity. Qed.
Theorem entry58 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "supportsModuleType" args flags caller tail ids init b a s w fee count = specification d58 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup58]. Qed.
Definition d59 := (descriptor "isModuleInstalled" 3 18049 true true).
Example lookup59 : D.abi_select abi "isModuleInstalled" 3 = Some d59.
Proof. vm_compute. reflexivity. Qed.
Theorem entry59 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "isModuleInstalled" args flags caller tail ids init b a s w fee count = specification d59 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup59]. Qed.
Definition d60 := (descriptor "isValidSignature" 3 18156 true true).
Example lookup60 : D.abi_select abi "isValidSignature" 3 = Some d60.
Proof. vm_compute. reflexivity. Qed.
Theorem entry60 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "isValidSignature" args flags caller tail ids init b a s w fee count = specification d60 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup60]. Qed.
Definition d61 := (descriptor "getVerifier" 1 18389 true true).
Example lookup61 : D.abi_select abi "getVerifier" 1 = Some d61.
Proof. vm_compute. reflexivity. Qed.
Theorem entry61 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getVerifier" args flags caller tail ids init b a s w fee count = specification d61 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup61]. Qed.
Definition d62 := (descriptor "getHook" 1 18403 true true).
Example lookup62 : D.abi_select abi "getHook" 1 = Some d62.
Proof. vm_compute. reflexivity. Qed.
Theorem entry62 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getHook" args flags caller tail ids init b a s w fee count = specification d62 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup62]. Qed.
Definition d63 := (descriptor "getBackupOwner" 1 18417 true true).
Example lookup63 : D.abi_select abi "getBackupOwner" 1 = Some d63.
Proof. vm_compute. reflexivity. Qed.
Theorem entry63 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getBackupOwner" args flags caller tail ids init b a s w fee count = specification d63 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup63]. Qed.
Definition d64 := (descriptor "getEscapeTimelock" 1 18431 true true).
Example lookup64 : D.abi_select abi "getEscapeTimelock" 1 = Some d64.
Proof. vm_compute. reflexivity. Qed.
Theorem entry64 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getEscapeTimelock" args flags caller tail ids init b a s w fee count = specification d64 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup64]. Qed.
Definition d65 := (descriptor "getEscapeTriggeredAt" 1 18445 true true).
Example lookup65 : D.abi_select abi "getEscapeTriggeredAt" 1 = Some d65.
Proof. vm_compute. reflexivity. Qed.
Theorem entry65 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getEscapeTriggeredAt" args flags caller tail ids init b a s w fee count = specification d65 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup65]. Qed.
Definition d66 := (descriptor "getMarketEscrowContract" 1 3226 true true).
Example lookup66 : D.abi_select abi "getMarketEscrowContract" 1 = Some d66.
Proof. vm_compute. reflexivity. Qed.
Theorem entry66 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getMarketEscrowContract" args flags caller tail ids init b a s w fee count = specification d66 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup66]. Qed.
Definition d67 := (descriptor "getMarketEscrowListingId" 1 3291 true true).
Example lookup67 : D.abi_select abi "getMarketEscrowListingId" 1 = Some d67.
Proof. vm_compute. reflexivity. Qed.
Theorem entry67 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getMarketEscrowListingId" args flags caller tail ids init b a s w fee count = specification d67 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup67]. Qed.
Definition d68 := (descriptor "isMarketEscrowActive" 1 3184 true true).
Example lookup68 : D.abi_select abi "isMarketEscrowActive" 1 = Some d68.
Proof. vm_compute. reflexivity. Qed.
Theorem entry68 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "isMarketEscrowActive" args flags caller tail ids init b a s w fee count = specification d68 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup68]. Qed.
Definition d69 := (descriptor "isEscapeActive" 1 18459 true true).
Example lookup69 : D.abi_select abi "isEscapeActive" 1 = Some d69.
Proof. vm_compute. reflexivity. Qed.
Theorem entry69 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "isEscapeActive" args flags caller tail ids init b a s w fee count = specification d69 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup69]. Qed.
Definition d70 := (descriptor "getNonce" 2 18475 true true).
Example lookup70 : D.abi_select abi "getNonce" 2 = Some d70.
Proof. vm_compute. reflexivity. Qed.
Theorem entry70 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "getNonce" args flags caller tail ids init b a s w fee count = specification d70 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup70]. Qed.
Definition d71 := (descriptor "computeArgsHash" 1 18569 true true).
Example lookup71 : D.abi_select abi "computeArgsHash" 1 = Some d71.
Proof. vm_compute. reflexivity. Qed.
Theorem entry71 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "computeArgsHash" args flags caller tail ids init b a s w fee count = specification d71 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup71]. Qed.
Definition d72 := (descriptor "hasPendingVerifierUpdate" 1 18645 true true).
Example lookup72 : D.abi_select abi "hasPendingVerifierUpdate" 1 = Some d72.
Proof. vm_compute. reflexivity. Qed.
Theorem entry72 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "hasPendingVerifierUpdate" args flags caller tail ids init b a s w fee count = specification d72 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup72]. Qed.
Definition d73 := (descriptor "hasPendingHookUpdate" 1 18671 true true).
Example lookup73 : D.abi_select abi "hasPendingHookUpdate" 1 = Some d73.
Proof. vm_compute. reflexivity. Qed.
Theorem entry73 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "hasPendingHookUpdate" args flags caller tail ids init b a s w fee count = specification d73 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup73]. Qed.
Definition d74 := (descriptor "getPendingVerifierUpdate" 1 18696 true true).
Example lookup74 : D.abi_select abi "getPendingVerifierUpdate" 1 = Some d74.
Proof. vm_compute. reflexivity. Qed.
Theorem entry74 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingVerifierUpdate" args flags caller tail ids init b a s w fee count = specification d74 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup74]. Qed.
Definition d75 := (descriptor "getPendingHookUpdate" 1 18766 true true).
Example lookup75 : D.abi_select abi "getPendingHookUpdate" 1 = Some d75.
Proof. vm_compute. reflexivity. Qed.
Theorem entry75 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingHookUpdate" args flags caller tail ids init b a s w fee count = specification d75 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup75]. Qed.
Definition d76 := (descriptor "getPendingVerifierUpdateTime" 1 18827 true true).
Example lookup76 : D.abi_select abi "getPendingVerifierUpdateTime" 1 = Some d76.
Proof. vm_compute. reflexivity. Qed.
Theorem entry76 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingVerifierUpdateTime" args flags caller tail ids init b a s w fee count = specification d76 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup76]. Qed.
Definition d77 := (descriptor "getPendingHookUpdateTime" 1 18871 true true).
Example lookup77 : D.abi_select abi "getPendingHookUpdateTime" 1 = Some d77.
Proof. vm_compute. reflexivity. Qed.
Theorem entry77 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingHookUpdateTime" args flags caller tail ids init b a s w fee count = specification d77 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup77]. Qed.
Definition d78 := (descriptor "hasPendingVerifierCall" 1 18950 true true).
Example lookup78 : D.abi_select abi "hasPendingVerifierCall" 1 = Some d78.
Proof. vm_compute. reflexivity. Qed.
Theorem entry78 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "hasPendingVerifierCall" args flags caller tail ids init b a s w fee count = specification d78 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup78]. Qed.
Definition d79 := (descriptor "hasPendingHookCall" 1 18963 true true).
Example lookup79 : D.abi_select abi "hasPendingHookCall" 1 = Some d79.
Proof. vm_compute. reflexivity. Qed.
Theorem entry79 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "hasPendingHookCall" args flags caller tail ids init b a s w fee count = specification d79 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup79]. Qed.
Definition d80 := (descriptor "getPendingVerifierCallModule" 1 18976 true true).
Example lookup80 : D.abi_select abi "getPendingVerifierCallModule" 1 = Some d80.
Proof. vm_compute. reflexivity. Qed.
Theorem entry80 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingVerifierCallModule" args flags caller tail ids init b a s w fee count = specification d80 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup80]. Qed.
Definition d81 := (descriptor "getPendingHookCallModule" 1 19020 true true).
Example lookup81 : D.abi_select abi "getPendingHookCallModule" 1 = Some d81.
Proof. vm_compute. reflexivity. Qed.
Theorem entry81 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingHookCallModule" args flags caller tail ids init b a s w fee count = specification d81 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup81]. Qed.
Definition d82 := (descriptor "getPendingVerifierCallHash" 1 19064 true true).
Example lookup82 : D.abi_select abi "getPendingVerifierCallHash" 1 = Some d82.
Proof. vm_compute. reflexivity. Qed.
Theorem entry82 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingVerifierCallHash" args flags caller tail ids init b a s w fee count = specification d82 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup82]. Qed.
Definition d83 := (descriptor "getPendingHookCallHash" 1 19093 true true).
Example lookup83 : D.abi_select abi "getPendingHookCallHash" 1 = Some d83.
Proof. vm_compute. reflexivity. Qed.
Theorem entry83 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingHookCallHash" args flags caller tail ids init b a s w fee count = specification d83 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup83]. Qed.
Definition d84 := (descriptor "getPendingVerifierCallTime" 1 19122 true true).
Example lookup84 : D.abi_select abi "getPendingVerifierCallTime" 1 = Some d84.
Proof. vm_compute. reflexivity. Qed.
Theorem entry84 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingVerifierCallTime" args flags caller tail ids init b a s w fee count = specification d84 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup84]. Qed.
Definition d85 := (descriptor "getPendingHookCallTime" 1 19151 true true).
Example lookup85 : D.abi_select abi "getPendingHookCallTime" 1 = Some d85.
Proof. vm_compute. reflexivity. Qed.
Theorem entry85 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getPendingHookCallTime" args flags caller tail ids init b a s w fee count = specification d85 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup85]. Qed.
Definition d86 := (descriptor "cancelVerifierUpdate" 1 19180 false false).
Example lookup86 : D.abi_select abi "cancelVerifierUpdate" 1 = Some d86.
Proof. vm_compute. reflexivity. Qed.
Theorem entry86 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "cancelVerifierUpdate" args flags caller tail ids init b a s w fee count = specification d86 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup86]. Qed.
Definition d87 := (descriptor "cancelHookUpdate" 1 19307 false false).
Example lookup87 : D.abi_select abi "cancelHookUpdate" 1 = Some d87.
Proof. vm_compute. reflexivity. Qed.
Theorem entry87 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "cancelHookUpdate" args flags caller tail ids init b a s w fee count = specification d87 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup87]. Qed.
Definition d88 := (descriptor "setMetadataUri" 2 19425 false false).
Example lookup88 : D.abi_select abi "setMetadataUri" 2 = Some d88.
Proof. vm_compute. reflexivity. Qed.
Theorem entry88 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "setMetadataUri" args flags caller tail ids init b a s w fee count = specification d88 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup88]. Qed.
Definition d89 := (descriptor "getMetadataUri" 1 19540 true true).
Example lookup89 : D.abi_select abi "getMetadataUri" 1 = Some d89.
Proof. vm_compute. reflexivity. Qed.
Theorem entry89 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getMetadataUri" args flags caller tail ids init b a s w fee count = specification d89 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup89]. Qed.
Definition d90 := (descriptor "callVerifierChild" 4 19576 false true).
Example lookup90 : D.abi_select abi "callVerifierChild" 4 = Some d90.
Proof. vm_compute. reflexivity. Qed.
Theorem entry90 : forall args flags caller tail ids b a s w fee count,
List.length args = 4 -> D.valid_flags flags ->
enter hp dp abi "callVerifierChild" args flags caller tail ids init b a s w fee count = specification d90 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup90]. Qed.
Definition d91 := (descriptor "verify" 1 21023 true true).
Example lookup91 : D.abi_select abi "verify" 1 = Some d91.
Proof. vm_compute. reflexivity. Qed.
Theorem entry91 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "verify" args flags caller tail ids init b a s w fee count = specification d91 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup91]. Qed.
Definition d92 := (descriptor "getVerifyScopeTarget" 1 21400 true true).
Example lookup92 : D.abi_select abi "getVerifyScopeTarget" 1 = Some d92.
Proof. vm_compute. reflexivity. Qed.
Theorem entry92 : forall args flags caller tail ids b a s w fee count,
List.length args = 1 -> D.valid_flags flags ->
enter hp dp abi "getVerifyScopeTarget" args flags caller tail ids init b a s w fee count = specification d92 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup92]. Qed.
Definition d93 := (descriptor "setVerifyScopeTarget" 2 24202 false false).
Example lookup93 : D.abi_select abi "setVerifyScopeTarget" 2 = Some d93.
Proof. vm_compute. reflexivity. Qed.
Theorem entry93 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "setVerifyScopeTarget" args flags caller tail ids init b a s w fee count = specification d93 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup93]. Qed.
Definition d94 := (descriptor "setVerifyScopeTargets" 2 24462 false false).
Example lookup94 : D.abi_select abi "setVerifyScopeTargets" 2 = Some d94.
Proof. vm_compute. reflexivity. Qed.
Theorem entry94 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "setVerifyScopeTargets" args flags caller tail ids init b a s w fee count = specification d94 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup94]. Qed.
Definition d95 := (descriptor "canConfigureVerifier" 2 24592 true true).
Example lookup95 : D.abi_select abi "canConfigureVerifier" 2 = Some d95.
Proof. vm_compute. reflexivity. Qed.
Theorem entry95 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "canConfigureVerifier" args flags caller tail ids init b a s w fee count = specification d95 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup95]. Qed.
Definition d96 := (descriptor "canConfigureHook" 2 24661 true true).
Example lookup96 : D.abi_select abi "canConfigureHook" 2 = Some d96.
Proof. vm_compute. reflexivity. Qed.
Theorem entry96 : forall args flags caller tail ids b a s w fee count,
List.length args = 2 -> D.valid_flags flags ->
enter hp dp abi "canConfigureHook" args flags caller tail ids init b a s w fee count = specification d96 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup96]. Qed.
Definition d97 := (descriptor "canExecuteVerifier" 3 24731 true true).
Example lookup97 : D.abi_select abi "canExecuteVerifier" 3 = Some d97.
Proof. vm_compute. reflexivity. Qed.
Theorem entry97 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "canExecuteVerifier" args flags caller tail ids init b a s w fee count = specification d97 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup97]. Qed.
Definition d98 := (descriptor "canExecuteHook" 3 24817 true true).
Example lookup98 : D.abi_select abi "canExecuteHook" 3 = Some d98.
Proof. vm_compute. reflexivity. Qed.
Theorem entry98 : forall args flags caller tail ids b a s w fee count,
List.length args = 3 -> D.valid_flags flags ->
enter hp dp abi "canExecuteHook" args flags caller tail ids init b a s w fee count = specification d98 args flags caller tail ids init b a s w fee count.
Proof. intros * L V. apply ordinary_entry; try reflexivity; try exact V;
 rewrite L; [apply Nat.leb_le; vm_compute; reflexivity | exact lookup98]. Qed.
Definition d99 := (descriptor "_initialize" 0 24903 false false).
Example lookup99 : D.abi_select abi "_initialize" 0 = Some d99.
Proof. vm_compute. reflexivity. Qed.
Theorem entry99 : forall args flags caller tail ids b a s w fee count,
enter hp dp abi "_initialize" args flags caller tail ids init b a s w fee count = NotCallable.
Proof. intros. apply private_name. reflexivity. Qed.
Example arities0 : arities_for abi "computeRegistrationAccountId" = [5].
Proof. vm_compute. reflexivity. Qed.
Theorem reject0 : forall args flags caller tail ids, ~ In (List.length args) [5] ->
D.source_call dp abi "computeRegistrationAccountId" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities0. Qed.
Example arities1 : arities_for abi "registerAccount" = [6].
Proof. vm_compute. reflexivity. Qed.
Theorem reject1 : forall args flags caller tail ids, ~ In (List.length args) [6] ->
D.source_call dp abi "registerAccount" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities1. Qed.
Example arities2 : arities_for abi "registerAccounts" = [6].
Proof. vm_compute. reflexivity. Qed.
Theorem reject2 : forall args flags caller tail ids, ~ In (List.length args) [6] ->
D.source_call dp abi "registerAccounts" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities2. Qed.
Example arities3 : arities_for abi "updateHook" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject3 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "updateHook" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities3. Qed.
Example arities4 : arities_for abi "confirmHookUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject4 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "confirmHookUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities4. Qed.
Example arities5 : arities_for abi "updateVerifier" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject5 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "updateVerifier" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities5. Qed.
Example arities6 : arities_for abi "confirmVerifierUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject6 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "confirmVerifierUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities6. Qed.
Example arities7 : arities_for abi "callVerifier" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject7 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "callVerifier" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities7. Qed.
Example arities8 : arities_for abi "callHook" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject8 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "callHook" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities8. Qed.
Example arities9 : arities_for abi "_deploy" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject9 : forall args flags caller tail ids,
D.source_call dp abi "_deploy" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. left. reflexivity. Qed.
Example arities10 : arities_for abi "proposeUpdate" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject10 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "proposeUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities10. Qed.
Example arities11 : arities_for abi "cancelUpdate" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject11 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "cancelUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities11. Qed.
Example arities12 : arities_for abi "update" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject12 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "update" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities12. Qed.
Example arities13 : arities_for abi "confirmUpdate" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject13 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "confirmUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities13. Qed.
Example arities14 : arities_for abi "getContractAdmin" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject14 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "getContractAdmin" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities14. Qed.
Example arities15 : arities_for abi "proposeAdminTransfer" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject15 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "proposeAdminTransfer" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities15. Qed.
Example arities16 : arities_for abi "cancelAdminTransfer" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject16 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "cancelAdminTransfer" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities16. Qed.
Example arities17 : arities_for abi "confirmAdminTransfer" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject17 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "confirmAdminTransfer" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities17. Qed.
Example arities18 : arities_for abi "getPendingContractAdmin" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject18 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "getPendingContractAdmin" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities18. Qed.
Example arities19 : arities_for abi "getAdminTransferAvailableAt" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject19 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "getAdminTransferAvailableAt" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities19. Qed.
Example arities20 : arities_for abi "isOwnerOnlyRecovery" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject20 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "isOwnerOnlyRecovery" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities20. Qed.
Example arities21 : arities_for abi "finalizeEscapeToOwner" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject21 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "finalizeEscapeToOwner" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities21. Qed.
Example arities22 : arities_for abi "initiateEscape" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject22 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "initiateEscape" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities22. Qed.
Example arities23 : arities_for abi "finalizeEscape" = [2;3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject23 : forall args flags caller tail ids, ~ In (List.length args) [2;3] ->
D.source_call dp abi "finalizeEscape" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities23. Qed.
Example arities24 : arities_for abi "executeUserOp" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject24 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "executeUserOp" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities24. Qed.
Example arities25 : arities_for abi "previewUserOpValidation" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject25 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "previewUserOpValidation" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities25. Qed.
Example arities26 : arities_for abi "executeUserOps" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject26 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "executeUserOps" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities26. Qed.
Example arities27 : arities_for abi "isExecutionActive" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject27 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "isExecutionActive" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities27. Qed.
Example arities28 : arities_for abi "enterMarketEscrow" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject28 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "enterMarketEscrow" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities28. Qed.
Example arities29 : arities_for abi "cancelMarketEscrow" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject29 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "cancelMarketEscrow" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities29. Qed.
Example arities30 : arities_for abi "settleMarketEscrow" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject30 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "settleMarketEscrow" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities30. Qed.
Example arities31 : arities_for abi "initiateMarketEscrowCancel" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject31 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "initiateMarketEscrowCancel" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities31. Qed.
Example arities32 : arities_for abi "forceCancelMarketEscrow" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject32 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "forceCancelMarketEscrow" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities32. Qed.
Example arities33 : arities_for abi "hasMarketEscrowOwnerCancel" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject33 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "hasMarketEscrowOwnerCancel" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities33. Qed.
Example arities34 : arities_for abi "getMarketEscrowOwnerCancelTime" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject34 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getMarketEscrowOwnerCancelTime" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities34. Qed.
Example arities35 : arities_for abi "executeSponsoredUserOp" = [5].
Proof. vm_compute. reflexivity. Qed.
Theorem reject35 : forall args flags caller tail ids, ~ In (List.length args) [5] ->
D.source_call dp abi "executeSponsoredUserOp" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities35. Qed.
Example arities36 : arities_for abi "executeSponsoredUserOps" = [5].
Proof. vm_compute. reflexivity. Qed.
Theorem reject36 : forall args flags caller tail ids, ~ In (List.length args) [5] ->
D.source_call dp abi "executeSponsoredUserOps" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities36. Qed.
Example arities37 : arities_for abi "computePlatformAccountId" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject37 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "computePlatformAccountId" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities37. Qed.
Example arities38 : arities_for abi "computeStablePlatformAccountId" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject38 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "computeStablePlatformAccountId" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities38. Qed.
Example arities39 : arities_for abi "registerPlatformAccount" = [4].
Proof. vm_compute. reflexivity. Qed.
Theorem reject39 : forall args flags caller tail ids, ~ In (List.length args) [4] ->
D.source_call dp abi "registerPlatformAccount" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities39. Qed.
Example arities40 : arities_for abi "registerStablePlatformAccount" = [4].
Proof. vm_compute. reflexivity. Qed.
Theorem reject40 : forall args flags caller tail ids, ~ In (List.length args) [4] ->
D.source_call dp abi "registerStablePlatformAccount" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities40. Qed.
Example arities41 : arities_for abi "rotatePlatformAccountOwner" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject41 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "rotatePlatformAccountOwner" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities41. Qed.
Example arities42 : arities_for abi "proposePlatformAccountOwnerRotation" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject42 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "proposePlatformAccountOwnerRotation" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities42. Qed.
Example arities43 : arities_for abi "confirmPlatformAccountOwnerRotation" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject43 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "confirmPlatformAccountOwnerRotation" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities43. Qed.
Example arities44 : arities_for abi "cancelPlatformAccountOwnerRotation" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject44 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "cancelPlatformAccountOwnerRotation" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities44. Qed.
Example arities45 : arities_for abi "getPendingPlatformAccountOwnerRotation" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject45 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingPlatformAccountOwnerRotation" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities45. Qed.
Example arities46 : arities_for abi "getPlatformAccountOwnerRotationAvailableAt" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject46 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPlatformAccountOwnerRotationAvailableAt" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities46. Qed.
Example arities47 : arities_for abi "proposePlatformRegistrar" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject47 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "proposePlatformRegistrar" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities47. Qed.
Example arities48 : arities_for abi "confirmPlatformRegistrar" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject48 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "confirmPlatformRegistrar" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities48. Qed.
Example arities49 : arities_for abi "cancelPlatformRegistrar" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject49 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "cancelPlatformRegistrar" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities49. Qed.
Example arities50 : arities_for abi "getPlatformRegistrar" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject50 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "getPlatformRegistrar" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities50. Qed.
Example arities51 : arities_for abi "getAccountIdByProxy" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject51 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getAccountIdByProxy" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities51. Qed.
Example arities52 : arities_for abi "getPendingPlatformRegistrar" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject52 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "getPendingPlatformRegistrar" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities52. Qed.
Example arities53 : arities_for abi "getPlatformRegistrarAvailableAt" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject53 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "getPlatformRegistrarAvailableAt" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities53. Qed.
Example arities54 : arities_for abi "getProxyScriptHash" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject54 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getProxyScriptHash" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities54. Qed.
Example arities55 : arities_for abi "getAccountImplementationId" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject55 : forall args flags caller tail ids, ~ In (List.length args) [0] ->
D.source_call dp abi "getAccountImplementationId" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities55. Qed.
Example arities56 : arities_for abi "supportsExecutionMode" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject56 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "supportsExecutionMode" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities56. Qed.
Example arities57 : arities_for abi "supportsModuleType" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject57 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "supportsModuleType" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities57. Qed.
Example arities58 : arities_for abi "isModuleInstalled" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject58 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "isModuleInstalled" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities58. Qed.
Example arities59 : arities_for abi "isValidSignature" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject59 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "isValidSignature" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities59. Qed.
Example arities60 : arities_for abi "getVerifier" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject60 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getVerifier" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities60. Qed.
Example arities61 : arities_for abi "getHook" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject61 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getHook" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities61. Qed.
Example arities62 : arities_for abi "getBackupOwner" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject62 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getBackupOwner" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities62. Qed.
Example arities63 : arities_for abi "getEscapeTimelock" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject63 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getEscapeTimelock" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities63. Qed.
Example arities64 : arities_for abi "getEscapeTriggeredAt" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject64 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getEscapeTriggeredAt" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities64. Qed.
Example arities65 : arities_for abi "getMarketEscrowContract" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject65 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getMarketEscrowContract" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities65. Qed.
Example arities66 : arities_for abi "getMarketEscrowListingId" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject66 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getMarketEscrowListingId" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities66. Qed.
Example arities67 : arities_for abi "isMarketEscrowActive" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject67 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "isMarketEscrowActive" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities67. Qed.
Example arities68 : arities_for abi "isEscapeActive" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject68 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "isEscapeActive" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities68. Qed.
Example arities69 : arities_for abi "getNonce" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject69 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "getNonce" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities69. Qed.
Example arities70 : arities_for abi "computeArgsHash" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject70 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "computeArgsHash" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities70. Qed.
Example arities71 : arities_for abi "hasPendingVerifierUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject71 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "hasPendingVerifierUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities71. Qed.
Example arities72 : arities_for abi "hasPendingHookUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject72 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "hasPendingHookUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities72. Qed.
Example arities73 : arities_for abi "getPendingVerifierUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject73 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingVerifierUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities73. Qed.
Example arities74 : arities_for abi "getPendingHookUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject74 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingHookUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities74. Qed.
Example arities75 : arities_for abi "getPendingVerifierUpdateTime" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject75 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingVerifierUpdateTime" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities75. Qed.
Example arities76 : arities_for abi "getPendingHookUpdateTime" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject76 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingHookUpdateTime" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities76. Qed.
Example arities77 : arities_for abi "hasPendingVerifierCall" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject77 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "hasPendingVerifierCall" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities77. Qed.
Example arities78 : arities_for abi "hasPendingHookCall" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject78 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "hasPendingHookCall" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities78. Qed.
Example arities79 : arities_for abi "getPendingVerifierCallModule" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject79 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingVerifierCallModule" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities79. Qed.
Example arities80 : arities_for abi "getPendingHookCallModule" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject80 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingHookCallModule" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities80. Qed.
Example arities81 : arities_for abi "getPendingVerifierCallHash" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject81 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingVerifierCallHash" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities81. Qed.
Example arities82 : arities_for abi "getPendingHookCallHash" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject82 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingHookCallHash" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities82. Qed.
Example arities83 : arities_for abi "getPendingVerifierCallTime" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject83 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingVerifierCallTime" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities83. Qed.
Example arities84 : arities_for abi "getPendingHookCallTime" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject84 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getPendingHookCallTime" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities84. Qed.
Example arities85 : arities_for abi "cancelVerifierUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject85 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "cancelVerifierUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities85. Qed.
Example arities86 : arities_for abi "cancelHookUpdate" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject86 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "cancelHookUpdate" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities86. Qed.
Example arities87 : arities_for abi "setMetadataUri" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject87 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "setMetadataUri" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities87. Qed.
Example arities88 : arities_for abi "getMetadataUri" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject88 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getMetadataUri" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities88. Qed.
Example arities89 : arities_for abi "callVerifierChild" = [4].
Proof. vm_compute. reflexivity. Qed.
Theorem reject89 : forall args flags caller tail ids, ~ In (List.length args) [4] ->
D.source_call dp abi "callVerifierChild" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities89. Qed.
Example arities90 : arities_for abi "verify" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject90 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "verify" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities90. Qed.
Example arities91 : arities_for abi "getVerifyScopeTarget" = [1].
Proof. vm_compute. reflexivity. Qed.
Theorem reject91 : forall args flags caller tail ids, ~ In (List.length args) [1] ->
D.source_call dp abi "getVerifyScopeTarget" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities91. Qed.
Example arities92 : arities_for abi "setVerifyScopeTarget" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject92 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "setVerifyScopeTarget" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities92. Qed.
Example arities93 : arities_for abi "setVerifyScopeTargets" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject93 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "setVerifyScopeTargets" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities93. Qed.
Example arities94 : arities_for abi "canConfigureVerifier" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject94 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "canConfigureVerifier" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities94. Qed.
Example arities95 : arities_for abi "canConfigureHook" = [2].
Proof. vm_compute. reflexivity. Qed.
Theorem reject95 : forall args flags caller tail ids, ~ In (List.length args) [2] ->
D.source_call dp abi "canConfigureHook" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities95. Qed.
Example arities96 : arities_for abi "canExecuteVerifier" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject96 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "canExecuteVerifier" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities96. Qed.
Example arities97 : arities_for abi "canExecuteHook" = [3].
Proof. vm_compute. reflexivity. Qed.
Theorem reject97 : forall args flags caller tail ids, ~ In (List.length args) [3] ->
D.source_call dp abi "canExecuteHook" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. right. now rewrite arities97. Qed.
Example arities98 : arities_for abi "_initialize" = [0].
Proof. vm_compute. reflexivity. Qed.
Theorem reject98 : forall args flags caller tail ids,
D.source_call dp abi "_initialize" args flags caller tail ids init = None.
Proof. intros. apply rejected_dispatch. left. reflexivity. Qed.
Print Assumptions init_lookup.
Print Assumptions lookup0.
Print Assumptions entry0.
Print Assumptions lookup1.
Print Assumptions entry1.
Print Assumptions lookup2.
Print Assumptions entry2.
Print Assumptions lookup3.
Print Assumptions entry3.
Print Assumptions lookup4.
Print Assumptions entry4.
Print Assumptions lookup5.
Print Assumptions entry5.
Print Assumptions lookup6.
Print Assumptions entry6.
Print Assumptions lookup7.
Print Assumptions entry7.
Print Assumptions lookup8.
Print Assumptions entry8.
Print Assumptions lookup9.
Print Assumptions entry9.
Print Assumptions lookup10.
Print Assumptions entry10.
Print Assumptions lookup11.
Print Assumptions entry11.
Print Assumptions lookup12.
Print Assumptions entry12.
Print Assumptions lookup13.
Print Assumptions entry13.
Print Assumptions lookup14.
Print Assumptions entry14.
Print Assumptions lookup15.
Print Assumptions entry15.
Print Assumptions lookup16.
Print Assumptions entry16.
Print Assumptions lookup17.
Print Assumptions entry17.
Print Assumptions lookup18.
Print Assumptions entry18.
Print Assumptions lookup19.
Print Assumptions entry19.
Print Assumptions lookup20.
Print Assumptions entry20.
Print Assumptions lookup21.
Print Assumptions entry21.
Print Assumptions lookup22.
Print Assumptions entry22.
Print Assumptions lookup23.
Print Assumptions entry23.
Print Assumptions lookup24.
Print Assumptions entry24.
Print Assumptions lookup25.
Print Assumptions entry25.
Print Assumptions lookup26.
Print Assumptions entry26.
Print Assumptions lookup27.
Print Assumptions entry27.
Print Assumptions lookup28.
Print Assumptions entry28.
Print Assumptions lookup29.
Print Assumptions entry29.
Print Assumptions lookup30.
Print Assumptions entry30.
Print Assumptions lookup31.
Print Assumptions entry31.
Print Assumptions lookup32.
Print Assumptions entry32.
Print Assumptions lookup33.
Print Assumptions entry33.
Print Assumptions lookup34.
Print Assumptions entry34.
Print Assumptions lookup35.
Print Assumptions entry35.
Print Assumptions lookup36.
Print Assumptions entry36.
Print Assumptions lookup37.
Print Assumptions entry37.
Print Assumptions lookup38.
Print Assumptions entry38.
Print Assumptions lookup39.
Print Assumptions entry39.
Print Assumptions lookup40.
Print Assumptions entry40.
Print Assumptions lookup41.
Print Assumptions entry41.
Print Assumptions lookup42.
Print Assumptions entry42.
Print Assumptions lookup43.
Print Assumptions entry43.
Print Assumptions lookup44.
Print Assumptions entry44.
Print Assumptions lookup45.
Print Assumptions entry45.
Print Assumptions lookup46.
Print Assumptions entry46.
Print Assumptions lookup47.
Print Assumptions entry47.
Print Assumptions lookup48.
Print Assumptions entry48.
Print Assumptions lookup49.
Print Assumptions entry49.
Print Assumptions lookup50.
Print Assumptions entry50.
Print Assumptions lookup51.
Print Assumptions entry51.
Print Assumptions lookup52.
Print Assumptions entry52.
Print Assumptions lookup53.
Print Assumptions entry53.
Print Assumptions lookup54.
Print Assumptions entry54.
Print Assumptions lookup55.
Print Assumptions entry55.
Print Assumptions lookup56.
Print Assumptions entry56.
Print Assumptions lookup57.
Print Assumptions entry57.
Print Assumptions lookup58.
Print Assumptions entry58.
Print Assumptions lookup59.
Print Assumptions entry59.
Print Assumptions lookup60.
Print Assumptions entry60.
Print Assumptions lookup61.
Print Assumptions entry61.
Print Assumptions lookup62.
Print Assumptions entry62.
Print Assumptions lookup63.
Print Assumptions entry63.
Print Assumptions lookup64.
Print Assumptions entry64.
Print Assumptions lookup65.
Print Assumptions entry65.
Print Assumptions lookup66.
Print Assumptions entry66.
Print Assumptions lookup67.
Print Assumptions entry67.
Print Assumptions lookup68.
Print Assumptions entry68.
Print Assumptions lookup69.
Print Assumptions entry69.
Print Assumptions lookup70.
Print Assumptions entry70.
Print Assumptions lookup71.
Print Assumptions entry71.
Print Assumptions lookup72.
Print Assumptions entry72.
Print Assumptions lookup73.
Print Assumptions entry73.
Print Assumptions lookup74.
Print Assumptions entry74.
Print Assumptions lookup75.
Print Assumptions entry75.
Print Assumptions lookup76.
Print Assumptions entry76.
Print Assumptions lookup77.
Print Assumptions entry77.
Print Assumptions lookup78.
Print Assumptions entry78.
Print Assumptions lookup79.
Print Assumptions entry79.
Print Assumptions lookup80.
Print Assumptions entry80.
Print Assumptions lookup81.
Print Assumptions entry81.
Print Assumptions lookup82.
Print Assumptions entry82.
Print Assumptions lookup83.
Print Assumptions entry83.
Print Assumptions lookup84.
Print Assumptions entry84.
Print Assumptions lookup85.
Print Assumptions entry85.
Print Assumptions lookup86.
Print Assumptions entry86.
Print Assumptions lookup87.
Print Assumptions entry87.
Print Assumptions lookup88.
Print Assumptions entry88.
Print Assumptions lookup89.
Print Assumptions entry89.
Print Assumptions lookup90.
Print Assumptions entry90.
Print Assumptions lookup91.
Print Assumptions entry91.
Print Assumptions lookup92.
Print Assumptions entry92.
Print Assumptions lookup93.
Print Assumptions entry93.
Print Assumptions lookup94.
Print Assumptions entry94.
Print Assumptions lookup95.
Print Assumptions entry95.
Print Assumptions lookup96.
Print Assumptions entry96.
Print Assumptions lookup97.
Print Assumptions entry97.
Print Assumptions lookup98.
Print Assumptions entry98.
Print Assumptions lookup99.
Print Assumptions entry99.
Print Assumptions arities0.
Print Assumptions reject0.
Print Assumptions arities1.
Print Assumptions reject1.
Print Assumptions arities2.
Print Assumptions reject2.
Print Assumptions arities3.
Print Assumptions reject3.
Print Assumptions arities4.
Print Assumptions reject4.
Print Assumptions arities5.
Print Assumptions reject5.
Print Assumptions arities6.
Print Assumptions reject6.
Print Assumptions arities7.
Print Assumptions reject7.
Print Assumptions arities8.
Print Assumptions reject8.
Print Assumptions arities9.
Print Assumptions reject9.
Print Assumptions arities10.
Print Assumptions reject10.
Print Assumptions arities11.
Print Assumptions reject11.
Print Assumptions arities12.
Print Assumptions reject12.
Print Assumptions arities13.
Print Assumptions reject13.
Print Assumptions arities14.
Print Assumptions reject14.
Print Assumptions arities15.
Print Assumptions reject15.
Print Assumptions arities16.
Print Assumptions reject16.
Print Assumptions arities17.
Print Assumptions reject17.
Print Assumptions arities18.
Print Assumptions reject18.
Print Assumptions arities19.
Print Assumptions reject19.
Print Assumptions arities20.
Print Assumptions reject20.
Print Assumptions arities21.
Print Assumptions reject21.
Print Assumptions arities22.
Print Assumptions reject22.
Print Assumptions arities23.
Print Assumptions reject23.
Print Assumptions arities24.
Print Assumptions reject24.
Print Assumptions arities25.
Print Assumptions reject25.
Print Assumptions arities26.
Print Assumptions reject26.
Print Assumptions arities27.
Print Assumptions reject27.
Print Assumptions arities28.
Print Assumptions reject28.
Print Assumptions arities29.
Print Assumptions reject29.
Print Assumptions arities30.
Print Assumptions reject30.
Print Assumptions arities31.
Print Assumptions reject31.
Print Assumptions arities32.
Print Assumptions reject32.
Print Assumptions arities33.
Print Assumptions reject33.
Print Assumptions arities34.
Print Assumptions reject34.
Print Assumptions arities35.
Print Assumptions reject35.
Print Assumptions arities36.
Print Assumptions reject36.
Print Assumptions arities37.
Print Assumptions reject37.
Print Assumptions arities38.
Print Assumptions reject38.
Print Assumptions arities39.
Print Assumptions reject39.
Print Assumptions arities40.
Print Assumptions reject40.
Print Assumptions arities41.
Print Assumptions reject41.
Print Assumptions arities42.
Print Assumptions reject42.
Print Assumptions arities43.
Print Assumptions reject43.
Print Assumptions arities44.
Print Assumptions reject44.
Print Assumptions arities45.
Print Assumptions reject45.
Print Assumptions arities46.
Print Assumptions reject46.
Print Assumptions arities47.
Print Assumptions reject47.
Print Assumptions arities48.
Print Assumptions reject48.
Print Assumptions arities49.
Print Assumptions reject49.
Print Assumptions arities50.
Print Assumptions reject50.
Print Assumptions arities51.
Print Assumptions reject51.
Print Assumptions arities52.
Print Assumptions reject52.
Print Assumptions arities53.
Print Assumptions reject53.
Print Assumptions arities54.
Print Assumptions reject54.
Print Assumptions arities55.
Print Assumptions reject55.
Print Assumptions arities56.
Print Assumptions reject56.
Print Assumptions arities57.
Print Assumptions reject57.
Print Assumptions arities58.
Print Assumptions reject58.
Print Assumptions arities59.
Print Assumptions reject59.
Print Assumptions arities60.
Print Assumptions reject60.
Print Assumptions arities61.
Print Assumptions reject61.
Print Assumptions arities62.
Print Assumptions reject62.
Print Assumptions arities63.
Print Assumptions reject63.
Print Assumptions arities64.
Print Assumptions reject64.
Print Assumptions arities65.
Print Assumptions reject65.
Print Assumptions arities66.
Print Assumptions reject66.
Print Assumptions arities67.
Print Assumptions reject67.
Print Assumptions arities68.
Print Assumptions reject68.
Print Assumptions arities69.
Print Assumptions reject69.
Print Assumptions arities70.
Print Assumptions reject70.
Print Assumptions arities71.
Print Assumptions reject71.
Print Assumptions arities72.
Print Assumptions reject72.
Print Assumptions arities73.
Print Assumptions reject73.
Print Assumptions arities74.
Print Assumptions reject74.
Print Assumptions arities75.
Print Assumptions reject75.
Print Assumptions arities76.
Print Assumptions reject76.
Print Assumptions arities77.
Print Assumptions reject77.
Print Assumptions arities78.
Print Assumptions reject78.
Print Assumptions arities79.
Print Assumptions reject79.
Print Assumptions arities80.
Print Assumptions reject80.
Print Assumptions arities81.
Print Assumptions reject81.
Print Assumptions arities82.
Print Assumptions reject82.
Print Assumptions arities83.
Print Assumptions reject83.
Print Assumptions arities84.
Print Assumptions reject84.
Print Assumptions arities85.
Print Assumptions reject85.
Print Assumptions arities86.
Print Assumptions reject86.
Print Assumptions arities87.
Print Assumptions reject87.
Print Assumptions arities88.
Print Assumptions reject88.
Print Assumptions arities89.
Print Assumptions reject89.
Print Assumptions arities90.
Print Assumptions reject90.
Print Assumptions arities91.
Print Assumptions reject91.
Print Assumptions arities92.
Print Assumptions reject92.
Print Assumptions arities93.
Print Assumptions reject93.
Print Assumptions arities94.
Print Assumptions reject94.
Print Assumptions arities95.
Print Assumptions reject95.
Print Assumptions arities96.
Print Assumptions reject96.
Print Assumptions arities97.
Print Assumptions reject97.
Print Assumptions arities98.
Print Assumptions reject98.
