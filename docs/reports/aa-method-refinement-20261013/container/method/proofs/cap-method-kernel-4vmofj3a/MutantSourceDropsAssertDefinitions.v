From Coq Require Import ZArith List Bool Lia.
Require Import IntegerSemantics CapArithmetic CapMethodVm.
Import ListNotations.
Open Scope Z_scope.
Definition artifact : list nat := [87%nat;7%nat;1%nat;65%nat;45%nat;81%nat;8%nat;48%nat;16%nat;206%nat;112%nat;95%nat;34%nat;65%nat;155%nat;246%nat;103%nat;206%nat;65%nat;146%nat;93%nat;232%nat;49%nat;113%nat;105%nat;11%nat;151%nat;38%nat;41%nat;16%nat;12%nat;32%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;0%nat;18%nat;192%nat;34%nat;6%nat;105%nat;55%nat;4%nat;0%nat;114%nat;106%nat;16%nat;206%nat;104%nat;152%nat;38%nat;16%nat;104%nat;74%nat;106%nat;16%nat;81%nat;208%nat;69%nat;16%nat;74%nat;106%nat;17%nat;81%nat;208%nat;69%nat;65%nat;45%nat;81%nat;8%nat;48%nat;20%nat;206%nat;65%nat;45%nat;81%nat;8%nat;48%nat;21%nat;206%nat;158%nat;115%nat;17%nat;17%nat;107%nat;185%nat;159%nat;116%nat;16%nat;107%nat;106%nat;17%nat;206%nat;159%nat;186%nat;108%nat;120%nat;160%nat;158%nat;117%nat;109%nat;120%nat;185%nat;118%nat;110%nat;16%nat;183%nat;36%nat;42%nat;12%nat;37%nat;82%nat;101%nat;105%nat;109%nat;98%nat;117%nat;114%nat;115%nat;101%nat;109%nat;101%nat;110%nat;116%nat;32%nat;101%nat;120%nat;99%nat;101%nat;101%nat;100%nat;115%nat;32%nat;97%nat;99%nat;116%nat;117%nat;97%nat;108%nat;32%nat;103%nat;97%nat;115%nat;32%nat;99%nat;111%nat;115%nat;116%nat;224%nat;106%nat;74%nat;17%nat;206%nat;110%nat;158%nat;78%nat;17%nat;80%nat;208%nat;69%nat;106%nat;55%nat;3%nat;0%nat;95%nat;34%nat;65%nat;155%nat;246%nat;103%nat;206%nat;65%nat;230%nat;63%nat;24%nat;132%nat;110%nat;34%nat;2%nat;64%nat].
Definition source : list Stmt := [(SLet 0%nat (EField ETransaction 0%nat));
 (SLet 1%nat (EGet EContext EKey));
 (SIf (EEq (ELocal 1%nat) (EVal VNull)) [(SLet 2%nat (ENew ArrayKind [(EVal (VBytes [0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat; 0%nat])); (EVal (VInt (0)%Z))]))] [(SLet 2%nat (EDeserialize (ELocal 1%nat)))]);
 (SIf (ENeq (EField (ELocal 2%nat) 0%nat) (ELocal 0%nat)) [(SSetField (ELocal 2%nat) 0%nat (ELocal 0%nat));
 (SSetField (ELocal 2%nat) 1%nat (EVal (VInt (0)%Z)))] []);
 (SLet 3%nat (EBinary Add (EField ETransaction 4%nat) (EField ETransaction 5%nat)));
 (SLet 4%nat (EBinary Sub (EVal (VInt (1)%Z)) (EBinary Min (ELocal 3%nat) (EVal (VInt (1)%Z)))));
 (SLet 5%nat (EBinary Add (EBinary Max (EBinary Sub (ELocal 3%nat) (EField (ELocal 2%nat) 1%nat)) (EVal (VInt (0)%Z))) (EBinary Mul (ELocal 4%nat) (EArg 0%nat))));
 (SLet 6%nat (EBinary Min (EArg 0%nat) (ELocal 5%nat)));
 (SSetField (ELocal 2%nat) 1%nat (EBinary Add (EField (ELocal 2%nat) 1%nat) (ELocal 6%nat)));
 (SExpr (EPut EContext EKey (ESerialize (ELocal 2%nat))));
 (SReturn (ELocal 6%nat))].

