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
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3721;

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

// ===== 读取 body.html（前端 body 较大，运行时内联进 index.html）=====
const bodyHtml = fs.readFileSync(path.join(__dirname, 'public', 'body.html'), 'utf-8');

// ===== 首页：内联 body.html + 注入核心前端脚本 =====
// 注意：原始提取的 body.html 并不引用 app.js（898KB 核心逻辑），
// 必须在此显式注入，否则事件监听不会绑定、页面不可交互。
app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html') {
        const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf-8');
        const fullHtml = indexHtml.replace(
            '</body>',
            `${bodyHtml}\n<script src="/js/app.js"></script>\n</body>`
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(fullHtml);
    }
    next();
});

// ===== 静态资源 =====
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

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
        onProxyReq: (proxyReq, req, res) => {
            proxyReq.setHeader('Host', new URL(target).hostname);

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
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, Cookie');
            res.setHeader('Access-Control-Allow-Credentials', 'true');
            delete proxyRes.headers['access-control-allow-origin'];
            delete proxyRes.headers['access-control-allow-methods'];
            delete proxyRes.headers['access-control-allow-headers'];
        },
        onError: (err, req, res) => {
            console.error('[Proxy Error]', err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Proxy error', message: err.message, target });
            }
        }
    });
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
