# 阈值钱包权限方

> 中文版本与 `docs/NATIVE_ACCOUNT_THRESHOLD_RECOVERY.md` 同构。若两者冲突，以英文版本为准。

标准 Neo P-256 的 m-of-n 钱包可以作为账户的守护者、托管或费用支付方。它是交易见证账户，不是 `MultiSigVerifier` 模块，也不是另一个原生账户代理。它不改变账户身份、恢复延迟或“托管 + 守护者解冻”的规则。公开激活仍是独立的协议决策。

守护者法定人数在首次配置时也必须同意：注册与守护者替换都包含其真实见证。拟定的新托管同样必须为其恢复提案提供见证。已成熟的激活只需要支付方；零值会在没有新守护者见证的情况下移除可选守护者。

当某个权限方相对于当前托管、恢复与待生效权限地址是首次引入时，会检查其同意。对已准入的待生效地址重新提案不需要新的接收方同意；但当前控制权限的检查仍然适用。

## 签名方约定

把标准钱包脚本哈希作为 `account`，并提供其确切的规范 `verificationScript`。单签名适配器继续返回 64 字节的 P1363 签名字符串。多签适配器从 `sign(signDataHex)` 返回 `{ publicKey, signature }` 条目数组。公钥是压缩的 P-256 点，签名使用 P-256/SHA-256 对确切提供的、绑定网络的交易签名数据签名一次。SDK 不存储任何私钥。

```js
const guardian = {
  account: guardianScriptHash,
  verificationScript: guardianVerificationScript,
  async sign(signDataHex) {
    return Promise.all(availableMembers.map(async member => ({
      publicKey: member.publicKey,
      signature: await member.sign(signDataHex),
    })));
  },
};
const plan = await client.buildAction({ accountId, action: 'unfreeze' });
const prepared = await client.prepareTransaction(plan, {
  feePayer: payer, authoritySigners: [custody, guardian], ...feeLimits,
});
const signed = await client.signTransaction(prepared);
await client.broadcastTransaction(signed);
```

签名之前，请向每位参与者展示固定的交易、阈值、完整公钥名单、账户角色、作用域与费用。守护者是一个交易签名方，其一个见证包含 m 个签名。把其成员钱包哈希列为独立签名方，无法满足守护者见证。

只接受规范的标准 CHECKSIG 与 CHECKMULTISIG 脚本。每个点都必须有效；多签成员必须唯一，并按 Neo 对 EC 点的排序（先 X 后 Y）排列。脚本哈希必须与签名方匹配。所有提交的签名都会被检查，包括超出阈值的签名。重复、未知或无效条目会拒绝该响应；绝不会被悄悄丢弃。校验之后，脚本顺序中前 m 个可用成员构成见证，独立于回调完成顺序或响应数组顺序。

调用脚本与验证脚本都必须满足 Neo 既有的 1,024 字节见证限制。标准的 66 字节签名压栈把 m 限制为 15；规范的 35 字节公钥压栈与脚本框架把 n 限制为 29。更大的脚本会被拒绝，而不是扩展协议限制。网络费用估算使用 m 个签名占位符与完整验证脚本，然后检查最终见证费用。这些限制并不承诺交易能满足所有其他费用、大小或验证 Gas 边界；已签名预检仍必须成功。

可移植的已签名交易导入路径必须使用相同的脚本、签名、顺序与大小校验。JSON 不是签名或广播的许可。浏览器校验使用 P-256 WebCrypto 与同一个公开脚本解析器；检查已签名工件不需要私钥或签名能力。

## 可用性与恢复边界

对于 2-of-3 的守护者，丢失一把成员密钥仍能有可用的法定人数。Frozen 账户的解冻需要该法定人数**以及**托管。若托管已丢失，法定人数可以使用既有的七天恢复流程；恢复之后，新的托管与守护者法定人数仍必须协作才能解冻。

若可用守护者密钥少于 m 把，Frozen 账户没有仅托管的逃生路径。恢复足够的现有备份可以重建法定人数；更改阈值或名单会产生不同的钱包脚本哈希，且不会改变已配置的守护者。在 Active 且没有待生效托管恢复时，托管可以使用既有的延迟守护者替换流程。所有必要权限的丢失没有密码学恢复捷径。

请把阈值、完整公钥名单与确切的验证脚本同公开账户记录放在一起，并独立保存参与者的钱包备份。不同公钥并不证明是不同的人或独立的备份。任何可用法定人数都可以行使守护者的冻结与恢复权力，因此阈值在提升密钥丢失容忍度的同时也分散了这些权力。

## 校验与上线

SDK 测试覆盖所有 2-of-3 法定人数、响应顺序、无效的多余签名、畸形或超长脚本、费用占位符，以及守护者 / 托管 / 支付方角色。核心测试使用公开夹具密钥，并在冻结、恢复与共同解冻之前执行真实的交易 Verification。它们不演练已登记原生账户的跨代理权限。依赖阈值守护者之前，必须用所选的钱包集成演示运行时支持；仅凭普通钱包 `invoke` 无法证明多签协同能力。
