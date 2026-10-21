import { createApp } from './app.js';
import { createServer } from 'node:http';
import { attachSuggestionWebSocket } from './suggestionWebSocket.js';

const app = createApp();
const server = createServer(app);
const closeSockets = attachSuggestionWebSocket(server);

// Cloud Run passes the port via the PORT environment variable
const port = parseInt(process.env.PORT || '8080', 10);

// Listen on 0.0.0.0 to accept connections from any network interface in Cloud Run / containers
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Dallas Urbanists API Server running on port ${port}`);
  console.log(`📖 Swagger API documentation available at http://localhost:${port}/docs`);
});

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 8000);
  deadline.unref();
  server.close(() => { void closeSockets().then(() => process.exit(0)); });
  void closeSockets();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
