# 阈值钱包权限方

> 中文版本与 `docs/NATIVE_ACCOUNT_THRESHOLD_RECOVERY.md` 同构。若两者冲突，以英文版本为准。

标准 Neo P-256 的 m-of-n 钱包可以作为账户的托管地址、恢复权限方或费用支付方。它是交易见证账户，不是作用在模块上的阈值策略，也不是另一个原生账户代理。它不改变账户身份、恢复时间锁或模块模型。公开激活仍是独立的协议决策。

账户的恢复权限方由配置意图内的 `setRecoveryPolicy` 动作设定，因此像其他每个意图一样要成熟 24 小时。之后的 `beginRecovery(accountId, newCustody)` 需要托管地址**或**已配置的恢复权限方，并且还需要新托管地址的见证。`cancelRecovery(accountId)` 接受这两者中的任意一个。`freezeAccount` 只允许托管，而且——不同于 v3 的守护者模型——`unfreezeAccount` 也**只**允许托管：授权一个恢复权限方授予的是恢复权力，不是解冻权力。

## 签名方约定

把标准钱包脚本哈希作为 `account`，并提供其确切的规范 `verificationScript`。单签名适配器继续返回 64 字节的 P1363 签名字符串。多签适配器从 `sign(signDataHex)` 返回 `{ publicKey, signature }` 条目数组。公钥是压缩的 P-256 点，签名使用 P-256/SHA-256 对确切提供的、绑定网络的交易签名数据签名一次。SDK 不存储任何私钥。

```js
const authority = {
  account: authorityScriptHash,
  verificationScript: authorityVerificationScript,
  async sign(signDataHex) {
    return Promise.all(availableMembers.map(async member => ({
      publicKey: member.publicKey,
      signature: await member.sign(signDataHex),
    })));
  },
};

const action = { method: 'unfreezeAccount', accountId };
const plan = client.buildAccountActionScript(action);
const prepared = await client.prepareTransaction(plan, {
  feePayer: payer,
  recipe: { method: 'buildAccountActionScript', input: action },
  authorizers: [custody],
  ...feeLimits,
});
const signed = await client.signTransaction(prepared);
await client.broadcastTransaction(signed);
```

`prepareTransaction` 按评审时使用的 `recipe` 重建脚本，把费用支付方解析为 `None` 见证作用域，并把每个 `authorizers` 条目限定到确切的 core hash，因为核心用 `Runtime.CheckWitness` 识别权限方。签名之前，请向每位参与者展示固定的交易、阈值、完整公钥名单、账户角色、作用域与费用。

只接受规范的标准 CHECKSIG 与 CHECKMULTISIG 脚本。每个点都必须有效；多签成员必须唯一，并按 Neo 对 EC 点的排序（先 X 后 Y）排列。脚本哈希必须与签名方匹配。所有提交的签名都会被检查，包括超出阈值的签名。重复、未知或无效条目会拒绝该响应；绝不会被悄悄丢弃。校验之后，脚本顺序中前 m 个可用成员构成见证，独立于回调完成顺序或响应数组顺序。

调用脚本与验证脚本都必须满足 Neo 既有的 1,024 字节见证限制。标准的 66 字节签名压栈把 m 限制为 15；规范的 35 字节公钥压栈与脚本框架把 n 限制为 29。更大的脚本会被拒绝，而不是扩展协议限制。网络费用估算使用 m 个签名占位符与完整验证脚本，然后检查最终见证费用。这些限制并不承诺交易能满足所有其他费用、大小或验证 Gas 边界；已签名预检仍必须成功。

可移植的已签名交易导入路径必须使用相同的脚本、签名、顺序与大小校验。JSON 不是签名或广播的许可。浏览器校验使用 P-256 WebCrypto 与同一个公开脚本解析器；检查已签名工件不需要私钥或签名能力。

## 可用性与恢复边界

对于 2-of-3 的恢复权限方，丢失一把成员密钥仍能有可用的法定人数。`beginRecovery` 携带创建时选定的 7..90 天时间锁，时间锁成熟且授权 epoch 未变之后，`executeRecovery` 无需权限。执行是无回调的：它删除每一行模块模型记录、清空恢复权限方、恢复 `Active`，并重新启用默认操作与消息授权。因此新的托管启动时没有任何已安装模块，必须再次通过配置意图安装其验证器。

若托管已丢失且可用恢复成员少于 m，没有密码学捷径：更改阈值或名单会产生不同的钱包脚本哈希，且不会改变已配置的恢复权限方。在 Active 且没有待生效恢复时，托管可以提出恢复权限方替换，该提案成熟 24 小时。

请把阈值、完整公钥名单与确切的验证脚本同公开账户记录放在一起，并独立保存参与者的钱包备份。不同公钥并不证明是不同的人或独立的备份。任何可用法定人数都可以行使恢复，因此阈值在分配该权力的同时也提升密钥丢失容忍度。由于恢复权限方不参与解冻，托管不应是你无法替换的单把密钥。

## 校验与上线

SDK 测试覆盖所有 2-of-3 法定人数、响应顺序、无效的多余签名、畸形或超长脚本、费用占位符，以及权限方 / 托管 / 支付方角色。核心测试使用公开夹具密钥，并在冻结、恢复与解冻之前执行真实的交易 Verification。它们不演练已登记原生账户的跨代理权限。依赖阈值权限方之前，必须用所选的钱包集成演示运行时支持；仅凭普通钱包 `invoke` 无法证明多签协同能力。
