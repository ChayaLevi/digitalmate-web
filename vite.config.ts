import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { rssProxyPlugin } from './server/rss';
import { orbitBridgePlugin } from './server/orbit';
import { epicBridgePlugin } from './server/epic';
import { fridgeBridgePlugin } from './server/fridge';
import { homemindBridgePlugin } from './server/homemind';
import { cloudGatePlugin } from './server/cloud';
import { accessGatePlugin } from './server/accessGate';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    base: process.env.VITE_BASE ?? '/',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    // The cloud gate goes first, so a closed bridge (P10) is never reached; then the access code gate (T10.3).
    plugins: [cloudGatePlugin(), accessGatePlugin(), react(), rssProxyPlugin(), orbitBridgePlugin(), epicBridgePlugin(), fridgeBridgePlugin(), homemindBridgePlugin()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    }
  };
});
