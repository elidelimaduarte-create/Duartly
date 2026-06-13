// src/healthcheck.js
const http = require('http');

function iniciarHealthCheck(bot) {
  const port = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {

    // ── WEBHOOK MERCADO PAGO ──
    if (req.method === 'POST' && req.url === '/webhook/mercadopago') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);
          const { processarWebhook } = require('./handlers/webhookHandler');
          await processarWebhook({ body: payload }, res, bot);
        } catch (err) {
          console.error('Erro no webhook:', err);
          res.writeHead(200);
          res.end(JSON.stringify({ received: true }));
        }
      });
      return;
    }

    // ── HEALTH CHECK ──
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      app: 'Duartly 🦙',
      uptime: process.uptime()
    }));
  });

  server.listen(port, () => {
    console.log(`🦙 Health check + webhook rodando na porta ${port}`);
  });
}

module.exports = { iniciarHealthCheck };
