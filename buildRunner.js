/**
 * buildRunner.js — Smart Build Abstraction
 *
 * Switches between two execution modes based on RUNNER env var:
 *   local  → child_process (git clone + npm on the host OS)
 *            Works on Render free tier, Play with Docker, local dev
 *   docker → spawns an isolated Docker container per build
 *            Requires a VPS with Docker installed
 *
 * Both modes:
 *   1. Clone the GitHub repo
 *   2. Run install command
 *   3. Run build command
 *   4. Copy output to SITES_DIR/subdomain/dist
 *   5. Cleanup temp directory
 */

'use strict';

const { spawn }   = require('child_process');
const path        = require('path');
const fs          = require('fs');

/**
 * Main entry point.
 * @param {Object} opts
 * @param {string} opts.deployId
 * @param {Object} opts.project       — Project document
 * @param {Object} opts.deployment    — Deployment document
 * @param {string} opts.sitesDir      — /var/www/user-sites
 * @param {string} opts.tmpDir        — /tmp/deployboard-builds
 * @param {string} opts.githubToken   — Optional GitHub PAT
 * @param {'local'|'docker'} opts.mode
 * @param {Function} opts.emit        — (event, data) => void  — Socket.io emitter
 * @param {Function} opts.onLog       — (line) => void  — saves to deployment.logs
 */
async function runBuild(opts) {
  if (opts.mode === 'docker') {
    return runDockerBuild(opts);
  }
  return runLocalBuild(opts);
}

// ════════════════════════════════════════════════════════════════════
// LOCAL MODE  (child_process — works on Render / any Linux host)
// ════════════════════════════════════════════════════════════════════
async function runLocalBuild({ deployId, project, sitesDir, tmpDir, githubToken, emit, onLog }) {
  const buildDir  = path.join(tmpDir, deployId);
  const outputDir = path.join(buildDir, project.outputDir || 'dist');
  const destDir   = path.join(sitesDir, project.subdomain, 'dist');

  const log = (line) => { emit('build:log', { line }); onLog(line); };

  // ── Step 1: Clone ───────────────────────────────────────────────
  emit('build:step', { step: { id: 'clone', state: 'active' } });
  log(`\x1b[36m[Step 1/5]\x1b[0m Cloning repository…`);
  log(`\x1b[90m$ git clone --depth=1 --branch=${project.branch||'main'} ${maskToken(project.repoUrl)} ${buildDir}\x1b[0m`);

  // Build authenticated URL if token provided
  const cloneUrl = githubToken
    ? project.repoUrl.replace('https://', `https://${githubToken}@`)
    : project.repoUrl;

  await spawnStream('git', [
    'clone', '--depth=1', '--branch', project.branch||'main',
    cloneUrl, buildDir
  ], { env: { ...process.env } }, log);
  emit('build:step', { step: { id: 'clone', state: 'done' } });
  log(`\x1b[32m[Clone]\x1b[0m Repository cloned successfully.`);

  // ── Step 2: Install ─────────────────────────────────────────────
  emit('build:step', { step: { id: 'install', state: 'active' } });
  log(`\n\x1b[36m[Step 2/5]\x1b[0m Installing dependencies…`);
  const installParts = (project.installCmd || 'npm install').split(/\s+/);
  log(`\x1b[90m$ ${project.installCmd || 'npm install'}\x1b[0m`);
  await spawnStream(installParts[0], installParts.slice(1), {
    cwd: buildDir,
    env: { ...process.env, ...Object.fromEntries(project.envVars||[]) }
  }, log);
  emit('build:step', { step: { id: 'install', state: 'done' } });
  log(`\x1b[32m[Install]\x1b[0m Dependencies installed.`);

  // ── Step 3: Build ───────────────────────────────────────────────
  emit('build:step', { step: { id: 'build', state: 'active' } });
  log(`\n\x1b[36m[Step 3/5]\x1b[0m Building project…`);
  const buildParts = (project.buildCmd || 'npm run build').split(/\s+/);
  log(`\x1b[90m$ ${project.buildCmd || 'npm run build'}\x1b[0m`);
  await spawnStream(buildParts[0], buildParts.slice(1), {
    cwd: buildDir,
    env: { ...process.env, NODE_ENV:'production', ...Object.fromEntries(project.envVars||[]) }
  }, log);
  emit('build:step', { step: { id: 'build', state: 'done' } });
  log(`\x1b[32m[Build]\x1b[0m Build completed.`);

  // ── Step 4: Copy to hosting ─────────────────────────────────────
  emit('build:step', { step: { id: 'copy', state: 'active' } });
  log(`\n\x1b[36m[Step 4/5]\x1b[0m Copying output to hosting directory…`);
  log(`\x1b[90m$ cp -r ${outputDir} ${destDir}\x1b[0m`);
  if (!fs.existsSync(outputDir)) {
    throw new Error(`Build output directory not found: ${project.outputDir}. Check your buildCmd and outputDir settings.`);
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  // Remove old deployment
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  copyDirSync(outputDir, destDir);
  emit('build:step', { step: { id: 'copy', state: 'done' } });
  log(`\x1b[32m[Copy]\x1b[0m Files deployed to ${destDir}`);

  // ── Step 5: Cleanup ─────────────────────────────────────────────
  emit('build:step', { step: { id: 'cleanup', state: 'active' } });
  log(`\n\x1b[36m[Step 5/5]\x1b[0m Cleaning up temporary files…`);
  try {
    fs.rmSync(buildDir, { recursive: true, force: true });
    log(`\x1b[32m[Cleanup]\x1b[0m Removed ${buildDir}`);
  } catch(e) {
    log(`\x1b[33m[Cleanup]\x1b[0m Warning: could not remove temp dir: ${e.message}`);
  }
  emit('build:step', { step: { id: 'cleanup', state: 'done' } });
  log(`\n\x1b[32m✓ Deployment complete!\x1b[0m Your site is live.`);
}

// ════════════════════════════════════════════════════════════════════
// DOCKER MODE  (isolated container per build — for VPS)
// ════════════════════════════════════════════════════════════════════
async function runDockerBuild({ deployId, project, sitesDir, tmpDir, githubToken, emit, onLog }) {
  const buildDir = path.join(tmpDir, deployId);
  const destDir  = path.join(sitesDir, project.subdomain, 'dist');

  const log = (line) => { emit('build:log', { line }); onLog(line); };

  // Build env flags for docker run
  const envFlags = [];
  const envVars  = project.envVars instanceof Map
    ? Object.fromEntries(project.envVars)
    : (project.envVars || {});
  Object.entries(envVars).forEach(([k,v]) => { envFlags.push('-e', `${k}=${v}`); });
  envFlags.push('-e', 'NODE_ENV=production');
  if (githubToken) envFlags.push('-e', `GITHUB_TOKEN=${githubToken}`);

  const nodeImage  = `node:${project.nodeVer||'18'}-alpine`;
  const cloneUrl   = githubToken
    ? project.repoUrl.replace('https://', `https://${githubToken}@`)
    : project.repoUrl;
  const branchArg  = project.branch || 'main';
  const installCmd = project.installCmd || 'npm install';
  const buildCmd   = project.buildCmd   || 'npm run build';
  const outputDir  = project.outputDir  || 'dist';

  // Inline shell script executed inside the container
  const script = [
    `set -e`,
    `echo "[Docker] Node $(node -v)"`,
    `git clone --depth=1 --branch=${branchArg} "${cloneUrl}" /app`,
    `cd /app`,
    `${installCmd}`,
    `${buildCmd}`,
    `cp -r /app/${outputDir} /output/dist`
  ].join(' && ');

  // Ensure output folder exists on host
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  // ── Step 1-4 in one docker run ──────────────────────────────────
  ['clone','install','build','copy'].forEach(s => {
    emit('build:step', { step: { id: s, state: 'active' } });
  });

  log(`\x1b[36m[Docker]\x1b[0m Pulling image ${nodeImage}…`);

  const dockerArgs = [
    'run', '--rm',
    '--name', `deployboard-${deployId.slice(-8)}`,
    '--memory', '512m', '--cpus', '1',
    '-v', `${destDir}:/output/dist`,
    ...envFlags,
    nodeImage,
    'sh', '-c', script
  ];

  log(`\x1b[90m$ docker ${dockerArgs.filter(a => !a.includes('TOKEN')).join(' ')}\x1b[0m`);
  await spawnStream('docker', dockerArgs, {}, log);

  ['clone','install','build','copy'].forEach(s => {
    emit('build:step', { step: { id: s, state: 'done' } });
  });

  // ── Step 5: Cleanup ─────────────────────────────────────────────
  emit('build:step', { step: { id: 'cleanup', state: 'active' } });
  log(`\n\x1b[36m[Step 5/5]\x1b[0m Cleanup complete (Docker handles temp automatically)`);
  emit('build:step', { step: { id: 'cleanup', state: 'done' } });
  log(`\n\x1b[32m✓ Docker deployment complete!\x1b[0m`);
}

// ════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════

/**
 * Spawn a child process and stream stdout/stderr line-by-line to `logFn`.
 * Rejects with the exit code if non-zero.
 */
function spawnStream(cmd, args, options, logFn) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      env:   options.env || process.env,
      cwd:   options.cwd || undefined
    });

    let stderrBuf = '';

    child.stdout.on('data', (chunk) => {
      chunk.toString().split('\n').forEach(l => { if (l) logFn(l); });
    });
    child.stderr.on('data', (chunk) => {
      const str = chunk.toString();
      stderrBuf += str;
      str.split('\n').forEach(l => { if (l) logFn(`\x1b[90m${l}\x1b[0m`); });
    });

    child.on('error', (err) => reject(new Error(`Failed to start ${cmd}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}. ${stderrBuf.slice(-200)}`));
    });
  });
}

/** Recursively copy a directory */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.readdirSync(src).forEach(entry => {
    const srcPath  = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.lstatSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  });
}

/** Remove GitHub token from URL for display */
function maskToken(url) {
  return url.replace(/https:\/\/[^@]+@/, 'https://***@');
}

module.exports = { runBuild };
