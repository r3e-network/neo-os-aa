(* Source-derived collection programs. Engine APIs, mutable-object projection,
   reference counting, readonly/resource policy and C# extraction remain TCB.
   These programs never call vm_step/read_field/write_field/allocate. *)
From Coq Require Import ZArith List Bool Lia PeanoNat.
Require Import IntegerSemantics NumericCoercions CapMethodVm RuntimeInstructionBridge.
Import ListNotations.
Open Scope Z_scope.
Inductive Compare := CLt | CLe | CGt | CGe | CEq | CNe.
Definition compare op a b := match op with
 | CLt => a <? b | CLe => a <=? b | CGt => b <? a | CGe => b <=? a
 | CEq => Z.eqb a b | CNe => negb (Z.eqb a b) end.
Record Bounds := bounds { lower_op : Compare; lower_value : Z; upper_op : Compare }.
Definition fails_bounds b index size := compare (lower_op b) index (lower_value b) ||
 compare (upper_op b) index (Z.of_nat size).
Definition int32 z := if (-2^31 <=? z) && (z <? 2^31) then Some z else None.
Inductive CollectionProgram :=
 | ArrayGet : Bounds -> Z -> CollectionProgram
 | ArrayPut : Bounds -> Z -> bool -> CollectionProgram
 | CountedPack : Bounds -> Kind -> nat -> Compare -> Z -> CollectionProgram
 | EmptyAllocation : Kind -> CollectionProgram
 | LiteralPush : Value -> CollectionProgram
 | OperandPush : CollectionProgram
 | EntryInitSlots : nat -> bool -> nat -> Compare -> Z -> CollectionProgram.
Definition continue_source s width values objects :=
 Some (change s (pc s+width)%nat values (arguments s) (locals s) objects (storage s) (effects s)).
(* Loop execution appends each popped item, matching Array.Add. *)
Fixpoint pop_add_loop fuel size cursor op step values accumulated : option (list Value * list Value) :=
 match fuel with O => None | S remaining =>
 if compare op cursor size then match values with
 | [] => None | item::rest => pop_add_loop remaining size (cursor+step) op step rest (accumulated++[item]) end
 else Some (accumulated,values) end.
Definition object_get objects reference index :=
 match nth_error objects reference with
 | Some object => nth_error (fields object) index | None => None end.
(* Object-list indexed updates are separate from value-list slot updates. *)
Fixpoint replace_object index object objects : option (list Object) :=
 match index,objects with
 | O,_::rest => Some (object::rest)
 | S n,head::rest => option_map (fun changed => head::changed) (replace_object n object rest)
 | _,_ => None end.
Definition store_object objects reference index value :=
 match nth_error objects reference with
 | Some object => bind (update_at index value (fields object)) (fun changed =>
 replace_object reference (obj (object_kind object) changed) objects)
 | None => None end.
Definition fresh_object s width kind values rest :=
 continue_source s width (VRef (length (heap s))::rest) (heap s++[obj kind values]).
Definition source_collection program width s operand readonly absent_slots : option State :=
 match program with
 | ArrayGet b offset => match stack s with
 | key::VRef reference::rest => bind (get_integer (numeric_projection key)) (fun index =>
   match nth_error (heap s) reference with
   | Some object => if fails_bounds b index (length (fields object)) then None else
     bind (int32 (index+offset)) (fun integer => if 0 <=? integer then
       bind (object_get (heap s) reference (Z.to_nat integer)) (fun value => continue_source s width (value::rest) (heap s)) else None)
   | None => None end) | _ => None end
 | ArrayPut b offset use_key => match stack s with
 | value::key::VRef reference::rest =>
   (* The source clones Struct values. This domain deliberately rejects all
      reference/structured values, without claiming they fault in the VM. *)
   if scalar value then bind (get_integer (numeric_projection key)) (fun index =>
   match nth_error (heap s) reference with
   | Some object => if fails_bounds b index (length (fields object)) || readonly then None else
     bind (int32 (index+offset)) (fun integer => if 0 <=? integer then
       bind (store_object (heap s) reference (Z.to_nat integer) (if use_key then key else value))
         (fun objects => continue_source s width rest objects) else None)
   | None => None end) else None | _ => None end
 | CountedPack b kind start op step => match stack s with
 | key::rest => bind (get_integer (numeric_projection key)) (fun size => bind (int32 size) (fun size =>
   if fails_bounds b size (length rest) then None else
   bind (pop_add_loop (S (length rest)) size (Z.of_nat start) op step rest [])
     (fun '(values,remaining) => fresh_object s width kind values remaining))) | _ => None end
 | EmptyAllocation kind => fresh_object s width kind [] (stack s)
 | LiteralPush (VInt z) => bind (checked_integer z) (fun z => continue_source s width (VInt z::stack s) (heap s))
 | LiteralPush value => continue_source s width (value::stack s) (heap s)
 | OperandPush => if (length operand <=? 131070)%nat then continue_source s width (VBytes operand::stack s) (heap s) else None
 | EntryInitSlots rejected alternate start op step =>
   if absent_slots && Nat.eqb (length (locals s)) 0 && Nat.eqb (length (arguments s)) 0 then
     match operand with l::a::_ => if Nat.eqb (l+256*a) rejected then None else
     bind (pop_add_loop (S (length (stack s))) (Z.of_nat a) (Z.of_nat start) op step (stack s) [])
       (fun '(items,remaining) => Some (change s (pc s+width)%nat remaining items
         (repeat VNull (if alternate then a else l)) (heap s) (storage s) (effects s)))
     | _ => None end else None
 end.

Lemma replace_object_slice : forall index objects object,
 (index < length objects)%nat -> replace_object index object objects =
 Some (firstn index objects ++ object::skipn (S index) objects).
Proof. induction index; intros [|head rest] object H; simpl in *; try lia; [reflexivity|].
 rewrite IHindex by lia. reflexivity. Qed.
Lemma pop_add_loop_order : forall n fuel values acc,
 (n < fuel)%nat -> (n <= length values)%nat ->
 pop_add_loop fuel (Z.of_nat n) 0 CLt 1 values acc =
 Some (acc++firstn n values,skipn n values).
Proof.
 (* Stronger cursor form accounts for the source for-loop's increasing index. *)
 assert (Hcursor : forall n fuel values acc cursor,
  (n < fuel)%nat -> (n <= length values)%nat ->
  pop_add_loop fuel (Z.of_nat n+cursor) cursor CLt 1 values acc =
  Some (acc++firstn n values,skipn n values)).
 { induction n as [|n IH]; intros [|fuel] values acc cursor Hfuel Hlength; try lia.
   - cbn [pop_add_loop compare firstn skipn]. rewrite Z.add_0_l, Z.ltb_irrefl, app_nil_r. reflexivity.
   - destruct values as [|v rest]; [cbn in Hlength; lia|].
     cbn [pop_add_loop compare].
     assert (Hlt : (cursor <? Z.of_nat (S n)+cursor)=true) by (apply Z.ltb_lt; lia).
     rewrite Hlt. replace (Z.of_nat (S n)+cursor) with (Z.of_nat n+(cursor+1)) by lia.
     rewrite IH by (cbn in Hlength; lia). cbn [firstn skipn].
     rewrite <- app_assoc. reflexivity. }
 intros. replace (Z.of_nat n) with (Z.of_nat n+0) by lia. apply Hcursor; assumption.
Qed.
Lemma object_update_preserves_identity : forall objects reference object index value,
 nth_error objects reference = Some object -> (index < length (fields object))%nat ->
 store_object objects reference index value =
 Some (firstn reference objects ++ obj (object_kind object)
   (firstn index (fields object)++value::skipn (S index) (fields object)) :: skipn (S reference) objects).
Proof. intros objects reference object index value Hobj Hindex.
 unfold store_object. rewrite Hobj, update_at_as_indexed_assignment by assumption.
 cbn [bind]. apply replace_object_slice. apply nth_error_Some. rewrite Hobj. discriminate. Qed.
Lemma existing_alias_observes_write : forall objects reference object index value changed,
 nth_error objects reference = Some object -> (index < length (fields object))%nat ->
 store_object objects reference index value = Some changed ->
 object_get changed reference index = Some value.
Proof. intros objects reference object index value changed Hobject Hindex Hwrite.
 rewrite object_update_preserves_identity with (object:=object) in Hwrite by assumption.
 injection Hwrite as Hchanged. subst changed. unfold object_get.
 assert (Hr : (reference < length objects)%nat) by (apply nth_error_Some;rewrite Hobject;discriminate).
 rewrite nth_error_app2 by (rewrite firstn_length, Nat.min_l by lia;lia).
 rewrite firstn_length, Nat.min_l by lia. rewrite Nat.sub_diag. cbn [nth_error fields].
 rewrite nth_error_app2 by (rewrite firstn_length, Nat.min_l by lia;lia).
 rewrite firstn_length, Nat.min_l by lia. rewrite Nat.sub_diag. reflexivity.
Qed.
Print Assumptions replace_object_slice.
Print Assumptions pop_add_loop_order.
Print Assumptions object_update_preserves_identity.
Print Assumptions existing_alias_observes_write.

Definition array_bounds := bounds CLt 0 CGe.
Definition pack_bounds := bounds CLt 0 CGt.
Lemma canonical_array_bounds_pass : forall index count,
 (index < count)%nat -> fails_bounds array_bounds (Z.of_nat index) count = false.
Proof. intros. unfold fails_bounds, array_bounds, compare. cbn [lower_op lower_value upper_op].
 assert (Hn : (Z.of_nat index <? 0)=false) by (apply Z.ltb_ge;lia).
 assert (Hu : (Z.of_nat count <=? Z.of_nat index)=false) by (apply Z.leb_gt;lia).
 rewrite Hn, Hu. reflexivity. Qed.
Lemma canonical_pack_bounds_pass : forall index count,
 (index <= count)%nat -> fails_bounds pack_bounds (Z.of_nat index) count = false.
Proof. intros. unfold fails_bounds, pack_bounds, compare. cbn [lower_op lower_value upper_op].
 assert (Hn : (Z.of_nat index <? 0)=false) by (apply Z.ltb_ge;lia).
 assert (Hu : (Z.of_nat count <? Z.of_nat index)=false) by (apply Z.ltb_ge;lia).
 rewrite Hn, Hu. reflexivity. Qed.
Lemma natural_int32 : forall n, Z.of_nat n < 2^31 -> int32 (Z.of_nat n) = Some (Z.of_nat n).
Proof. intros. unfold int32.
 assert (Hlow : (-2^31 <=? Z.of_nat n)=true) by (apply Z.leb_le;lia).
 assert (Hhigh : (Z.of_nat n <? 2^31)=true) by (apply Z.ltb_lt;lia).
 rewrite Hlow,Hhigh. reflexivity. Qed.
Lemma natural_int32_is_integer : forall n,
 Z.of_nat n < 2^31 -> integer_fits (Z.of_nat n).
Proof. intros. unfold integer_fits,integer_limit. lia. Qed.
Theorem array_get_refines : forall p ar lo hp store ev static reference object index value rest,
 nth_error hp reference = Some object -> nth_error (fields object) index = Some value ->
 Z.of_nat (length (fields object)) <= 2^31 ->
 source_collection (ArrayGet array_bounds 0) 1
 (state p (VInt (Z.of_nat index)::VRef reference::rest) ar lo hp store ev static) [] false false =
 instruction_observation (vm_step PickItem 1
 (state p (VInt (Z.of_nat index)::VRef reference::rest) ar lo hp store ev static)).
Proof. intros p ar lo hp store ev static reference object index value rest Ho Hv Hsize.
 assert (Hi : (index < length (fields object))%nat) by (apply nth_error_Some;rewrite Hv;discriminate).
 assert (Hz : Z.of_nat index < 2^31) by lia.
 assert (Hfit := natural_int32_is_integer index Hz).
 assert (Hpos : (0 <=? Z.of_nat index)=true) by (apply Z.leb_le;lia).
 unfold source_collection. cbn [stack numeric_projection get_integer]. rewrite (checked_integer_in_range _ Hfit).
 cbn [bind heap]. rewrite Ho, canonical_array_bounds_pass by assumption.
 rewrite Z.add_0_r, natural_int32 by assumption. cbn [bind]. rewrite Hpos.
 unfold object_get. cbn [heap]. rewrite Nat2Z.id,Ho,Hv. cbn [bind].
 unfold instruction_observation,vm_step. cbn [stack]. rewrite Hpos.
 unfold read_field. cbn [heap]. rewrite Nat2Z.id,Ho,Hv.
 reflexivity. Qed.
Theorem array_put_refines : forall p ar lo hp store ev static reference object index value rest,
 nth_error hp reference = Some object -> (index < length (fields object))%nat ->
 Z.of_nat (length (fields object)) <= 2^31 -> scalar value = true ->
 source_collection (ArrayPut array_bounds 0 false) 1
 (state p (value::VInt (Z.of_nat index)::VRef reference::rest) ar lo hp store ev static) [] false false =
 instruction_observation (vm_step SetItem 1
 (state p (value::VInt (Z.of_nat index)::VRef reference::rest) ar lo hp store ev static)).
Proof. intros p ar lo hp store ev static reference object index value rest Ho Hi Hsize Hscalar.
 assert (Hz : Z.of_nat index < 2^31) by lia.
 assert (Hfit := natural_int32_is_integer index Hz).
 assert (Hpos : (0 <=? Z.of_nat index)=true) by (apply Z.leb_le;lia).
 assert (Hindex : (index <? length (fields object))%nat=true) by (apply Nat.ltb_lt;lia).
 unfold source_collection. cbn [stack numeric_projection get_integer]. rewrite Hscalar, (checked_integer_in_range _ Hfit).
 cbn [bind heap]. rewrite Ho, canonical_array_bounds_pass by assumption.
 rewrite Z.add_0_r,natural_int32 by assumption. cbn [bind]. rewrite Hpos,Nat2Z.id.
 rewrite object_update_preserves_identity with (object:=object) by assumption.
 cbn [bind continue_source].
 unfold instruction_observation,vm_step. cbn [stack]. rewrite Hpos.
 unfold write_field. cbn [heap]. rewrite Nat2Z.id,Ho,Hindex,Hscalar.
 reflexivity. Qed.
Theorem counted_pack_refines : forall p ar lo hp store ev static count values,
 (count <= length values)%nat -> Z.of_nat count < 2^31 ->
 source_collection (CountedPack pack_bounds ArrayKind 0 CLt 1) 1
 (state p (VInt (Z.of_nat count)::values) ar lo hp store ev static) [] false false =
 instruction_observation (vm_step Pack 1 (state p (VInt (Z.of_nat count)::values) ar lo hp store ev static)).
Proof. intros p ar lo hp store ev static count values Hlength H32.
 assert (Hfit := natural_int32_is_integer count H32).
 assert (Hpos : (0 <=? Z.of_nat count)=true) by (apply Z.leb_le;lia).
 assert (Hcount : (count <=? length values)%nat=true) by (apply Nat.leb_le;lia).
 unfold source_collection. cbn [stack numeric_projection get_integer]. rewrite (checked_integer_in_range _ Hfit).
 cbn [bind]. rewrite natural_int32 by assumption. cbn [bind].
 rewrite canonical_pack_bounds_pass by assumption.
 rewrite pop_add_loop_order by lia. cbn [bind app].
 unfold instruction_observation,vm_step. cbn [stack]. rewrite Hpos,Nat2Z.id,Hcount.
 reflexivity. Qed.
Theorem entry_slot_refines : forall p hp store ev static l a values,
 (a <= length values)%nat -> (0 < l+256*a)%nat ->
 source_collection (EntryInitSlots 0 false 0 CLt 1) 3
 (state p values [] [] hp store ev static) [l;a] false true =
 instruction_observation (vm_step (InitSlot l a) 3 (state p values [] [] hp store ev static)).
Proof. intros p hp store ev static l a values Hlength Hnonzero.
 assert (Hne : Nat.eqb (l+256*a) 0 = false) by (apply Nat.eqb_neq;lia).
 assert (Hlengthb : (a <=? length values)%nat=true) by (apply Nat.leb_le;lia).
 unfold source_collection. cbn [locals arguments Nat.eqb andb stack]. rewrite Hne.
 rewrite pop_add_loop_order by lia. cbn [bind app].
 unfold instruction_observation,vm_step. cbn [stack locals arguments Nat.eqb andb]. rewrite Hlengthb. reflexivity. Qed.
Theorem initialized_empty_slots_reject : forall s l a,
 source_collection (EntryInitSlots 0 false 0 CLt 1) 3 s [l;a] false false = None.
Proof. intros. cbn [source_collection andb]. reflexivity. Qed.
Theorem zero_zero_operand_rejects : forall s,
 source_collection (EntryInitSlots 0 false 0 CLt 1) 3 s [0%nat;0%nat] false true = None.
Proof. intros. unfold source_collection.
 destruct (Nat.eqb (length (locals s)) 0); destruct (Nat.eqb (length (arguments s)) 0); reflexivity. Qed.
Print Assumptions array_get_refines.
Print Assumptions array_put_refines.
Print Assumptions counted_pack_refines.
Print Assumptions entry_slot_refines.
Print Assumptions initialized_empty_slots_reject.
Print Assumptions zero_zero_operand_rejects.

(* RET boundary projection retains the shared caller stack and jump flag only.
   It deliberately carries no caller continuation or ContextUnloaded semantics. *)
Definition shared_return_boundary (copy_when_equal jumping : bool) (values : list Value) shared remaining :=
 if shared && negb copy_when_equal && (0 <? remaining)%nat then Some (values,jumping) else None.
Theorem shared_return_preserves_all_values : forall values remaining,
 (0 < remaining)%nat -> shared_return_boundary false true values true remaining = Some (values,true).
Proof. intros. unfold shared_return_boundary. cbn [andb negb].
 assert (Hb : (0 <? remaining)%nat=true) by (apply Nat.ltb_lt;assumption). rewrite Hb. reflexivity. Qed.
Theorem unsupported_return_context_rejects : forall copied jumping values remaining,
 shared_return_boundary copied jumping values false remaining = None.
Proof. reflexivity. Qed.
Print Assumptions shared_return_preserves_all_values.
Print Assumptions unsupported_return_context_rejects.

(* Adjacent codec views, not new cases silently added to vm_step. *)
Fixpoint count_fields (values : list Value) : Z :=
 match values with [] => 0 | _::rest => 1+count_fields rest end.
Fixpoint copy_bytes (bytes : list nat) : list nat :=
 match bytes with [] => [] | byte::rest => byte::copy_bytes rest end.
Definition source_array_size objects reference :=
 match nth_error objects reference with
 | Some object => option_map VInt (checked_integer (count_fields (fields object)))
 | None => None end.
Definition reference_array_size objects reference :=
 match nth_error objects reference with
 | Some object => Some (VInt (Z.of_nat (length (fields object)))) | None => None end.
Definition valid_type_target target := negb (Nat.eqb target 0) && existsb (Nat.eqb target) [0%nat;16%nat;32%nat;33%nat;40%nat;48%nat;64%nat;65%nat;72%nat;96%nat].
Definition source_array_tag op objects reference target :=
 if valid_type_target target then
 match nth_error objects reference with
 | Some object => Some (VBool (compare op (match object_kind object with ArrayKind=>64 | StructKind=>65 end) (Z.of_nat target)))
 | None => None end else None.
Definition reference_array_tag objects reference target :=
 if valid_type_target target then
 match nth_error objects reference with
 | Some object => Some (VBool (Z.eqb (match object_kind object with ArrayKind=>64 | StructKind=>65 end) (Z.of_nat target)))
 | None => None end else None.
Definition source_buffer_view drop value :=
 match value with
 | VBytes bytes => if (drop <=? length bytes)%nat then Some (VBuffer (copy_bytes (skipn drop bytes))) else None
 | VBuffer bytes => Some (VBuffer bytes)
 | _ => None end.
Definition reference_buffer_view value :=
 match value with VBytes bytes | VBuffer bytes => Some (VBuffer bytes) | _ => None end.
Lemma source_field_count : forall fields, count_fields fields = Z.of_nat (length fields).
Proof. induction fields; cbn [count_fields length]; [reflexivity|]. rewrite IHfields,Nat2Z.inj_succ. lia. Qed.
Lemma source_byte_copy_preserves_contents : forall bytes, copy_bytes bytes = bytes.
Proof. induction bytes; cbn [copy_bytes]; [reflexivity|]. rewrite IHbytes. reflexivity. Qed.
Theorem source_size_refines_view : forall objects reference object,
 nth_error objects reference = Some object -> Z.of_nat (length (fields object)) < 2^31 ->
 source_array_size objects reference = reference_array_size objects reference.
Proof. intros. unfold source_array_size,reference_array_size. rewrite H,source_field_count.
 rewrite checked_integer_in_range by (apply natural_int32_is_integer;assumption). reflexivity. Qed.
Theorem source_type_refines_view : forall objects reference target,
 source_array_tag CEq objects reference target = reference_array_tag objects reference target.
Proof. reflexivity. Qed.
Theorem source_buffer_refines_view : forall value,
 source_buffer_view 0 value = reference_buffer_view value.
Proof. destruct value; cbn [source_buffer_view reference_buffer_view skipn Nat.leb]; try reflexivity.
 rewrite source_byte_copy_preserves_contents. reflexivity. Qed.
Print Assumptions source_field_count.
Print Assumptions source_byte_copy_preserves_contents.
Print Assumptions source_size_refines_view.
Print Assumptions source_type_refines_view.
Print Assumptions source_buffer_refines_view.
