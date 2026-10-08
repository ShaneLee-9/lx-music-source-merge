# lx-music-source-merge

用于管理和整理音乐软件音源文件的 Bun 项目。

## 📁 目录约定

- `checked/`：已经验证可用的音源文件，可以按音质等分类递归存放。
- `unchecked/`：已经收集但尚未验证的音源文件。

## 🛠️ 计划功能

- 读取音源文件开头 JSDoc 中的 `name`、`version` 和 `author` 信息。
- 递归扫描 `checked/` 目录。
- 将验证可用的音源与已测试音源进行比对。
- 如果存在相同名称和作者的音源，则使用当前音源替换旧文件。
- 如果不存在匹配项，则将当前音源归档到 `checked/`。

处理音源时只读取必要的元数据，不向 LLM 输出完整音源文件内容。

## 💻 开发环境

- Bun 1.4.2
- TypeScript

## ▶️ 运行

直接运行时会打开交互式选择器，只展示 `unchecked/` 中 `.js` 后缀的音源文件，可以使用方向键选择并按文件名搜索：

```bash
bun run index.ts
```

选中文件后会先显示归档预览，确认后才会执行移动或替换。

也可以直接指定文件：

```bash
bun run index.ts unchecked/example.js
```

预览模式：

```bash
bun run index.ts --dry-run
bun run index.ts unchecked/example.js --dry-run
```

删除 `unchecked/` 中与 `checked/` 存在相同 `name` 和 `author` 的 `.js` 音源：

```bash
bun run prune
```

可通过 `--checked <目录>` 和 `--unchecked <目录>` 指定目录。无匹配、多重匹配或元数据无效的文件会保留。开头没有 JSDoc 的文件会跳过，不参与比对且不报错；有 JSDoc 但元数据字段无效仍会报错。版本号不参与匹配。`index.ts` 直接指定这类无 JSDoc 文件时也会跳过。
