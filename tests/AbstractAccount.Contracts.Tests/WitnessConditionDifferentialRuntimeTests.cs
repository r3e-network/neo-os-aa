using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Cryptography.ECC;
using Neo.Network.P2P.Payloads.Conditions;
using Neo.SmartContract;
using Neo.SmartContract.Testing;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

/// <summary>
/// Differentially exercises the concrete Neo witness-condition evaluator against
/// the finite fault-aware reference relation used by the formal model. This is
/// implementation correspondence evidence for the bounded corpus; it is not a
/// compiler or cryptographic soundness proof.
/// </summary>
[TestClass]
public class WitnessConditionDifferentialRuntimeTests
{
    private enum Kind
    {
        True,
        False,
        CurrentScript,
        ForeignScript,
        CalledByContract,
        CalledByEntry,
        Group,
        CalledByGroup,
        Not,
        And,
        Or,
    }

    private sealed record RefCondition(Kind Kind, params RefCondition[] Children);

    private readonly record struct RefContext(bool ReadStates, int CallDepth);

    private readonly record struct RefResult(bool Value, bool Fault);

    private static readonly UInt160 CurrentHash = UInt160.Parse("0x0000000000000000000000000000000000000001");
    private static readonly UInt160 CallerHash = UInt160.Parse("0x0000000000000000000000000000000000000002");
    private static readonly UInt160 ForeignHash = UInt160.Parse("0x0000000000000000000000000000000000000003");
    private static readonly ECPoint Group = ECCurve.Secp256r1.G;

    private static RefCondition Leaf(Kind kind) => new(kind);

    private static IReadOnlyList<RefCondition> Corpus()
    {
        RefCondition[] leaves =
        [
            Leaf(Kind.True), Leaf(Kind.False), Leaf(Kind.CurrentScript),
            Leaf(Kind.ForeignScript), Leaf(Kind.CalledByContract),
            Leaf(Kind.CalledByEntry), Leaf(Kind.Group), Leaf(Kind.CalledByGroup),
        ];

        var corpus = new List<RefCondition>(leaves);
        foreach (RefCondition leaf in leaves)
        {
            corpus.Add(new RefCondition(Kind.Not, leaf));
        }

        foreach (RefCondition left in leaves)
            foreach (RefCondition right in leaves)
            {
                corpus.Add(new RefCondition(Kind.And, left, right));
                corpus.Add(new RefCondition(Kind.Or, left, right));
            }

        RefCondition[] shallow = corpus.Skip(leaves.Length).ToArray();
        foreach (RefCondition child in shallow.Take(24))
        {
            corpus.Add(new RefCondition(Kind.Not, child));
        }

        // Include nested short-circuit and permission-fault shapes explicitly.
        corpus.Add(new RefCondition(Kind.And, Leaf(Kind.False), Leaf(Kind.Group)));
        corpus.Add(new RefCondition(Kind.And, Leaf(Kind.Group), Leaf(Kind.False)));
        corpus.Add(new RefCondition(Kind.Or, Leaf(Kind.True), Leaf(Kind.CalledByGroup)));
        corpus.Add(new RefCondition(Kind.Or, Leaf(Kind.CalledByGroup), Leaf(Kind.True)));
        return corpus;
    }

    private static RefResult EvaluateReference(RefCondition condition, RefContext context)
    {
        switch (condition.Kind)
        {
            case Kind.True:
                return new(true, false);
            case Kind.False:
                return new(false, false);
            case Kind.CurrentScript:
                return new(true, false);
            case Kind.ForeignScript:
                return new(false, false);
            case Kind.CalledByContract:
                return new(context.CallDepth > 0, false);
            case Kind.CalledByEntry:
                return new(context.CallDepth <= 1, false);
            case Kind.Group:
            case Kind.CalledByGroup:
                return context.ReadStates ? new(false, false) : new(false, true);
            case Kind.Not:
                {
                    RefResult child = EvaluateReference(condition.Children[0], context);
                    return child.Fault ? child : new(!child.Value, false);
                }
            case Kind.And:
                {
                    foreach (RefCondition child in condition.Children)
                    {
                        RefResult result = EvaluateReference(child, context);
                        if (result.Fault || !result.Value)
                            return result;
                    }
                    return new(true, false);
                }
            case Kind.Or:
                {
                    foreach (RefCondition child in condition.Children)
                    {
                        RefResult result = EvaluateReference(child, context);
                        if (result.Fault || result.Value)
                            return result;
                    }
                    return new(false, false);
                }
            default:
                throw new ArgumentOutOfRangeException();
        }
    }

    private static WitnessCondition ToNeoCondition(RefCondition condition) => condition.Kind switch
    {
        Kind.True => new BooleanCondition { Expression = true },
        Kind.False => new BooleanCondition { Expression = false },
        Kind.CurrentScript => new ScriptHashCondition { Hash = CurrentHash },
        Kind.ForeignScript => new ScriptHashCondition { Hash = ForeignHash },
        Kind.CalledByContract => new CalledByContractCondition { Hash = CallerHash },
        Kind.CalledByEntry => new CalledByEntryCondition(),
        Kind.Group => new GroupCondition { Group = Group },
        Kind.CalledByGroup => new CalledByGroupCondition { Group = Group },
        Kind.Not => new NotCondition { Expression = ToNeoCondition(condition.Children[0]) },
        Kind.And => new AndCondition { Expressions = condition.Children.Select(ToNeoCondition).ToArray() },
        Kind.Or => new OrCondition { Expressions = condition.Children.Select(ToNeoCondition).ToArray() },
        _ => throw new ArgumentOutOfRangeException(),
    };

    private static (bool Value, Exception? Fault) EvaluateNeo(
        WitnessCondition condition, bool readStates, int depth)
    {
        var test = new TestEngine();
        bool value = false;
        Exception? fault = null;
        test.Execute(new Script(new byte[] { (byte)OpCode.RET }), beforeExecute: app =>
        {
            var state = app.CurrentContext!.GetState<ExecutionContextState>();
            state.CallFlags = readStates ? CallFlags.ReadOnly : CallFlags.None;
            state.ScriptHash = depth == 0 ? CurrentHash : CallerHash;
            for (int level = 0; level < depth; level++)
            {
                var caller = app.CurrentContext;
                app.LoadScript(new Script(new byte[] { (byte)OpCode.RET }), configureState: child =>
                {
                    child.CallingContext = caller;
                    child.ScriptHash = level == depth - 1 ? CurrentHash : CallerHash;
                    child.CallFlags = readStates ? CallFlags.ReadOnly : CallFlags.None;
                });
            }

            try
            {
                value = condition.Match(app);
            }
            catch (Exception error)
            {
                fault = error;
            }
        });
        return (value, fault);
    }

    [TestMethod]
    public void FiniteWitnessCorpusMatchesFaultAwareReference()
    {
        int cases = 0;
        foreach (RefCondition condition in Corpus())
            foreach (bool readStates in new[] { false, true })
                for (int depth = 0; depth <= 2; depth++)
                {
                    RefResult expected = EvaluateReference(condition, new RefContext(readStates, depth));
                    (bool value, Exception? fault) = EvaluateNeo(ToNeoCondition(condition), readStates, depth);

                    Assert.AreEqual(expected.Fault, fault is not null,
                        $"Fault mismatch for {condition} readStates={readStates} depth={depth}");
                    if (!expected.Fault)
                    {
                        Assert.AreEqual(expected.Value, value,
                            $"Value mismatch for {condition} readStates={readStates} depth={depth}");
                    }

                    cases++;
                }

        Assert.AreEqual(1032, cases, "The differential corpus inventory changed unexpectedly.");
    }
}
