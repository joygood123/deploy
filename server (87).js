/**
 * DeployBoard — Orchestrator Server
 * Express + Socket.io backend that handles deploy requests,
 * streams build logs in real-time, and manages project data.
 *
 * Subdomain routing on Render/Pxxl:
 *   After each successful build, the server calls the Cloudflare API
 *   to create a CNAME + tunnel ingress for <subdomain>.joytreehostingserver.dpdns.org
 *   Static files are served directly by Express from SITES_DIR.
 */

'use strict';

const express   = require('express');
const http      = require('http');
const { Server: SocketIO } = require('socket.io');
const path      = require('path');
const fs        = require('fs');
const mongoose  = require('mongoose');
require('dotenv').config();

const app    = express();
const server = http.createServer(app);
const io     = new SocketIO(server, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

const PORT          = process.env.PORT         || 3001;
const MONGODB_URI   = process.env.MONGODB_URI  || 'mongodb://localhost:27017/deployboard';
const SITES_DIR     = process.env.SITES_DIR    || '/tmp/user-sites';
const TMP_DIR       = process.env.TMP_DIR      || '/tmp/deployboard-builds';
const RUNNER_MODE   = process.env.RUNNER       || 'local';
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN || '';

// ── Cloudflare config (same credentials as Treetrodactly) ───────────────────
const CF_API_TOKEN  = process.env.CF_API_TOKEN  || '';
const CF_ZONE_ID    = process.env.CF_ZONE_ID    || '';
const CF_TUNNEL_ID  = process.env.CF_TUNNEL_ID  || '';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const BASE_DOMAIN   = process.env.BASE_DOMAIN   || 'joytreehostingserver.dpdns.org';

// ── Ensure directories exist ─────────────────────────────────────────────────
[SITES_DIR, TMP_DIR].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ════════════════════════════════════════════════════════════════════
// SUBDOMAIN STATIC FILE SERVING
//
// Requests that come in with a Host header like:
//   my-app.joytreehostingserver.dpdns.org
// are served from:
//   SITES_DIR/my-app/dist/
//
// This lets the same Render server host ALL deployed sites.
// ════════════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();

  // Match *.joytreehostingserver.dpdns.org (or whatever BASE_DOMAIN is)
  const match = host.match(new RegExp(`^([a-z0-9][a-z0-9-]{0,61}[a-z0-9])\\.${BASE_DOMAIN.replace(/\./g,'\\.')}$`));
  if (!match) return next(); // Not a subdomain request → serve dashboard

  const subdomain = match[1];
  const siteDir   = path.join(SITES_DIR, subdomain, 'dist');

  if (!fs.existsSync(siteDir)) {
    return res.status(404).send(`
      <!DOCTYPE html><html><head><title>Not Found</title>
      <style>body{font-family:sans-serif;background:#060b14;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
      .box{text-align:center;} h1{font-size:2rem;} p{color:#64748b;}</style></head>
      <body><div class="box">
        <h1>404 — Site Not Found</h1>
        <p><code>${subdomain}.${BASE_DOMAIN}</code> has not been deployed yet.</p>
        <p>Deploy it from <a href="https://${BASE_DOMAIN}" style="color:#3b82f6;">DeployBoard</a>.</p>
      </div></body></html>
    `);
  }

  // Serve static files from the site's dist folder
  const staticMw = express.static(siteDir, { index: 'index.html' });
  staticMw(req, res, () => {
    // SPA fallback: serve index.html for client-side routes
    const indexFile = path.join(siteDir, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile);
    } else {
      res.status(404).send('Not found');
    }
  });
});

// Serve the dashboard (index.html) for all other requests
app.use(express.static(path.join(__dirname)));

// ════════════════════════════════════════════════════════════════════
// CLOUDFLARE HELPERS
// ════════════════════════════════════════════════════════════════════

// Register a new subdomain via Cloudflare API after successful build
async function registerSubdomain(subdomain) {
  if (!CF_API_TOKEN || !CF_ZONE_ID) {
    console.warn(`[CF] Skipping DNS registration for ${subdomain} — CF_API_TOKEN or CF_ZONE_ID not set`);
    return { ok: false, reason: 'Missing Cloudflare credentials in env vars' };
  }

  const fullDomain = `${subdomain}.${BASE_DOMAIN}`;
  console.log(`[CF] Registering subdomain: ${fullDomain}`);

  // ── Create CNAME DNS record ──────────────────────────────────────
  try {
    // Point to tunnel if available, otherwise to Render URL
    const cnameTarget = CF_TUNNEL_ID
      ? `${CF_TUNNEL_ID}.cfargotunnel.com`
      : (process.env.RENDER_EXTERNAL_HOSTNAME || BASE_DOMAIN);

    const dnsRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'CNAME', name: subdomain,
          content: cnameTarget, proxied: true, ttl: 1,
          comment: `DeployBoard — auto-created for ${subdomain}`
        })
      }
    );
    const dnsData = await dnsRes.json();
    if (!dnsData.success) {
      const errMsg = dnsData.errors?.[0]?.message || 'DNS error';
      if (errMsg.toLowerCase().includes('already exists')) {
        console.log(`[CF] DNS record already exists for ${fullDomain}`);
      } else {
        console.error('[CF] DNS creation failed:', errMsg);
        return { ok: false, reason: errMsg };
      }
    } else {
      console.log(`[CF] DNS CNAME created → ${fullDomain}`);
    }
  } catch(e) {
    console.error('[CF] DNS request error:', e.message);
    return { ok: false, reason: e.message };
  }

  // ── Update tunnel ingress (if tunnel is configured) ──────────────
  if (CF_TUNNEL_ID && CF_ACCOUNT_ID) {
    try {
      const getRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations`,
        { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' } }
      );
      const getData = await getRes.json();
      if (!getData.success) throw new Error(getData.errors?.[0]?.message || 'GET tunnel config failed');

      const existing  = (getData.result?.config?.ingress || []).filter(r => r.hostname);
      const filtered  = existing.filter(r => r.hostname !== fullDomain);
      const renderUrl = process.env.RENDER_EXTERNAL_URL
        ? new URL(process.env.RENDER_EXTERNAL_URL).hostname
        : `localhost:${PORT}`;

      const newIngress = [
        // Route this subdomain to our Render service
        { hostname: fullDomain, service: `https://${renderUrl}`,
          originRequest: { noTLSVerify: true } },
        ...filtered,
        { service: 'http_status:404' }
      ];

      const putRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations`,
        {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: { ingress: newIngress } })
        }
      );
      const putData = await putRes.json();
      if (!putData.success) throw new Error(putData.errors?.[0]?.message || 'PUT tunnel config failed');
      console.log(`[CF] Tunnel ingress updated → ${fullDomain}`);
    } catch(e) {
      // Non-fatal — DNS is already created, tunnel update is best-effort
      console.warn('[CF] Tunnel ingress update failed (non-fatal):', e.message);
    }
  }

  return { ok: true, url: `https://${fullDomain}` };
}

// Remove a subdomain's DNS record when a project is deleted
async function removeSubdomain(subdomain) {
  if (!CF_API_TOKEN || !CF_ZONE_ID) return;
  try {
    const listRes = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=${encodeURIComponent(subdomain + '.' + BASE_DOMAIN)}&per_page=5`,
      { headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } }
    );
    const listData = await listRes.json();
    if (!listData.success || !listData.result?.length) return;
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records/${listData.result[0].id}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` } }
    );
    console.log(`[CF] DNS removed for ${subdomain}.${BASE_DOMAIN}`);
  } catch(e) { console.warn('[CF] removeSubdomain error:', e.message); }
}

// ════════════════════════════════════════════════════════════════════
// MONGODB MODELS
// ════════════════════════════════════════════════════════════════════
const projectSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  subdomain:  { type: String, required: true, unique: true },
  repoUrl:    { type: String, required: true },
  branch:     { type: String, default: 'main' },
  installCmd: { type: String, default: 'npm install' },
  buildCmd:   { type: String, default: 'npm run build' },
  startCmd:   { type: String, default: '' },
  outputDir:  { type: String, default: 'dist' },
  nodeVer:    { type: String, default: '18' },
  envVars:    { type: Map, of: String, default: {} },
  liveUrl:    { type: String, default: '' },
  createdAt:  { type: Date,   default: Date.now },
  updatedAt:  { type: Date,   default: Date.now }
});

const deploymentSchema = new mongoose.Schema({
  projectId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  projectName: { type: String },
  branch:      { type: String, default: 'main' },
  status:      { type: String, enum: ['pending','building','success','failed'], default: 'pending' },
  logs:        [String],
  duration:    Number,
  startedAt:   { type: Date, default: Date.now },
  endedAt:     Date
});

const Project    = mongoose.model('Project',    projectSchema);
const Deployment = mongoose.model('Deployment', deploymentSchema);

mongoose.connect(MONGODB_URI)
  .then(() => console.log('[DB] MongoDB connected'))
  .catch(err => console.warn('[DB] MongoDB unavailable — running without persistence:', err.message));

// ════════════════════════════════════════════════════════════════════
// BUILD RUNNER
// ════════════════════════════════════════════════════════════════════
const { runBuild } = require('./buildRunner');

// ════════════════════════════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    ok: true, mode: RUNNER_MODE, baseDomain: BASE_DOMAIN,
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: Math.round(process.uptime()) + 's'
  });
});

// Projects
app.get('/api/projects', async (req, res) => {
  try { res.json(await Project.find().sort({ createdAt: -1 })); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const p = await Project.findByIdAndDelete(req.params.id);
    if (p) {
      await Deployment.deleteMany({ projectId: req.params.id });
      // Remove the static site files
      const siteDir = path.join(SITES_DIR, p.subdomain);
      try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch(e) {}
      // Remove Cloudflare DNS record
      await removeSubdomain(p.subdomain);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Deployments
app.get('/api/deployments', async (req, res) => {
  try {
    const filter = req.query.projectId ? { projectId: req.query.projectId } : {};
    res.json(await Deployment.find(filter).sort({ startedAt: -1 }).limit(100));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DEPLOY TRIGGER ───────────────────────────────────────────────────────────
app.post('/api/deploy', async (req, res) => {
  const { name, subdomain, repoUrl, branch, installCmd, buildCmd, startCmd, outputDir, nodeVer, envVars } = req.body;

  if (!name || !subdomain || !repoUrl) {
    return res.status(400).json({ error: 'name, subdomain and repoUrl are required' });
  }

  // Clean subdomain: lowercase, no spaces, only alphanumeric + hyphens
  const cleanSub = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  // Upsert project
  let project;
  try {
    project = await Project.findOneAndUpdate(
      { subdomain: cleanSub },
      { name, subdomain: cleanSub, repoUrl,
        branch:     branch     || 'main',
        installCmd: installCmd || 'npm install',
        buildCmd:   buildCmd   || 'npm run build',
        startCmd:   startCmd   || '',
        outputDir:  outputDir  || 'dist',
        nodeVer:    nodeVer    || '18',
        envVars:    envVars    || {},
        updatedAt:  new Date() },
      { upsert: true, new: true }
    );
  } catch(dbErr) {
    project = {
      _id: 'local_' + Date.now(), name, subdomain: cleanSub, repoUrl,
      branch: branch||'main', installCmd: installCmd||'npm install',
      buildCmd: buildCmd||'npm run build', startCmd: startCmd||'',
      outputDir: outputDir||'dist',
      nodeVer: nodeVer||'18', envVars: envVars||{},
      save: async () => {}
    };
  }

  // Create deployment record
  let deployment;
  try {
    deployment = await new Deployment({
      projectId: project._id, projectName: name,
      branch: branch||'main', status: 'pending'
    }).save();
  } catch(dbErr) {
    deployment = {
      _id: 'local_' + Date.now(), projectId: project._id,
      projectName: name, branch: branch||'main',
      status: 'pending', logs: [], startedAt: new Date(),
      save: async () => {}
    };
  }

  const deployId = deployment._id.toString();

  // Respond immediately — build runs async
  res.json({ ok: true, deployId, message: 'Build started',
             liveUrl: `https://${cleanSub}.${BASE_DOMAIN}` });

  // ── Async build ──────────────────────────────────────────────────
  const buildStart = Date.now();
  deployment.status = 'building';
  try { await deployment.save(); } catch(e) {}

  const emit = (event, data) => io.emit(event, { deployId, ...data });

  try {
    emit('build:log', { line: `\x1b[36m[DeployBoard]\x1b[0m Starting ${RUNNER_MODE} build for \x1b[1m${name}\x1b[0m` });
    emit('build:log', { line: `\x1b[90mRepo: ${repoUrl}  Branch: ${branch||'main'}\x1b[0m` });
    emit('build:log', { line: `\x1b[90mTarget: https://${cleanSub}.${BASE_DOMAIN}\x1b[0m` });
    emit('build:log', { line: '' });

    await runBuild({
      deployId, project, deployment,
      sitesDir: SITES_DIR, tmpDir: TMP_DIR,
      githubToken: GITHUB_TOKEN, mode: RUNNER_MODE,
      emit,
      onLog: (line) => {
        deployment.logs = deployment.logs || [];
        deployment.logs.push(line);
      }
    });

    // ── Register subdomain on Cloudflare ──────────────────────────
    emit('build:log', { line: '' });
    emit('build:log', { line: `\x1b[36m[DeployBoard]\x1b[0m Registering subdomain with Cloudflare…` });
    const cfResult = await registerSubdomain(cleanSub);
    if (cfResult.ok) {
      emit('build:log', { line: `\x1b[32m[Cloudflare]\x1b[0m Subdomain live: ${cfResult.url}` });
      // Save live URL to project
      try {
        await Project.findByIdAndUpdate(project._id, { liveUrl: cfResult.url });
      } catch(e) {}
    } else {
      emit('build:log', { line: `\x1b[33m[Cloudflare]\x1b[0m DNS not registered: ${cfResult.reason}` });
      emit('build:log', { line: `\x1b[33m[DeployBoard]\x1b[0m Site still accessible via direct Render URL` });
    }

    const duration = Math.round((Date.now() - buildStart) / 1000);
    deployment.status   = 'success';
    deployment.duration = duration;
    deployment.endedAt  = new Date();
    try { await deployment.save(); } catch(e) {}

    emit('build:log',  { line: `\n\x1b[32m✓ Deployment complete in ${duration}s\x1b[0m` });
    emit('build:done', { status: 'success', duration,
                         liveUrl: cfResult.ok ? cfResult.url : null });
    console.log(`[Deploy] SUCCESS ${name} (${deployId}) in ${duration}s`);

  } catch(buildErr) {
    const duration = Math.round((Date.now() - buildStart) / 1000);
    deployment.status   = 'failed';
    deployment.duration = duration;
    deployment.endedAt  = new Date();
    try { await deployment.save(); } catch(e) {}

    // Cleanup temp dir on failure
    const buildDir = path.join(TMP_DIR, deployId);
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}

    emit('build:log',  { line: `\x1b[31m[DeployBoard]\x1b[0m Build failed: ${buildErr.message}` });
    emit('build:done', { status: 'failed', duration });
    console.error(`[Deploy] FAILED ${name} (${deployId}):`, buildErr.message);
  }
});

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket.io] Client connected:', socket.id);
  socket.on('disconnect', () => console.log('[Socket.io] Disconnected:', socket.id));
});

// ── Catch-all → dashboard ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[DeployBoard] Running on http://localhost:${PORT}`);
  console.log(`[DeployBoard] Mode:        ${RUNNER_MODE}`);
  console.log(`[DeployBoard] Base domain: ${BASE_DOMAIN}`);
  console.log(`[DeployBoard] Sites dir:   ${SITES_DIR}`);
  console.log(`[DeployBoard] Temp dir:    ${TMP_DIR}`);
});
