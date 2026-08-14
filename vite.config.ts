import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;
const cloudflareDatabaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
const cloudflareR2BucketName = process.env.CLOUDFLARE_R2_BUCKET_NAME?.trim();
const isCloudflareDeployment = Boolean(cloudflareDatabaseId);

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  vars: isCloudflareDeployment ? { PORTAL_BASE_URL: "https://pravdop-management-portal.simonian-e-be8.workers.dev" } : {},
  triggers: { crons: ["0 7 * * *"] },
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: isCloudflareDeployment ? "u-portal-db" : "site-creator-d1",
          database_id:
            cloudflareDatabaseId || SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  // Keep a local Miniflare bucket for development. Remote deployments only
  // receive R2 when an explicit bucket name is provided, so a free pilot can
  // run without enabling Cloudflare's usage-based R2 subscription.
  r2_buckets: r2 && (!isCloudflareDeployment || cloudflareR2BucketName)
    ? [
        {
          binding: r2,
          bucket_name: cloudflareR2BucketName || "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
