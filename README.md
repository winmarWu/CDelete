# CDelete

本地 AI 磁盘分析助手。  
目标：让用户通过 `npm` 安装后，一键打开本地网页，扫描 C / D 盘并查看“用途解释 + 删除建议”报告。

## 功能

- CLI 启动：`cdelete`
- 本地服务：`http://127.0.0.1:3456`
- 扫描目标：C 盘或 D 盘
- 报告内容：
  - 路径与大小
  - 风险分级（建议删除 / 谨慎删除 / 禁止删除）
  - 规则解释
  - AI 中文解释（DeepSeek）

## 安装与运行

```bash
npm install
npm start
```

或本地全局测试：

```bash
npm link
cdelete
```

## DeepSeek 配置

推荐在页面输入框直接填写 API Key（会存到浏览器 localStorage），也支持环境变量：

- `DEEPSEEK_API_KEY=你的key`
- `DEEPSEEK_MODEL=deepseek-reasoner`（可选）

当前版本会强制调用大模型生成用途解释：若未提供 key，扫描接口会直接报错。

## 可选配置

- `CDELETE_PORT`：默认 `3456`
- `CDELETE_MAX_SCAN_ITEMS`：默认 `5000`
- `CDELETE_MAX_FOLDERS`：默认 `120`
- `CDELETE_MAX_FILES`：默认 `120`
- `CDELETE_STAT_CONCURRENCY`：目录内并发 `stat` 数，默认 `24`
- `CDELETE_AI_MAX_ITEMS`：走 AI 解释的条目上限，默认 `0`（表示全部条目）
- `CDELETE_AI_BATCH_SIZE`：AI 单批条目数，默认 `8`（质量优先，减少漏解释）
- `CDELETE_AI_BATCH_CONCURRENCY`：AI 并发批次数，默认 `2`

## 目录结构

```text
bin/cdelete.js        # CLI 入口
src/server.js         # Express 服务与 API
src/scanner.js        # 盘符扫描与统计
src/rules.js          # 删除建议规则
src/ai.js             # DeepSeek AI 解释
public/index.html     # 扫描启动页
public/report.html    # 报告展示页
public/styles.css     # UI 样式
public/app.js         # 前端交互
```
