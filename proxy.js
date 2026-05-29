const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 代理监听的本地端口
const PORT = 8080;
const LOG_FILE = path.join(os.homedir(), '.claude', 'proxy.log');

// 缓存最后一次由 DeepSeek 官方返回的 thinking 块
let lastThinkingBlock = null;

// 记录日志到文件的辅助函数
function logToFile(msg) {
    const time = new Date().toISOString();
    const logLine = `[${time}] ${msg}\n`;
    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
}

// 辅助函数：将思维块安全注入到 assistant 消息的 content 开头
function injectThinking(msg, block) {
    if (typeof msg.content === 'string') {
        msg.content = [
            block,
            { type: 'text', text: msg.content }
        ];
    } else if (Array.isArray(msg.content)) {
        msg.content.unshift(block);
    }
}

const server = http.createServer((req, res) => {
    // 跨域支持
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url.startsWith('/v1/messages') && req.method === 'POST') {
        let bodyChunks = [];
        req.on('data', chunk => {
            bodyChunks.push(chunk);
        });
        req.on('end', () => {
            const bodyStr = Buffer.concat(bodyChunks).toString();
            let payload;
            try {
                payload = JSON.parse(bodyStr);
            } catch (e) {
                logToFile(`[Error] 无法解析请求 JSON: ${e.message}`);
                proxyRequest(req, res, bodyStr);
                return;
            }

            logToFile(`================= 收到客户端请求 (Model: ${payload.model}) =================`);
            
            // --- 核心修复 1：清洗并吸收 messages 中的 system 消息 (DeepSeek 不支持 messages 中含有 system 角色) ---
            if (payload.messages && Array.isArray(payload.messages)) {
                logToFile(`原始请求中包含 ${payload.messages.length} 条消息. 启动 system 角色无损清洗...`);
                const cleanedMessages = [];
                for (let i = 0; i < payload.messages.length; i++) {
                    const msg = payload.messages[i];
                    if (msg.role === 'system') {
                        logToFile(`[System Fix] 发现 messages[${i}] 为 system 消息，将其无损合并到上一条消息中.`);
                        let systemText = '';
                        if (typeof msg.content === 'string') {
                            systemText = msg.content;
                        } else if (Array.isArray(msg.content)) {
                            systemText = msg.content.map(block => block.text || JSON.stringify(block)).join('\n');
                        }
                        
                        const mergedText = `\n\n<system_context>\n${systemText}\n</system_context>`;
                        
                        if (cleanedMessages.length > 0) {
                            const prevMsg = cleanedMessages[cleanedMessages.length - 1];
                            if (typeof prevMsg.content === 'string') {
                                prevMsg.content += mergedText;
                            } else if (Array.isArray(prevMsg.content)) {
                                prevMsg.content.push({ type: 'text', text: mergedText });
                            }
                        } else {
                            // 如果第一条就是 system 消息且无前置，将其转换为 user 消息以符合交替协议
                            msg.role = 'user';
                            cleanedMessages.push(msg);
                        }
                    } else {
                        cleanedMessages.push(msg);
                    }
                }
                payload.messages = cleanedMessages;
                logToFile(`清洗完成. 最终消息数量: ${payload.messages.length} 条.`);
            }

            // --- 核心修复 2：重组多轮/历史对话，注入并修复所有缺失的 thinking 块 ---
            if (payload.messages && Array.isArray(payload.messages)) {
                let hasInjectedLatest = false;
                
                // 自后往前遍历所有的消息，修复所有丢失 thinking 的 assistant 消息
                for (let i = payload.messages.length - 1; i >= 0; i--) {
                    const msg = payload.messages[i];
                    if (msg.role === 'assistant') {
                        // 检查该 assistant 消息中是否包含了 thinking 块
                        let hasThinking = false;
                        if (Array.isArray(msg.content)) {
                            hasThinking = msg.content.some(block => block.type === 'thinking');
                        }
                        
                        if (!hasThinking) {
                            // 1. 如果是最新的回复，并且我们有最新的真实缓存，优先注入真实的
                            if (!hasInjectedLatest && lastThinkingBlock) {
                                logToFile(`[Fix] 🛠️ 检测到最新一轮 assistant 会话缺失思维块，注入缓存的 Thinking Block.`);
                                injectThinking(msg, lastThinkingBlock);
                                hasInjectedLatest = true;
                            } else {
                                // 2. 属于历史会话（比如使用 /resume 恢复历史），注入万能占位符，欺骗 API 校验
                                logToFile(`[Fix] 🩹 检测到历史会话 [第 ${i} 条消息] 缺失思维块，注入 Base64 占位符.`);
                                // 【超关键协议修复】：Anthropic 规范中，thinking 块里的文本内容字段名叫 "thinking" 而不是 "text"！
                                const placeholderBlock = {
                                    type: "thinking",
                                    signature: "Y2xhdWRlLWRzLXByb3h5LXBsYWNlaG9sZGVyLXNpZ25hdHVyZS1mb3ItZGVlcHNlZWstdjQtY29tcGF0aWJpbGl0eS1hbnRocm9waWMtcHJvdG9jb2wtZml4ZWQtNDAwLWJhZC1yZXF1ZXN0LWVycm9y",
                                    thinking: "" 
                                };
                                injectThinking(msg, placeholderBlock);
                            }
                        } else {
                            if (!hasInjectedLatest) {
                                const found = msg.content.find(block => block.type === 'thinking');
                                if (found) {
                                    lastThinkingBlock = found;
                                    logToFile(`[Cache] 💾 更新最新 thinking 缓存 (含有真实 signature).`);
                                }
                                hasInjectedLatest = true;
                            }
                        }
                    }
                }
            }

            // 过滤或修正可能导致 DeepSeek 拒绝的非标准属性
            if (payload.thinking && payload.thinking.type === 'adaptive') {
                payload.thinking.type = 'enabled';
                logToFile(`[Fix] 修正 thinking.type 为 enabled.`);
            }

            const modifiedBodyStr = JSON.stringify(payload);
            proxyRequest(req, res, modifiedBodyStr);
        });
    } else {
        // 非聊天 API 的其他请求直接透传
        let bodyChunks = [];
        req.on('data', chunk => bodyChunks.push(chunk));
        req.on('end', () => {
            proxyRequest(req, res, Buffer.concat(bodyChunks));
        });
    }
});

function proxyRequest(clientReq, clientRes, body) {
    const targetUrl = 'https://api.deepseek.com/anthropic' + clientReq.url;
    const parsedUrl = url.parse(targetUrl);
    
    // 复制请求头
    const headers = { ...clientReq.headers };
    headers.host = parsedUrl.host;
    delete headers['content-length']; // 重新计算长度
    
    const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: clientReq.method,
        headers: headers,
        rejectUnauthorized: false
    };

    const targetReq = https.request(options, (targetRes) => {
        logToFile(`================= 收到 DeepSeek 响应 (Status: ${targetRes.statusCode}) =================`);
        
        // 将原状态码及 Header 返回给客户端
        clientRes.writeHead(targetRes.statusCode, targetRes.headers);

        const isStream = targetRes.headers['content-type'] && targetRes.headers['content-type'].includes('event-stream');
        let rawResponseBuffer = [];
        let thinkingTextAccumulator = '';
        let thinkingSignature = '';

        targetRes.on('data', (chunk) => {
            clientRes.write(chunk);
            
            if (isStream) {
                const chunkStr = chunk.toString();
                const lines = chunkStr.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data:')) {
                        const jsonStr = line.slice(5).trim();
                        if (jsonStr === '[DONE]') continue;
                        try {
                            const data = JSON.parse(jsonStr);
                            if (data.type === 'content_block_start' && data.content_block && data.content_block.type === 'thinking') {
                                thinkingSignature = data.content_block.signature || '';
                            } else if (data.type === 'content_block_delta' && data.delta && data.delta.type === 'thinking_delta') {
                                thinkingTextAccumulator += data.delta.thinking || '';
                            }
                        } catch (e) {
                            // 忽略解析失败
                        }
                    }
                }
            } else {
                rawResponseBuffer.push(chunk);
            }
        });

        targetRes.on('end', () => {
            clientRes.end();

            if (isStream) {
                if (thinkingSignature || thinkingTextAccumulator) {
                    // 【超关键协议修复】：缓存真实思维块时，其文本内容字段名叫 "thinking" 
                    lastThinkingBlock = {
                        type: 'thinking',
                        signature: thinkingSignature,
                        thinking: thinkingTextAccumulator
                    };
                    logToFile(`[Cache] 💾 成功缓存本次 Stream 的真实思维块 (长度: ${thinkingTextAccumulator.length})`);
                }
            } else {
                const fullResStr = Buffer.concat(rawResponseBuffer).toString();
                try {
                    const data = JSON.parse(fullResStr);
                    
                    if (targetRes.statusCode === 400) {
                        logToFile(`[CRITICAL] 🛑 DeepSeek 返回了 400 Bad Request! 详情: ${JSON.stringify(data)}`);
                    }

                    if (data.content && Array.isArray(data.content)) {
                        const thinkingBlock = data.content.find(block => block.type === 'thinking');
                        if (thinkingBlock) {
                            lastThinkingBlock = thinkingBlock;
                            logToFile(`[Cache] 💾 成功缓存本次 JSON 的真实思维块.`);
                        }
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        });
    });

    targetReq.on('error', (e) => {
        logToFile(`[Error] 转发目标请求错误: ${e.message}`);
        clientRes.writeHead(500);
        clientRes.end(e.message);
    });

    if (body) {
        targetReq.write(body);
    }
    targetReq.end();
}

// 首次清空日志
fs.writeFileSync(LOG_FILE, `--- DeepSeek-Claude-Proxy 启动日志 (${new Date().toISOString()}) ---\n`, 'utf8');

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[Proxy] Schema-corrected proxy is running at http://127.0.0.1:${PORT}`);
});
