(* Compose the ordinary-call permission decision with ABI frame construction.
   The caller's CanCall and policy answers are observations; their production
   and the execution of the resulting frames are outside this projection. *)
From Coq Require Import List Bool String NArith PeanoNat.
Require EntryDispatch ContractHandoff.
Module D := EntryDispatch.
Module H := ContractHandoff.

Definition site (d : D.Descriptor) args requested caller (init : option nat)
    blocked caller_allows callee_allows whitelist fee counter :=
  H.call_site requested (D.frame_flags caller) (D.descriptor_safe d)
    (negb (D.descriptor_nonvoid d)) (D.descriptor_nonvoid d)
    (D.descriptor_offset d) (match init with Some n => n | None => 0 end)
    (match init with Some _ => true | None => false end)
    (D.descriptor_arity d) args blocked caller_allows callee_allows whitelist fee counter.

Inductive Result :=
  | NotCallable
  | Denied (why : H.Reject) (counter : nat)
  | Entered (handoff : H.Frame) (dispatch : D.DispatchOutcome).

Definition enter hp dp abi name args requested caller tail ids init blocked allow self white fee count :=
  if D.starts_underscore name then NotCallable else
  match D.abi_select abi name (List.length args) with
  | None => NotCallable
  | Some d =>
      match H.handoff hp (site d args requested caller init blocked allow self white fee count) with
      | H.Rejected why n => Denied why n
      | H.Accepted f =>
          match D.source_call dp abi name args requested caller tail ids init with
          | Some out => Entered f out
          | None => NotCallable
          end
      end
  end.

Definition specification d args requested caller tail ids init (blocked allow self white : bool) fee count :=
  if blocked then Denied H.RejectBlocked count else
  if negb (D.descriptor_safe d) && negb allow then Denied H.RejectUnauthorized count else
  Entered (H.frame_of H.canonical_handoff
            (site d args requested caller init blocked allow self white fee count))
          (D.spec_success d args requested caller tail ids init).

Theorem ordinary_entry : forall hp dp abi name d args requested caller tail ids init
    blocked allow self white fee count,
  hp = H.canonical_handoff -> dp = D.canonical_program ->
  D.starts_underscore name = false -> D.valid_flags requested ->
  List.length args <= 65535 -> D.abi_select abi name (List.length args) = Some d ->
  enter hp dp abi name args requested caller tail ids init blocked allow self white fee count =
    specification d args requested caller tail ids init blocked allow self white fee count.
Proof.
  intros * E F N V B L. subst hp dp. unfold enter. rewrite N, L.
  pose proof (D.projected_call_refines_spec abi name d args requested caller tail ids init N V B L) as Pass.
  pose proof (D.exact_lookup_matches_count _ _ _ _ L) as Arity.
  unfold H.handoff, specification.
  cbn [site H.cs_blocked H.hp_blocked_gate H.cs_method_safe H.hp_authorization_gate
       H.authorized H.hp_authorization_subject_is_caller H.cs_authorized H.cs_counter
       H.cs_args H.cs_parameters H.cs_has_return H.cs_return_void H.canonical_handoff].
  rewrite Arity, Nat.eqb_refl, Bool.negb_involutive, Bool.eqb_reflx, Pass.
  destruct blocked, (D.descriptor_safe d), allow; reflexivity.
Qed.

Theorem private_name : forall hp dp abi name args requested caller tail ids init b a s w f c,
  D.starts_underscore name = true ->
  enter hp dp abi name args requested caller tail ids init b a s w f c = NotCallable.
Proof. intros * E. unfold enter. now rewrite E. Qed.

Print Assumptions ordinary_entry.
Print Assumptions private_name.

Fixpoint arities_for (abi : list D.Descriptor) (name : string) : list nat :=
  match abi with
  | nil => nil
  | d :: rest => if String.eqb (D.descriptor_name d) name
      then D.descriptor_arity d :: arities_for rest name else arities_for rest name
  end.

Lemma missing_arity : forall abi name n, ~ In n (arities_for abi name) ->
  D.abi_select abi name n = None.
Proof.
  induction abi as [|d rest IH]; intros name n; simpl; [reflexivity|].
  destruct (String.eqb (D.descriptor_name d) name); simpl; intro H.
  - destruct (Nat.eqb (D.descriptor_arity d) n) eqn:E.
    + apply Nat.eqb_eq in E. exfalso. apply H. now left.
    + apply IH. intro I. apply H. now right.
  - now apply IH.
Qed.

Theorem rejected_dispatch : forall abi name args flags caller tail ids init,
  D.starts_underscore name = true \/ ~ In (List.length args) (arities_for abi name) ->
  D.source_call D.canonical_program abi name args flags caller tail ids init = None.
Proof.
  intros * [R|M]; unfold D.source_call.
  - rewrite R. reflexivity.
  - destruct (_ && _ && _)%bool; [|reflexivity].
    rewrite D.canonical_lookup_exact, missing_arity by exact M. reflexivity.
Qed.
Print Assumptions rejected_dispatch.
