(* Complete helper reference machine. Decode actual bytes, model aliases and
   explicit environment effects. No Neo ApplicationEngine or codec theorem. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics CapArithmetic.
Import ListNotations.
Open Scope Z_scope.

Inductive Kind := ArrayKind | StructKind.
(* The headroom comparison keeps its own constant so that a symbolic comparison
   stays nameable: a case split in the certificate can then read the exact term
   the instruction produced, instead of the `Z.compare` match its body unfolds
   into. `norm` deliberately does not unfold it. *)
Definition vm_leb (left right : Z) : bool := Z.leb left right.
Lemma vm_leb_spec : forall left right, vm_leb left right = true <-> left <= right.
Proof. intros. unfold vm_leb. apply Z.leb_le. Qed.
Inductive Value :=
| VInt : Z -> Value | VBool : bool -> Value | VNull : Value
| VBytes : list nat -> Value | VBuffer : list nat -> Value | VRef : nat -> Value | VContext : Value
| VWire : Kind -> list Value -> Value.
Record Object := obj { object_kind : Kind; fields : list Value }.
Inductive Effect := ReadStorage : Value -> Effect | Deserialized : Value -> Effect
| Serialized : Value -> Effect | WroteStorage : Value -> Effect.
Record State := state {
  pc : nat; stack : list Value; arguments : list Value; locals : list Value;
  heap : list Object; storage : Value; effects : list Effect; statics : nat -> option Value
}.
Definition change (s : State) (p : nat) (st ar lo : list Value)
    (hp : list Object) (store : Value) (ev : list Effect) : State :=
  state p st ar lo hp store ev (statics s).
Definition with_stack s p st := change s p st (arguments s) (locals s) (heap s) (storage s) (effects s).
Definition with_local s i v :=
  let lo := firstn i (locals s) ++ v :: skipn (S i) (locals s) in
  change s (pc s) (stack s) (arguments s) lo (heap s) (storage s) (effects s).
Definition with_heap s hp := change s (pc s) (stack s) (arguments s) (locals s) hp (storage s) (effects s).
Definition with_effect s ev := change s (pc s) (stack s) (arguments s) (locals s) (heap s) (storage s) (effects s ++ [ev]).
Definition with_storage s v := change s (pc s) (stack s) (arguments s) (locals s) (heap s) v (effects s ++ [WroteStorage v]).
Definition allocate s kind items :=
  (VRef (length (heap s)), with_heap s (heap s ++ [obj kind items])).
Fixpoint bytes_eqb (a b : list nat) : bool :=
  match a,b with
  | [],[] => true | x::xs,y::ys => Nat.eqb x y && bytes_eqb xs ys
  | _,_ => false end.
Lemma bytes_eqb_refl : forall bytes, bytes_eqb bytes bytes = true.
Proof. induction bytes as [|x xs IH]; cbn [bytes_eqb]; [reflexivity|].
  rewrite Nat.eqb_refl, IH. reflexivity. Qed.
Lemma bytes_eqb_true : forall a b, bytes_eqb a b = true -> a = b.
Proof. induction a as [|x xs IH]; destruct b as [|y ys]; cbn [bytes_eqb];
  try discriminate; [reflexivity|]. intros H. apply andb_true_iff in H.
  destruct H as [Hxy Hrest]. apply Nat.eqb_eq in Hxy. subst y.
  f_equal. apply IH. exact Hrest. Qed.

Definition value_eqb (a b : Value) : bool :=
  match a,b with
  | VNull,VNull => true | VInt x,VInt y => Z.eqb x y
  | VBool x,VBool y => Bool.eqb x y | VBytes x,VBytes y => bytes_eqb x y
  | VRef x,VRef y => Nat.eqb x y | VContext,VContext => true
  | _,_ => false end.
Definition read_field s receiver index : option Value :=
  match receiver with VRef ref =>
    match nth_error (heap s) ref with
    | Some o => nth_error (fields o) index | None => None end
  | _ => None end.
Definition scalar (v : Value) : bool :=
  match v with VRef _ | VWire _ _ => false | _ => true end.
Definition write_field s receiver index value : option State :=
  match receiver with VRef ref =>
    match nth_error (heap s) ref with
    | Some o => if (index <? length (fields o))%nat && scalar value then
        let updated := obj (object_kind o) (firstn index (fields o) ++ value :: skipn (S index) (fields o)) in
        Some (with_heap s (firstn ref (heap s) ++ updated :: skipn (S ref) (heap s)))
      else None
    | None => None end
  | _ => None end.
Definition deserialize s value : option (Value * State) :=
  match value with VWire kind items =>
    if forallb scalar items then
      let '(ref,next) := allocate s kind items in
      Some (ref,with_effect next (Deserialized value))
    else None
  | _ => None end.
Definition serialize s value : option (Value * State) :=
  match value with VRef ref =>
    match nth_error (heap s) ref with
    | Some o => if forallb scalar (fields o) then
        let wire := VWire (object_kind o) (fields o) in
        Some (wire,with_effect s (Serialized wire)) else None
    | None => None end
  | _ => None end.
Definition get_storage s context key : option (Value * State) :=
  match context,key with VContext,VBuffer [33%nat] =>
    Some (storage s,with_effect s (ReadStorage (storage s))) | _,_ => None end.
Definition put_storage s context key value : option State :=
  match context,key,value with VContext,VBuffer [33%nat],VWire _ _ => Some (with_storage s value)
  | _,_,_ => None end.

Inductive Instruction :=
| InitSlot : nat -> nat -> Instruction | Push : Value -> Instruction
| LoadStatic : nat -> Instruction | LoadLocal : nat -> Instruction
| StoreLocal : nat -> Instruction | LoadArgument : nat -> Instruction
| Binary : BinaryOp -> Instruction | Greater : Instruction | LessOrEqual : Instruction
| Equal : bool -> Instruction | Jump : Z -> Instruction
| JumpIf : bool -> Z -> Instruction
| Dup | Drop | Rot | Tuck | Swap | Pack | PickItem | SetItem
| Syscall : list nat -> Instruction | CallToken : nat -> Instruction
| AbortMessage | Return.
Definition signed_byte n := if (n <? 128)%nat then Z.of_nat n else Z.of_nat n - 256.
(* A PUSHINT16 operand is a signed little-endian short: the sign lives in the
   top bit of the high byte. The comparison is written against 128 rather than
   32768 because nat numerals above 1000 elaborate to an abstract decimal and a
   restricted `cbv` cannot reduce them. *)
Definition signed_short lo hi : Z :=
  if (hi <? 128)%nat then Z.of_nat (lo + 256 * hi) else Z.of_nat (lo + 256 * hi) - 65536.
Definition decode (code : list nat) (p : nat) : option (Instruction * nat) :=
  match skipn p code with
  | 87%nat::l::a::_ => Some (InitSlot l a,3%nat)
  | 65%nat::a::b::c::d::_ => Some (Syscall [a;b;c;d],5%nat)
  | 12%nat::n::rest => if (n <=? length rest)%nat then Some (Push (VBytes (firstn n rest)),(n+2)%nat) else None
  | 95%nat::n::_ => Some (LoadStatic n,2%nat)
  | 55%nat::lo::hi::_ => Some (CallToken (lo+256*hi)%nat,3%nat)
  | 1%nat::lo::hi::_ => Some (Push (VInt (signed_short lo hi)),3%nat)
  | 34%nat::offset::_ => Some (Jump (signed_byte offset),2%nat)
  | 36%nat::offset::_ => Some (JumpIf true (signed_byte offset),2%nat)
  | 38%nat::offset::_ => Some (JumpIf false (signed_byte offset),2%nat)
  (* The compact local and argument opcodes stop at slot six. The compiler emits
     the generic form carrying a slot operand as soon as a method needs a seventh
     local, which this helper now does for the domain maximum. *)
  | 111%nat::n::_ => Some (LoadLocal n,2%nat)
  | 119%nat::n::_ => Some (StoreLocal n,2%nat)
  | 127%nat::n::_ => Some (LoadArgument n,2%nat)
  | byte::_ =>
      if (16 <=? byte)%nat && (byte <=? 32)%nat then Some (Push (VInt (Z.of_nat (byte-16))),1%nat)
      else if (104 <=? byte)%nat && (byte <=? 110)%nat then Some (LoadLocal (byte-104)%nat,1%nat)
      else if (112 <=? byte)%nat && (byte <=? 118)%nat then Some (StoreLocal (byte-112)%nat,1%nat)
      else if (120 <=? byte)%nat && (byte <=? 126)%nat then Some (LoadArgument (byte-120)%nat,1%nat)
      else match byte with
      | 11%nat => Some (Push VNull,1%nat) | 151%nat => Some (Equal true,1%nat)
      | 152%nat => Some (Equal false,1%nat) | 74%nat => Some (Dup,1%nat)
      | 69%nat => Some (Drop,1%nat) | 81%nat => Some (Rot,1%nat)
      | 78%nat => Some (Tuck,1%nat) | 80%nat => Some (Swap,1%nat)
      | 192%nat => Some (Pack,1%nat) | 206%nat => Some (PickItem,1%nat)
      | 208%nat => Some (SetItem,1%nat) | 158%nat => Some (Binary Add,1%nat)
      | 159%nat => Some (Binary Sub,1%nat) | 160%nat => Some (Binary Mul,1%nat)
      | 185%nat => Some (Binary Min,1%nat) | 186%nat => Some (Binary Max,1%nat)
      | 168%nat => Some (Binary Shl,1%nat) | 182%nat => Some (LessOrEqual,1%nat)
      | 183%nat => Some (Greater,1%nat) | 224%nat => Some (AbortMessage,1%nat)
      | 64%nat => Some (Return,1%nat) | _ => None end
  | _ => None end.

Inductive Outcome := Continue : State -> Outcome | Halt : Value -> State -> Outcome
| Aborted : list nat -> State -> Outcome | Fault : State -> Outcome | Timeout : State -> Outcome.
Definition jump_target s offset := Z.to_nat (Z.of_nat (pc s) + offset).
Definition vm_step instruction width s : Outcome :=
  let next := (pc s + width)%nat in
  let push value rest := Continue (with_stack s next (value::rest)) in
  match instruction with
  | InitSlot local_count arg_count =>
    if (arg_count <=? length (stack s))%nat && Nat.eqb (length (locals s)) 0 && Nat.eqb (length (arguments s)) 0 then
      Continue (change s next (skipn arg_count (stack s)) (firstn arg_count (stack s))
        (repeat VNull local_count) (heap s) (storage s) (effects s)) else Fault s
  | Push (VInt z) => match checked_integer z with Some v => push (VInt v) (stack s) | None => Fault s end
  | Push value => push value (stack s)
  | LoadStatic index => match (statics s) index with Some value => push value (stack s) | None => Fault s end
  | LoadLocal index => match nth_error (locals s) index with Some v => push v (stack s) | None => Fault s end
  | LoadArgument index => match nth_error (arguments s) index with Some v => push v (stack s) | None => Fault s end
  | StoreLocal index => match stack s with
    | value::rest => if (index <? length (locals s))%nat then
        Continue (with_stack (with_local s index value) next rest) else Fault s
    | _ => Fault s end
  | Binary op => match stack s with VInt rhs::VInt lhs::rest =>
      match checked_binary op lhs rhs with Some value => push (VInt value) rest | None => Fault s end
    | _ => Fault s end
  | Greater => match stack s with VInt rhs::VInt lhs::rest => push (VBool (rhs <? lhs)) rest | _ => Fault s end
  | LessOrEqual => match stack s with VInt rhs::VInt lhs::rest => push (VBool (vm_leb lhs rhs)) rest | _ => Fault s end
  | Equal positive => match stack s with rhs::lhs::rest =>
      push (VBool (Bool.eqb positive (value_eqb lhs rhs))) rest | _ => Fault s end
  | Jump offset => Continue (with_stack s (jump_target s offset) (stack s))
  | JumpIf positive offset => match stack s with VBool condition::rest =>
      Continue (with_stack s (if Bool.eqb condition positive then jump_target s offset else next) rest)
    | _ => Fault s end
  | Dup => match stack s with a::rest => push a (a::rest) | _ => Fault s end
  | Drop => match stack s with _::rest => Continue (with_stack s next rest) | _ => Fault s end
  | Rot => match stack s with a::b::c::rest => push c (a::b::rest) | _ => Fault s end
  | Tuck => match stack s with a::b::rest => push a (b::a::rest) | _ => Fault s end
  | Swap => match stack s with a::b::rest => push b (a::rest) | _ => Fault s end
  | Pack => match stack s with VInt n::rest =>
      if (0 <=? n) && (Z.to_nat n <=? length rest)%nat then
        let '(ref,allocated) := allocate s ArrayKind (firstn (Z.to_nat n) rest) in
        Continue (with_stack allocated next (ref::skipn (Z.to_nat n) rest)) else Fault s
    | _ => Fault s end
  | PickItem => match stack s with VInt index::receiver::rest =>
      if 0 <=? index then match read_field s receiver (Z.to_nat index) with
        Some value => push value rest | None => Fault s end else Fault s
    | _ => Fault s end
  | SetItem => match stack s with value::VInt index::receiver::rest =>
      if 0 <=? index then match write_field s receiver (Z.to_nat index) value with
        Some written => Continue (with_stack written next rest) | None => Fault s end else Fault s
    | _ => Fault s end
  | Syscall [45%nat;81%nat;8%nat;48%nat] => push (VRef 0) (stack s)
  | Syscall [155%nat;246%nat;103%nat;206%nat] => push VContext (stack s)
  | Syscall [146%nat;93%nat;232%nat;49%nat] => match stack s with context::key::rest =>
      match get_storage s context key with Some (v,read) => Continue (with_stack read next (v::rest)) | None => Fault s end
    | _ => Fault s end
  | Syscall [230%nat;63%nat;24%nat;132%nat] => match stack s with context::key::v::rest =>
      match put_storage s context key v with Some written => Continue (with_stack written next rest) | None => Fault s end
    | _ => Fault s end
  | Syscall _ => Fault s
  | CallToken index => match stack s with value::rest =>
      let applied := match index with 3%nat => serialize s value | 4%nat => deserialize s value | _ => None end in
      match applied with Some (v,changed) => Continue (with_stack changed next (v::rest)) | None => Fault s end
    | _ => Fault s end
  | AbortMessage => match stack s with VBytes message::rest => Aborted message (with_stack s next rest) | _ => Fault s end
  | Return => match stack s with [value] => Halt value (with_stack s next []) | _ => Fault s end
  end.
Fixpoint run_vm fuel code s :=
  match fuel with O => Timeout s | S n =>
    match decode code (pc s) with
    | None => Fault s
    | Some (instruction,width) => match vm_step instruction width s with
      | Continue next => run_vm n code next | terminal => terminal end
    end end.

Lemma run_vm_one_step : forall fuel code s,
  run_vm (S fuel) code s =
    match decode code (pc s) with
    | None => Fault s
    | Some (instruction,width) => match vm_step instruction width s with
      | Continue next => run_vm fuel code next | terminal => terminal end
    end.
Proof. reflexivity. Qed.

(* Source IR has mathematical BigInteger arithmetic, deliberately not the VM's
   bounded arithmetic. Refinement consequently requires a no-overflow domain. *)
Inductive Expr :=
| EVal : Value -> Expr | ELocal : nat -> Expr | EArg : nat -> Expr
| EField : Expr -> nat -> Expr | EBinary : BinaryOp -> Expr -> Expr -> Expr
| EEq : Expr -> Expr -> Expr | ENeq : Expr -> Expr -> Expr | EGT : Expr -> Expr -> Expr
| ELE : Expr -> Expr -> Expr
| ETransaction | EContext | EKey
| EGet : Expr -> Expr -> Expr | EDeserialize : Expr -> Expr | ESerialize : Expr -> Expr
| ENew : Kind -> list Expr -> Expr | EPut : Expr -> Expr -> Expr -> Expr.
Inductive Stmt := SLet : nat -> Expr -> Stmt
| SIf : Expr -> list Stmt -> list Stmt -> Stmt
| SSetField : Expr -> nat -> Expr -> Stmt
| SAssert : Expr -> list nat -> Stmt | SExpr : Expr -> Stmt | SReturn : Expr -> Stmt.
Definition bind {A B} (x : option A) (f : A -> option B) := match x with Some a => f a | None => None end.
Fixpoint eval_expr fuel expression s : option (Value * State) :=
  match fuel with O => None | S n =>
  match expression with
  | EVal value => Some (value,s)
  | ELocal index => bind (nth_error (locals s) index) (fun value => Some (value,s))
  | EArg index => bind (nth_error (arguments s) index) (fun value => Some (value,s))
  | EField receiver index => bind (eval_expr n receiver s) (fun '(ref,next) =>
      bind (read_field next ref index) (fun value => Some (value,next)))
  | EBinary op lhs rhs => bind (eval_expr n lhs s) (fun '(lv,s1) =>
      bind (eval_expr n rhs s1) (fun '(rv,s2) =>
        match lv,rv with VInt a,VInt b => Some (VInt (binary_value op a b),s2) | _,_ => None end))
  | EEq lhs rhs => bind (eval_expr n lhs s) (fun '(lv,s1) =>
      bind (eval_expr n rhs s1) (fun '(rv,s2) => Some (VBool (value_eqb lv rv),s2)))
  | ENeq lhs rhs => bind (eval_expr n lhs s) (fun '(lv,s1) =>
      bind (eval_expr n rhs s1) (fun '(rv,s2) => Some (VBool (negb (value_eqb lv rv)),s2)))
  | EGT lhs rhs => bind (eval_expr n lhs s) (fun '(lv,s1) =>
      bind (eval_expr n rhs s1) (fun '(rv,s2) =>
        match lv,rv with VInt a,VInt b => Some (VBool (b <? a),s2) | _,_ => None end))
  | ELE lhs rhs => bind (eval_expr n lhs s) (fun '(lv,s1) =>
      bind (eval_expr n rhs s1) (fun '(rv,s2) =>
        match lv,rv with VInt a,VInt b => Some (VBool (vm_leb a b),s2) | _,_ => None end))
  | ETransaction => Some (VRef 0,s) | EContext => Some (VContext,s) | EKey => Some (VBuffer [33%nat],s)
  | EGet context key => bind (eval_expr n context s) (fun '(c,s1) =>
      bind (eval_expr n key s1) (fun '(k,s2) => get_storage s2 c k))
  | EDeserialize value => bind (eval_expr n value s) (fun '(v,s1) => deserialize s1 v)
  | ESerialize value => bind (eval_expr n value s) (fun '(v,s1) => serialize s1 v)
  | ENew kind items => bind (eval_args n items s) (fun '(values,s1) => Some (allocate s1 kind values))
  | EPut context key value => bind (eval_expr n context s) (fun '(c,s1) =>
      bind (eval_expr n key s1) (fun '(k,s2) => bind (eval_expr n value s2) (fun '(v,s3) =>
        bind (put_storage s3 c k v) (fun written => Some (VNull,written)))))
  end end
with eval_args fuel expressions s : option (list Value * State) :=
  match fuel with O => None | S n =>
    match expressions with [] => Some ([],s)
    | expression::rest => bind (eval_expr n expression s) (fun '(v,next) =>
        bind (eval_args n rest next) (fun '(vs,final) => Some (v::vs,final))) end end.
Fixpoint run_source fuel statements s : Outcome :=
  match fuel with O => Timeout s | S n =>
  match statements with [] => Continue s | statement::rest =>
    match statement with
    | SLet index expression => match eval_expr 32 expression s with
      | Some (v,next) => run_source n rest (with_local next index v) | None => Fault s end
    | SIf expression yes no => match eval_expr 32 expression s with
      | Some (VBool b,next) => run_source n ((if b then yes else no) ++ rest) next | _ => Fault s end
    | SSetField receiver index expression =>
      match bind (eval_expr 32 receiver s) (fun '(ref,s1) =>
          bind (eval_expr 32 expression s1) (fun '(value,s2) => write_field s2 ref index value)) with
      | Some next => run_source n rest next | None => Fault s end
    | SAssert expression message => match eval_expr 32 expression s with
      | Some (VBool true,next) => run_source n rest next
      | Some (VBool false,next) => Aborted message next | _ => Fault s end
    | SExpr expression => match eval_expr 32 expression s with
      | Some (_,next) => run_source n rest next | _ => Fault s end
    | SReturn expression => match eval_expr 32 expression s with
      | Some (v,next) => Halt v next | _ => Fault s end
    end
  end end.

Lemma run_source_one_step : forall n statements s,
 run_source (S n) statements s =
  match statements with [] => Continue s | statement::rest =>
    match statement with
    | SLet index expression => match eval_expr 32 expression s with
      | Some (v,next) => run_source n rest (with_local next index v) | None => Fault s end
    | SIf expression yes no => match eval_expr 32 expression s with
      | Some (VBool b,next) => run_source n ((if b then yes else no) ++ rest) next | _ => Fault s end
    | SSetField receiver index expression =>
      match bind (eval_expr 32 receiver s) (fun '(ref,s1) =>
          bind (eval_expr 32 expression s1) (fun '(value,s2) => write_field s2 ref index value)) with
      | Some next => run_source n rest next | None => Fault s end
    | SAssert expression message => match eval_expr 32 expression s with
      | Some (VBool true,next) => run_source n rest next
      | Some (VBool false,next) => Aborted message next | _ => Fault s end
    | SExpr expression => match eval_expr 32 expression s with
      | Some (_,next) => run_source n rest next | _ => Fault s end
    | SReturn expression => match eval_expr 32 expression s with
      | Some (v,next) => Halt v next | _ => Fault s end
    end
  end.
Proof. reflexivity. Qed.

Inductive Observation := Returned : Value -> Value -> list Effect -> Observation
| Rejected : list nat -> Value -> list Effect -> Observation
| Faulted : Value -> list Effect -> Observation | Unfinished : Observation.
Definition observe outcome := match outcome with
| Halt value s => Returned value (storage s) (effects s)
| Aborted message s => Rejected message (storage s) (effects s)
| Fault s => Faulted (storage s) (effects s)
| _ => Unfinished end.
Definition tx_object hash system_fee network_fee :=
  obj ArrayKind [VBytes hash;VNull;VNull;VNull;VInt system_fee;VInt network_fee;VNull;VNull].
Definition initial_vm hash system_fee network_fee requested stored static_values :=
  state 0 [VInt requested] [] [] [tx_object hash system_fee network_fee] stored [] static_values.
Definition initial_source hash system_fee network_fee requested stored :=
  state 0 [] [VInt requested] (repeat VNull 8) [tx_object hash system_fee network_fee] stored [] (fun _ => None).

Example heap_update_preserves_alias_identity :
  let s := state 0 [VRef 0] [] [VRef 0] [obj StructKind [VInt 3]] VNull [] (fun _ => None) in
  bind (write_field s (VRef 0) 0 (VInt 7)) (fun updated => read_field updated (VRef 0) 0) = Some (VInt 7).
Proof. reflexivity. Qed.
Example native_serialize_reads_updated_fields :
  let s := state 0 [] [] [] [obj ArrayKind [VBytes [1%nat];VInt 3]] VNull [] (fun _ => None) in
  bind (write_field s (VRef 0) 1 (VInt 7)) (fun updated =>
    bind (serialize updated (VRef 0)) (fun '(wire,_) => Some wire)) = Some (VWire ArrayKind [VBytes [1%nat];VInt 7]).
Proof. reflexivity. Qed.
Example unsupported_instruction_faults :
  run_vm 1 [255%nat] (initial_vm [] 0 0 1 VNull (fun _ => None)) = Fault (initial_vm [] 0 0 1 VNull (fun _ => None)).
Proof. reflexivity. Qed.
Print Assumptions heap_update_preserves_alias_identity.
Print Assumptions native_serialize_reads_updated_fields.
Print Assumptions unsupported_instruction_faults.
Print Assumptions run_vm_one_step.

Print Assumptions bytes_eqb_refl.
Print Assumptions bytes_eqb_true.

Print Assumptions run_source_one_step.

Definition charge_expression (c q r : Z) :=
  Z.min q (Z.max (c-r) 0 + (1-Z.min c 1)*q).

Lemma charge_expression_refines_charge : forall c q r,
  cap_domain c q r -> charge_expression c q r = source_charge c q r.
Proof.
  intros c q r [Hc [Hq Hr]].
  unfold charge_expression, source_charge.
  rewrite cost_minimum by lia.
  destruct (Z.eqb c 0) eqn:Ec.
  - apply Z.eqb_eq in Ec. subst c.
    rewrite Z.max_r by lia.
    replace (0 + (1 - 0) * q) with q by ring.
    apply Z.min_id.
  - replace (1 - 1) with 0 by ring.
    rewrite Z.mul_0_l, Z.add_0_r. reflexivity.
Qed.

Lemma cap_updated_reservation_fits : forall c q r,
  cap_domain c q r ->
  (c = 0 -> r + q < integer_limit) ->
  integer_fits (r + charge_expression c q r).
Proof.
  intros c q r Hdom Hzero.
  rewrite charge_expression_refines_charge by exact Hdom.
  destruct Hdom as [Hc [Hq Hr]].
  unfold source_charge.
  destruct (Z.eqb c 0) eqn:Ec.
  - apply Z.eqb_eq in Ec. apply nonnegative_integer_fits.
    split; [lia | apply Hzero; exact Ec].
  - apply Z.eqb_neq in Ec.
    destruct (Z_le_dec r c) as [Hremaining | Hexhausted].
    + rewrite Z.max_l by lia.
      assert (Hmin0 : 0 <= Z.min q (c-r)) by (apply Z.min_glb; lia).
      pose proof (Z.le_min_r q (c-r)) as Hminc.
      apply nonnegative_integer_fits. lia.
    + rewrite Z.max_r by lia.
      rewrite Z.min_r by lia.
      rewrite Z.add_0_r. apply nonnegative_integer_fits. exact Hr.
Qed.

Print Assumptions charge_expression_refines_charge.
Print Assumptions cap_updated_reservation_fits.

(* Independent observation contract: storage/effect values are derived from the
   input ledger and the mathematical protocol charge, never supplied to CALLT. *)
Definition method_error : list nat := [82%nat;101%nat;105%nat;109%nat;98%nat;117%nat;114%nat;115%nat;101%nat;109%nat;101%nat;110%nat;116%nat;32%nat;101%nat;120%nat;99%nat;101%nat;101%nat;100%nat;115%nat;32%nat;97%nat;99%nat;116%nat;117%nat;97%nat;108%nat;32%nat;103%nat;97%nat;115%nat;32%nat;99%nat;111%nat;115%nat;116%nat].
(* The VM-integer domain maximum is 2^255 - 1: 2^255 itself is already outside
   the domain, so the helper builds the maximum from its top half. The helper
   asserts this headroom explicitly, so an accumulating reservation is rejected
   by the contract instead of faulting inside the ADD. The body is written the
   way the helper computes it, and `vm_max_is_top_half` closes the gap to the
   domain boundary. *)
Definition vm_max : Z := 1 * 2 ^ 254 - 1 + 1 * 2 ^ 254.
Lemma vm_max_is_top_half : vm_max = integer_limit - 1.
Proof. vm_compute. reflexivity. Qed.
(* Subtracting an in-range non-negative charge from the domain maximum stays
   inside the signed range, so the guard's SUB cannot fault on a value the
   helper already accepted. The bound is stated against `integer_limit` rather
   than its numeral expansion so that linear arithmetic can use it. *)
Lemma vm_margin_fits : forall settled,
  (0 <? settled) = true -> integer_fits settled -> integer_fits (vm_max - settled).
Proof.
  intros settled Hpos Hfits.
  apply Z.ltb_lt in Hpos. unfold integer_fits in *.
  rewrite vm_max_is_top_half. pose proof integer_limit_positive. lia.
Qed.
Definition margin_error : list nat := [82%nat;101%nat;105%nat;109%nat;98%nat;117%nat;114%nat;115%nat;101%nat;109%nat;101%nat;110%nat;116%nat;32%nat;98%nat;117%nat;100%nat;103%nat;101%nat;116%nat;32%nat;101%nat;120%nat;99%nat;101%nat;101%nat;100%nat;115%nat;32%nat;86%nat;77%nat;32%nat;105%nat;110%nat;116%nat;101%nat;103%nat;101%nat;114%nat;32%nat;108%nat;105%nat;109%nat;105%nat;116%nat].
Definition classified hash sf nf q r kind stored trace :=
  let settled := charge_expression (sf+nf) q r in
  let wire := VWire kind [VBytes hash;VInt (r+settled)] in
  if 0 <? settled then
    (if vm_leb r (vm_max - settled) then
       Returned (VInt settled) wire (trace++[Serialized wire;WroteStorage wire])
     else Rejected margin_error stored trace)
  else Rejected method_error stored trace.
Inductive BudgetInput := AbsentBudget | PresentBudget : Kind -> list nat -> Z -> BudgetInput.
Definition stored_value input := match input with
| AbsentBudget => VNull | PresentBudget kind hash reserved => VWire kind [VBytes hash;VInt reserved] end.
Definition input_kind input := match input with AbsentBudget => ArrayKind | PresentBudget kind _ _ => kind end.
Definition effective_reserved hash input := match input with
| AbsentBudget => 0 | PresentBudget _ old reserved => if bytes_eqb old hash then reserved else 0 end.
Definition input_trace input := match input with
| AbsentBudget => [ReadStorage VNull]
| PresentBudget _ _ _ => [ReadStorage (stored_value input);Deserialized (stored_value input)] end.
Definition valid_hash hash := length hash = 32%nat /\ Forall (fun b => (b < 256)%nat) hash.
Definition valid_budget input := match input with
| AbsentBudget => True | PresentBudget _ old reserved => valid_hash old /\ 0 <= reserved < integer_limit end.
Definition legal_inputs hash sf nf q input :=
 valid_hash hash /\ 0 <= sf < 2^63 /\ 0 <= nf < 2^63 /\
 0 < q < integer_limit /\ valid_budget input /\
 (sf+nf = 0 -> effective_reserved hash input + q < integer_limit).
Definition contract_observation hash sf nf q input :=
 let reserved := effective_reserved hash input in
 let settled := source_charge (sf+nf) q reserved in
 let wire := VWire (input_kind input) [VBytes hash; VInt (reserved+settled)] in
 if 0 <? settled then
   (if vm_leb reserved (vm_max - settled) then
      Returned (VInt settled) wire (input_trace input++[Serialized wire;WroteStorage wire])
    else Rejected margin_error (stored_value input) (input_trace input))
 else Rejected method_error (stored_value input) (input_trace input).
(* Both guard branches end in a terminal outcome, so a refinement statement is
   enough on its own to rule out a fault or a timeout. Keeping the case analysis
   here means the no-fault theorem never has to guess which branch was taken. *)
Lemma contract_observation_total : forall hash sf nf q input,
  (exists value wire trace, contract_observation hash sf nf q input = Returned value wire trace) \/
  (exists message stored trace, contract_observation hash sf nf q input = Rejected message stored trace).
Proof.
  intros. unfold contract_observation. cbn zeta.
  destruct (0 <? source_charge (sf+nf) q (effective_reserved hash input));
  destruct (vm_leb (effective_reserved hash input) (vm_max - source_charge (sf+nf) q (effective_reserved hash input)));
  first [ (left; repeat eexists; reflexivity) | (right; repeat eexists; reflexivity) ].
Qed.
Lemma legal_cap_domain : forall hash sf nf q input,
 legal_inputs hash sf nf q input -> cap_domain (sf+nf) q (effective_reserved hash input).
Proof.
 intros hash sf nf q input [_ [Hsf [Hnf [Hq [Hbudget Hzero]]]]].
 assert (Hlimit : 2*2^63 < integer_limit) by (vm_compute; reflexivity).
 unfold cap_domain. split; [lia|]. split; [exact Hq|].
 destruct input as [|kind old reserved]; cbn [effective_reserved] in *.
 - pose proof integer_limit_positive. lia.
 - cbn [valid_budget] in Hbudget. destruct Hbudget as [_ Hreserved].
   destruct (bytes_eqb old hash); [exact Hreserved|]. pose proof integer_limit_positive. lia.
Qed.
Lemma legal_update_fits : forall hash sf nf q input,
 legal_inputs hash sf nf q input ->
 integer_fits (effective_reserved hash input + charge_expression (sf+nf) q (effective_reserved hash input)).
Proof. intros. apply cap_updated_reservation_fits.
 - apply (legal_cap_domain hash sf nf q input). exact H.
 - unfold legal_inputs in H. tauto.
Qed.
Lemma classified_refines_contract : forall hash sf nf q input,
 legal_inputs hash sf nf q input ->
 classified hash sf nf q (effective_reserved hash input) (input_kind input) (stored_value input) (input_trace input) =
 contract_observation hash sf nf q input.
Proof. intros. unfold classified, contract_observation.
 rewrite charge_expression_refines_charge by (apply legal_cap_domain; exact H). reflexivity. Qed.
Print Assumptions legal_cap_domain.
Print Assumptions legal_update_fits.
Print Assumptions classified_refines_contract.
Print Assumptions contract_observation_total.
Print Assumptions vm_margin_fits.
