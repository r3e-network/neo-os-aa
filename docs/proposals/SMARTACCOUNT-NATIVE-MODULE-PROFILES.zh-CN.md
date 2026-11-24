# SmartAccount 原生模块打包

[当前参数](smartaccount-native-profile-parameters.json)用于核心、SDK 和模块打包。打包器按[模块清单](../../contracts/plugins/native-profile/profiles.json)构建六个验证器与钩子，保留编译器生成的 NEF 和 manifest 原始字节，核对权限白名单、回调、NEF 校验和及 `native-smartaccount` 标记。配置管理、消息签名和门限策略见[标准模块](../../contracts/modules/README.md)。

安装时，核心读取模块自己的 `getModuleProfile` 并绑定代码与配置。模块指纹和整个协议的参数指纹用途不同，不能互相替代。核心及模块均未发布。构建两次得到相同字节可以证明构建可复现，但不能证明已激活或实现已通过形式化验证。
