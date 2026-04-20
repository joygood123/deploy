/**
 * buildRunner.js — Smart Build Abstraction
 *
 * LOCAL mode  → child_process (works on Render, Play with Docker, local dev)
 * DOCKER mode → isolated container per build (requires VPS with Docker)
 *
 * Key fixes vs v1:
 *  - git writes progress to stderr, not stdout — we show ALL output
 *  - envVars can be a Mongoose Map or plain object — handled both
 *  - Branch fallback: tries 'main' then 'master' automatically
 *  - Every line is emitted immediately (no buffering)
 *  - Clear error messages that explain what went wrong
 *  - buildDir is cleaned up on failure AND success
 */

'use strict';

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');

// ── Main entry point ─────────────────────────────────────────────────────────
async function runBuild(opts) {
  // appPort: the assigned port for server apps (passed from server.js)
  // This is set on the project so runStartAndCleanup can use it
  if (opts.appPort && opts.project) {
    opts.project._assignedPort = opts.appPort;
  }
  return opts.mode === 'docker'
    ? runDockerBuild(opts)
    : runLocalBuild(opts);
}

// ════════════════════════════════════════════════════════════════════════════
// LOCAL MODE  —  child_process on the host
// ════════════════════════════════════════════════════════════════════════════
async function runLocalBuild({ deployId, project, sitesDir, tmpDir, githubToken, emit, onLog }) {
  const buildDir  = path.join(tmpDir, deployId);
  const destDir   = path.join(sitesDir, project.subdomain, 'dist');
  // outputDir is relative to the project root (detected after clone)
  // We set this after clone when we know the actual projectRoot
  let outputDir;

  // Helper: emit a line to the terminal AND save it to the deployment log
  const log = (line) => {
    emit('build:log', { line });
    if (typeof onLog === 'function') onLog(line);
    // Yield to event loop after every log line so Socket.io can flush immediately
    // This is what makes logs stream smoothly instead of appearing in chunks
    setImmediate(() => {});
  };

  // Helper: convert Mongoose Map or plain object to a plain JS object
  const resolveEnvVars = (evars) => {
    if (!evars) return {};
    if (typeof evars.toObject === 'function') return evars.toObject(); // Mongoose Map
    if (evars instanceof Map) return Object.fromEntries(evars);         // native Map
    return evars;                                                        // plain object
  };
  const envObj = resolveEnvVars(project.envVars);

  // ── Step 1: Clone ───────────────────────────────────────────────────────
  emitStep(emit, 'clone', 'active');
  log(`\x1b[36m━━━ Step 1/5 — Clone Repository ━━━\x1b[0m`);

  // Clean up any previous failed build at this path
  if (fs.existsSync(buildDir)) {
    log(`\x1b[90m[cleanup] Removing stale build dir from previous attempt…\x1b[0m`);
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });

  // Build the authenticated clone URL
  let cloneUrl = project.repoUrl.trim();
  if (!cloneUrl.startsWith('http')) {
    throw new Error(`Invalid repo URL: "${cloneUrl}". Must start with https://`);
  }
  if (githubToken) {
    cloneUrl = cloneUrl.replace(/^https:\/\//, `https://${githubToken}@`);
  }

  // Try specified branch, fall back to master
  const branch = (project.branch || 'main').trim();
  const fallbackBranch = branch === 'main' ? 'master' : 'main';
  let clonedBranch = branch;

  log(`\x1b[90m$ git clone --depth=1 --branch ${branch} ${maskToken(project.repoUrl, githubToken)} ${buildDir}\x1b[0m`);

  try {
    await exec('git', [
      'clone', '--depth=1',
      '--branch', branch,
      '--single-branch',
      '--progress',         // Forces git to write progress to stderr (we show it)
      cloneUrl, buildDir
    ], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, log);

  } catch (cloneErr) {
    // Branch might not exist — try fallback
    if (cloneErr.message.includes('not found') ||
        cloneErr.message.includes('not exist') ||
        cloneErr.message.includes("Remote branch") ||
        cloneErr.message.includes('Could not find')) {

      log(`\x1b[33m[clone] Branch "${branch}" not found — trying "${fallbackBranch}"…\x1b[0m`);
      clonedBranch = fallbackBranch;
      // Remove the failed partial clone
      fs.rmSync(buildDir, { recursive: true, force: true });
      fs.mkdirSync(buildDir, { recursive: true });

      await exec('git', [
        'clone', '--depth=1',
        '--branch', fallbackBranch,
        '--single-branch',
        '--progress',
        cloneUrl, buildDir
      ], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, log);
    } else {
      // Real error (bad URL, auth fail, network) — throw with clear message
      const hint = cloneErr.message.includes('Authentication') || cloneErr.message.includes('403')
        ? '\x1b[33mHint: This looks like a private repo. Add your GITHUB_TOKEN in Settings.\x1b[0m'
        : cloneErr.message.includes('not found') || cloneErr.message.includes('404')
        ? '\x1b[33mHint: Check your repo URL — the repo may not exist or may be private.\x1b[0m'
        : '';
      if (hint) log(hint);
      throw cloneErr;
    }
  }

  emitStep(emit, 'clone', 'done');
  log(`\x1b[32m[clone] Cloned branch "${clonedBranch}" successfully.\x1b[0m`);

  // ── Detect actual project root (handles monorepos / nested projects) ────
  // Some repos clone with package.json NOT at root level.
  // Walk up to 2 levels deep to find the real package.json location.
  let projectRoot = buildDir;
  const pkgAtRoot = path.join(buildDir, 'package.json');
  if (!fs.existsSync(pkgAtRoot)) {
    log(`\x1b[33m[info] No package.json at repo root — searching subdirectories…\x1b[0m`);
    const entries = fs.readdirSync(buildDir);
    let found = false;
    for (const entry of entries) {
      const sub = path.join(buildDir, entry);
      if (fs.statSync(sub).isDirectory()) {
        const subPkg = path.join(sub, 'package.json');
        if (fs.existsSync(subPkg)) {
          projectRoot = sub;
          log(`\x1b[32m[info] Found package.json in subdirectory: ${entry}/\x1b[0m`);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      log(`\x1b[33m[warning] No package.json found anywhere in the repo.\x1b[0m`);
      log(`\x1b[33m[warning] Files found: ${entries.slice(0,12).join(', ')}\x1b[0m`);
    }
  } else {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgAtRoot, 'utf8'));
      log(`\x1b[90m[info] Package: ${pkg.name || '(unnamed)'} v${pkg.version || '?'}\x1b[0m`);
    } catch(e) {}
  }

  // Now that we know projectRoot, set the outputDir correctly
  outputDir = path.join(projectRoot, project.outputDir || 'dist');

  // ── Step 2: Install ─────────────────────────────────────────────────────
  emitStep(emit, 'install', 'active');
  log(`\n\x1b[36m━━━ Step 2/5 — Install Dependencies ━━━\x1b[0m`);
  const installCmd = project.installCmd || 'npm install';
  log(`\x1b[90m$ ${installCmd}\x1b[0m`);

  // Determine install flags
  // devDependencies MUST be installed for build tools like tsc, vite, webpack.
  // We force this regardless of what command the user entered, by:
  //   - Setting NODE_ENV=development (npm skips devDeps when NODE_ENV=production)
  //   - Appending --include=dev if the command is npm install
  let finalInstallCmd = installCmd;
  const isNpmInstall  = /^npm\s+(install|i)/.test(installCmd.trim());
  const isYarnInstall = /^yarn(\s+install)?\s*$/.test(installCmd.trim());
  if (isNpmInstall && !installCmd.includes('--omit') && !installCmd.includes('--only')) {
    // Ensure devDeps are included — critical for TypeScript, Vite, Webpack, etc.
    if (!installCmd.includes('--include=dev')) {
      finalInstallCmd = installCmd.trim() + ' --include=dev';
    }
  }
  log(`[90m$ ${finalInstallCmd}[0m`);
  const installParts = splitCmd(finalInstallCmd);
  await exec(installParts[0], installParts.slice(1), {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...envObj,
      // NODE_ENV=development ensures npm does not skip devDependencies
      NODE_ENV: 'development',
      CI: 'false',  // don't treat warnings as errors during install
      NPM_CONFIG_PROGRESS: 'true'
    }
  }, log);

  emitStep(emit, 'install', 'done');
  log(`\x1b[32m[install] Dependencies installed.\x1b[0m`);

  // ── Step 3: Build ────────────────────────────────────────────────────────
  emitStep(emit, 'build', 'active');
  log(`\n\x1b[36m━━━ Step 3/5 — Build Project ━━━\x1b[0m`);
  const buildCmd = project.buildCmd || 'npm run build';

  // ── Pre-flight: check that the build script exists in package.json ────────
  const pkgJsonPath = path.join(projectRoot, 'package.json');
  if (buildCmd.startsWith('npm run') && fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const scriptName = buildCmd.replace('npm run', '').trim().split(' ')[0];
      const availableScripts = Object.keys(pkg.scripts || {});
      if (!pkg.scripts || !pkg.scripts[scriptName]) {
        log(`\x1b[31m[error] Script "${scriptName}" not found in package.json\x1b[0m`);
        log(`\x1b[33m[hint] Available scripts: ${availableScripts.join(', ') || '(none)'}\x1b[0m`);
        log(`\x1b[33m[hint] Go back to New Deployment and change the Build Command to one of the above,\x1b[0m`);
        log(`\x1b[33m[hint] or use "echo skip" if this project has no build step.\x1b[0m`);
        throw new Error(
          `Script "${scriptName}" not found in package.json. ` +
          `Available: ${availableScripts.join(', ') || 'none'}. ` +
          `Check your Build Command in New Deployment settings.`
        );
      }
      // Read the script value and check if it uses tsc, nx, vite etc directly
      // If so, prepend PATH to include node_modules/.bin automatically
      const scriptVal = pkg.scripts[scriptName] || '';
      const localBinTools = ['tsc', 'nx', 'ng', 'vite', 'webpack', 'rollup', 'parcel', 'esbuild', 'turbo'];
      const usesLocalTool = localBinTools.some(t =>
        scriptVal.includes(`${t} `) || scriptVal === t || scriptVal.endsWith(` ${t}`)
      );
      if (usesLocalTool) {
        log(`\x1b[90m[info] Build script uses a local tool — setting PATH to include node_modules/.bin\x1b[0m`);
      }
    } catch (pkgErr) {
      if (pkgErr.message.includes('Script')) throw pkgErr;
      log(`\x1b[33m[warning] Could not parse package.json: ${pkgErr.message}\x1b[0m`);
    }
  }

  log(`\x1b[90m$ ${buildCmd}\x1b[0m`);

  // Add node_modules/.bin to PATH so local tools (tsc, vite, nx etc.) work
  // without needing to be globally installed — this is the correct production approach
  const localBin = path.join(projectRoot, 'node_modules', '.bin');
  const buildEnvPath = localBin + ':' + (process.env.PATH || '');

  const buildParts = splitCmd(buildCmd);
  await exec(buildParts[0], buildParts.slice(1), {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...envObj,
      PATH: buildEnvPath,   // node_modules/.bin first so local tools take priority
      NODE_ENV: 'production',
      CI: 'false'           // Some bundlers (CRA) treat CI=true as fatal warnings
    }
  }, log);

  emitStep(emit, 'build', 'done');
  log(`\x1b[32m[build] Build completed.\x1b[0m`);

  // ── Step 4: Copy output ──────────────────────────────────────────────────
  emitStep(emit, 'copy', 'active');
  log(`\n\x1b[36m━━━ Step 4/5 — Copy to Hosting ━━━\x1b[0m`);

  const isServerApp = (project.siteType === 'server') || !!(project.startCmd || '').trim();

  // ── SERVER APPS: always copy the entire project to a PERMANENT app dir ───
  // CRITICAL FIX: we must start pm2 from the DEPLOYED directory, not from the
  // temp buildDir — buildDir gets deleted in cleanup, which was crashing the app.
  // This handles ALL server apps: Express, Fastify, Next.js SSR, etc.
  if (isServerApp) {
    const serverDestDir = path.join(sitesDir, project.subdomain, 'app');
    log(`\x1b[90m[copy] Server app — deploying full project to ${serverDestDir}\x1b[0m`);
    if (fs.existsSync(serverDestDir)) {
      fs.rmSync(serverDestDir, { recursive: true, force: true });
    }
    fs.mkdirSync(serverDestDir, { recursive: true });
    copyDirSync(projectRoot, serverDestDir);
    emitStep(emit, 'copy', 'done');
    log(`\x1b[32m[copy] \u2713 Full app deployed to ${serverDestDir}\x1b[0m`);
    if (project._assignedPort) {
      log(`\x1b[90m[info] App will listen on PORT=${project._assignedPort} — DeployBoard proxies this\x1b[0m`);
    }
    // Pass serverDestDir as projectRoot so pm2 runs from the permanent location
    return await runStartAndCleanup({
      project,
      projectRoot: serverDestDir,
      buildDir,
      emit, log, onLog, envObj
    });
  }

  // ── STATIC SITES: verify build output exists, then copy only outputDir ───
  if (!fs.existsSync(outputDir)) {
    // Show what IS in the build dir to help debug
    const dirs = fs.readdirSync(buildDir).filter(f =>
      fs.statSync(path.join(buildDir, f)).isDirectory()
    );
    log(`\x1b[31m[error] Output dir not found: "${project.outputDir || 'dist'}"\x1b[0m`);
    log(`\x1b[33m[hint] Directories in repo: ${dirs.join(', ') || '(none)'}\x1b[0m`);
    log(`\x1b[33m[hint] Try changing "Output Directory" to one of the folders above.\x1b[0m`);
    throw new Error(
      `Build output directory "${project.outputDir||'dist'}" was not created. ` +
      `Check your build command. Available dirs: ${dirs.join(', ') || 'none'}`
    );
  }

  const outFiles = countFiles(outputDir);
  log(`\x1b[90m[copy] Output: ${outFiles} files in ${outputDir}\x1b[0m`);
  log(`\x1b[90m[copy] Destination: ${destDir}\x1b[0m`);

  // ── Create destination directory safely ─────────────────────────────────
  // /var/www/user-sites may not exist and may be owned by root.
  // We always try to create the full path. If it fails with EACCES,
  // we automatically switch to a writable fallback under /tmp.
  let finalDestDir = destDir;
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (mkErr) {
    if (mkErr.code === 'EACCES' || mkErr.code === 'EPERM') {
      const fallback = path.join(
        process.env.TMP_SITES_FALLBACK || '/tmp/user-sites',
        project.subdomain, 'dist'
      );
      log(`\x1b[33m[copy] Warning: No write permission to ${destDir}\x1b[0m`);
      log(`\x1b[33m[copy] Falling back to writable path: ${fallback}\x1b[0m`);
      log(`\x1b[33m[copy] Tip: To fix this permanently run:\x1b[0m`);
      log(`\x1b[33m[copy]   sudo mkdir -p ${sitesDir} && sudo chown -R $(whoami) ${sitesDir}\x1b[0m`);
      fs.mkdirSync(fallback, { recursive: true });
      finalDestDir = fallback;
    } else {
      throw mkErr;
    }
  }

  if (fs.existsSync(finalDestDir) && finalDestDir !== destDir) {
    // already created above
  } else if (fs.existsSync(finalDestDir)) {
    fs.rmSync(finalDestDir, { recursive: true, force: true });
    fs.mkdirSync(finalDestDir, { recursive: true });
  }

  copyDirSync(outputDir, finalDestDir);

  emitStep(emit, 'copy', 'done');
  log(`\x1b[32m[copy] ${outFiles} files deployed to ${finalDestDir}\x1b[0m`);

  // ── Steps 5+6: Start command + Cleanup (shared helper) ─────────────────
  await runStartAndCleanup({ project, projectRoot, buildDir, emit, log, onLog, envObj });
}

// ── Helper: run start command + cleanup (shared by static + server app paths) ─
async function runStartAndCleanup({ project, projectRoot, buildDir, emit, log, onLog, envObj }) {
  const startCmd = (project.startCmd || '').trim();
  if (startCmd) {
    emitStep(emit, 'start', 'active');
    log(`\n\x1b[36m━━━ Step 5/6 — Start Command ━━━\x1b[0m`);

    const assignedPort = String(project._assignedPort || 3000);
    const appName      = `db-${project.subdomain}`;
    const localBin     = path.join(projectRoot, 'node_modules', '.bin');

    // Build env for the app — PORT is the most important var
    const appEnv = {
      NODE_ENV: 'production',
      PORT: assignedPort,
      PATH: localBin + ':' + (process.env.PATH || ''),
      ...envObj,
      // Always override PORT last so user envVars can't accidentally shadow it
      PORT: assignedPort,
    };

    log(`\x1b[90m[start] App: ${appName}  Port: ${assignedPort}\x1b[0m`);
    log(`\x1b[90m$ ${startCmd}\x1b[0m`);

    // ── Write a pm2 ecosystem config so env vars are guaranteed to be passed ──
    // This is the ONLY reliable way to set PORT when using pm2.
    // Passing env via the shell doesn't work because pm2 forks independently.
    const startParts   = splitCmd(startCmd);
    const ecosystemCfg = {
      apps: [{
        name:   appName,
        script: startParts[0],
        args:   startParts.slice(1).join(' '),
        cwd:    projectRoot,
        env:    appEnv,
        // Auto-restart if app crashes, max 5 times then give up
        max_restarts: 5,
        restart_delay: 2000,
        autorestart: true,
      }]
    };
    const ecoPath = path.join(projectRoot, '.deployboard-pm2.json');
    try {
      fs.writeFileSync(ecoPath, JSON.stringify(ecosystemCfg, null, 2));
      log(`\x1b[90m[start] Wrote pm2 ecosystem config → ${ecoPath}\x1b[0m`);
    } catch(e) {
      log(`\x1b[33m[start] Warning: Could not write pm2 config: ${e.message}\x1b[0m`);
    }

    const pm2Available = await checkCommand('pm2');
    if (pm2Available) {
      // Kill any previous instance of this app first
      await killPm2App(appName);

      // Snapshot ports BEFORE starting so we can detect the new one
      const portsBefore = getListeningPorts();

      try {
        // Start using ecosystem file — guarantees env vars including PORT are passed
        await exec('pm2', ['start', ecoPath],
          { cwd: projectRoot, env: { ...process.env, PATH: localBin + ':' + process.env.PATH } },
          log);

        await new Promise(r => {
          const p = spawn('pm2', ['save'], { stdio: 'ignore' });
          p.on('close', r); p.on('error', r);
        });

        // Wait for app to boot and bind its port
        log(`\x1b[90m[start] Waiting for app to bind to port…\x1b[0m`);
        await new Promise(r => setTimeout(r, 4000));

        // Detect actual port the app opened
        const portsAfter  = getListeningPorts();
        const newPorts = [...portsAfter].filter(p => !portsBefore.has(p) && p !== 3001 && p > 1024);

        if (newPorts.length > 0) {
          const actualPort = newPorts[0];
          log(`\x1b[32m[start] ✓ App is listening on port ${actualPort}\x1b[0m`);
          if (actualPort !== parseInt(assignedPort)) {
            log(`\x1b[33m[start] App chose port ${actualPort} instead of assigned ${assignedPort} — updating proxy\x1b[0m`);
          }
          try {
            const siteRoot  = path.dirname(projectRoot);
            const sitesRoot = path.dirname(siteRoot);
            const pFile     = path.join(sitesRoot, 'ports.json');
            let registry = {};
            try { registry = JSON.parse(fs.readFileSync(pFile, 'utf8')); } catch(e) {}
            registry[project.subdomain] = actualPort;
            fs.writeFileSync(pFile, JSON.stringify(registry, null, 2));
            log(`\x1b[32m[start] ✓ Port registry updated: ${project.subdomain} → ${actualPort}\x1b[0m`);
          } catch(e) {
            log(`\x1b[33m[start] Could not update port registry: ${e.message}\x1b[0m`);
          }
        } else {
          log(`\x1b[31m[start] ✗ App did not open any port after 4 seconds — it crashed on startup.\x1b[0m`);
          // Automatically fetch and display pm2 crash logs right here in the build output
          log(`\x1b[33m[start] ── Crash logs from pm2 ──────────────────────\x1b[0m`);
          try {
            const pm2LogFile = `/root/.pm2/logs/${appName}-error.log`;
            const pm2OutFile = `/root/.pm2/logs/${appName}-out.log`;
            let crashLog = '';
            for (const f of [pm2ErrorFile = pm2LogFile, pm2OutFile]) {
              try {
                const content = fs.readFileSync(f, 'utf8');
                const lines   = content.trim().split('\n').slice(-30); // last 30 lines
                if (lines.length) crashLog += lines.join('\n') + '\n';
              } catch(e) {}
            }
            if (crashLog.trim()) {
              for (const line of crashLog.trim().split('\n')) {
                log(`\x1b[31m${line}\x1b[0m`);
              }
            } else {
              // Try pm2 logs command as fallback
              await new Promise(resolve => {
                const p = spawn('pm2', ['logs', appName, '--lines', '20', '--nostream'], { stdio: ['ignore','pipe','pipe'] });
                p.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && log(`\x1b[31m${l}\x1b[0m`)));
                p.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && log(`\x1b[31m${l}\x1b[0m`)));
                p.on('close', resolve); p.on('error', resolve);
              });
            }
          } catch(e) {
            log(`\x1b[33m[start] Could not read crash logs: ${e.message}\x1b[0m`);
          }
          log(`\x1b[33m[start] ── Common causes: wrong start command, missing env var, app requires DB ──\x1b[0m`);
        }

      } catch(e) {
        log(`\x1b[31m[start] pm2 failed: ${e.message}\x1b[0m`);
      }

    } else {
      // No pm2 — spawn detached, then detect actual port
      log(`\x1b[33m[start] pm2 not found — starting as detached process\x1b[0m`);
      const portsBefore = getListeningPorts();
      try {
        const child = spawn(startParts[0], startParts.slice(1), {
          detached: true,
          stdio:    'ignore',
          cwd:      projectRoot,
          env:      { ...process.env, ...appEnv }
        });
        child.unref();
        log(`\x1b[32m[start] Started (PID ${child.pid})\x1b[0m`);
        await new Promise(r => setTimeout(r, 4000));

        const portsAfter = getListeningPorts();
        const newPorts   = [...portsAfter].filter(p => !portsBefore.has(p) && p !== 3001 && p > 1024);
        if (newPorts.length > 0) {
          const actualPort = newPorts[0];
          log(`\x1b[32m[start] ✓ App listening on port ${actualPort}\x1b[0m`);
          try {
            const siteRoot  = path.dirname(projectRoot);
            const sitesRoot = path.dirname(siteRoot);
            const pFile     = path.join(sitesRoot, 'ports.json');
            let registry = {};
            try { registry = JSON.parse(fs.readFileSync(pFile, 'utf8')); } catch(e) {}
            registry[project.subdomain] = actualPort;
            fs.writeFileSync(pFile, JSON.stringify(registry, null, 2));
          } catch(e) {}
        } else {
          log(`\x1b[31m[start] ✗ App did not open any port — it may have crashed.\x1b[0m`);
        }
      } catch(e) {
        log(`\x1b[31m[start] Could not start: ${e.message}\x1b[0m`);
      }
    }
    emitStep(emit, 'start', 'done');
  }
  const cleanupStep = startCmd ? '6/6' : '5/5';
  emitStep(emit, 'cleanup', 'active');
  log(`\n\x1b[36m━━━ Step ${cleanupStep} — Cleanup ━━━\x1b[0m`);
  try { fs.rmSync(buildDir, { recursive: true, force: true }); log(`\x1b[32m[cleanup] Removed ${buildDir}\x1b[0m`); }
  catch(e) { log(`\x1b[33m[cleanup] Warning: ${e.message}\x1b[0m`); }
  emitStep(emit, 'cleanup', 'done');
  log(`\n\x1b[32;1m✓ Build pipeline complete!\x1b[0m`);
}

async function checkCommand(cmd) {
  return new Promise(resolve => {
    const c = spawn('which', [cmd], { shell: false });
    c.on('close', code => resolve(code === 0));
    c.on('error', () => resolve(false));
  });
}

/** Read all currently listening TCP ports from /proc/net/tcp - works in Docker without ss */
function getListeningPorts() {
  const ports = new Set();
  try {
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      try {
        const lines = fs.readFileSync(file, 'utf8').split('\n').slice(1);
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length > 3 && parts[3] === '0A') {
            const portHex = (parts[1] || '').split(':').pop();
            if (portHex) ports.add(parseInt(portHex, 16));
          }
        }
      } catch(e) {}
    }
  } catch(e) {}
  return ports;
}

/** Check if a TCP port is open within timeoutMs */
function checkPortOpen(host, port, timeoutMs) {
  return new Promise(resolve => {
    const net = require('net');
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.connect(port, host, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function killPm2App(name) {
  return new Promise(resolve => {
    const c = spawn('pm2', ['delete', name], { shell: false });
    c.on('close', resolve); c.on('error', resolve);
  });
}

// ════════════════════════════════════════════════════════════════════════════
// DOCKER MODE  —  isolated container (VPS only)
// ════════════════════════════════════════════════════════════════════════════
async function runDockerBuild({ deployId, project, sitesDir, tmpDir, githubToken, emit, onLog }) {
  const destDir = path.join(sitesDir, project.subdomain, 'dist');
  const log = (line) => {
    emit('build:log', { line });
    if (typeof onLog === 'function') onLog(line);
    setImmediate(() => {});
  };

  const resolveEnvVars = (evars) => {
    if (!evars) return {};
    if (typeof evars.toObject === 'function') return evars.toObject();
    if (evars instanceof Map) return Object.fromEntries(evars);
    return evars;
  };
  const envObj = resolveEnvVars(project.envVars);

  const envFlags = [];
  Object.entries(envObj).forEach(([k, v]) => envFlags.push('-e', `${k}=${v}`));
  envFlags.push('-e', 'NODE_ENV=production', '-e', 'CI=false');
  if (githubToken) envFlags.push('-e', `GITHUB_TOKEN=${githubToken}`);

  const nodeImage  = `node:${project.nodeVer||'18'}-alpine`;
  const cloneUrl   = githubToken
    ? project.repoUrl.replace(/^https:\/\//, `https://${githubToken}@`)
    : project.repoUrl;
  const branch     = (project.branch || 'main').trim();
  const installCmd = project.installCmd || 'npm install';
  const buildCmd   = project.buildCmd   || 'npm run build';
  const outputDir  = project.outputDir  || 'dist';

  const script = [
    'set -e',
    `echo "Node $(node -v) / npm $(npm -v)"`,
    `git clone --depth=1 --branch ${branch} --progress "${cloneUrl}" /app || ` +
    `git clone --depth=1 --progress "${cloneUrl}" /app`,
    'cd /app',
    installCmd,
    buildCmd,
    `cp -r /app/${outputDir} /output/dist`,
    `echo "Build complete — $(find /output/dist -type f | wc -l) files deployed"`
  ].join(' && ');

  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  ['clone','install','build','copy'].forEach(s => emitStep(emit, s, 'active'));
  log(`\x1b[36m[Docker]\x1b[0m Pulling ${nodeImage} and running build…`);

  await exec('docker', [
    'run', '--rm',
    '--name', `db-${deployId.slice(-8)}`,
    '--memory', '512m', '--cpus', '1',
    '-v', `${destDir}:/output/dist`,
    ...envFlags,
    nodeImage, 'sh', '-c', script
  ], {}, log);

  ['clone','install','build','copy'].forEach(s => emitStep(emit, s, 'done'));

  emitStep(emit, 'cleanup', 'active');
  log(`\x1b[32m[cleanup] Docker cleaned up container automatically.\x1b[0m`);
  emitStep(emit, 'cleanup', 'done');
  log(`\n\x1b[32;1m✓ Docker build complete!\x1b[0m`);
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Spawn a child process.
 * IMPORTANT: git sends most output to stderr (not stdout), so we treat
 * stderr as normal log output rather than errors. We only reject on
 * non-zero exit code.
 */
function exec(cmd, args, options, logFn) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      cwd:   options.cwd,
      env:   options.env || process.env
    });

    let lastLines = []; // keep last 10 lines for error context

    const handleLine = (line, isStderr) => {
      if (!line.trim()) return;
      // Git puts its useful messages on stderr — show them all in grey
      const display = isStderr ? `\x1b[90m${line}\x1b[0m` : line;
      logFn(display);
      lastLines.push(line);
      if (lastLines.length > 10) lastLines.shift();
    };

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop(); // keep incomplete last line
      lines.forEach(l => handleLine(l, false));
    });

    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      // Split on \n and \r (git uses \r for progress overwriting)
      const lines = stderrBuf.split(/[\n\r]+/);
      stderrBuf = lines.pop();
      lines.forEach(l => handleLine(l, true));
    });

    child.stdout.on('end', () => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf, false);
    });
    child.stderr.on('end', () => {
      if (stderrBuf.trim()) handleLine(stderrBuf, true);
    });

    child.on('error', (err) => {
      reject(new Error(
        `Could not start "${cmd}": ${err.message}. ` +
        (cmd === 'git' ? 'Is git installed on this server?' :
         cmd === 'npm' ? 'Is Node.js installed?' : '')
      ));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const context = lastLines.slice(-5).join('\n');
        reject(new Error(
          `"${cmd} ${args.slice(0,3).join(' ')}…" failed with exit code ${code}.\n${context}`
        ));
      }
    });
  });
}

/**
 * Like exec() but kills the process after `timeoutMs` milliseconds.
 * Resolves (not rejects) with a TIMEOUT error message so start cmd is non-fatal.
 */
function execWithTimeout(cmd, args, options, logFn, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      cwd:   options.cwd,
      env:   options.env || process.env
    });

    let lastLines = [];
    const handleLine = (line, isStderr) => {
      if (!line.trim()) return;
      const display = isStderr ? `\x1b[90m${line}\x1b[0m` : line;
      logFn(display);
      lastLines.push(line);
      if (lastLines.length > 10) lastLines.shift();
      setImmediate(() => {});
    };

    let stdoutBuf = '', stderrBuf = '';
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n'); stdoutBuf = lines.pop();
      lines.forEach(l => handleLine(l, false));
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split(/[\n\r]+/); stderrBuf = lines.pop();
      lines.forEach(l => handleLine(l, true));
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('TIMEOUT'));
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve();
      else reject(new Error(`exited with code ${code}\n${lastLines.slice(-3).join('\n')}`));
    });
  });
}


function splitCmd(cmdStr) {
  const parts = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (const ch of cmdStr.trim()) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true; quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts.length ? parts : ['npm', 'run', 'build'];
}

/** Recursively copy a directory */
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const s = path.join(src, entry);
    const d = path.join(dest, entry);
    if (fs.lstatSync(s).isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Count files recursively */
function countFiles(dir) {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (fs.lstatSync(full).isDirectory()) count += countFiles(full);
      else count++;
    }
  } catch(e) {}
  return count;
}

/** Remove GitHub token from URL for display in logs */
function maskToken(url, token) {
  if (!token) return url;
  return url.replace(/^https:\/\//, 'https://***@');
}

/** Emit a build step state update */
function emitStep(emit, id, state) {
  emit('build:step', { step: { id, state } });
}

module.exports = { runBuild };
