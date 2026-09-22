import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative, isAbsolute, resolve} from 'node:path';
import {spawnOptions, verifyBackend} from '../server/autolive/decoder/FFmpegHealthWorker.js';

// Reviewed machine-local binary, used in place. No PATH lookup, binary copy or automatic download.
export const LOCAL_BACKEND = Object.freeze({
    path: 'C:\\Program Files (x86)\\Common Files\\Axel Technology\\Utility\\FFMpeg\\ffmpeg.exe',
    digest: '574845e3507616421c34ae6d556c72519b1aff6fde33f094b066896c0604d743'
});
export async function generate(args, {cwd} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(LOCAL_BACKEND.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], {...spawnOptions(), ...(cwd ? {cwd} : {})});
        let bytes = 0, diagnostic = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        const drain = data => { bytes += data.length; diagnostic = (diagnostic + data.toString()).slice(-2048); if (bytes > 65536) child.kill('SIGKILL'); };
        child.stdout.on('data', drain); child.stderr.on('data', drain); child.stdin.end();
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`FIXTURE_GENERATION_FAILED_${code}: ${diagnostic}`)); });
    });
}
export async function fixtures() {
    const backend = await verifyBackend(LOCAL_BACKEND);
    const root = await mkdtemp(join(tmpdir(), 'lz-decoder-fixtures-'));
    const paths = Object.fromEntries(['av', 'audio', 'video', 'stall', 'malformed'].map(k => [k, join(root, `${k}.mkv`)]));
    const video = ['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=4'];
    const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=4'];
    const close = async () => {
        const rel = relative(resolve(tmpdir()), resolve(root));
        if (isAbsolute(rel) || rel.startsWith('..') || !rel.startsWith('lz-decoder-fixtures-')) throw Error('UNSAFE_FIXTURE_CLEANUP');
        await rm(root, {recursive: true, force: true});
    };
    try {
        await generate([...video, ...audio, '-c:v', 'ffv1', '-c:a', 'pcm_s16le', paths.av]);
        await generate([...audio, '-c:a', 'pcm_s16le', paths.audio]);
        await generate([...video, '-c:v', 'ffv1', paths.video]);
        await generate(['-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=4:duration=2',
            '-vf', "setpts='PTS+if(gte(N,4),7/TB,0)'", '-vsync', '0', '-c:v', 'ffv1', paths.stall]);
        await writeFile(paths.malformed, 'Not a media container. Local bounded negative fixture.');
        return {root, paths, backend, close};
    } catch (error) { await close(); throw error; }
}
export function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
