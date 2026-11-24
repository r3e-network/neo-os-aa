From Coq Require Import List PeanoNat.
Require Import CapMethodVm CapContext InitializerReferences.
Import ListNotations.
Open Scope nat_scope.
Definition program := [InitSlots 53;Push;Preserve;Store;Push;Push;Push;Push;Push;Push;Push;Pack 6;Store;Push;Push;Push;Push;Push;Push;Push;Push;Push;Pack 8;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Store;Push;Store;Push;Store;Push;Preserve;Store;Push;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Push;Preserve;Store;Preserve].
Definition counts_after := trace program (counts 0 0 0).
Definition raw_initializer : list nat := [86;53;12;4;170;82;71;1;219;48;96;12;15;115;101;116;68;75;73;77;82;101;103;105;115;116;114;121;12;18;99;114;101;97;116;101;83;117;98;115;99;114;105;112;116;105;111;110;12;9;115;101;116;67;111;110;102;105;103;12;15;99;108;101;97;114;83;101;115;115;105;111;110;75;101;121;12;13;115;101;116;83;101;115;115;105;111;110;75;101;121;12;12;99;108;101;97;114;65;99;99;111;117;110;116;22;192;103;10;12;12;99;108;101;97;114;65;99;99;111;117;110;116;12;9;115;101;116;67;111;110;102;105;103;12;8;115;101;116;72;111;111;107;115;12;11;115;101;116;82;101;103;105;115;116;114;121;12;38;114;101;113;117;105;114;101;67;114;101;100;101;110;116;105;97;108;67;111;109;109;105;116;109;101;110;116;70;111;114;67;111;110;116;114;97;99;116;12;18;115;101;116;82;101;115;116;114;105;99;116;101;100;84;111;107;101;110;12;12;115;101;116;87;104;105;116;101;108;105;115;116;12;13;115;101;116;68;97;105;108;121;76;105;109;105;116;24;192;103;12;12;1;17;219;48;103;14;12;1;26;219;48;103;17;12;1;27;219;48;103;18;12;1;20;219;48;103;19;2;0;132;12;36;103;20;12;1;21;219;48;103;21;12;1;22;219;48;103;22;12;1;18;219;48;103;15;12;1;19;219;48;103;16;12;1;34;219;48;99;12;1;1;219;48;97;12;1;2;219;48;103;24;12;1;3;219;48;103;32;12;1;4;219;48;98;12;1;5;219;48;103;8;12;1;6;219;48;100;12;1;7;219;48;101;12;1;8;219;48;103;28;12;1;9;219;48;103;9;12;1;10;219;48;102;12;1;11;219;48;103;23;12;1;12;219;48;103;29;12;1;13;219;48;103;26;12;1;14;219;48;103;25;12;1;15;219;48;103;11;12;1;16;219;48;103;13;12;1;28;219;48;103;47;1;240;0;103;46;2;128;238;54;0;103;31;2;0;92;38;5;103;7;12;1;29;219;48;103;30;2;0;132;12;36;103;33;12;1;33;219;48;103;34;12;1;23;219;48;103;36;12;1;24;219;48;103;42;12;1;25;219;48;103;43;12;1;30;219;48;103;37;12;1;32;219;48;103;27;12;1;31;219;48;103;41;12;4;170;82;71;2;219;48;103;35;12;2;12;20;219;48;103;38;12;13;17;192;31;12;6;118;101;114;105;102;121;12;20;219;48;103;39;12;5;65;98;125;91;82;219;48;103;40;12;4;22;38;186;126;219;48;103;45;12;4;255;255;255;255;219;48;103;44;12;2;12;20;219;48;103;49;12;2;18;192;219;48;103;50;12;15;12;13;101;120;101;99;117;116;101;85;115;101;114;79;112;219;48;103;51;12;16;12;14;101;120;101;99;117;116;101;85;115;101;114;79;112;115;219;48;103;52;12;5;65;98;125;91;82;219;48;103;48;64].
(* Count the stack roots, static roots and element slots allocated by these
   exact bytes. The two allocated arrays remain reachable through RET. *)
Definition measured s :=
  length (init_stack s) + length (match init_slots s with Some xs => xs | None => [] end)
  + fold_right (fun o n => length (fields o) + n) 0 (init_heap s).
Fixpoint measured_run fuel (s : InitState) : option (list nat) :=
  match fuel with
  | O => None
  | S rest =>
    match init_decode raw_initializer (init_pc s) with
    | Some (op, size) =>
      match init_step op size s with
      | InitNext t => option_map (cons (measured t)) (measured_run rest t)
      | InitHalt t => if Nat.eqb (init_pc t + size) (length raw_initializer)
                      then Some [measured t] else None
      | InitFault => None end
    | None => None end end.
Theorem bytecode_reference_trace :
  measured_run 170 (initializer_entry [] []) = Some counts_after.
Proof. vm_compute. reflexivity. Qed.
Print Assumptions bytecode_reference_trace.
Lemma peak : fold_right Nat.max 0 counts_after = 68.
Proof. reflexivity. Qed.
Theorem all_steps_fit : forall base limit, base <= limit ->
  (fits base limit counts_after = true <-> base + 68 <= limit).
Proof. intros. now rewrite fit_iff_peak, peak by assumption. Qed.
Theorem final_usage : last counts_after 0 = 67.
Proof. reflexivity. Qed.
Print Assumptions peak.
Print Assumptions all_steps_fit.
Print Assumptions final_usage.
