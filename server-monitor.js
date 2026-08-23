const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3006;

// ========== CONFIGURACAO ==========
let config = {
    controlIdIp: '',
    controlIdUser: 'admin',
    controlIdPass: 'admin',
    apiUrl: '',
    intervalo: 3,
    loja: 'TRANS BUS',
    tempo: 15
};

// ========== ESTADO ==========
let estado = {
    phase: 'idle',
    clienteAtual: null,
    ultimaEntrada: null,
    ultimaEntradaId: null
};

let clientesSSE = [];
let pollingTimer = null;

// ========== UTILS ==========
function log(tag, msg) {
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] [${tag}] ${msg}`);
}

function broadcast(data) {
    const msg = 'data: ' + JSON.stringify(data) + '\n\n';
    clientesSSE = clientesSSE.filter(c => !c.finished);
    clientesSSE.forEach(c => {
        try { c.res.write(msg); } catch(e) { c.finished = true; }
    });
}

function enviarWelcome(nome) {
    estado.phase = 'welcome';
    estado.clienteAtual = nome;
    log('WELCOME', nome);
    broadcast({ phase: 'welcome', nome: nome });
}

function enviarIdle() {
    estado.phase = 'idle';
    estado.clienteAtual = null;
    broadcast({ phase: 'idle' });
}

function enviarPromocoes() {
    estado.phase = 'promocoes';
    estado.clienteAtual = null;
    broadcast({ phase: 'promocoes' });
}

// ========== CONTROL ID / ENTRADAS ==========
async function verificarEntradas() {
    if (!config.controlIdIp && !config.apiUrl) return;

    try {
        let nome = null;
        let id = null;

        if (config.apiUrl) {
            // API alternativa (ex: log-porta local ou E4)
            const res = await fetch(config.apiUrl, { signal: AbortSignal.timeout(5000) });
            const data = await res.json();
            const entradas = data.entradas || data.ocorrencias || data;
            if (Array.isArray(entradas) && entradas.length > 0) {
                const ultimo = entradas[0];
                nome = ultimo.cliente || ultimo.nome || ultimo.user_name;
                id = ultimo.id || ultimo.timestamp || ultimo.datahora;
            }
        } else {
            // Control iD local direto
            const url = `http://${config.controlIdIp}/user_events.fcgi?session=&limit=1`;
            const auth = Buffer.from(`${config.controlIdUser}:${config.controlIdPass}`).toString('base64');
            const res = await fetch(url, {
                headers: { 'Authorization': `Basic ${auth}` },
                signal: AbortSignal.timeout(5000)
            });
            const text = await res.text();
            // Tenta extrair nome de varios formatos
            const m1 = text.match(/"name"\s*[:=]\s*"([^"]+)"/i);
            const m2 = text.match(/"nome"\s*[:=]\s*"([^"]+)"/i);
            const m3 = text.match(/"user_name"\s*[:=]\s*"([^"]+)"/i);
            const m4 = text.match(/usuario[\s:=]+([^\s,;]+)/i);
            nome = (m1 || m2 || m3 || m4)?.[1];
            const t1 = text.match(/"timestamp"\s*[:=]\s*"([^"]+)"/i);
            const t2 = text.match(/"date"\s*[:=]\s*"([^"]+)"/i);
            id = (t1 || t2)?.[1] || text;
        }

        if (nome && id && id !== estado.ultimaEntradaId) {
            estado.ultimaEntradaId = id;
            enviarWelcome(nome);
        }
    } catch(e) {
        // Silencioso - Control iD pode estar offline
    }
}

function iniciarPolling() {
    if (pollingTimer) clearInterval(pollingTimer);
    if (config.intervalo > 0) {
        pollingTimer = setInterval(verificarEntradas, config.intervalo * 1000);
    }
}

// ========== PROMOCOES ==========
function carregarPromocoes() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'promocoes.json'), 'utf8');
        return JSON.parse(data).promocoes || [];
    } catch(e) {
        return [];
    }
}

// ========== SERVIDOR HTTP ==========
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Pagina principal
    if (url === '/' || url === '/welcome' || url === '/monitor') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(fs.readFileSync(path.join(__dirname, 'monitor-bemvindo.html')));
        return;
    }

    // Logo da loja
    if (url === '/logo.png' || url === '/logo.jpg' || url === '/logo.jpeg' || url === '/logo.svg') {
        const logoPath = path.join(__dirname, 'public', url);
        if (fs.existsSync(logoPath)) {
            const ext = path.extname(logoPath).toLowerCase();
            const ct = ext === '.svg' ? 'image/svg+xml' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png');
            res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
            res.end(fs.readFileSync(logoPath));
        } else {
            res.writeHead(404);
            res.end('Logo nao encontrado. Coloque o arquivo em public/logo.png');
        }
        return;
    }

    // Arquivos estaticos da pasta public
    if (url.startsWith('/public/')) {
        const filePath = path.join(__dirname, url);
        if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
            const ext = path.extname(filePath).toLowerCase();
            const mime = {
                '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp',
                '.css': 'text/css', '.js': 'application/javascript'
            };
            res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
            res.end(fs.readFileSync(filePath));
        } else {
            res.writeHead(404);
            res.end('404');
        }
        return;
    }

    // SSE stream
    if (url === '/api/monitor/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write(':ok\n\n');
        const cliente = { res: res, finished: false };
        clientesSSE.push(cliente);
        req.on('close', () => { cliente.finished = true; });
        return;
    }

    // Receber configuracao
    if (url === '/api/monitor/config' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const nova = JSON.parse(body);
                Object.assign(config, nova);
                log('CONFIG', JSON.stringify(config));
                iniciarPolling();
            } catch(e) {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, config: config }));
        });
        return;
    }

    // Simular entrada
    if (url === '/api/monitor/simular' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            let nome = 'CLIENTE TESTE';
            try { nome = JSON.parse(body).nome || nome; } catch(e) {}
            enviarWelcome(nome);
            setTimeout(enviarIdle, config.tempo * 1000);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }

    // Promocoes
    if (url === '/api/monitor/promocoes') {
        const promos = carregarPromocoes();
        if (req.method === 'POST') {
            enviarPromocoes();
            setTimeout(enviarIdle, 30000);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, promocoes: promos }));
        return;
    }

    // Forcar idle
    if (url === '/api/monitor/idle') {
        enviarIdle();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // Status
    if (url === '/api/monitor/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, estado: estado, config: config }));
        return;
    }

    res.writeHead(404);
    res.end('404');
});

function getLocalIp() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log('');
    console.log('========================================');
    console.log('  MONITOR DE BOAS-VINDAS - SERVIDOR');
    console.log('========================================');
    console.log('');
    console.log(`  Este computador:   http://localhost:${PORT}`);
    console.log(`  Outros na rede:    http://${ip}:${PORT}`);
    console.log('');
    console.log(`  Stream SSE:        http://${ip}:${PORT}/api/monitor/stream`);
    console.log(`  Status:            http://${ip}:${PORT}/api/monitor/status`);
    console.log('');
    console.log('  Configure o Control iD no painel (tecla C)');
    console.log('');
    iniciarPolling();
});
