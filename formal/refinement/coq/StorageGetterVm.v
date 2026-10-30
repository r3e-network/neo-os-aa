(* Dedicated VM model for the pinned storage-key getter bytecode regions
   (direct getters, the shared GetAccountState callee and its projection
   callers, and the pending-update accessors).
   The instruction set covers exactly the opcodes occurring in the pinned
   regions; any other opcode fails closed (Thrown). Syscall behavior is a
   pinned-hash contract (9bf667ce = Storage.GetContext, 925de831 =
   Storage.Get). System.Storage.Get pops its declared parameters in order
   from the top of the stack: the storage context handle first, then the
   key; the emitted regions push the key before the context and the context
   handle is pinned to the value GetContext pushes. CONVERT 0x30 (Buffer) and
   CONVERT 0x28 (ByteString) are identity pass-throughs on byte values and
   CONVERT 0x21 (Integer) applies the pinned little-endian decode; payload
   decode contracts live in StorageGetter. NEWBUFFER allocates a zero-filled
   buffer of the popped length (the compiled `(ByteString)new byte[0]` empty
   default of the record-hash getters is PUSH0; NEWBUFFER; CONVERT 0x28); a
   negative length faults, exactly as the engine does.
   Frames: CALL pushes the return slot onto mcalls and jumps; RET returns to
   the saved slot, and a RET with an empty call stack terminates the run
   (Done with the top of the stack). Model restriction, pinned by the lane:
   frames share one evaluation stack, local and argument slots; the certified
   regions have disjoint local usage (the getter callers declare no locals and
   never read an argument after the certified CALL), so the sharing is
   behaviorally invisible on the certified traces.
   LdArg reads slot 0 of margs (the ABI account argument). LdArgN i reads slot
   i and exists for callees that declare more than one parameter: the runners
   pin the callee's parameter list to the operand block the caller pushes
   immediately before the certified CALL, and render each callee LDARGk as the
   LdArg/LdArgN read of the matching caller operand, so the argument mapping is
   a checked property of the two regions rather than an assumption about the
   shared frame.
   CALLT is modeled as the oracle field mtokens applied to the popped
   argument; the lane pins the token index to the StdLib.deserialize entry of
   the NEF token table and the certificates quantify universally over the
   oracle, so no axiom about interop behavior is assumed. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics StorageGetter.
Import ListNotations.
Open Scope Z_scope.

Inductive Ins :=
| Push : GVal -> Ins
| LdStatic : nat -> Ins
| LdArg : Ins
| LdArgN : nat -> Ins
| LdLoc : nat -> Ins
| StLoc : nat -> Ins
| InitSlot : nat -> nat -> Ins
| Concat : Ins
| Convert : nat -> Ins
| NewBuffer : Ins
| GetContext : Ins
| StorageGet : Ins
| EqualIns : Ins
| NotEqualIns : Ins
| PickItem : Ins
| Greater : Ins
| AddIns : Ins
| Pack : Ins
| IsType : nat -> Ins
| NumEquals : Ins
| CallToken : nat -> Ins
| Call : nat -> Ins
| AbortMsg : Ins
| JumpIfNot : nat -> Ins
| Jump : nat -> Ins
| JumpIf : nat -> Ins
| JumpEq : nat -> Ins
| Dup : Ins
| Drop : Ins
| IsNull : Ins
| SizeIns : Ins
| Throw : Ins
| Ret : Ins
| Unsupported : Ins.

Record Machine := machine {
  mstack : list GVal;
  mlocals : list GVal;
  margs : list GVal;
  mstatics : nat -> option GVal;
  msto : storage;
  mcalls : list nat;
  mtokens : nat -> GVal -> GVal;
}.

Inductive Stop :=
| Done : GVal -> Stop
| Thrown : Stop.

Definition set_stack (v : list GVal) (m : Machine) :=
  {| mstack := v; mlocals := mlocals m; margs := margs m;
     mstatics := mstatics m; msto := msto m; mcalls := mcalls m;
     mtokens := mtokens m |}.
Definition set_locals (l : list GVal) (m : Machine) :=
  {| mstack := mstack m; mlocals := l; margs := margs m;
     mstatics := mstatics m; msto := msto m; mcalls := mcalls m;
     mtokens := mtokens m |}.
Definition set_statics (s : nat -> option GVal) (m : Machine) :=
  {| mstack := mstack m; mlocals := mlocals m; margs := margs m;
     mstatics := s; msto := msto m; mcalls := mcalls m;
     mtokens := mtokens m |}.
Definition set_calls (c : list nat) (m : Machine) :=
  {| mstack := mstack m; mlocals := mlocals m; margs := margs m;
     mstatics := mstatics m; msto := msto m; mcalls := c;
     mtokens := mtokens m |}.

Definition pop (m : Machine) : option (GVal * Machine) :=
  match mstack m with
  | v :: rest => Some (v, set_stack rest m)
  | [] => None
  end.

Definition pushv (v : GVal) (m : Machine) := set_stack (v :: mstack m) m.

Definition gbytes_eqb : bytes -> bytes -> bool :=
  fix f (a b : bytes) : bool :=
    match a, b with
    | [], [] => true
    | x :: xs, y :: ys => andb (Nat.eqb x y) (f xs ys)
    | _, _ => false
    end.

Fixpoint gval_eqb (a b : GVal) : bool :=
  match a, b with
  | GBytes x, GBytes y => gbytes_eqb x y
  | GInt x, GInt y => Z.eqb x y
  | GBool x, GBool y => Bool.eqb x y
  | GArray x, GArray y =>
      (fix gvals_eqb (xs ys : list GVal) : bool :=
         match xs, ys with
         | [], [] => true
         | u :: us, v :: vs => andb (gval_eqb u v) (gvals_eqb us vs)
         | _, _ => false
         end) x y
  | GNull, GNull => true
  | _, _ => false
  end.

Definition gval_size (v : GVal) : nat :=
  match v with
  | GBytes b => length b
  | GArray xs => length xs
  | _ => 0
  end.

(* System.Storage.Get pops its declared parameters in order from the top of
   the stack: the storage context handle first (top), then the key. The
   context handle must be exactly the value GetContext pushes; the lookup
   uses the machine storage map keyed by the second-popped byte string. *)
Definition storage_lookup (m : Machine) : option (GVal * Machine) :=
  match pop m with
  | Some (GBytes ctx, m1) =>
      if gbytes_eqb ctx [33%nat]
      then match pop m1 with
           | Some (GBytes key, m2) =>
               match msto m2 key with
               | Some payload => Some (GBytes payload, m2)
               | None => Some (GNull, m2)
               end
           | _ => None
           end
      else None
  | _ => None
  end.

(* PACK pops the element count first and then that many values, each popped
   value becoming the next array element, so the value pushed last is element 0.
   This is the pinned engine loop `for (var i = 0; i < size; i++) items.Add(Pop())`
   that the runtime-collection lane certifies, and the emitted regions make the
   order observable: the compiler pushes an array literal in reverse source
   order, so pop order recovers the source element order. A negative count
   faults, an exhausted stack faults, and no other stack shape is admitted. *)
Fixpoint popn (n : nat) (m : Machine) : option (list GVal * Machine) :=
  match n with
  | 0%nat => Some ([], m)
  | S k =>
      match pop m with
      | Some (v, m1) =>
          match popn k m1 with
          | Some (vs, m2) => Some (v :: vs, m2)
          | None => None
          end
      | None => None
      end
  end.

Definition step (ins : Ins) (m : Machine) : option Machine :=
  match ins with
  | InitSlot n _ => Some (set_locals (repeat GNull n) m)
  | Push v => Some (pushv v m)
  | LdStatic i =>
      match mstatics m i with
      | Some v => Some (pushv v m)
      | None => None
      end
  | LdArg =>
      match margs m with
      | v :: _ => Some (pushv v m)
      | [] => None
      end
  | LdArgN i =>
      match nth_error (margs m) i with
      | Some v => Some (pushv v m)
      | None => None
      end
  | LdLoc i =>
      match nth_error (mlocals m) i with
      | Some v => Some (pushv v m)
      | None => None
      end
  | StLoc i =>
      match pop m with
      | Some (v, m1) =>
          Some (set_locals
            (firstn i (mlocals m1) ++ v :: skipn (S i) (mlocals m1)) m1)
      | None => None
      end
  | Concat =>
      match pop m with
      | Some (GBytes a, m1) =>
          match pop m1 with
          | Some (GBytes b, m2) => Some (pushv (GBytes (b ++ a)) m2)
          | _ => None
          end
      | _ => None
      end
  | Convert mode =>
      match pop m with
      | Some (GBytes b, m1) =>
          match mode with
          (* 33 = 0x21 StackItemType.Integer: pinned little-endian decode.
             48 = 0x30 StackItemType.Buffer and any other type marker are
             identity pass-throughs on byte strings. *)
          | 33%nat => match decode_integer b with
                      | OK (GInt z) => Some (pushv (GInt z) m1)
                      | _ => None
                      end
          | _ => Some (pushv (GBytes b) m1)
          end
      | _ => None
      end
  | NewBuffer =>
      match pop m with
      | Some (GInt n, m1) =>
          match Z.ltb n 0 with
          | true => None
          | false => Some (pushv (GBytes (repeat 0%nat (Z.to_nat n))) m1)
          end
      | _ => None
      end
  | GetContext => Some (pushv (GBytes [33%nat]) m)
  | StorageGet =>
      match storage_lookup m with
      | Some (v, m1) => Some (pushv v m1)
      | None => None
      end
  | EqualIns =>
      match pop m with
      | Some (a, m1) =>
          match pop m1 with
          | Some (b, m2) => Some (pushv (GBool (gval_eqb a b)) m2)
          | _ => None
          end
      | _ => None
      end
  | NotEqualIns =>
      match pop m with
      | Some (a, m1) =>
          match pop m1 with
          | Some (b, m2) => Some (pushv (GBool (negb (gval_eqb a b))) m2)
          | _ => None
          end
      | _ => None
      end
  | PickItem =>
      match pop m with
      | Some (GInt i, m1) =>
          match pop m1 with
          | Some (GArray xs, m2) =>
              match nth_error xs (Z.to_nat i) with
              | Some v => Some (pushv v m2)
              | None => None
              end
          | _ => None
          end
      | _ => None
      end
  | Greater =>
      match pop m with
      | Some (GInt b, m1) =>
          match pop m1 with
          | Some (GInt a, m2) => Some (pushv (GBool (Z.ltb b a)) m2)
          | _ => None
          end
      | _ => None
      end
  | AddIns =>
      match pop m with
      | Some (GInt b, m1) =>
          match pop m1 with
          | Some (GInt a, m2) => Some (pushv (GInt (a + b)) m2)
          | _ => None
          end
      | _ => None
      end
  | Pack =>
      match pop m with
      | Some (GInt n, m1) =>
          match Z.ltb n 0 with
          | true => None
          | false =>
              match popn (Z.to_nat n) m1 with
              | Some (vs, m2) => Some (pushv (GArray vs) m2)
              | None => None
              end
          end
      | _ => None
      end
  (* ISTYPE t pops the value and pushes whether its type marker equals t. Only
     the pinned ByteString marker (0x28 = 40) is modeled; every other marker
     fails closed instead of being approximated. The engine contract is the one
     the runtime-collection lane certifies: `engine.Push(x.Type == type)`. *)
  | IsType t =>
      match pop m with
      | Some (v, m1) =>
          match t with
          | 40%nat =>
              Some (pushv (GBool (match v with GBytes _ => true | _ => false end)) m1)
          | _ => None
          end
      | _ => None
      end
  (* NUMEQUAL pops two integers and pushes their equality; a non-integer
     operand faults. *)
  | NumEquals =>
      match pop m with
      | Some (GInt b, m1) =>
          match pop m1 with
          | Some (GInt a, m2) => Some (pushv (GBool (Z.eqb a b)) m2)
          | _ => None
          end
      | _ => None
      end
  | CallToken i =>
      match pop m with
      | Some (v, m1) => Some (pushv (mtokens m i v) m1)
      | None => None
      end
  | Dup =>
      match mstack m with
      | v :: _ => Some (pushv v m)
      | [] => None
      end
  | Drop =>
      match pop m with
      | Some (_, m1) => Some m1
      | None => None
      end
  | IsNull =>
      match pop m with
      | Some (v, m1) =>
          Some (pushv (GBool (match v with GNull => true | _ => false end)) m1)
      | None => None
      end
  | SizeIns =>
      match pop m with
      | Some (v, m1) => Some (pushv (GInt (Z.of_nat (gval_size v))) m1)
      | None => None
      end
  (* THROW faults; ABORTMSG aborts with a message - both fail closed. *)
  | Throw => None
  | AbortMsg => None
  | Ret => None
  | JumpIfNot _ | Jump _ | JumpIf _ | JumpEq _ | Call _ | Unsupported => None
  end.

(* The run loop owns control flow, call/return and RET/THROW termination.
   Fail-closed: exhausted fuel, unsupported opcode, stack underflow, THROW
   and ABORTMSG all yield Thrown, never a fabricated result. CALL pushes the
   return slot (S pc) and jumps; RET pops the saved slot and continues there,
   or terminates with the top of the stack when the call stack is empty. *)
Fixpoint run (fuel : nat) (pc : nat) (program : nat -> Ins) (m : Machine)
  {struct fuel} : Stop :=
  match fuel with
  | 0%nat => Thrown
  | S fuel' =>
      match program pc with
      | Jump t => run fuel' t program m
      | JumpIfNot t =>
          match mstack m with
          | GBool b :: rest =>
              if b then run fuel' (S pc) program (set_stack rest m)
              else run fuel' t program (set_stack rest m)
          | _ => Thrown
          end
      | JumpIf t =>
          match mstack m with
          | GBool b :: rest =>
              if b then run fuel' t program (set_stack rest m)
              else run fuel' (S pc) program (set_stack rest m)
          | _ => Thrown
          end
      | JumpEq t =>
          match mstack m with
          | GInt b :: GInt a :: rest =>
              if Z.eqb a b then run fuel' t program (set_stack rest m)
              else run fuel' (S pc) program (set_stack rest m)
          | _ => Thrown
          end
      | Call t => run fuel' t program (set_calls (S pc :: mcalls m) m)
      | Throw => Thrown
      | AbortMsg => Thrown
      | Ret =>
          match mcalls m with
          | [] =>
              match mstack m with
              | v :: _ => Done v
              | [] => Thrown
              end
          | r :: cs => run fuel' r program (set_calls cs m)
          end
      | ins =>
          match step ins m with
          | Some m' => run fuel' (S pc) program m'
          | None => Thrown
          end
      end
  end.

(* One-step unfolding lemma: lets trace certificates drive the machine
   without fully expanding run (which would not terminate on the kernel). *)
Lemma run_S : forall fuel pc program m,
  run (S fuel) pc program m =
  match program pc with
  | Jump t => run fuel t program m
  | JumpIfNot t =>
      match mstack m with
      | GBool b :: rest =>
          if b then run fuel (S pc) program (set_stack rest m)
          else run fuel t program (set_stack rest m)
      | _ => Thrown
      end
  | JumpIf t =>
      match mstack m with
      | GBool b :: rest =>
          if b then run fuel t program (set_stack rest m)
          else run fuel (S pc) program (set_stack rest m)
      | _ => Thrown
      end
  | JumpEq t =>
      match mstack m with
      | GInt b :: GInt a :: rest =>
          if Z.eqb a b then run fuel t program (set_stack rest m)
          else run fuel (S pc) program (set_stack rest m)
      | _ => Thrown
      end
  | Call t => run fuel t program (set_calls (S pc :: mcalls m) m)
  | Throw => Thrown
  | AbortMsg => Thrown
  | Ret =>
      match mcalls m with
      | [] =>
          match mstack m with
          | v :: _ => Done v
          | [] => Thrown
          end
      | r :: cs => run fuel r program (set_calls cs m)
      end
  | ins =>
      match step ins m with
      | Some m' => run fuel (S pc) program m'
      | None => Thrown
      end
  end.
Proof. intros fuel pc program m; destruct fuel; reflexivity. Qed.

Opaque run.
Print Assumptions run_S.
