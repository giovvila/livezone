import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {stat, realpath} from 'node:fs/promises';
const fail = code => {
    throw Object.assign(Error(code), {code});
};

const TOKEN = /^[a-f0-9]{64}\.(?:ts|m4s|mp4)$/;

export default class DecoderLoopbackOrigin {
    constructor({
        manifest = () => null,
        object = () => null,
        host = '127.0.0.1'
    } = {}) {
        if (
            host !== '127.0.0.1' ||
            typeof manifest !== 'function' ||
            typeof object !== 'function'
        ) {
            fail('LOOPBACK_OPTIONS_INVALID');
        }

        this.host = host;
        this.manifest = manifest;
        this.object = object;
        this.requests = 0;
        this.rejected = 0;
        this.closed = false;
    }

    async start() {
        if (this.server || this.closed) fail('LOOPBACK_ALREADY_STARTED');

        this.server = createServer(async (req, res) => {
            this.requests++;

            if (
                req.method !== 'GET' ||
                typeof req.url !== 'string' ||
                req.url.length > 256
            ) {
                this.rejected++;
                res.writeHead(404);
                return res.end();
            }

            if (req.url === '/input.m3u8') {
                const body = this.manifest();

                if (
                    typeof body !== 'string' ||
                    !body.startsWith('#EXTM3U\n') ||
                    Buffer.byteLength(body) > 131072
                ) {
                    this.rejected++;
                    res.writeHead(503);
                    return res.end();
                }

                res.writeHead(200, {
                    'Content-Type': 'application/vnd.apple.mpegurl',
                    'Content-Length': Buffer.byteLength(body),
                    'Cache-Control': 'no-store'
                });

                return res.end(body);
            }

            const match = /^\/media\/([^/?#]+)$/.exec(req.url);

            if (!match || !TOKEN.test(match[1])) {
                this.rejected++;
                res.writeHead(404);
                return res.end();
            }

            const media = this.object(match[1]);

if (!media || typeof media !== 'object') {
    this.rejected++;
    res.writeHead(404);
    return res.end();
}

if (Buffer.isBuffer(media.body)) {
    if (
        media.body.length < 1 ||
        media.body.length > 16 * 1024 * 1024
    ) {
        this.rejected++;
        res.writeHead(404);
        return res.end();
    }

    res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': media.body.length,
        'Cache-Control': 'no-store'
    });

    return res.end(media.body);
}

if (typeof media.path === 'string') {
    try {
        const actual = await realpath(media.path);
        const info = await stat(actual);

        if (
            !info.isFile() ||
            info.size < 1 ||
            info.size > 16 * 1024 * 1024
        ) {
            throw Error('MEDIA_FILE_INVALID');
        }

        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': info.size,
            'Cache-Control': 'no-store'
        });

        const stream = createReadStream(actual);

        stream.once('error', () => {
            res.destroy();
        });

        stream.pipe(res);
        return;
    } catch {
        this.rejected++;
        res.writeHead(404);
        return res.end();
    }
}

this.rejected++;
res.writeHead(404);
res.end();
        });

        this.server.on('clientError', (error, socket) => socket.destroy());

        await new Promise((resolve, reject) => {
            const onError = error => {
                this.server.off('listening', onListening);
                reject(error);
            };

            const onListening = () => {
                this.server.off('error', onError);
                resolve();
            };

            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(0, this.host);
        });

        const address = this.server.address();

        if (
            !address ||
            typeof address === 'string' ||
            address.address !== this.host
        ) {
            await this.close();
            fail('LOOPBACK_BIND_INVALID');
        }

        this.port = address.port;
        this.url = `http://${this.host}:${this.port}/input.m3u8`;

        return this;
    }

    snapshot() {
        return Object.freeze({
            host: this.host,
            port: this.port ?? null,
            started: Boolean(this.server?.listening),
            closed: this.closed,
            requests: this.requests,
            rejected: this.rejected,
            executionAllowed: false,
            serverTake: false,
            transferReady: false
        });
    }

    async close() {
        if (this.closed) return;

        this.closed = true;

        if (!this.server) return;

        this.server.closeAllConnections?.();

        await new Promise(resolve => {
            this.server.close(() => resolve());
        });
    }
}
