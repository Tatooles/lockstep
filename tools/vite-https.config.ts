// The dev server over HTTPS, for testing on a phone on the LAN. Safari only
// JIT-compiles JavaScript and WebAssembly in secure contexts, and a plain
// http://<LAN IP> page isn't one (http://localhost is), so emulator speed
// measured over plain HTTP on an iPhone is interpreter speed.
//   mkdir -p tools/out/cert && openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
//     -keyout tools/out/cert/key.pem -out tools/out/cert/cert.pem -subj /CN=lockstep-dev \
//     -addext "subjectAltName=IP:<LAN IP>,DNS:localhost"
//   pnpm vite --config tools/vite-https.config.ts
// The certificate is self-signed: accept the warning on the phone once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, mergeConfig } from 'vite';
import base from '../vite.config.ts';

const cert = join(import.meta.dirname, 'out', 'cert');

export default mergeConfig(
  base,
  defineConfig({
    root: join(import.meta.dirname, '..'),
    server: {
      host: true,
      port: 5175,
      strictPort: true,
      https: { key: readFileSync(join(cert, 'key.pem')), cert: readFileSync(join(cert, 'cert.pem')) },
    },
  }),
);
