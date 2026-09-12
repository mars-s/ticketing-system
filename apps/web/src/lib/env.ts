function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  betterAuthSecret: required('BETTER_AUTH_SECRET'),
  betterAuthUrl: required('BETTER_AUTH_URL'),
  authentikIssuer: required('AUTHENTIK_ISSUER'),
  authentikClientId: required('AUTHENTIK_CLIENT_ID'),
  authentikClientSecret: required('AUTHENTIK_CLIENT_SECRET'),
  authentikApiToken: required('AUTHENTIK_API_TOKEN'),
  adminGroups: (process.env.ADMIN_GROUPS ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean),
  internalApiSecret: required('INTERNAL_API_SECRET'),
  directoryServiceApiUrl: required('DIRECTORY_SERVICE_API_URL'),
  directoryServiceApiKey: required('DIRECTORY_SERVICE_API_KEY'),
  uptimeKumaWebhookSecret: required('UPTIME_KUMA_WEBHOOK_SECRET'),
  publicAppUrl: required('PUBLIC_APP_URL'),
  s3Endpoint: required('S3_ENDPOINT'),
  s3InternalEndpoint: process.env.S3_INTERNAL_ENDPOINT ?? required('S3_ENDPOINT'),
  s3Region: process.env.S3_REGION ?? 'us-east-1',
  s3Bucket: required('S3_BUCKET'),
  s3AccessKeyId: required('S3_ACCESS_KEY_ID'),
  s3SecretAccessKey: required('S3_SECRET_ACCESS_KEY'),
  s3ForcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  // Shared app-wide export credentials -- optional (unset = that target is unavailable for
  // every group, PATCH .../export-config rejects enabling it). See
  // docs/ticket-group-external-export-plan.md section 0 for why these are app-wide rather
  // than per-group: a group only supplies a database/spreadsheet id and shares it with the
  // integration/service account named here.
  notionIntegrationToken: process.env.NOTION_INTEGRATION_TOKEN,
  /** Raw service account JSON (the file contents), not a path. */
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
};
