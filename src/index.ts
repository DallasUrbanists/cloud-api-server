import { createApp } from './app.js';
import { createServer } from 'node:http';
import { attachSuggestionWebSocket } from './suggestionWebSocket.js';
import { PresentationWebSocketServer } from './presentationWebSocket.js';
import { PresentationService } from './services/presentationService.js';
import { FirestorePresentationStore } from './services/presentationStore.js';
import { getPublicImprovementsDb } from './config/firestore.js';
import { deploymentConfig } from './config/deployment.js';

const { environment, database, bucket, buildCommit, revision } = deploymentConfig();
console.info(JSON.stringify({ event: 'deployment_identity', environment, database, bucket, buildCommit, revision }));

const presentationService = new PresentationService(new FirestorePresentationStore(getPublicImprovementsDb()));
const app = createApp({ presentationService });
const server = createServer(app);
const presentationSockets = new PresentationWebSocketServer(presentationService);
const closeSockets = attachSuggestionWebSocket(server, { presentation: presentationSockets });

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
  void closeSockets().finally(() => server.close(() => process.exit(0)));
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
