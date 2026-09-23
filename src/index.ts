import { createApp } from './app.js';

const app = createApp();

// Cloud Run passes the port via the PORT environment variable
const port = parseInt(process.env.PORT || '8080', 10);

// Listen on 0.0.0.0 to accept connections from any network interface in Cloud Run / containers
app.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Dallas Urbanists API Server running on port ${port}`);
  console.log(`📖 Swagger API documentation available at http://localhost:${port}/docs`);
});
