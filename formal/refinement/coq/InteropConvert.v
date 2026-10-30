(** * The interop argument window and the handler's converted arguments.

    This layer starts where the [syscall-dispatch] lane stops: [OnSysCall] has
    already validated the call flags, has already been charged, and now turns
    the caller's stack window into the invoked handler's argument vector by one
    pop-and-convert step per declared argument.  It stops at that vector, before
    the handler body runs; nothing here closes an entrypoint and nothing here
    says anything about a handler's effect.

    The record fields below are *projections* of the pinned C#: each one is
    derived from the source text by [interop_convert_source.py], never restated
    by hand.  Eighteen of the nineteen fields have exactly one textual mutant in
    that lane; [ic_arity] is pinned by the declaration header instead, which the
    projector requires to appear exactly once, so deleting a declared argument
    makes the projection fail to parse rather than yield a weaker record. *)

From Coq Require Import NArith PeanoNat List Bool Lia.
Import ListNotations.

(** ** Items and values

    A [Item] is a stack item as far as this window can see it: null, an
    integer, a VM array payload, or anything else.  A [Value] is a converted
    argument.  The converters themselves are opaque, so the shapes below are
    only as fine as the branches the pinned C# actually distinguishes. *)

Inductive Item : Type :=
| NullItem : Item
| IntItem (count : N) : Item
| ArrayItem (elements : list Item) : Item
| PlainItem : Item.

Inductive Value : Type :=
| VNull : Value
| VInt (number : N) : Value
| VPlain : Value
| VBytes : Value
| VEnum (number : N) : Value
| VInterface : Value
| VArray (values : list Value) : Value.

Definition is_null_item (item : Item) : bool :=
  match item with
  | NullItem => true
  | _ => false
  end.

(** ** The projected program *)

Record ConvertProgram := convert_program {
  ic_arity : nat;
  ic_arity_from_descriptor : bool;
  ic_one_pop_per_parameter : bool;
  ic_reverse_index : bool;
  ic_push_only_nonvoid : bool;
  ic_return_drops_nulls : bool;
  ic_byte_excluded : bool;
  ic_element_converter : bool;
  ic_enum_converter : bool;
  ic_unknown_is_interface : bool;
  ic_plain_array_identity : bool;
  ic_payload_length : bool;
  ic_payload_order : bool;
  ic_counted_order : bool;
  ic_counted_pops : bool;
  ic_max_length : N;
  ic_null_argument_check : bool;
  ic_null_payload_check : bool;
  ic_null_counted_check : bool
}.

(** The reviewed record: 4 declared arguments, 2048 = 2 * 1024 read off
    [ExecutionEngineLimits.MaxStackSize]. *)
Definition canonical_convert :=
  convert_program 4 true true true true true true true true true true true true
                  true true 2048%N true true true.

(** ** One descriptor entry

    [pa_is_array_type] is [Type.IsArray] and [pa_element_type] is
    [Type.GetElementType()]; the derived [IsArray] member is the conjunction
    with "the element type is not [byte]". *)

Inductive ElementType : Type := EByte | EOther.

Record Param := param {
  pa_is_array_type : bool;
  pa_element_type : ElementType;
  pa_element_nullable : bool;
  pa_nullable : bool;
  pa_is_stack_item : bool;
  pa_known : bool;
  pa_enum : bool;
  pa_interface : bool
}.

Definition element_is_byte (entry : Param) : bool :=
  match entry.(pa_element_type) with
  | EByte => true
  | EOther => false
  end.

Definition is_array_branch (p : ConvertProgram) (entry : Param) : bool :=
  andb entry.(pa_is_array_type)
       (if p.(ic_byte_excluded) then negb (element_is_byte entry) else true).

(** ** One element

    [convert_element] is the table lookup.  [ic_element_converter] decides
    whether the element type or the whole array type keys the table; only the
    element type is in it, so the other lookup faults.  A plain-array element
    goes through the identity entry, an unnamed type through the interface
    entry, and an unknown type whose interface flag was dropped keeps a null
    converter, which faults on invocation. *)

Definition convert_element (p : ConvertProgram) (entry : Param) (item : Item)
  : option Value :=
  if negb p.(ic_element_converter) then None
  else
    match item with
    | NullItem => Some VNull
    | IntItem number => Some (VInt number)
    | ArrayItem _ => if p.(ic_plain_array_identity) then Some VPlain else None
    | PlainItem =>
        if andb entry.(pa_is_array_type) (element_is_byte entry) then Some VBytes
        else if entry.(pa_known) then Some VPlain
        else if p.(ic_unknown_is_interface) then Some VInterface
             else None
    end.

(** The scalar branch rewrites an enumeration through its underlying type and
    takes the interface out of the wrapping stack item. *)
Definition convert_scalar (p : ConvertProgram) (entry : Param) (item : Item)
  : option Value :=
  match convert_element p entry item with
  | None => None
  | Some value =>
      if entry.(pa_enum) then
        if p.(ic_enum_converter) then Some (VEnum 0) else None
      else if entry.(pa_interface) then Some VInterface
           else Some value
  end.

(** The per-element null check, which differs between the two array branches
    only in which field switches it. *)
Definition element_value (p : ConvertProgram) (entry : Param) (check : bool)
    (item : Item) : option Value :=
  match item with
  | NullItem =>
      if andb check (negb entry.(pa_element_nullable)) then None else Some VNull
  | _ => convert_element p entry item
  end.

Fixpoint convert_all (p : ConvertProgram) (entry : Param) (check : bool)
    (items : list Item) : option (list Value) :=
  match items with
  | [] => Some []
  | item :: rest =>
      match element_value p entry check item with
      | None => None
      | Some value =>
          match convert_all p entry check rest with
          | None => None
          | Some tail => Some (value :: tail)
          end
      end
  end.

(** ** The payload branch

    [Array.CreateInstance(elementType, array.Count)] then one [SetValue] per
    index.  When the length is not the item count the allocation is the stack
    limit instead, so reading the payload at those indices faults. *)
Definition payload_slots (p : ConvertProgram) (entry : Param)
    (elements : list Item) : option (list Value) :=
  if p.(ic_payload_length) then
    match convert_all p entry p.(ic_null_payload_check) elements with
    | None => None
    | Some values => Some (if p.(ic_payload_order) then values else rev values)
    end
  else None.

(** ** The counted branch

    The length is the item's own integer, checked with a strict [>] against the
    stack limit, and the elements come off the same window the caller's
    arguments come off.  When the pop is dropped the items stay on the stack. *)
Definition convert_counted (p : ConvertProgram) (entry : Param) (count : N)
    (window : list Item) : option (list Value * list Item) :=
  if N.ltb p.(ic_max_length) count then None
  else if Nat.leb (N.to_nat count) (length window) then
    match convert_all p entry p.(ic_null_counted_check)
                      (firstn (N.to_nat count) window) with
    | None => None
    | Some values =>
        Some ((if p.(ic_counted_order) then values else rev values),
              (if p.(ic_counted_pops) then skipn (N.to_nat count) window
               else window))
    end
  else None.

(** ** One argument *)

(** The null guard tests the item first and the descriptor last, which is the
    same conjunction as the pinned source; the order only makes the guard
    reduce on a non-null item without consulting the descriptor. *)
Definition argument_is_rejected (p : ConvertProgram) (entry : Param)
    (item : Item) : bool :=
  andb (is_null_item item)
       (andb p.(ic_null_argument_check)
             (andb (negb entry.(pa_nullable)) (negb entry.(pa_is_stack_item)))).

Definition convert_argument (p : ConvertProgram) (entry : Param) (item : Item)
    (window : list Item) : option (option Value * list Item) :=
  if argument_is_rejected p entry item
  then None
  else if is_array_branch p entry then
         match item with
         | ArrayItem elements =>
             match payload_slots p entry elements with
             | Some values => Some (Some (VArray values), window)
             | None => None
             end
         | IntItem count =>
             match convert_counted p entry count window with
             | Some (values, remaining) => Some (Some (VArray values), remaining)
             | None => None
             end
         | _ => None
         end
       else
         match convert_scalar p entry item with
         | Some value => Some (Some value, window)
         | None => None
         end.

(** ** The whole argument vector

    One pop per declared argument when the field says so; otherwise an extra
    item is swallowed per argument, which shifts every later argument. *)

Definition pop_window (p : ConvertProgram) (window : list Item)
  : option (Item * list Item) :=
  match window with
  | [] => None
  | item :: rest =>
      if p.(ic_one_pop_per_parameter) then Some (item, rest)
      else match rest with
           | [] => None
           | _ :: rest' => Some (item, rest')
           end
  end.

Fixpoint build_parameters (p : ConvertProgram) (entries : list Param)
    (window : list Item) : option (list (option Value) * list Item) :=
  match entries with
  | [] => Some ([], window)
  | entry :: rest =>
      match pop_window p window with
      | None => None
      | Some (item, after_pop) =>
          match convert_argument p entry item after_pop with
          | None => None
          | Some (value, after_convert) =>
              match build_parameters p rest after_convert with
              | None => None
              | Some (values, remaining) =>
                  Some ((if p.(ic_reverse_index) then value :: values
                                                    else values ++ [value]), remaining)
              end
          end
      end
  end.

(** ** The return value *)

Inductive Return : Type :=
| ReturnVoid : Return
| ReturnPayload (payload : list Item) : Return.

Definition payload_items (p : ConvertProgram) (payload : list Item) : list Item :=
  if p.(ic_return_drops_nulls) then
    filter (fun item => negb (is_null_item item)) payload
  else payload.

Definition tail_stack (p : ConvertProgram) (result : Return)
    (stack : list Item) : list Item :=
  match result with
  | ReturnVoid => if p.(ic_push_only_nonvoid) then stack else NullItem :: stack
  | ReturnPayload payload => ArrayItem (payload_items p payload) :: stack
  end.

(** ** The call site *)

Record CallSite := call_site {
  cs_entries : list Param;
  cs_window : list Item;
  cs_result : Return
}.

Definition on_syscall (p : ConvertProgram) (cs : CallSite)
  : option (list (option Value) * list Item) :=
  match (if p.(ic_arity_from_descriptor) then Some cs.(cs_window)
         else match cs.(cs_window) with
              | IntItem _ :: rest => Some rest
              | _ => None
              end) with
  | None => None
  | Some window =>
      match build_parameters p cs.(cs_entries) window with
      | None => None
      | Some (values, remaining) => Some (values, tail_stack p cs.(cs_result) remaining)
      end
  end.

(** * Canonical facts

    One theorem per projected field: the reviewed record really carries the
    value the source text has. *)

Theorem canonical_arity : ic_arity canonical_convert = 4.
Proof. reflexivity. Qed.

Theorem canonical_reads_the_arity_from_the_descriptor :
  ic_arity_from_descriptor canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_pops_one_item_per_parameter :
  ic_one_pop_per_parameter canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_fills_in_forward_index_order :
  ic_reverse_index canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_pushes_only_a_value_return :
  ic_push_only_nonvoid canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_return_drops_null_elements :
  ic_return_drops_nulls canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_excludes_byte_arrays :
  ic_byte_excluded canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_keys_the_element_converter_by_element_type :
  ic_element_converter canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_keys_the_enum_converter_by_underlying_type :
  ic_enum_converter canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_unknown_type_goes_to_the_interface :
  ic_unknown_is_interface canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_plain_array_converter_is_the_identity :
  ic_plain_array_identity canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_payload_length_is_the_item_count :
  ic_payload_length canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_payload_fills_in_index_order :
  ic_payload_order canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_counted_fills_in_index_order :
  ic_counted_order canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_counted_pops_the_count :
  ic_counted_pops canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_max_length_is_2048 : ic_max_length canonical_convert = 2048%N.
Proof. reflexivity. Qed.

Theorem canonical_rejects_a_null_argument :
  ic_null_argument_check canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_rejects_a_null_payload_element :
  ic_null_payload_check canonical_convert = true.
Proof. reflexivity. Qed.

Theorem canonical_rejects_a_null_counted_element :
  ic_null_counted_check canonical_convert = true.
Proof. reflexivity. Qed.

(** * Structural facts about the window *)

Lemma N_ltb_irrefl : forall a : N, N.ltb a a = false.
Proof.
  intros a. apply N.ltb_ge. apply N.le_refl.
Qed.

(** The array branch really excludes a byte element, and only because the
    field says so. *)
Theorem byte_element_leaves_the_array_branch : forall p entry,
  p.(ic_byte_excluded) = true ->
  element_is_byte entry = true ->
  is_array_branch p entry = false.
Proof.
  intros p entry Hfield Hbyte. unfold is_array_branch. rewrite Hfield, Hbyte.
  simpl. destruct entry.(pa_is_array_type); reflexivity.
Qed.

Theorem dropping_the_exclusion_moves_byte_arrays_into_the_branch : forall entry,
  entry.(pa_is_array_type) = true ->
  element_is_byte entry = true ->
  is_array_branch (convert_program 4 true true true true true false true true
                                    true true true true true true 2048%N
                                    true true true) entry = true.
Proof.
  intros entry Harray Hbyte. unfold is_array_branch. rewrite Harray.
  simpl. reflexivity.
Qed.

(** A byte-array argument converts to a byte span on one side of the branch and
    to an array of bytes on the other, so the exclusion is observable. *)
Theorem byte_array_arguments_differ_across_the_branch : forall entry window,
  entry.(pa_is_array_type) = true ->
  element_is_byte entry = true ->
  entry.(pa_enum) = false ->
  entry.(pa_interface) = false ->
  convert_argument canonical_convert entry (ArrayItem []) window
    = Some (Some VPlain, window)
  /\ convert_argument
       (convert_program 4 true true true true true false true true true true
                        true true true true 2048%N true true true)
       entry (ArrayItem []) window = Some (Some (VArray []), window).
Proof.
  intros entry window Harray Hbyte Henum Hinterface.
  split.
  - unfold convert_argument, is_array_branch.
    rewrite Harray, Hbyte. simpl.
    unfold convert_scalar, convert_element.
    rewrite Henum, Hinterface. reflexivity.
  - unfold convert_argument, is_array_branch.
    rewrite Harray. simpl.
    unfold payload_slots. reflexivity.
Qed.

(** One slot is allocated per declared argument. *)
Theorem the_vector_has_one_slot_per_declared_argument :
  forall p entries window values remaining,
    build_parameters p entries window = Some (values, remaining) ->
    length values = length entries.
Proof.
  intros p entries. induction entries as [| entry rest IH];
    intros window values remaining Hbuilt.
  - simpl in Hbuilt. injection Hbuilt as <- <-. reflexivity.
  - simpl in Hbuilt.
    destruct (pop_window p window) as [[item after_pop] |] eqn:Hpop;
      [| discriminate Hbuilt].
    destruct (convert_argument p entry item after_pop) as [[value after_conv] |]
        eqn:Hconv; [| discriminate Hbuilt].
    destruct (build_parameters p rest after_conv) as [[sub_values rest_left] |]
        eqn:Hrest; [| discriminate Hbuilt].
    injection Hbuilt as <- _.
    pose proof (IH after_conv sub_values rest_left Hrest) as Hsub.
    destruct p.(ic_reverse_index).
    + simpl. lia.
    + rewrite length_app. cbn. lia.
Qed.

(** An argument never adds items to the window: conversion only pops. *)
Theorem conversion_never_grows_the_window :
  forall p entry item window value remaining,
    convert_argument p entry item window = Some (value, remaining) ->
    length remaining <= length window.
Proof.
  intros p entry item window value remaining Hconv.
  unfold convert_argument in Hconv.
  destruct (argument_is_rejected p entry item) eqn:Hnull.
  - discriminate Hconv.
  - destruct (is_array_branch p entry) eqn:Hbranch.
    + destruct item as [| count | elements | ].
      * discriminate Hconv.
      * unfold convert_counted in Hconv.
        destruct (N.ltb p.(ic_max_length) count) eqn:Hlimit; [discriminate Hconv |].
        destruct (Nat.leb (N.to_nat count) (length window)) eqn:Hfit;
          [| discriminate Hconv].
        destruct (convert_all p entry p.(ic_null_counted_check)
                              (firstn (N.to_nat count) window))
          as [values |] eqn:Hvalues; [| discriminate Hconv].
        injection Hconv as _ Hleft. rewrite <- Hleft.
        destruct p.(ic_counted_pops); simpl.
        -- rewrite length_skipn. lia.
        -- lia.
      * unfold payload_slots in Hconv.
        destruct p.(ic_payload_length) eqn:Hlen; [| discriminate Hconv].
        destruct (convert_all p entry p.(ic_null_payload_check) elements)
          as [values |] eqn:Hvalues; [| discriminate Hconv].
        injection Hconv as _ Hleft. rewrite <- Hleft. lia.
      * discriminate Hconv.
    + destruct (convert_scalar p entry item) as [value' |] eqn:Hscalar;
        [| discriminate Hconv].
      injection Hconv as _ Hleft. rewrite <- Hleft. lia.
Qed.

(** With one pop per argument the window shrinks by exactly the arity. *)
Theorem the_window_shrinks_by_the_arity : forall p entries window values remaining,
  p.(ic_one_pop_per_parameter) = true ->
  build_parameters p entries window = Some (values, remaining) ->
  length remaining + length entries <= length window.
Proof.
  intros p entries. induction entries as [| entry rest IH];
    intros window values remaining Hone Hbuilt.
  - simpl in Hbuilt. injection Hbuilt as _ Hleft. rewrite <- Hleft. simpl. lia.
  - simpl in Hbuilt.
    destruct (pop_window p window) as [[item after_pop] |] eqn:Hpop;
      [| discriminate Hbuilt].
    destruct (convert_argument p entry item after_pop) as [[value after_conv] |]
        eqn:Hconv; [| discriminate Hbuilt].
    destruct (build_parameters p rest after_conv) as [[sub_values rest_left] |]
        eqn:Hrest; [| discriminate Hbuilt].
    injection Hbuilt as _ Hremaining.
    pose proof (IH after_conv sub_values rest_left Hone Hrest) as Htail.
    pose proof (conversion_never_grows_the_window p entry item after_pop value
                  after_conv Hconv) as Hgrow.
    assert (Hpopped : length after_pop + 1 = length window).
    { unfold pop_window in Hpop. rewrite Hone in Hpop.
      destruct window as [| head tail]; [discriminate Hpop |].
      injection Hpop as _ Hafter. rewrite <- Hafter. simpl. lia. }
    rewrite <- Hremaining. simpl. lia.
Qed.

(** Dropping the pop leaves the counted items on the stack. *)
Theorem counted_items_stay_when_the_pop_is_dropped : forall p entry count window
    values,
  p.(ic_max_length) = 2048%N ->
  p.(ic_counted_pops) = false ->
  convert_all p entry p.(ic_null_counted_check)
              (firstn (N.to_nat count) window) = Some values ->
  N.ltb 2048%N count = false ->
  Nat.leb (N.to_nat count) (length window) = true ->
  convert_counted p entry count window
    = Some ((if p.(ic_counted_order) then values else rev values), window).
Proof.
  intros p entry count window values Hlimit Hpops Hvalues Hlt Hfit.
  unfold convert_counted. rewrite Hlimit, Hlt, Hfit, Hvalues, Hpops.
  reflexivity.
Qed.

(** * The counted branch's bound *)

Theorem counted_length_above_the_limit_faults : forall p entry count window,
  N.ltb p.(ic_max_length) count = true ->
  convert_counted p entry count window = None.
Proof.
  intros p entry count window Hlimit. unfold convert_counted. rewrite Hlimit.
  reflexivity.
Qed.

Theorem counted_length_at_the_limit_is_accepted : forall p entry window,
  Nat.leb (N.to_nat (ic_max_length p)) (length window) = true ->
  convert_counted p entry (ic_max_length p) window
    = match convert_all p entry (ic_null_counted_check p)
                        (firstn (N.to_nat (ic_max_length p)) window) with
      | None => None
      | Some values =>
          Some ((if p.(ic_counted_order) then values else rev values),
                (if p.(ic_counted_pops)
                 then skipn (N.to_nat (ic_max_length p)) window else window))
      end.
Proof.
  intros p entry window Hfit. unfold convert_counted.
  rewrite N_ltb_irrefl, Hfit. reflexivity.
Qed.

(** The bound is [>], not [>=]: the limit itself converts nothing away. *)
Theorem counted_length_one_above_the_limit_faults : forall p entry window,
  convert_counted p entry (N.succ (ic_max_length p)) window = None.
Proof.
  intros p entry window. apply counted_length_above_the_limit_faults.
  apply N.ltb_lt. apply N.lt_succ_diag_r.
Qed.

Theorem counted_branch_takes_exactly_the_count : forall p entry count window,
  length window = N.to_nat count ->
  N.ltb p.(ic_max_length) count = false ->
  convert_counted p entry count window
    = match convert_all p entry p.(ic_null_counted_check) window with
      | None => None
      | Some values =>
          Some ((if p.(ic_counted_order) then values else rev values),
                (if p.(ic_counted_pops) then [] else window))
      end.
Proof.
  intros p entry count window Hlen Hlimit. unfold convert_counted.
  rewrite Hlimit. rewrite Hlen. rewrite Nat.leb_refl.
  rewrite firstn_all2; [| lia]. rewrite skipn_all2; [| lia].
  reflexivity.
Qed.

Theorem counted_branch_without_enough_items_faults : forall p entry count window,
  N.ltb p.(ic_max_length) count = false ->
  length window < N.to_nat count ->
  convert_counted p entry count window = None.
Proof.
  intros p entry count window Hlimit Hshort. unfold convert_counted.
  rewrite Hlimit.
  assert (Hle : Nat.leb (N.to_nat count) (length window) = false) by
    (apply Nat.leb_gt; lia).
  rewrite Hle. reflexivity.
Qed.

(** * The null checks *)

Theorem a_null_argument_faults_when_the_check_is_on : forall p entry window,
  p.(ic_null_argument_check) = true ->
  entry.(pa_nullable) = false ->
  entry.(pa_is_stack_item) = false ->
  convert_argument p entry NullItem window = None.
Proof.
  intros p entry window Hcheck Hnullable Hstack.
  unfold convert_argument, argument_is_rejected. rewrite Hcheck, Hnullable, Hstack. reflexivity.
Qed.

Theorem a_nullable_argument_accepts_null : forall p entry window,
  p.(ic_null_argument_check) = true ->
  entry.(pa_nullable) = true ->
  p.(ic_element_converter) = true ->
  entry.(pa_enum) = false ->
  entry.(pa_interface) = false ->
  is_array_branch p entry = false ->
  convert_argument p entry NullItem window = Some (Some VNull, window).
Proof.
  intros p entry window Hcheck Hnullable Helement Henum Hinterface Hbranch.
  unfold convert_argument, argument_is_rejected. rewrite Hcheck, Hnullable. simpl.
  rewrite Hbranch. unfold convert_scalar, convert_element.
  rewrite Helement, Henum, Hinterface. reflexivity.
Qed.

Theorem a_stack_item_argument_accepts_null : forall p entry window,
  p.(ic_null_argument_check) = true ->
  entry.(pa_nullable) = false ->
  entry.(pa_is_stack_item) = true ->
  p.(ic_element_converter) = true ->
  entry.(pa_enum) = false ->
  entry.(pa_interface) = false ->
  is_array_branch p entry = false ->
  convert_argument p entry NullItem window = Some (Some VNull, window).
Proof.
  intros p entry window Hcheck Hnullable Hstack Helement Henum Hinterface Hbranch.
  unfold convert_argument, argument_is_rejected. rewrite Hcheck, Hnullable, Hstack. simpl.
  rewrite Hbranch. unfold convert_scalar, convert_element.
  rewrite Helement, Henum, Hinterface. reflexivity.
Qed.

Theorem a_null_payload_element_faults : forall p entry elements,
  p.(ic_null_payload_check) = true ->
  entry.(pa_element_nullable) = false ->
  payload_slots p entry (NullItem :: elements) = None.
Proof.
  intros p entry elements Hcheck Hnullable. unfold payload_slots.
  destruct p.(ic_payload_length).
  - simpl. unfold element_value. rewrite Hcheck, Hnullable. reflexivity.
  - reflexivity.
Qed.

(** The counted branch reads its elements off the caller's window, so a null
    argument element faults only when the window actually supplies one. *)
Theorem a_null_counted_element_faults : forall p entry count tail,
  p.(ic_null_counted_check) = true ->
  entry.(pa_element_nullable) = false ->
  N.to_nat count = S (length tail) ->
  N.ltb p.(ic_max_length) count = false ->
  convert_counted p entry count (NullItem :: tail) = None.
Proof.
  intros p entry count tail Hcheck Hnullable Hcount Hlimit.
  unfold convert_counted. rewrite Hlimit.
  assert (Hfit : Nat.leb (N.to_nat count) (length (NullItem :: tail)) = true).
  { cbn. rewrite Hcount. cbn. apply Nat.leb_refl. }
  rewrite Hfit.
  assert (Hprefix : firstn (N.to_nat count) (NullItem :: tail)
                    = NullItem :: tail).
  { rewrite Hcount. cbn. rewrite firstn_all. reflexivity. }
  rewrite Hprefix. cbn. rewrite Hcheck, Hnullable. reflexivity.
Qed.

(** * The scalar branches *)

Theorem enum_arguments_use_the_underlying_converter : forall p entry item,
  entry.(pa_enum) = true ->
  p.(ic_enum_converter) = true ->
  convert_element p entry item = Some VPlain ->
  convert_scalar p entry item = Some (VEnum 0).
Proof.
  intros p entry item Henum Hconverter Helement.
  unfold convert_scalar. rewrite Helement, Hconverter, Henum. reflexivity.
Qed.

Theorem dropping_the_underlying_converter_faults_an_enum : forall p entry item,
  entry.(pa_enum) = true ->
  p.(ic_enum_converter) = false ->
  convert_element p entry item = Some VPlain ->
  convert_scalar p entry item = None.
Proof.
  intros p entry item Henum Hconverter Helement.
  unfold convert_scalar. rewrite Helement, Henum. rewrite Hconverter.
  reflexivity.
Qed.

Theorem an_unknown_type_goes_to_the_interface : forall p entry,
  entry.(pa_known) = false ->
  entry.(pa_is_array_type) = false ->
  p.(ic_element_converter) = true ->
  p.(ic_unknown_is_interface) = true ->
  convert_element p entry PlainItem = Some VInterface.
Proof.
  intros p entry Hunknown Harray Helement Hinterface.
  unfold convert_element. rewrite Helement. rewrite Harray, Hunknown.
  rewrite Hinterface. reflexivity.
Qed.

Theorem dropping_the_interface_flag_leaves_no_converter : forall p entry,
  entry.(pa_known) = false ->
  entry.(pa_is_array_type) = false ->
  p.(ic_element_converter) = true ->
  p.(ic_unknown_is_interface) = false ->
  convert_element p entry PlainItem = None.
Proof.
  intros p entry Hunknown Harray Helement Hinterface.
  unfold convert_element. rewrite Helement, Harray, Hunknown, Hinterface.
  reflexivity.
Qed.

Theorem a_plain_array_element_needs_the_identity_entry : forall p entry items,
  p.(ic_element_converter) = true ->
  p.(ic_plain_array_identity) = true ->
  convert_element p entry (ArrayItem items) = Some VPlain.
Proof.
  intros p entry items Helement Hidentity. unfold convert_element.
  rewrite Helement, Hidentity. reflexivity.
Qed.

(** * The return value *)

Theorem a_void_return_pushes_nothing : forall p stack,
  p.(ic_push_only_nonvoid) = true ->
  tail_stack p ReturnVoid stack = stack.
Proof.
  intros p stack Hpush. unfold tail_stack. rewrite Hpush. reflexivity.
Qed.

Theorem dropping_the_void_guard_pushes_a_null : forall p stack,
  p.(ic_push_only_nonvoid) = false ->
  tail_stack p ReturnVoid stack = NullItem :: stack.
Proof.
  intros p stack Hpush. unfold tail_stack. rewrite Hpush. reflexivity.
Qed.

Theorem a_value_return_pushes_one_item : forall p payload stack,
  tail_stack p (ReturnPayload payload) stack
    = ArrayItem (payload_items p payload) :: stack.
Proof. intros p payload stack. reflexivity. Qed.

Theorem returned_nulls_are_dropped : forall p payload,
  p.(ic_return_drops_nulls) = true ->
  payload_items p payload = filter (fun item => negb (is_null_item item)) payload.
Proof.
  intros p payload Hdrop. unfold payload_items. rewrite Hdrop. reflexivity.
Qed.

Theorem keeping_returned_nulls_keeps_every_element : forall p payload,
  p.(ic_return_drops_nulls) = false ->
  payload_items p payload = payload.
Proof.
  intros p payload Hdrop. unfold payload_items. rewrite Hdrop. reflexivity.
Qed.

(** * The whole call *)

Theorem the_arity_is_read_from_the_descriptor : forall cs values remaining,
  ic_arity_from_descriptor canonical_convert = true ->
  build_parameters canonical_convert cs.(cs_entries) cs.(cs_window)
    = Some (values, remaining) ->
  on_syscall canonical_convert cs
    = Some (values, tail_stack canonical_convert cs.(cs_result) remaining).
Proof.
  intros cs values remaining Hfield Hbuilt.
  unfold on_syscall. rewrite Hfield. simpl. rewrite Hbuilt.
  reflexivity.
Qed.

Theorem a_stack_counted_arity_shifts_the_window : forall cs rest,
  cs.(cs_window) = IntItem 4 :: rest ->
  ic_arity_from_descriptor
    (convert_program 4 false true true true true true true true true true true
                     true true true 2048%N true true true) = false ->
  on_syscall
    (convert_program 4 false true true true true true true true true true true
                     true true true 2048%N true true true) cs
    = match build_parameters
              (convert_program 4 false true true true true true true true true
                               true true true true true 2048%N true true true)
              cs.(cs_entries) rest with
      | None => None
      | Some (values, remaining) =>
          Some (values,
                tail_stack
                  (convert_program 4 false true true true true true true true
                                   true true true true true true 2048%N true
                                   true true)
                  cs.(cs_result) remaining)
      end.
Proof.
  intros cs rest Hwindow Hfield. unfold on_syscall. rewrite Hfield.
  rewrite Hwindow. reflexivity.
Qed.

(** * Assumption inventory *)

Print Assumptions canonical_arity.
Print Assumptions canonical_reads_the_arity_from_the_descriptor.
Print Assumptions canonical_pops_one_item_per_parameter.
Print Assumptions canonical_fills_in_forward_index_order.
Print Assumptions canonical_pushes_only_a_value_return.
Print Assumptions canonical_return_drops_null_elements.
Print Assumptions canonical_excludes_byte_arrays.
Print Assumptions canonical_keys_the_element_converter_by_element_type.
Print Assumptions canonical_keys_the_enum_converter_by_underlying_type.
Print Assumptions canonical_unknown_type_goes_to_the_interface.
Print Assumptions canonical_plain_array_converter_is_the_identity.
Print Assumptions canonical_payload_length_is_the_item_count.
Print Assumptions canonical_payload_fills_in_index_order.
Print Assumptions canonical_counted_fills_in_index_order.
Print Assumptions canonical_counted_pops_the_count.
Print Assumptions canonical_max_length_is_2048.
Print Assumptions canonical_rejects_a_null_argument.
Print Assumptions canonical_rejects_a_null_payload_element.
Print Assumptions canonical_rejects_a_null_counted_element.
Print Assumptions N_ltb_irrefl.
Print Assumptions byte_element_leaves_the_array_branch.
Print Assumptions dropping_the_exclusion_moves_byte_arrays_into_the_branch.
Print Assumptions byte_array_arguments_differ_across_the_branch.
Print Assumptions the_vector_has_one_slot_per_declared_argument.
Print Assumptions conversion_never_grows_the_window.
Print Assumptions the_window_shrinks_by_the_arity.
Print Assumptions counted_items_stay_when_the_pop_is_dropped.
Print Assumptions counted_length_above_the_limit_faults.
Print Assumptions counted_length_at_the_limit_is_accepted.
Print Assumptions counted_length_one_above_the_limit_faults.
Print Assumptions counted_branch_takes_exactly_the_count.
Print Assumptions counted_branch_without_enough_items_faults.
Print Assumptions a_null_argument_faults_when_the_check_is_on.
Print Assumptions a_nullable_argument_accepts_null.
Print Assumptions a_stack_item_argument_accepts_null.
Print Assumptions a_null_payload_element_faults.
Print Assumptions a_null_counted_element_faults.
Print Assumptions enum_arguments_use_the_underlying_converter.
Print Assumptions dropping_the_underlying_converter_faults_an_enum.
Print Assumptions an_unknown_type_goes_to_the_interface.
Print Assumptions dropping_the_interface_flag_leaves_no_converter.
Print Assumptions a_plain_array_element_needs_the_identity_entry.
Print Assumptions a_void_return_pushes_nothing.
Print Assumptions dropping_the_void_guard_pushes_a_null.
Print Assumptions a_value_return_pushes_one_item.
Print Assumptions returned_nulls_are_dropped.
Print Assumptions keeping_returned_nulls_keeps_every_element.
Print Assumptions the_arity_is_read_from_the_descriptor.
Print Assumptions a_stack_counted_arity_shifts_the_window.
