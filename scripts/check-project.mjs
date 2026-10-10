import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const manifestPath = join(root, 'manifest.json');
const packagePath = join(root, 'package.json');

function checkFile(relative, source) {
  if (!existsSync(join(root, relative))) errors.push(`${source} references missing file: ${relative}`);
}

function walk(dir) {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (['.git', 'node_modules', '__pycache__'].includes(entry)) continue;
      result.push(...walk(full));
    } else {
      result.push(full);
    }
  }
  return result;
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`Invalid manifest.json: ${error.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
try {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (pkg.version !== manifest.version) errors.push(`package.json version (${pkg.version}) does not match manifest version (${manifest.version})`);
  if (!pkg.scripts?.test || !pkg.scripts?.check) errors.push('package.json must define test and check scripts');
} catch (error) {
  errors.push(`Invalid package.json: ${error.message}`);
}
for (const permission of ['storage', 'offscreen', 'tabs', 'scripting']) {
  if (!manifest.permissions?.includes(permission)) errors.push(`required permission missing: ${permission}`);
}
checkFile(manifest.background?.service_worker, 'manifest background');
checkFile(manifest.action?.default_popup, 'manifest popup');
for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) checkFile(file, 'manifest content_scripts');
}
const contentScript = manifest.content_scripts?.find(script => script.js?.includes('content.js'));
if (!contentScript || contentScript.js[0] !== 'src/site-routing.js') {
  errors.push('content_scripts must load src/site-routing.js before content.js');
}
for (const pattern of [
  '*://instagram.com/*', '*://www.instagram.com/*',
  '*://tiktok.com/*', '*://www.tiktok.com/*',
  '*://youtube.com/*', '*://www.youtube.com/*',
]) {
  if (!contentScript?.matches?.includes(pattern)) errors.push(`content_scripts missing host pattern: ${pattern}`);
  if (!manifest.host_permissions?.includes(pattern)) errors.push(`host_permissions missing pattern: ${pattern}`);
}
for (const file of Object.values(manifest.icons || {})) checkFile(file, 'manifest icons');
for (const page of manifest.sandbox?.pages || []) checkFile(page, 'manifest sandbox');

const files = walk(root);
for (const file of files.filter(file => /\.html?$/i.test(file))) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
    const ref = match[1];
    if (/^(?:[a-z]+:|#|\/\/)/i.test(ref)) continue;
    const local = ref.split(/[?#]/, 1)[0];
    if (!local) continue;
    checkFile(resolve(dirname(file), local).replace(root + '/', ''), file.replace(root + '/', ''));
  }
  if (/\son(?:click|load|error|change|submit)\s*=/i.test(html)) {
    errors.push(`${file.replace(root + '/', '')} contains inline event handlers blocked by extension CSP`);
  }
}

const backgroundJs = readFileSync(join(root, 'background.js'), 'utf8');
if (!backgroundJs.includes("importScripts('src/site-routing.js')")) {
  errors.push('background service worker must load the shared site-routing helper');
}
if (!backgroundJs.includes('ensureFeedContentScript(activeTab')) {
  errors.push('GET_STATE must be able to recover content-script injection on the active feed');
}
if (!backgroundJs.includes('BlinkScrollRouting.resolveCameraTarget')) {
  errors.push('camera target must be derived from the active tab URL, not a feed heartbeat Set');
}
if (!backgroundJs.includes('status.cameraOn || status.cameraStarting')) {
  errors.push('active feed sync must verify actual camera status before skipping a start');
}
if (!backgroundJs.includes("case 'RETRY_CAMERA'")) {
  errors.push('popup camera recovery must have an explicit retry message handler');
}
if (/if\s*\(\s*!browserFocused\s*\)/.test(readFileSync(join(root, 'src/site-routing.js'), 'utf8'))) {
  errors.push('camera eligibility must not be gated by browser focus or action-popup visibility');
}
if (!/if \(windowId === chrome\.windows\.WINDOW_ID_NONE\) return;/.test(backgroundJs)) {
  errors.push('WINDOW_ID_NONE focus transitions must not stop the active feed camera');
}

const offscreenJs = readFileSync(join(root, 'offscreen.js'), 'utf8');
if (!offscreenJs.includes('cameraGeneration') || !offscreenJs.includes('generation !== cameraGeneration')) {
  errors.push('camera lifecycle must invalidate stale async getUserMedia starts when tabs change');
}
if (!offscreenJs.includes('bitmap.close()') || !offscreenJs.includes('inFlightGeneration === generation')) {
  errors.push('camera detection loop must release image frames and ignore stale-generation results');
}
const popupJs = readFileSync(join(root, 'popup.js'), 'utf8');
if (!popupJs.includes("type: 'RETRY_CAMERA'")) errors.push('popup must expose camera retry flow');
if ((offscreenJs.match(/^init\(\);?$/gm) || []).length !== 1) {
  errors.push('offscreen.js must call init() exactly once');
}
if (/init\(\)\.catch\(/.test(offscreenJs)) errors.push('offscreen.js calls .catch() on the synchronous init() result');

const jsFiles = files.filter(file => /\.(?:m?js)$/i.test(file));
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    errors.push(`JavaScript syntax error in ${file.replace(root + '/', '')}: ${(result.stderr || result.stdout).trim()}`);
  }
}

const pyFiles = files.filter(file => /\.py$/i.test(file));
for (const file of pyFiles) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(python, ['-m', 'py_compile', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    errors.push(`Python syntax error in ${file.replace(root + '/', '')}: ${(result.stderr || result.stdout).trim()}`);
  }
}

if (errors.length) {
  console.error(`Project checks failed (${errors.length} issue${errors.length === 1 ? '' : 's'}):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Project checks passed: manifest, local references, CSP handlers, and syntax (${jsFiles.length} JS/MJS, ${pyFiles.length} Python files).`);
