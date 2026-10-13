using System;
using System.Linq;
using System.Reflection;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Neo;
using Neo.Cryptography.ECC;
using Neo.Extensions;
using Neo.IO;
using Neo.Network.P2P.Payloads;
using Neo.Network.P2P.Payloads.Conditions;
using Neo.SmartContract;
using Neo.SmartContract.Testing;
using Neo.VM;

namespace AbstractAccount.Contracts.Tests;

[TestClass]
public class WitnessConditionRuntimeTests
{
    private const int MaxWitnessConditionDepth = 3;
    private static readonly UInt160 CurrentHash = UInt160.Parse("0x0000000000000000000000000000000000000001");
    private static readonly UInt160 CallerHash = UInt160.Parse("0x0000000000000000000000000000000000000002");
    private static readonly UInt160 WitnessHash = UInt160.Parse("0x0000000000000000000000000000000000000003");
    private static readonly ECPoint Group = ECCurve.Secp256r1.G;
    private static readonly MethodInfo CheckWitness = typeof(ApplicationEngine).GetMethod(
        "CheckWitness", BindingFlags.Instance | BindingFlags.NonPublic)!;

    private static WitnessCondition Condition(string name) => name switch
    {
        "true" => new BooleanCondition { Expression = true },
        "false" => new BooleanCondition { Expression = false },
        "current" => new ScriptHashCondition { Hash = CurrentHash },
        "foreign" => new ScriptHashCondition { Hash = WitnessHash },
        "caller" => new CalledByContractCondition { Hash = CallerHash },
        "entry" => new CalledByEntryCondition(),
        "group" => new GroupCondition { Group = Group },
        "callerGroup" => new CalledByGroupCondition { Group = Group },
        "notGroup" => new NotCondition { Expression = Condition("group") },
        "falseAndGroup" => new AndCondition { Expressions = [Condition("false"), Condition("group")] },
        "groupAndFalse" => new AndCondition { Expressions = [Condition("group"), Condition("false")] },
        "trueOrGroup" => new OrCondition { Expressions = [Condition("true"), Condition("group")] },
        "groupOrTrue" => new OrCondition { Expressions = [Condition("group"), Condition("true")] },
        _ => throw new ArgumentOutOfRangeException(nameof(name)),
    };

    private static (bool Value, Exception? Fault) Evaluate(
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

    private static (bool Value, Exception? Fault) EvaluateWitness(Signer signer, bool readStates, int depth)
    {
        var test = new TestEngine();
        test.SetTransactionSigners(signer);
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
                value = (bool)CheckWitness.Invoke(app, [signer.Account.ToArray()])!;
            }
            catch (TargetInvocationException error)
            {
                fault = error.InnerException ?? error;
            }
        });
        return (value, fault);
    }

    [TestMethod]
    [DataRow("true", false, 0, "true")]
    [DataRow("false", false, 0, "false")]
    [DataRow("current", false, 2, "true")]
    [DataRow("foreign", true, 1, "false")]
    [DataRow("caller", false, 0, "false")]
    [DataRow("caller", false, 1, "true")]
    [DataRow("entry", false, 0, "true")]
    [DataRow("entry", false, 1, "true")]
    [DataRow("entry", false, 2, "false")]
    [DataRow("group", false, 0, "fault")]
    [DataRow("group", true, 0, "false")]
    [DataRow("callerGroup", false, 0, "fault")]
    [DataRow("callerGroup", true, 0, "false")]
    [DataRow("callerGroup", false, 1, "fault")]
    [DataRow("callerGroup", true, 1, "false")]
    [DataRow("notGroup", false, 1, "fault")]
    [DataRow("notGroup", true, 1, "true")]
    [DataRow("falseAndGroup", false, 1, "false")]
    [DataRow("groupAndFalse", false, 1, "fault")]
    [DataRow("trueOrGroup", false, 1, "true")]
    [DataRow("groupOrTrue", false, 1, "fault")]
    public void ConditionsPreservePermissionFaultsAndShortCircuit(string name, bool readStates, int depth, string expected)
    {
        var result = Evaluate(Condition(name), readStates, depth);
        Assert.AreEqual(expected == "true", result.Value);
        if (expected == "fault")
            Assert.IsInstanceOfType<InvalidOperationException>(result.Fault);
        else
            Assert.IsNull(result.Fault);
    }

    [TestMethod]
    [DataRow("group", "true", "fault")]
    [DataRow("falseAndGroup", "true", "true")]
    [DataRow("trueOrGroup", "group", "false")]
    public void FirstMatchingRuleDoesNotSwallowFaults(string first, string second, string expected)
    {
        var signer = new Signer
        {
            Account = WitnessHash,
            Scopes = WitnessScope.WitnessRules,
            Rules =
            [
                new WitnessRule { Action = WitnessRuleAction.Deny, Condition = Condition(first) },
                new WitnessRule { Action = WitnessRuleAction.Allow, Condition = Condition(second) },
            ],
        };
        var result = EvaluateWitness(signer, false, 1);
        if (expected == "fault")
            Assert.IsInstanceOfType<InvalidOperationException>(result.Fault);
        else
            Assert.AreEqual(expected == "true", result.Value);
    }

    [TestMethod]
    [DataRow(WitnessScope.None, 1, false)]
    [DataRow(WitnessScope.WitnessRules, 1, false)]
    [DataRow(WitnessScope.CalledByEntry | WitnessScope.WitnessRules, 1, true)]
    [DataRow(WitnessScope.CalledByEntry | WitnessScope.WitnessRules, 2, false)]
    [DataRow(WitnessScope.CustomContracts | WitnessScope.WitnessRules, 2, true)]
    [DataRow(WitnessScope.Global, 2, true)]
    public void ScopeAllowsPrecedeExplicitDenyRules(WitnessScope scope, int depth, bool expected)
    {
        var signer = new Signer
        {
            Account = WitnessHash,
            Scopes = scope,
            AllowedContracts = [CurrentHash],
            Rules = [new WitnessRule { Action = WitnessRuleAction.Deny, Condition = Condition("true") }],
        };
        var result = EvaluateWitness(signer, false, depth);
        Assert.AreEqual(expected, result.Value);
        Assert.IsNull(result.Fault);
    }

    [TestMethod]
    public void BinaryAndJsonWitnessParsersEnforceNodeDepth()
    {
        WitnessCondition valid = new NotCondition
        {
            Expression = new NotCondition
            {
                Expression = new BooleanCondition { Expression = true },
            },
        };

        var reader = new MemoryReader(valid.ToArray());
        Assert.AreEqual(valid, WitnessCondition.DeserializeFrom(ref reader, MaxWitnessConditionDepth));
        Assert.AreEqual(valid, WitnessCondition.FromJson(valid.ToJson(), MaxWitnessConditionDepth));

        WitnessCondition tooDeep = new NotCondition
        {
            Expression = new NotCondition
            {
                Expression = new NotCondition
                {
                    Expression = new BooleanCondition { Expression = true },
                },
            },
        };

        reader = new MemoryReader(tooDeep.ToArray());
        var binaryRejected = false;
        try
        {
            WitnessCondition.DeserializeFrom(ref reader, MaxWitnessConditionDepth);
        }
        catch (FormatException)
        {
            binaryRejected = true;
        }

        Assert.IsTrue(binaryRejected, "The binary witness parser accepted a condition beyond its node-depth budget.");
        Assert.ThrowsExactly<FormatException>(() =>
            WitnessCondition.FromJson(tooDeep.ToJson(), MaxWitnessConditionDepth));
    }

    private static WitnessCondition ParseBinary(WitnessCondition condition)
    {
        var reader = new MemoryReader(condition.ToArray());
        return WitnessCondition.DeserializeFrom(ref reader, MaxWitnessConditionDepth);
    }

    [TestMethod]
    [DataRow(false, 0, false)]
    [DataRow(false, 1, true)]
    [DataRow(false, 16, true)]
    [DataRow(false, 17, false)]
    [DataRow(true, 0, false)]
    [DataRow(true, 1, true)]
    [DataRow(true, 16, true)]
    [DataRow(true, 17, false)]
    public void BinaryAndJsonParsersEnforceFormalFanOutBound(bool disjunction, int width, bool accepted)
    {
        WitnessCondition[] children = Enumerable.Range(0, width)
            .Select(_ => (WitnessCondition)new BooleanCondition { Expression = true }).ToArray();
        WitnessCondition condition = disjunction
            ? new OrCondition { Expressions = children }
            : new AndCondition { Expressions = children };

        if (!accepted)
        {
            Assert.ThrowsExactly<FormatException>(() => ParseBinary(condition));
            Assert.ThrowsExactly<FormatException>(() =>
                WitnessCondition.FromJson(condition.ToJson(), MaxWitnessConditionDepth));
            return;
        }

        foreach (WitnessCondition parsed in new[]
        {
            ParseBinary(condition),
            WitnessCondition.FromJson(condition.ToJson(), MaxWitnessConditionDepth),
        })
        {
            Assert.AreEqual(condition, parsed);
            var result = Evaluate(parsed, true, 1);
            Assert.IsNull(result.Fault);
            Assert.IsTrue(result.Value);
        }
    }

    [TestMethod]
    public void MaximumWidthDepthThreeTreeParsesAndEvaluatesWithoutShortCircuit()
    {
        // All sixteen disjunctions must visit all sixteen Boolean children.
        // This corresponds to full_width_nested_condition_refines, not a GAS bound.
        var condition = new AndCondition
        {
            Expressions = Enumerable.Range(0, 16).Select(_ => (WitnessCondition)new OrCondition
            {
                Expressions = Enumerable.Range(0, 16)
                    .Select(index => (WitnessCondition)new BooleanCondition { Expression = index == 15 }).ToArray(),
            }).ToArray(),
        };

        foreach (WitnessCondition parsed in new[]
        {
            ParseBinary(condition),
            WitnessCondition.FromJson(condition.ToJson(), MaxWitnessConditionDepth),
        })
        {
            Assert.AreEqual(condition, parsed);
            var result = Evaluate(parsed, true, 1);
            Assert.IsNull(result.Fault);
            Assert.IsTrue(result.Value);
        }

        // Parsing validates the last descendant even when evaluation would
        // short-circuit at the first true child of the first disjunction.
        ((OrCondition)condition.Expressions[0]).Expressions[0] = Condition("true");
        ((OrCondition)condition.Expressions[15]).Expressions[15] = new NotCondition
        {
            Expression = Condition("false"),
        };
        Assert.ThrowsExactly<FormatException>(() => ParseBinary(condition));
        Assert.ThrowsExactly<FormatException>(() =>
            WitnessCondition.FromJson(condition.ToJson(), MaxWitnessConditionDepth));
    }
}
