/**
 * 临智AI (Linzhi AI Studio) - 本地代理服务器
 * ----------------------------------------------------------------
 * 本项目是对「临智AI」前端的本地复刻 + 可自定义后端代理。
 *
 * 功能：
 *  1. 托管前端静态文件（index.html / css / js）
 *  2. 将 /api/* 请求代理到任意后端（默认指向复刻网站原站，可运行时切换）
 *  3. 后端管理 API：查看 / 切换 / 添加 / 删除（见 README）
 *  4. 处理 CORS 跨域、透传 API Key 与 Cookie
 *
 * ⚠️ 安全说明：
 *  - 原站 API Key 不会硬编码进仓库。请通过环境变量 API_KEY 或 config.json 提供。
 *  - 默认 original 后端仅提供 target 地址，apiKey 为空时会在日志提示需要自建/自备 Key。
 */

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3721;

// ===== 本地资源目录（SAVE_LOCAL=1 时，生成结果的外链图片/视频会下载到这里）=====
const OUTPUT_DIR = path.join(__dirname, 'output');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// ===== 默认配置（不含任何明文密钥）=====
const DEFAULT_CONFIG = {
    backends: {
        original: {
            name: '复刻网站原站 (Demo)',
            target: 'https://agnes-ai-studio-02306.app.workbuddy.host',
            apiKey: process.env.API_KEY || '',
            description: '原站后端。需自备 API Key：设置 API_KEY 环境变量，或在 config.json 中填入。'
        }
    },
    active: 'original'
};

// ===== 配置文件路径 =====
const CONFIG_PATH = path.join(__dirname, 'config.json');

// ===== 读取配置 =====
function loadConfig() {
    // 1) 优先使用 config.json（用户已创建）
    if (fs.existsSync(CONFIG_PATH)) {
        try {
            const fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
            // 与默认配置合并，确保新增字段有兜底
            return {
                backends: { ...DEFAULT_CONFIG.backends, ...(fileConfig.backends || {}) },
                active: fileConfig.active || DEFAULT_CONFIG.active
            };
        } catch (e) {
            console.warn('[Config] config.json 解析失败，回退默认配置:', e.message);
        }
    }
    // 2) 回退到默认配置（API Key 来自环境变量）
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

let config = loadConfig();

// 若当前激活后端缺 Key，给出提示（不阻断启动，仅提醒）
if (!getCurrentBackend().apiKey) {
    console.warn('[Config] 当前后端未配置 API Key，API 调用可能被拒。请用 API_KEY 环境变量或 config.json 提供。');
}

// ===== 获取当前后端 =====
function getCurrentBackend() {
    const backend = config.backends[config.active];
    if (!backend) {
        config.active = 'original';
        return config.backends.original;
    }
    return backend;
}

// ===== 读取 body.html / app.js / index.html（前端资源较大，启动时一次读入内存）=====
const bodyHtml = fs.readFileSync(path.join(__dirname, 'public', 'body.html'), 'utf-8');
const appJsSource = fs.readFileSync(path.join(__dirname, 'public', 'js', 'app.js'), 'utf-8');
const indexHtmlSource = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
// 缓存破坏版本号：随 app.js 内容变化，确保浏览器/预览始终拿到最新版本
const APPJS_VERSION = crypto.createHash('md5').update(appJsSource).digest('hex').slice(0, 8);
// 首页完整 HTML：启动时拼装一次，每次请求直接返回（避免重复读盘 + 字符串替换）
const fullHtml = indexHtmlSource.replace(
    '</body>',
    `${bodyHtml}\n<script src="/js/app.js?v=${APPJS_VERSION}"></script>\n</body>`
);

// ===== 首页：直接返回预拼装的完整 HTML =====
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fullHtml);
});
app.get('/index.html', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(fullHtml);
});

// ===== 静态资源（禁用强缓存，避免浏览器拿到旧版脚本）=====
app.use('/css', express.static(path.join(__dirname, 'public', 'css'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
app.use('/js', express.static(path.join(__dirname, 'public', 'js'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
// 本地保存的生成资源（图片/视频），SAVE_LOCAL=1 时页面引用会被改写到 /output/*
app.use('/output', express.static(OUTPUT_DIR));

// ===== 后端管理 API =====
app.use('/api-backend', express.json());

// 查看所有后端 + 当前激活
app.get('/api-backend/config', (req, res) => {
    const current = getCurrentBackend();
    res.json({
        active: config.active,
        backends: config.backends,
        current: {
            name: current.name,
            target: current.target,
            apiKeyMasked: current.apiKey ? current.apiKey.substring(0, 8) + '****' : '(未设置)',
            description: current.description
        }
    });
});

// 切换后端（运行时，无需重启）
app.post('/api-backend/switch', (req, res) => {
    const { backendId } = req.body || {};
    if (!backendId || !config.backends[backendId]) {
        return res.status(400).json({ error: '后端不存在', available: Object.keys(config.backends) });
    }
    config.active = backendId;
    saveConfig();
    const b = config.backends[backendId];
    res.json({ ok: true, active: backendId, target: b.target, name: b.name });
});

// 添加后端
app.post('/api-backend/add', (req, res) => {
    const { id, name, target, apiKey, description } = req.body || {};
    if (!id || !target) {
        return res.status(400).json({ error: 'id 和 target 必填' });
    }
    config.backends[id] = {
        name: name || id,
        target,
        apiKey: apiKey || '',
        description: description || ''
    };
    saveConfig();
    res.json({ ok: true, backends: Object.keys(config.backends) });
});

// 删除后端（保护默认 original）
app.delete('/api-backend/delete', (req, res) => {
    const { backendId } = req.body || {};
    if (backendId === 'original') {
        return res.status(400).json({ error: '不能删除默认后端 original' });
    }
    if (!config.backends[backendId]) {
        return res.status(404).json({ error: '后端不存在' });
    }
    delete config.backends[backendId];
    if (config.active === backendId) {
        config.active = 'original';
    }
    saveConfig();
    res.json({ ok: true, active: config.active });
});

// 保存配置到文件
function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.warn('[Config] 保存 config.json 失败:', e.message);
    }
}

// ===== 动态创建代理（每次请求取当前后端，支持运行时切换）=====
function createApiProxy() {
    const backend = getCurrentBackend();
    const target = backend.target;
    const apiKey = backend.apiKey;

    return createProxyMiddleware({
        target,
        changeOrigin: true,
        secure: target.startsWith('https://') && !target.includes('localhost'),
        cookieDomainRewrite: '',
        timeout: 120000,
        // ★ 必须设 selfHandleResponse: true，否则 http-proxy 会在 onProxyRes 之后
        //   自动 proxyRes.pipe(res)，与 SAVE_LOCAL 的手动 res.end(newBody) 冲突
        //   （headers already sent → 静默降级返回原始 body，本地改写失效）
        selfHandleResponse: true,
        onProxyReq: (proxyReq, req, res) => {
            proxyReq.setHeader('Host', new URL(target).hostname);

            // 重写 Origin 为后端自身 origin（同源），规避后端 CORS 允许列表校验
            // 远端后端仅放行其自身域名，127.0.0.1/localhost 均不在列表内
            proxyReq.setHeader('Origin', new URL(target).origin);

            // 后端默认 Key
            if (apiKey) {
                proxyReq.setHeader('x-api-key', apiKey);
                proxyReq.setHeader('Authorization', `Bearer ${apiKey}`);
            }

            // 客户端可临时覆盖 Key（header: x-api-key）
            const userKey = req.headers['x-api-key'];
            if (userKey && userKey !== apiKey) {
                proxyReq.setHeader('x-api-key', userKey);
                proxyReq.setHeader('Authorization', `Bearer ${userKey}`);
            }

            if (req.headers.cookie) {
                proxyReq.setHeader('Cookie', req.headers.cookie);
            }
            proxyReq.setHeader('User-Agent', req.headers['user-agent'] || 'LinzhiAI-Local-Proxy');
        },
        onProxyRes: (proxyRes, req, res) => {
            // CORS：直接写到 proxyRes.headers 上，随 writeHead 透传到 res
            proxyRes.headers['access-control-allow-origin'] = '*';
            proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
            proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization, x-api-key, Cookie';
            proxyRes.headers['access-control-allow-credentials'] = 'true';

            // SAVE_LOCAL=1 时：把 JSON 结果里的外链图片/视频 URL 下载到本地并改写
            const saveLocal = process.env.SAVE_LOCAL === '1';
            const ct = (proxyRes.headers['content-type'] || '');
            if (saveLocal && ct.includes('application/json')) {
                const chunks = [];
                proxyRes.on('data', (c) => chunks.push(c));
                proxyRes.on('end', async () => {
                    const rawBuffer = Buffer.concat(chunks);
                    // 支持 gzip/deflate 压缩体：解压后再解析
                    const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
                    let bodyStr;
                    try {
                        if (encoding === 'gzip') {
                            bodyStr = require('zlib').gunzipSync(rawBuffer).toString('utf8');
                        } else if (encoding === 'deflate') {
                            bodyStr = require('zlib').inflateSync(rawBuffer).toString('utf8');
                        } else {
                            bodyStr = rawBuffer.toString('utf8');
                        }
                    } catch (e) {
                        // 解压失败 → 原样返回
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);
                        return res.end(rawBuffer);
                    }
                    try {
                        const newBody = await rewriteAssetUrls(bodyStr);
                        // 改写后长度变了：去掉 chunked，设置精确 Content-Length
                        delete proxyRes.headers['transfer-encoding'];
                        delete proxyRes.headers['content-encoding'];
                        proxyRes.headers['content-length'] = Buffer.byteLength(newBody);
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);
                        res.end(newBody);
                    } catch (e) {
                        console.error('[SaveLocal] 改写异常:', e.message);
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);
                        res.end(rawBuffer);
                    }
                });
                return;
            }

            // 默认：手动写入状态码+头，再管道 body（selfHandleResponse 要求完全自处理）
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res).on('error', (err) => {
                console.error('[Pipe Error]', err.message);
                if (!res.headersSent) {
                    res.status(502).json({ error: 'Pipe error', message: err.message });
                }
            });
        },
        onError: (err, req, res) => {
            console.error('[Proxy Error]', err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Proxy error', message: err.message, target });
            }
        }
    });
}

// ===== 本地资源保存（SAVE_LOCAL=1 时启用）=====
// 只认图片/视频后缀的外链 URL，避免误下载模型缩略图等
const ASSET_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|mp4|mov|webm|avi)(\?|$)/i;

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const opts = {
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: { 'User-Agent': 'LinzhiAI-Local-Proxy/1.0' },
            timeout: 60000,
        };
        const req = mod.request(opts, (res) => {
            // 重定向跟随（3xx）
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    const buf = Buffer.concat(chunks);
                    if (buf.length === 0) return reject(new Error('空响应'));
                    fs.writeFileSync(dest, buf);
                    resolve();
                } catch (e) { reject(e); }
            });
        });
        req.on('error', (e) => reject(new Error(`请求失败: ${e.message}`)));
        req.on('timeout', () => { req.destroy(); reject(new Error('下载超时')); });
        req.end();
    });
}

async function maybeSaveLocal(url) {
    if (typeof url !== 'string' || !url) return url;
    if (!ASSET_EXT_RE.test(url)) return url;
    let parsed;
    try { parsed = new URL(url); } catch { return url; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
    if (url.startsWith('/output')) return url; // 已是本地路径

    const extMatch = parsed.pathname.match(/\.([a-z0-9]+)$/i);
    const ext = (extMatch ? extMatch[1] : 'bin').toLowerCase();
    const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
    const filename = `${hash}.${ext}`;
    const localPath = path.join(OUTPUT_DIR, filename);
    const localUrl = `/output/${filename}`;

    if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) return localUrl; // 已缓存

    try {
        await downloadFile(url, localPath);
        return localUrl;
    } catch (e) {
        console.warn('[SaveLocal] 下载失败，保留原 URL:', url, '|', e.message);
        return url; // 降级：不影响页面展示
    }
}

async function rewriteAssetUrls(body) {
    let data;
    try { data = JSON.parse(body); } catch { return body; }
    await walk(data, 0);
    return JSON.stringify(data);

    async function walk(node, depth) {
        if (depth > 10) return; // 防止过深/环状结构
        if (Array.isArray(node)) {
            // 收集所有需要下载的字符串 URL，批量并发
            const tasks = [];
            for (let i = 0; i < node.length; i++) {
                const v = node[i];
                if (typeof v === 'string') {
                    tasks.push({ idx: i, val: v });
                } else if (v && typeof v === 'object') {
                    await walk(v, depth + 1);
                }
            }
            if (tasks.length > 0) {
                const results = await Promise.all(tasks.map(t => maybeSaveLocal(t.val)));
                results.forEach((nv, i) => {
                    if (nv !== tasks[i].val) node[tasks[i].idx] = nv;
                });
            }
        } else if (node && typeof node === 'object') {
            const keys = Object.keys(node);
            const tasks = [];
            for (const key of keys) {
                const v = node[key];
                if (typeof v === 'string') {
                    tasks.push({ key, val: v });
                } else if (v && typeof v === 'object') {
                    await walk(v, depth + 1);
                }
            }
            if (tasks.length > 0) {
                const results = await Promise.all(tasks.map(t => maybeSaveLocal(t.val)));
                results.forEach((nv, i) => {
                    if (nv !== tasks[i].val) node[tasks[i].key] = nv;
                });
            }
        }
    }
}

// ===== /api/* 走代理 =====
app.use('/api', (req, res, next) => {
    const proxy = createApiProxy();
    proxy(req, res, next);
});

// ===== OPTIONS 预检 =====
app.options('*', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Cookie');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.status(204).end();
});

// ===== 健康检查 =====
app.get('/health', (req, res) => {
    const current = getCurrentBackend();
    res.json({
        status: 'ok',
        port: PORT,
        active: config.active,
        target: current.target,
        name: current.name
    });
});

// ===== 启动 =====
app.listen(PORT, () => {
    const current = getCurrentBackend();
    console.log(`
╔══════════════════════════════════════════════════════════╗
║      临智AI (Linzhi AI Studio) - 本地代理                ║
╠══════════════════════════════════════════════════════════╣
║  🌐 前端:     http://localhost:${PORT}                      ║
║  🔄 后端:     ${current.target}              ║
║              ${current.name}                      ║
║  🔑 API Key:  ${current.apiKey ? current.apiKey.substring(0, 8) + '****' : '(未设置)'}              ║
╠══════════════════════════════════════════════════════════╣
║  ⚙ 后端管理:  http://localhost:${PORT}/api-backend/config ║
╚══════════════════════════════════════════════════════════╝
    `);
});
