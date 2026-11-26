import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fetch } from 'undici';

const MIHOMO_URL = 'https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-v1-v1.19.34.gz';
const MIHOMO_GZ_SHA256 = '0c07340a01408d033dda4088ea2a4c1e4d82aeed7b2f84f7c046e93b6ff3290c';

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.2/cloudflared-linux-amd64';
const CLOUDFLARED_SHA256 = '56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf';

async function downloadVerified(url, expectedSha256, destPath, isGzip = false) {
  console.log(`[bootstrap] Downloading ${path.basename(destPath)} from official release...`);
  const resp = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!resp.ok) throw new Error(`Download HTTP ${resp.status} for ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const actualSha = crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
  if (actualSha !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha}`);
  }
  const output = isGzip ? zlib.gunzipSync(buf) : buf;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp`;
  fs.writeFileSync(tmpPath, output, { mode: 0o755 });
  fs.chmodSync(tmpPath, 0o755);
  fs.renameSync(tmpPath, destPath);
  console.log(`[bootstrap] Verified and installed ${destPath}`);
}

export async function ensureServerBinaries(binDir, needCloudflared = false) {
  if (process.env.MIHOMO_BIN && fs.existsSync(process.env.MIHOMO_BIN)) {
    return { mihomoBin: process.env.MIHOMO_BIN, cloudflaredBin: null };
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error(`Auto-bootstrap only supports linux/x64; set MIHOMO_BIN on ${process.platform}/${process.arch}`);
  }

  const mihomoBin = path.join(binDir, 'mihomo');
  const mihomoVerFile = path.join(binDir, 'mihomo.version');
  const curVer = fs.existsSync(mihomoVerFile) ? fs.readFileSync(mihomoVerFile, 'utf8').trim() : '';
  if (!fs.existsSync(mihomoBin) || curVer !== 'v1.19.34') {
    await downloadVerified(MIHOMO_URL, MIHOMO_GZ_SHA256, mihomoBin, true);
    fs.writeFileSync(mihomoVerFile, 'v1.19.34\n', 'utf8');
  }

  let cloudflaredBin = null;
  if (needCloudflared) {
    cloudflaredBin = path.join(binDir, 'cloudflared');
    const cfVerFile = path.join(binDir, 'cloudflared.version');
    const curCf = fs.existsSync(cfVerFile) ? fs.readFileSync(cfVerFile, 'utf8').trim() : '';
    if (!fs.existsSync(cloudflaredBin) || curCf !== '2026.11.2') {
      await downloadVerified(CLOUDFLARED_URL, CLOUDFLARED_SHA256, cloudflaredBin, false);
      fs.writeFileSync(cfVerFile, '2026.11.2\n', 'utf8');
    }
  }

  return { mihomoBin, cloudflaredBin };
}
