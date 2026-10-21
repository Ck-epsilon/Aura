# Aura

> 一组小而专的工具。每个工具独立安装，不要求一起使用。

Aura 是一个 **monorepo**，不是一个大而全的平台。这里放的是若干个边界清晰、可以单独取用的小工具：它们共享同一套工程约定，但各自有独立的 `package.json`、README、版本和发布节奏。

共同点只有四条：

- **本地优先**：默认不依赖云端账号，不把数据交给第三方
- **无 key 起步**：能不用 API key 就不用
- **可被 agent 调用**：CLI / HTTP / MCP / 库，按需提供
- **MIT**：代码可读、可改、可自托管

---

## 工具

### AuraArgus

**给 agent 的检索层。** 把技术问题路由到注册的官方源，抓回页面，返回可引用的原文段落；也可以把任意 URL 转成干净的 Markdown。

- 18 个实体 / 34 个官方源
- 零 API key、零按次计费、零运行时依赖
- Node.js ≥ 20
- CLI、HTTP、MCP stdio、Node 库四种入口
- npm：[`aura-argus`](https://www.npmjs.com/package/aura-argus)
- 源码：[`aura-argus/`](aura-argus/README.md)

```bash
npm i -g aura-argus
aura-argus search "SearXNG 对 429 的冷却时间是多少秒？" --json
aura-argus fetch https://docs.searxng.org/dev/search_api.html --max-chars 4000
```

给 MCP 客户端：

```json
{
  "mcpServers": {
    "aura-argus": {
      "command": "npx",
      "args": ["-y", "aura-argus", "mcp"]
    }
  }
}
```

### AuraCardea

**DSH Web 的对话折叠插件。** 把一轮对话里与正文无关的中间态——工具调用、思考、上下文注入、重试——按类折成一行；需要时再展开看参数、输出、耗时和失败原因。

- 只接管 `conversation.chat.node` 的 `turn-process` 一个渲染位
- 按类聚合、成功/失败计数、退出码、耗时、图片缩略图
- DSH 0.2.x Web profile；Node.js ≥ 20
- npm：[`aura-cardea`](https://www.npmjs.com/package/aura-cardea)
- 源码：[`aura-cardea/`](aura-cardea/README.md)

```bash
dsh plugin --profile web add aura-cardea
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: client-aura-cardea
      name: 'aura-cardea'
```

重启 `dsh web`。如果通过插件市场的 Discover 安装 bundle，`cordis.patch.yml` 会自动挂载，不需要手改。

> 更多 Aura 工具在筹备中；这里只列已经可安装的。

---

## 只取一个工具

不需要 clone 整个仓库：

### 稀疏检出（保留 git 历史）

```bash
git clone --filter=blob:none --sparse https://github.com/Ck-epsilon/Aura.git
cd Aura
git sparse-checkout set aura-cardea
```

把 `aura-cardea` 换成 `aura-argus` 即可取另一个。

### degit（不要历史）

```bash
npx degit Ck-epsilon/Aura/aura-cardea aura-cardea
```

### 直接安装

大多数时候用户根本不需要源码：

```bash
npm i -g aura-argus
npm i aura-cardea
```

---

## 仓库结构

```text
Aura/
  README.md
  LICENSE
  aura-argus/          # 检索层：CLI / HTTP / MCP / Node 库
  aura-cardea/         # DSH Web 对话折叠插件
```

每个子目录都是一个独立包，`package.json` 里用 `repository.directory` 指回本仓库：

```json
"repository": {
  "type": "git",
  "url": "https://github.com/Ck-epsilon/Aura",
  "directory": "aura-cardea"
}
```

---

## 约定

- **npm 名**：`aura-<product>`，例如 `aura-argus`、`aura-cardea`
- **产品名**：`AuraXxx`，例如 AuraArgus、AuraCardea
- **版本**：每个包独立 semver；推荐 tag 形如 `aura-cardea-v1.1.0`
- **DSH 插件**：同时声明 `dsh.bundle` 与 `dsh.client`；用 `engines.dsh` 标兼容范围
- **不共享运行时**：不为了“统一”强行抽公共包；重复三行比过早抽象好
- **仓库不强制 workspace**：每个工具可以单独 `npm test`、单独发布

---

## 状态

| 工具 | npm | 环境 | 说明 |
|---|---|---|---|
| AuraArgus | `0.1.2` | Node ≥ 20 | 默认 registry-only；`--fallback` 才开网页兜底 |
| AuraCardea | `1.1.0` | DSH 0.2.x Web | bundle + client；手动或 Discover 安装 |

---

## 开发

```bash
cd aura-argus
npm test

cd ../aura-cardea
npm pack
node tools/check-kinds.mjs <dsh-node_modules>/@deepseek-ai
```

两个包都是零依赖或仅依赖宿主运行时；改动后优先跑各自的离线测试，再跑联网评测（AuraArgus）或 DSH 冒烟（AuraCardea）。

---

## License

代码使用 MIT，见根目录 [`LICENSE`](LICENSE) 与各子包的 `LICENSE`。

各子包内涉及的第三方名称、商标与作品，归各自权利人所有；MIT 只覆盖本仓库原创代码，不授予任何第三方 IP 许可。
