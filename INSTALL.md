# dsh-session-messenger 0.4.2 安装说明

来源提交：2841313 feat: v0.4.2 multi-writer handoff and queue on one file（2026-09-30 14:02）

## 安装到 DSH
1. 解压到一个长期存放的目录（例如 `~/.dsh/plugin-src/dsh-session-messenger`）。插件以 link 方式安装，**安装后不要删除或移动这个目录**。
2. 在 DSH 里让任意会话执行：`plugin_manager` → `install_bundle`，target 为该目录的绝对路径。
3. 重启 DSH（代码变更必须重启才会加载）。
4. 验证：对任意会话说「查一下信使状态」，`negotiate status` 回执末尾应显示 `plugin v0.4.2`。

## 本地验证（需要 Node 22+，DSH 安装在默认位置）
```bash
npm test                 # 纯逻辑单测
npm run check:schemas    # 工具 Schema 与 spec 一致
npm run probe            # 真实 cordis 上的装载 / 自动登记 / 协商集成探针
```

## 还原完整 git 历史
```bash
git clone dsh-session-messenger.git.bundle dsh-session-messenger
```

运行时数据（占用登记、协商、指标）不在包内，位于 `~/.dsh/plugin-data/dsh-session-messenger/`。
