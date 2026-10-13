From Coq Require Import ZArith List Bool Lia.
Require Import IntegerSemantics CapArithmetic ArithmeticVm OrdinarySponsorship.
Import ListNotations.
Open Scope Z_scope.
Definition actual_bytes : list nat := [17%nat;17%nat;107%nat;185%nat;159%nat;116%nat;16%nat;107%nat;106%nat;17%nat;206%nat;159%nat;186%nat;108%nat;120%nat;160%nat;158%nat;117%nat;109%nat;120%nat;185%nat;118%nat].
Definition actual_source : Expression := (Apply Min (Read Requested) (Apply Add (Apply Max (Apply Add (Read Cost) (Read Reserved)) (Constant (0))) (Apply Mul (Apply Sub (Constant (1)) (Apply Min (Read Cost) (Constant (1)))) (Read Requested)))).
