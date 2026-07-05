import http from 'node:http';

export class HealthServer {
  constructor(port, bridge) {
    this.port = port;
    this.bridge = bridge;
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, () => {
        console.log(`[health] server listening on port ${this.port}`);
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  handleRequest(req, res) {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      const healthy = this.bridge?.isHealthy() ?? false;
      res.statusCode = healthy ? 200 : 503;
      res.end(JSON.stringify({ healthy }, null, 2));
      return;
    }

    if (req.method === 'GET' && req.url === '/status') {
      const status = this.bridge?.getStatus() ?? {};
      res.statusCode = 200;
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        try {
          this.server.closeIdleConnections?.();
        } catch {
          // ignore
        }
        this.server.close(resolve);
        // Fallback: force resolve after 5 seconds if close hangs on keep-alive
        setTimeout(resolve, 5000);
      } else {
        resolve();
      }
    });
  }
}
