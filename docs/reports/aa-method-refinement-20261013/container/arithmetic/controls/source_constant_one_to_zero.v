From Coq Require Import ZArith List Bool Lia.
Require Import IntegerSemantics CapArithmetic ArithmeticVm OrdinarySponsorship.
Import ListNotations.
Open Scope Z_scope.
Definition actual_bytes : list nat := [17%nat;17%nat;107%nat;185%nat;159%nat;116%nat;16%nat;107%nat;106%nat;17%nat;206%nat;159%nat;186%nat;108%nat;120%nat;160%nat;158%nat;117%nat;109%nat;120%nat;185%nat;118%nat].
Definition actual_source : Expression := (Apply Min (Read Requested) (Apply Add (Apply Max (Apply Sub (Read Cost) (Read Reserved)) (Constant (0))) (Apply Mul (Apply Sub (Constant (0)) (Apply Min (Read Cost) (Constant (0)))) (Read Requested)))).
Theorem actual_semantics : preserves_expression actual_bytes actual_source.
Proof.
 unfold preserves_expression.
 intros start cost requested reserved hash data old_flag old_cap old_settled is_struct H.
 pose proof (cap_intermediates_representable cost requested reserved H) as
   [Hm [Hf [Hd [Hr [Hq [Hc Hs]]]]]].
 assert (H0 : integer_fits 0) by (unfold integer_fits; pose proof integer_limit_positive; lia).
 assert (H1 : integer_fits 1) by (unfold integer_fits; pose proof integer_limit_positive; lia).
 destruct is_struct;
 cbv [actual_bytes initial_machine run_bytes step_byte decode_opcode vm_step advance
   pc stack arguments locals replace_local read_item option_bind Nat.leb Nat.sub andb Z.of_nat Pos.of_succ_nat checked_binary binary_value].
 all: repeat first [
   progress cbv [initial_machine Z.of_nat Pos.of_succ_nat option_bind advance pc stack arguments locals nth_error replace_local read_item Z.to_nat Pos.to_nat Pos.iter Pos.iter_op Z.ltb Z.compare Nat.add length firstn observed_result actual_bytes actual_source source_eval checked_binary binary_value]
   | rewrite (Z.min_comm 1 cost)
   | rewrite (Z.max_comm 0 (cost - reserved))
   | rewrite (Z.min_comm (Z.max (cost - reserved) 0 + (1 - Z.min cost 1) * requested) requested)
   | rewrite checked_integer_in_range by assumption
 ].
 all: fold Nat.add.
 all: rewrite (Nat.add_comm start 22).
 all: repeat split; reflexivity.
Qed.
Definition actual_certificate : Certificate actual_source :=
  mkCertificate actual_source actual_bytes actual_semantics.
Theorem actual_certificate_accepted : check_certificate actual_source actual_bytes actual_certificate = true.
Proof. vm_compute. reflexivity. Qed.
Theorem source_ir_refines_protocol : forall cost requested reserved,
  cap_domain cost requested reserved -> source_eval actual_source cost requested reserved =
    OrdinarySponsorship.charge cost requested reserved.
Proof.
 intros cost requested reserved [Hc [Hq Hr]].
 cbn [actual_source source_eval binary_value].
 apply OS_015_branch_free_cap_matches_abstract_charge; lia.
Qed.
Print Assumptions actual_semantics.
Print Assumptions actual_certificate_accepted.
Print Assumptions source_ir_refines_protocol.
