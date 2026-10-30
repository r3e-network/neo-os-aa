From Coq Require Import ZArith List Bool String Lia.
Require Import CapMethodVm NumericCoercions LedgerCodec.
Import ListNotations.
Open Scope string_scope.
Open Scope Z_scope.

(* A source-control interpreter for the two core methods' admitted ledger domain.
   VM value accessors, collections and small-varint stream primitives are explicit
   contracts. Unsupported branches fail; they are not erased from the source AST. *)
Inductive CX :=
| XNum (z:Z) | XBool (b:bool) | XNull | XText (s:string)
| XName (s:string) | XMember (e:CX) (s:string) | XCall (e:CX) (args:list CX)
| XNew (kind:string) (args:list CX) | XIndex (e i:CX) | XCast (kind:string) (e:CX)
| XUnary (op:string) (e:CX) | XPost (op:string) (e:CX)
| XBinary (op:string) (left right:CX) | XIs (e:CX) (kind name:string)
| XBox (e:CX) | XString (e:CX) | XJoin (parts:list CX).
Inductive CLabel := LPattern (kind name:string) | LEnum (kind name:string) | LDefault.
Inductive CS :=
| SBlock (body:list CS) | SDeclare (kind name:string) (e:CX) | SExpression (e:CX)
| SConditional (e:CX) (yes no:CS) | SWhile (e:CX) (body:CS)
| SFor (before:CS) (condition increment:CX) (body:CS)
| SForeach (kind name:string) (collection:CX) (body:CS)
| SSwitch (e:CX) (arms:list (list CLabel * CS))
| SBreak | SReturn (e:CX) | SThrow (e:CX).
Inductive CV :=
| CNum (z:Z) | CBool (b:bool) | CRef (index:nat) | CBytes (bytes:list nat)
| CNull | CType (name:string) | CMethod (receiver:CV) (name:string) | CComparer.
Inductive Cell :=
| CStack (items:list CV) | CSet (refs:list nat) | CWriter (bytes:list nat)
| CArray (is_struct:bool) (items:list CV) | CScalar (tag:nat) (bytes:list nat)
| CReader (remaining:list nat) | CInteger (value:Z) | CPlaceholder (kind count:Z).
Record CState := cstate { clocals:list (string * CV); cheap:list Cell }.
Fixpoint lookup_local (name:string) (ls:list (string * CV)) : option CV :=
 match ls with [] => None | (key,v)::tail => if String.eqb key name then Some v else lookup_local name tail end.
Definition put_local name value st := cstate ((name,value)::clocals st) (cheap st).
Fixpoint replace_cell (index:nat) (cell:Cell) (h:list Cell) :=
 match index,h with O,_::tail => cell::tail | S n,head::tail => head::replace_cell n cell tail | _,_ => h end.
Definition put_cell index cell st := cstate (clocals st) (replace_cell index cell (cheap st)).
Definition allocate cell st := (CRef (List.length (cheap st)),cstate (clocals st) (List.app (cheap st) [cell])).
Definition cell_at st index := nth_error (cheap st) index.
Definition ctag (cell:Cell) : option Z :=
 match cell with CArray k _ => Some (if k then 65 else 64) | CScalar tag _ => Some (Z.of_nat tag) | CInteger _ => Some 33 | CPlaceholder kind _ => Some kind | _ => None end.
Definition access_member receiver name st : option CV :=
 match receiver with
 | CBytes bytes => if String.eqb name "Span" then Some (CBytes bytes) else None
 | CType "Integer" => if String.eqb name "MaxSize" then Some (CNum 32) else None
 | CType "StackItemType" => option_map CNum (match name with "Any" => Some 0 | "Boolean" => Some 32 | "Integer" => Some 33 | "ByteString" => Some 40 | "Buffer" => Some 48 | "Array" => Some 64 | "Struct" => Some 65 | "Map" => Some 72 | _ => None end)
 | CType "ReferenceEqualityComparer" => if String.eqb name "Instance" then Some CComparer else None
 | CRef index => match cell_at st index with
   | None => None
   | Some cell => match name with
     | "Type" => option_map CNum (ctag cell)
     | "ElementCount" => match cell with CPlaceholder _ count => Some (CNum count) | _ => None end
     | "Count" => match cell with CArray _ items | CStack items => Some (CNum (Z.of_nat (List.length items))) | _ => None end
     | "BaseStream" => match cell with CWriter _ => Some receiver | _ => None end
     | "Position" => match cell with CWriter bytes => Some (CNum (Z.of_nat (List.length bytes))) | _ => None end
     | _ => Some (CMethod receiver name)
     end end
 | _ => None end.
Definition is_kind value kind st : bool :=
 match value with CRef index =>
 match cell_at st index with
 | Some (CArray k _) => String.eqb kind "Array" || (k && String.eqb kind "Struct")
 | Some (CPlaceholder _ _) => String.eqb kind "ContainerPlaceholder"
 | Some (CInteger _) => String.eqb kind "Integer"
 | Some (CScalar tag _) =>
    ((tag =? 33)%nat && String.eqb kind "Integer") ||
    ((tag =? 40)%nat && String.eqb kind "ByteString") ||
    ((tag =? 48)%nat && String.eqb kind "Buffer")
 | _ => false end | _ => false end.
Definition writer_append index bytes st :=
 match cell_at st index with Some (CWriter previous) => Some (CNull,put_cell index (CWriter (List.app previous bytes)) st) | _ => None end.
Definition invoke target args st : option (CV * CState) :=
 match target with CMethod (CRef index) name =>
 match cell_at st index,name,args with
 | Some (CStack items),"Push",[item] => Some (CNull,put_cell index (CStack (item::items)) st)
 | Some (CStack (item::rest)),"Pop",[] => Some (item,put_cell index (CStack rest) st)
 | Some (CStack (item::_)),"Peek",[] => Some (item,st)
 | Some (CSet refs),"Add",[CRef item] =>
   Some (CBool (negb (existsb (Nat.eqb item) refs)),put_cell index (CSet (item::refs)) st)
 | Some (CReader (byte::tail)),"ReadByte",[] => Some (CNum (Z.of_nat byte),put_cell index (CReader tail) st)
 | Some (CReader bytes),"ReadVarInt",[CNum maximum] =>
   match read_varint bytes with Some (value,tail) =>
     if Z.of_nat value <=? maximum then Some (CNum (Z.of_nat value),put_cell index (CReader tail) st) else None
     | None => None end
 | Some (CReader bytes),"ReadVarMemory",[CNum maximum] =>
   match read_varint bytes with Some (size,after_length) =>
     if Z.of_nat size <=? maximum then
       match take_exact size after_length with Some (payload,tail) => Some (CBytes payload,put_cell index (CReader tail) st) | None => None end
     else None | None => None end
 | Some (CArray k items),"Add",[item] => Some (CNull,put_cell index (CArray k (List.app items [item])) st)
 | Some (CInteger value),"GetSpan",[] => Some (CBytes (encode_integer value),st)
 | Some (CScalar _ bytes),"GetSpan",[] => Some (CBytes bytes,st)
 | Some (CWriter _),"Flush",[] => Some (CNull,st)
 | Some (CWriter _),"Write",[CNum z] =>
   if (0 <=? z) && (z <? 256) then writer_append index [Z.to_nat z] st else None
 | Some (CWriter _),"WriteVarInt",[CNum z] =>
   if (0 <=? z) && (z <? 253) then writer_append index [Z.to_nat z] st else None
 | Some (CWriter _),"WriteVarBytes",[CBytes bytes] =>
   if (List.length bytes <? 253)%nat then writer_append index (List.length bytes::bytes) st else None
 | _,_,_ => None end | _ => None end.
Definition construct kind args st : option (CV * CState) :=
 match kind,args with
 | "Stack<StackItem>",[] => Some (allocate (CStack []) st)
 | "HashSet<CompoundType>",[CComparer] => Some (allocate (CSet []) st)
 | "Array",[] => Some (allocate (CArray false []) st)
 | "Struct",[] => Some (allocate (CArray true []) st)
 | "Buffer",[CBytes bytes] => Some (allocate (CScalar 48 bytes) st)
 | "BigInteger",[CBytes bytes] => Some (CNum (signed_le bytes),st)
 | "ContainerPlaceholder",[CNum kind;CNum count] => Some (allocate (CPlaceholder kind count) st)
 | _,_ => None end.
Definition cbool value := match value with CBool b => Some b | _ => None end.
Definition binary_value op lhs rhs : option CV :=
 match lhs,rhs with CNum x,CNum y =>
 match op with "+" => Some (CNum (x+y)) | "-" => Some (CNum (x-y)) | "*" => Some (CNum (x*y))
 | ">" => Some (CBool (y <? x)) | "<" => Some (CBool (x <? y))
 | ">=" => Some (CBool (y <=? x)) | "<=" => Some (CBool (x <=? y))
 | "==" => Some (CBool (x =? y)) | "!=" => Some (CBool (negb (x =? y))) | _ => None end
 | _,_ => None end.
Fixpoint eval_list (evaluate:CX -> CState -> option (CV * CState)) xs st : option (list CV * CState) :=
 match xs with [] => Some ([],st) | x::tail =>
 match evaluate x st with Some (v,next) =>
 match eval_list evaluate tail next with Some (vs,final) => Some (v::vs,final) | None => None end | None => None end end.
Fixpoint eval_source (fuel:nat) e st : option (CV * CState) :=
 match fuel with O => None | S fuel' =>
 let ev := eval_source fuel' in
 match e with
 | XNum z => Some (CNum z,st) | XBool b => Some (CBool b,st) | XNull => Some (CNull,st)
 | XName name => Some (match lookup_local name (clocals st) with Some v => v | None => CType name end,st)
 | XMember object_expr name => match ev object_expr st with Some (v,next) => option_map (fun member => (member,next)) (access_member v name next) | None => None end
 | XCall target args => match ev target st with Some (v,next) => match eval_list ev args next with Some (vs,final) => invoke v vs final | None => None end | None => None end
 | XNew kind args => match eval_list ev args st with Some (vs,next) => construct kind vs next | None => None end
 | XIndex object_expr idx => match ev object_expr st with Some (CRef index,next) => match ev idx next with Some (CNum i,final) =>
     if 0 <=? i then match cell_at final index with Some (CArray _ items) => option_map (fun v => (v,final)) (nth_error items (Z.to_nat i)) | _ => None end else None
     | _ => None end | _ => None end
 | XCast kind value => match ev value st with Some (CNum z,next) =>
     Some (CNum (if String.eqb kind "byte" then Z.modulo z 256 else if String.eqb kind "uint" then Z.modulo z (2^32) else if String.eqb kind "int" then Z.modulo (z+2^31) (2^32)-2^31 else z),next)
     | result => result end
 | XBox value => match ev value st with Some (v,next) =>
     match v with CNum z => Some (allocate (CInteger z) next) | CBytes bytes => Some (allocate (CScalar 40 bytes) next) | CRef _ => Some (v,next) | _ => None end
     | None => None end
 | XUnary "!" value => match ev value st with Some (CBool b,next) => Some (CBool (negb b),next) | _ => None end
 | XUnary op (XName name) | XPost op (XName name) =>
     match lookup_local name (clocals st) with Some (CNum z) =>
       let changed := if String.eqb op "++" then z+1 else z-1 in
       Some (CNum (match e with XPost _ _ => z | _ => changed end),put_local name (CNum changed) st)
     | _ => None end
 | XBinary "+=" (XName name) rhs => match lookup_local name (clocals st),ev rhs st with Some (CNum lhs),Some (CNum rhs,next) => Some (CNum (lhs+rhs),put_local name (CNum (lhs+rhs)) next) | _,_ => None end
 | XBinary "=" (XName name) rhs => match ev rhs st with Some (value,next) => Some (value,put_local name value next) | None => None end
 | XBinary op lhs rhs => match ev lhs st with Some (leftv,next) => match ev rhs next with Some (rightv,final) => option_map (fun result => (result,final)) (binary_value op leftv rightv) | None => None end | None => None end
 | XIs value kind name => match ev value st with Some (v,next) => let matched := is_kind v kind next in Some (CBool matched,if matched then put_local name v next else next) | None => None end
 | _ => None end end.
Inductive Flow := CNormal | CBreak | CReturn (value:CV).
Fixpoint run_list (run:CS -> CState -> option (Flow * CState)) body st : option (Flow * CState) :=
 match body with [] => Some (CNormal,st) | head::tail =>
 match run head st with Some (CNormal,next) => run_list run tail next | result => result end end.
Fixpoint choose_label value labels st : option CState :=
 match labels with [] => None | label::tail =>
 match label with
 | LDefault => Some st
 | LPattern kind name => if is_kind value kind st then Some (put_local name value st) else choose_label value tail st
 | LEnum kind name => match access_member (CType kind) name st,value with Some (CNum expected),CNum actual => if actual =? expected then Some st else choose_label value tail st | _,_ => None end end end.
Fixpoint choose_case value arms st : option (CS * CState) :=
 match arms with [] => None | (labels,body)::tail =>
 match choose_label value labels st with Some next => Some (body,next) | None => choose_case value tail st end end.
Fixpoint run_source (fuel:nat) statement st : option (Flow * CState) :=
 match fuel with O => None | S fuel' =>
 let run := run_source fuel' in let ev := eval_source fuel' in
 match statement with
 | SBlock body => run_list run body st
 | SDeclare _ name e => match ev e st with Some (v,next) => Some (CNormal,put_local name v next) | None => None end
 | SExpression e => match ev e st with Some (_,next) => Some (CNormal,next) | None => None end
 | SConditional e yes no => match ev e st with Some (CBool b,next) => run (if b then yes else no) next | _ => None end
 | SWhile e body => match ev e st with Some (CBool b,next) =>
     if b then match run body next with Some (CNormal,after) => run statement after | Some (CBreak,after) => Some (CNormal,after) | result => result end else Some (CNormal,next)
     | _ => None end
 | SFor before condition increment body =>
     match run before st with Some (CNormal,ready) =>
     match ev condition ready with Some (CBool b,next) =>
       if b then match run body next with Some (CNormal,after) =>
         match ev increment after with Some (_,stepped) => run (SFor (SBlock []) condition increment body) stepped | None => None end
         | Some (CBreak,after) => Some (CNormal,after) | result => result end else Some (CNormal,next)
       | _ => None end | result => result end
 | SSwitch e arms => match ev e st with Some (v,next) =>
     match choose_case v arms next with Some (body,selected) =>
       match run body selected with Some (CBreak,after) => Some (CNormal,after) | result => result end
       | None => Some (CNormal,next) end | None => None end
 | SBreak => Some (CBreak,st)
 | SReturn e => match ev e st with Some (v,next) => Some (CReturn v,next) | None => None end
 | _ => None end end.
Definition serializer_state (is_struct is_buffer:bool) (hash payload:list nat) :=
 cstate [("writer",CRef 0);("item",CRef 1);("maxSize",CNum 131070);("maxItems",CNum 2048)]
 [CWriter [];CArray is_struct [CRef 2;CRef 3];CScalar (if is_buffer then 48 else 40)%nat hash;CScalar 33 payload].
Definition serialize_source_bytes program is_struct is_buffer hash payload :=
 match run_source 160 program (serializer_state is_struct is_buffer hash payload) with
 | Some (CNormal,final) => match cell_at final 0 with Some (CWriter bytes) => Some bytes | _ => None end
 | _ => None end.

Definition deserializer_state bytes :=
 cstate [("reader",CRef 0);("maxSize",CNum 131070);("maxItems",CNum 2048)] [CReader bytes].
Definition source_ledger_at st value : option Ledger :=
 match value with CRef index => match cell_at st index with
 | Some (CArray kind [CRef hash_ref;CRef value_ref]) =>
   match cell_at st hash_ref,cell_at st value_ref with
   | Some (CScalar tag hash),Some (CInteger z) =>
      if ((tag =? 40)%nat || (tag =? 48)%nat) then Some (ledger (if kind then StructKind else ArrayKind) (tag =? 48)%nat hash z) else None
   | _,_ => None end
 | _ => None end | _ => None end.
Definition deserialize_source_ledger program bytes :=
 match run_source 200 program (deserializer_state bytes) with
 | Some (CReturn value,final) => match source_ledger_at final value,cell_at final 0 with
   | Some l,Some (CReader remaining) => Some (l,remaining)
   | _,_ => None end
 | _ => None end.
