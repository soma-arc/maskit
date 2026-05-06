import dns from 'node:dns';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

dns.setDefaultResultOrder('verbatim');

export default defineConfig({
    server: {
        host: '127.0.0.1',
    },
    build: {
        rollupOptions: {
            input: {
                main: resolve(__dirname, 'index.html'),
                webgl: resolve(__dirname, 'webgl.html'),
            },
        },
    },
});
