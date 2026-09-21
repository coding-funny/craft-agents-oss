# ts-learn

1. index.md用于向外暴露相关的type
可以理解为：统一的公共 API 包，把分散在多个文件里的 DTO 集中导出
后续导入：import type { Workspace, AuthType } from '@craft-agent/core';
- export type：只导出编译时使用的类型，例如 interface、type；编译成 JavaScript 后通常不存在。
代码实例：
```ts
//导出Workspace and config types
//代表想外部暴露workspace相关的类型
export type {
  WorkspaceInfo,
  Workspace,
  RemoteServerConfig,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';
```

1. export：把当前文件里的内容开放给其他文件使用

默认情况下，文件中定义的内容只在当前文件可用；加上 export 后，其他文件才能 import 它。