import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            'libsodium-wrappers': path.resolve(__dirname, 'node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js'),
            'libsodium': path.resolve(__dirname, 'node_modules/libsodium/dist/modules/libsodium.js')
        }
    },
    build: {
        manifest: false,
        rollupOptions: {
            input: {
                index: path.resolve(__dirname, 'index.html'),
                'monitor-bootstrap': path.resolve(__dirname, 'src/monitor-bootstrap.ts')
            },
            treeshake: false,
            output: {
                entryFileNames: `[name].js`,
                chunkFileNames: `[name].js`,
                assetFileNames: `[name].[ext]`,
            }
        }
    },
})