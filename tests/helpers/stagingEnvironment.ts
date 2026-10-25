export const stagingEnv = {
  DEPLOY_ENV: 'staging', NODE_ENV: 'production', GOOGLE_CLOUD_PROJECT: 'urbanists-mixer-slides-helper',
  PUBLIC_IMPROVEMENTS_DB: 'public-improvements-staging', ASSIST_QUOTA_DB: 'public-improvements-staging',
  IDEAS_DATA_LAYOUT: 'legacy', IDEA_PHOTOS_BUCKET: 'urbanists-suggestion-photos-staging-143738155808',
  DB_NAME: 'urbanists_staging', DB_USER: 'urbanists_staging', DB_PASSWORD: 'test-only-password',
  INSTANCE_CONNECTION_NAME: 'urbanists-mixer-slides-helper:us-south1:contacts-relationships-db',
  ALLOWED_ORIGINS: 'https://map-staging-143738155808.web.app', BUILD_COMMIT: 'a'.repeat(40),
  API_KEYS_JSON: '[{"key":"test-only-key","name":"test"}]',
  BOUNDARY_SYNC_ENABLED: 'false', STREETMIX_ENABLED: 'false', PRESENTATION_ENABLED: 'false', PRESENTATION_WEBSOCKET_ENABLED: 'false',
};
