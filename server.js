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

// ── Port registry for server apps ─────────────────────────────────────────────
// Maps subdomain → port number for Node.js apps running via pm2.
// Ports are assigned starting at 4000, incrementing per new server app.
// Written to SITES_DIR/ports.json so it survives restarts.
const PORTS_FILE  = path.join(SITES_DIR, 'ports.json');
const PORT_START  = 4000;
const NGINX_SITES_DIR = process.env.NGINX_SITES_DIR || '/etc/nginx/conf.d/deployboard-apps';

let portRegistry = {};
try {
  if (fs.existsSync(PORTS_FILE)) {
    portRegistry = JSON.parse(fs.readFileSync(PORTS_FILE, 'utf8'));
    console.log(`[Ports] Loaded port registry: ${Object.keys(portRegistry).length} entries`);
  }
} catch(e) { console.warn('[Ports] Could not load ports.json:', e.message); }

function savePortRegistry() {
  try { fs.writeFileSync(PORTS_FILE, JSON.stringify(portRegistry, null, 2)); }
  catch(e) { console.warn('[Ports] Could not save ports.json:', e.message); }
}

// Read all currently listening TCP ports from /proc/net/tcp (works in Docker, no ss needed)
function getListeningPorts() {
  try {
    const lines = fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1);
    const ports = new Set();
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length > 3 && parts[3] === '0A') { // 0A = LISTEN state
        const portHex = (parts[1] || '').split(':')[1];
        if (portHex) ports.add(parseInt(portHex, 16));
      }
    }
    // Also check /proc/net/tcp6 for IPv6 listeners
    try {
      const lines6 = fs.readFileSync('/proc/net/tcp6', 'utf8').split('\n').slice(1);
      for (const line of lines6) {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 3 && parts[3] === '0A') {
          const portHex = (parts[1] || '').split(':')[1];
          if (portHex) ports.add(parseInt(portHex, 16));
        }
      }
    } catch(e) {}
    return ports;
  } catch(e) {
    console.warn('[Ports] Could not read /proc/net/tcp:', e.message);
    return new Set();
  }
}

// On startup: remove stale port entries where no process is actually listening.
// This fixes static sites that got stuck because of old failed server deployments.
setTimeout(() => {
  const listening = getListeningPorts();
  let cleaned = 0;
  for (const [sub, port] of Object.entries(portRegistry)) {
    if (!listening.has(port)) {
      console.log(`[Ports] Removing stale entry: ${sub} → ${port} (nothing listening)`);
      delete portRegistry[sub];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    savePortRegistry();
    console.log(`[Ports] Cleaned ${cleaned} stale entries from port registry`);
  }
}, 5000); // Wait 5s for pm2 apps to start before checking

// Get or assign a port for a subdomain
function getOrAssignPort(subdomain) {
  if (portRegistry[subdomain]) return portRegistry[subdomain];
  const usedPorts = Object.values(portRegistry);
  let port = PORT_START;
  while (usedPorts.includes(port)) port++;
  portRegistry[subdomain] = port;
  savePortRegistry();
  console.log(`[Ports] Assigned port ${port} to ${subdomain}`);
  return port;
}

// Write a per-subdomain Nginx config for Node.js server apps.
// This always uses 127.0.0.1 because:
// - Nginx runs on the HOST VM (via Cloudflare tunnel, not inside Docker)
// - The Node.js app port is mapped from Docker container → host (e.g. 4000:4000)
// - So nginx on the host reaches it via localhost, NOT via Docker service name
async function writeNginxProxyConfig(subdomain, port) {
  // Always write to the host nginx directory — never inside the container volume
  const configDir = NGINX_SITES_DIR || '/etc/nginx/conf.d/deployboard-apps';
  try { fs.mkdirSync(configDir, { recursive: true }); } catch(e) {}

  const configContent = `# Auto-generated by DeployBoard — ${subdomain}
server {
    listen 80;
    server_name ${subdomain}.${BASE_DOMAIN};
    location / {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       $host;
        proxy_set_header   X-Real-IP  $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout  60;
        proxy_send_timeout  60;
        proxy_connect_timeout 10;
        # If app not ready yet, retry
        proxy_next_upstream error timeout http_502 http_503;
    }
}
`;

  const configPath = path.join(configDir, `${subdomain}.conf`);
  try {
    fs.writeFileSync(configPath, configContent);
    console.log(`[Nginx] Wrote proxy config: ${configPath}`);
  } catch(e) {
    console.warn(`[Nginx] Could not write config for ${subdomain}:`, e.message);
    return false;
  }

  // Reload Nginx on the host VM
  try {
    const { execSync } = require('child_process');
    let reloaded = false;

    // Try direct nginx reload first (bare VM)
    for (const bin of ['/usr/sbin/nginx', '/usr/local/sbin/nginx', 'nginx']) {
      try {
        execSync(`${bin} -s reload`, { stdio: 'pipe' });
        console.log(`[Nginx] Reloaded via ${bin}`);
        reloaded = true;
        break;
      } catch(e) {}
    }

    // Fallback: docker exec (Docker Compose setup)
    if (!reloaded) {
      try {
        execSync('docker exec deployboard-nginx nginx -s reload', { stdio: 'pipe' });
        console.log(`[Nginx] Reloaded via docker exec`);
        reloaded = true;
      } catch(e) {}
    }

    if (!reloaded) {
      console.warn('[Nginx] Could not reload nginx automatically.');
    }
    return reloaded;
  } catch(e) {
    console.warn('[Nginx] Reload failed (non-fatal):', e.message);
    return false;
  }
}

// Remove Nginx config when project is deleted
async function removeNginxConfig(subdomain) {
  const configDir = NGINX_SITES_DIR || '/etc/nginx/conf.d/deployboard-apps';
  const configPath = path.join(configDir, `${subdomain}.conf`);
  try {
    if (fs.existsSync(configPath)) {
      fs.rmSync(configPath);
      const { execSync } = require('child_process');
      try {
        if (inDocker) execSync('docker exec deployboard-nginx nginx -s reload', {stdio:'pipe'});
        else {
          const bin = ['/usr/sbin/nginx','nginx'].find(c=>{try{execSync(`${c} -v 2>&1`,{stdio:'pipe'});return true;}catch(e){return false;}});
          if (bin) execSync(`${bin} -s reload`, {stdio:'pipe'});
        }
      } catch(e) {}
      console.log(`[Nginx] Removed config for ${subdomain}`);
    }
  } catch(e) { console.warn('[Nginx] removeNginxConfig error:', e.message); }
  delete portRegistry[subdomain];
  savePortRegistry();
}

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
// SUBDOMAIN ROUTING
// ════════════════════════════════════════════════════════════════════
function serveDistDir(req, res, distDir) {
  const mw = express.static(distDir, { index: 'index.html' });
  mw(req, res, () => {
    const idx = path.join(distDir, 'index.html');
    if (fs.existsSync(idx)) res.sendFile(idx);
    else res.status(404).send('Not found');
  });
}

app.use((req, res, next) => {
  const host  = (req.headers.host || '').toLowerCase();
  const match = host.match(new RegExp(`^([a-z0-9][a-z0-9-]{0,61}[a-z0-9]?)\\.${BASE_DOMAIN.replace(/\./g,'\\.')}$`));
  if (!match) return next();

  const subdomain = match[1];
  const distDir   = path.join(SITES_DIR, subdomain, 'dist');
  const appDir    = path.join(SITES_DIR, subdomain, 'app');
  const appPort   = portRegistry[subdomain];

  // ── SERVER APP ─────────────────────────────────────────────────────────────
  if (appPort && fs.existsSync(appDir)) {
    const httpMod  = require('http');
    const proxyReq = httpMod.request({
      hostname: '127.0.0.1', port: appPort,
      path: req.url, method: req.method,
      headers: { ...req.headers, host: req.headers.host,
                 'x-forwarded-for': req.ip || '', 'x-real-ip': req.ip || '' }
    }, (proxyRes) => {
      if (proxyRes.statusCode === 404 && req.url === '/') {
        let body = '';
        proxyRes.on('data', c => body += c);
        proxyRes.on('end', () => {
          if (body.includes('Cannot GET') || body.includes('Not Found')) {
            return res.status(200).send(`<!DOCTYPE html><html><head><title>${subdomain} is live</title>
              <style>body{font-family:sans-serif;background:#060b14;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
              .b{text-align:center;padding:2rem}.badge{background:#10b981;color:#fff;padding:4px 14px;border-radius:20px;font-size:.85rem;display:inline-block;margin-bottom:1rem}
              code{background:#1e293b;padding:3px 8px;border-radius:4px}p{color:#94a3b8}</style></head>
              <body><div class="b"><div class="badge">✓ App is Running</div>
              <h2>${subdomain}.${BASE_DOMAIN}</h2>
              <p>Your app is live on port <code>${appPort}</code>.</p>
              <p>This app has no <code>/</code> route — try a specific path like <code>/api</code>, <code>/users</code>, etc.</p>
              </div></body></html>`);
          }
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          res.end(body);
        });
        return;
      }
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    // Never hang — 10 second timeout
    proxyReq.setTimeout(10000, () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(502).send(`<h1>502 — App timed out on port ${appPort}</h1><p>Try redeploying from <a href="https://${BASE_DOMAIN}">DeployBoard</a>.</p>`);
    });

    proxyReq.on('error', () => {
      // Nothing listening — clean up stale entry, fall back to static if exists
      delete portRegistry[subdomain];
      savePortRegistry();
      if (fs.existsSync(distDir)) return serveDistDir(req, res, distDir);
      if (!res.headersSent) res.status(502).send(`<h1>App not responding</h1><p><a href="https://${BASE_DOMAIN}">Redeploy from DeployBoard</a></p>`);
    });

    req.pipe(proxyReq, { end: true });
    return;
  }

  // Clean up stale port entry if app dir is gone
  if (appPort && !fs.existsSync(appDir)) {
    delete portRegistry[subdomain];
    savePortRegistry();
  }

  // ── STATIC SITE ───────────────────────────────────────────────────────────
  if (fs.existsSync(distDir)) return serveDistDir(req, res, distDir);

  // ── NOT DEPLOYED ──────────────────────────────────────────────────────────
  if (fs.existsSync(appDir)) {
    return res.status(503).send(`<!DOCTYPE html><html><head><title>App Offline</title>
      <style>body{font-family:sans-serif;background:#060b14;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.b{text-align:center;padding:2rem}a{color:#10b981}</style></head>
      <body><div class="b"><h1>App Not Running</h1><p><code>${subdomain}</code> deployed but not running.</p>
      <p><a href="https://${BASE_DOMAIN}">Redeploy from DeployBoard</a></p></div></body></html>`);
  }

  res.status(404).send(`<!DOCTYPE html><html><head><title>Not Found</title>
    <style>body{font-family:sans-serif;background:#060b14;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.b{text-align:center;padding:2rem}a{color:#10b981}</style></head>
    <body><div class="b"><h1>404 — Not Deployed</h1><p><code>${subdomain}.${BASE_DOMAIN}</code> not found.</p>
    <p><a href="https://${BASE_DOMAIN}">Deploy from DeployBoard</a></p></div></body></html>`);
});

// Serve the dashboard (index.html) for all other requests
app.use(express.static(path.join(__dirname)));

// ════════════════════════════════════════════════════════════════════
// CLOUDFLARE HELPERS
// ════════════════════════════════════════════════════════════════════

// Register a new subdomain via Cloudflare API after successful build
async function registerSubdomain(subdomain) {
  const fullDomain = `${subdomain}.${BASE_DOMAIN}`;

  // ── Wildcard mode (recommended) ────────────────────────────────────────────
  // If you have a wildcard A record (* → your VPS IP) in Cloudflare,
  // individual DNS records are NOT needed — the wildcard already covers every
  // subdomain automatically. We just return the live URL directly.
  //
  // We only attempt to create a CNAME/A record if CF_API_TOKEN AND CF_ZONE_ID
  // are both set AND CF_WILDCARD_MODE is not "true".
  const wildcardMode = process.env.CF_WILDCARD_MODE !== 'false'; // default: true

  if (wildcardMode || !CF_API_TOKEN || !CF_ZONE_ID) {
    if (!CF_API_TOKEN || !CF_ZONE_ID) {
      console.log(`[CF] No API credentials set — relying on wildcard DNS for ${fullDomain}`);
    } else {
      console.log(`[CF] Wildcard mode — no individual DNS record needed for ${fullDomain}`);
    }
    return { ok: true, url: `https://${fullDomain}` };
  }

  console.log(`[CF] Registering individual DNS record for: ${fullDomain}`);

  // ── Individual DNS record mode (only needed without a wildcard) ─────────────
  try {
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
        console.log(`[CF] DNS record already exists for ${fullDomain} — OK`);
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
  startCmd:   { type: String, default: '' },
  siteType:   { type: String, default: 'static' },
  appPort:    { type: Number, default: 0 },
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
  try {
    const projects = await Project.find().sort({ createdAt: -1 });
    // Enrich each project with its most recent deployment status
    // so the frontend can sync stale localStorage states
    const Deployment = mongoose.model('Deployment');
    const enriched = await Promise.all(projects.map(async p => {
      const lastDeploy = await Deployment
        .findOne({ projectId: p._id })
        .sort({ createdAt: -1 })
        .select('status duration endedAt');
      const obj = p.toObject();
      obj.lastDeployStatus = lastDeploy ? lastDeploy.status : null;
      obj.lastDeployDuration = lastDeploy ? lastDeploy.duration : null;
      return obj;
    }));
    res.json(enriched);
  }
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
      // Remove Nginx proxy config (for server apps)
      await removeNginxConfig(p.subdomain);
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
  const { name, subdomain, repoUrl, branch, installCmd, buildCmd, startCmd, outputDir, nodeVer, siteType, envVars, customPort } = req.body;

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
        siteType:   siteType   || 'static',
        appPort:    ((siteType === 'server') || !!(startCmd || '').trim())
                      ? (customPort ? parseInt(customPort) : getOrAssignPort(cleanSub))
                      : 0,
        envVars:    envVars    || {},
        updatedAt:  new Date() },
      { upsert: true, new: true }
    );
  } catch(dbErr) {
    project = {
      _id: 'local_' + Date.now(), name, subdomain: cleanSub, repoUrl,
      branch: branch||'main', installCmd: installCmd||'npm install',
      buildCmd: buildCmd||'npm run build', startCmd: startCmd||'',
      outputDir: outputDir||'dist', nodeVer: nodeVer||'18',
      siteType: siteType||'static', envVars: envVars||{},
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
    // Resolve port for server apps before build starts
    const isServerDeploy = (siteType === 'server' || !!(startCmd || '').trim());
    const appPort = isServerDeploy
      ? (customPort ? (portRegistry[cleanSub] = parseInt(customPort), savePortRegistry(), parseInt(customPort))
                    : (project.appPort || getOrAssignPort(cleanSub)))
      : 0;

    // If this is a STATIC deploy, clean up any stale server app data for this subdomain
    // so the proxy doesn't try to forward requests to a dead port.
    if (!isServerDeploy) {
      if (portRegistry[cleanSub]) {
        console.log(`[Deploy] Removing stale port registry entry for static redeploy: ${cleanSub}`);
        delete portRegistry[cleanSub];
        savePortRegistry();
      }
      const staleAppDir = path.join(SITES_DIR, cleanSub, 'app');
      try {
        if (fs.existsSync(staleAppDir)) {
          fs.rmSync(staleAppDir, { recursive: true, force: true });
          console.log(`[Deploy] Removed stale app dir for static redeploy: ${staleAppDir}`);
        }
      } catch(e) { console.warn('[Deploy] Could not remove stale app dir:', e.message); }
    }

    emit('build:log', { line: `\x1b[36m[DeployBoard]\x1b[0m Starting ${RUNNER_MODE} build for \x1b[1m${name}\x1b[0m` });
    emit('build:log', { line: `\x1b[90mRepo: ${repoUrl}  Branch: ${branch||'main'}\x1b[0m` });
    emit('build:log', { line: `\x1b[90mTarget: https://${cleanSub}.${BASE_DOMAIN}\x1b[0m` });
    emit('build:log', { line: '' });

    await runBuild({
      deployId, project, deployment,
      sitesDir: SITES_DIR, tmpDir: TMP_DIR,
      githubToken: GITHUB_TOKEN, mode: RUNNER_MODE,
      appPort,
      emit,
      onLog: (line) => {
        deployment.logs = deployment.logs || [];
        deployment.logs.push(line);
      }
    });

    // ── For server apps: write Nginx proxy config ───────────────────
    const isServerApp = (siteType === 'server') || !!(startCmd || '').trim();
    if (isServerApp && appPort) {
      emit('build:log', { line: `\x1b[90m[Nginx] Writing proxy config for port ${appPort}…\x1b[0m` });
      const nginxOk = await writeNginxProxyConfig(cleanSub, appPort);
      if (nginxOk) {
        emit('build:log', { line: `\x1b[32m[Nginx] ✓ Proxy configured: ${cleanSub}.${BASE_DOMAIN} → localhost:${appPort}\x1b[0m` });
        // Update project's appPort in DB
        try { await Project.findByIdAndUpdate(project._id, { appPort }); } catch(e) {}
      } else {
        emit('build:log', { line: `\x1b[33m[Nginx] Could not reload Nginx automatically.\x1b[0m` });
        emit('build:log', { line: `\x1b[33m[Nginx] Run manually: sudo nginx -s reload\x1b[0m` });
      }
    }

    // ── Register subdomain on Cloudflare ──────────────────────────
    emit('build:log', { line: '' });
    emit('build:log', { line: `\x1b[36m[DeployBoard]\x1b[0m Resolving live URL…` });
    const cfResult = await registerSubdomain(cleanSub);
    if (cfResult.ok) {
      emit('build:log', { line: `\x1b[32m[Cloudflare]\x1b[0m ✓ Subdomain live via wildcard DNS: ${cfResult.url}` });
      emit('build:log', { line: `\x1b[32m[DeployBoard]\x1b[0m Your site is accessible at: \x1b[1m${cfResult.url}\x1b[0m` });
      try {
        await Project.findByIdAndUpdate(project._id, { liveUrl: cfResult.url });
      } catch(e) {}
    } else {
      emit('build:log', { line: `\x1b[33m[Cloudflare]\x1b[0m DNS note: ${cfResult.reason}` });
      emit('build:log', { line: `\x1b[33m[DeployBoard]\x1b[0m Site still accessible via direct server URL` });
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
