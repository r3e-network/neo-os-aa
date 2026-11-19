// Copyright (C) 2015-2026 The Neo Project.
//
// SmartAccount.Keys.cs file belongs to the neo project and is free
// software distributed under the MIT software license, see the
// accompanying file LICENSE in the main directory of the
// repository or http://www.opensource.org/licenses/mit-license.php
// for more details.
//
// Redistribution and use in source and binary forms with or without
// modifications are permitted.

// TRUE SOURCE: this is the only editable copy of this SmartAccount native
// contract file. The neo-native-core checkout carries a generated copy —
// regenerate it via scripts/sync_native_smartaccount.py.

#pragma warning disable IDE0051
using Neo.VM.Types;
using System;

namespace Neo.SmartContract.Native
{
    partial class SmartAccount
    {
        /// <summary>
        /// ABI validator for the `canonicalP256PublicKey` argument: the value
        /// must be an exact ByteString. The curve check itself lives in the
        /// method so a wrong encoding is a clean fault, never a silent accept.
        /// </summary>
        private sealed class P256PublicKeyAttribute : ValidatorAttribute
        {
            public override void Validate(StackItem item)
            {
                if (item is not ByteString)
                    throw new FormatException("A P-256 public key must be an exact ByteString.");
            }
        }
    }
}
