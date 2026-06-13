const http = require('http');

function iniciarHealthCheck() {
  const port = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      app: 'Duartly 🦙', 
      uptime: process.uptime() 
    }));
  });

  server.listen(port, () => {
    console.log(`🦙 Health check rodando na porta ${port}`);
  });
}

module.exports = { iniciarHealthCheck };
