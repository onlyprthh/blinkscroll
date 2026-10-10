import { spawnSync } from 'node:child_process';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

let exitCode = run(process.execPath, ['--test', 'test/engine.test.mjs', 'test/site-routing.test.mjs', 'test/camera-lifecycle.test.mjs']);
if (exitCode !== 0) process.exit(exitCode);

const pythonCandidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
let pythonRan = false;
for (const python of pythonCandidates) {
  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) continue;
  exitCode = run(python, ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py', '-v']);
  pythonRan = true;
  break;
}
if (!pythonRan) {
  console.error('Python was not found; installer regression tests could not run.');
  process.exit(1);
}
process.exit(exitCode);
