# DeepSeek Claude Proxy

一个轻量级的本地代理服务器，将 [Anthropic Claude Messages API](https://docs.anthropic.com/en/api/messages) 的请求协议无缝转换为 [DeepSeek API](https://api.deepseek.com/anthropic) 兼容格式。

## 解决的问题

DeepSeek 官方提供的 Anthropic-compatible API (`/anthropic`) 与标准 Claude API 协议之间存在一些差异，直接使用会导致 `400 Bad Request` 等错误。本代理解决了以下兼容性问题：

1. **System 消息清洗** — DeepSeek 不支持 `messages` 数组中的 `system` 角色，代理自动将 system 消息合并到相邻的用户消息中
2. **Thinking 块注入与修复** — 自动缓存并注入缺失的 thinking 块（含合法 signature），修复因缺失 thinking 块导致的 400 错误
3. **Streaming 响应缓存** — 在流式响应中实时捕获 thinking 内容，供后续多轮对话复用
4. **Adaptive Thinking 修正** — 将 `thinking.type = "adaptive"` 修正为 `"enabled"` 以兼容 DeepSeek

## 快速开始

### 1. 克隆仓库
```bash
git clone https://github.com/GuanLuoFu/deepseek-claude-proxy.git
cd deepseek-claude-proxy
```

### 2. 配置 API Key
确保你有一个 DeepSeek API Key。代理会将客户端请求中的 `x-api-key` 头直接转发给 DeepSeek。

### 3. 启动代理
```bash
node proxy.js
```
代理默认监听 `http://127.0.0.1:8080`。

### 4. 配置 Claude Code

设置环境变量，将请求指向本地代理（Claude Code 会自动拼接 `/v1/messages`）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
# ANTHROPIC_MODEL 和 ANTHROPIC_AUTH_TOKEN 保持不变
```

Windows (PowerShell):
```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
```

## 工作原理
```
客户端 (Claude API格式)
    │  POST /v1/messages
    ▼
┌───────────────┐    ┌───────────────┐
│  本地代理:8080 │ → │  DeepSeek API │
│  · 清洗/注入   │ ← │  /anthropic   │
│  · 缓存       │    └───────────────┘
└───────────────┘
```

## 日志
代理日志保存在 `~/.claude/proxy.log`，便于调试。

## 注意事项
- 本代理仅处理协议转换，不修改 API Key
- 代理日志文件可能包含敏感信息，请勿公开分享
- 仅供学习和研究使用
