/**
 * DeployBoard — Orchestrator Server
 * Express + Socket.io backend that handles deploy requests,
 * streams build logs in real-time, and manages project data.
 *
 * RUNNER modes:
 *   local  → uses child_process on the host (default, works on Render)
 *   docker → spawns isolated Docker containers (requires VPS with Docker)
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

const PORT         = process.env.PORT        || 3001;
const MONGODB_URI  = process.env.MONGODB_URI || 'mongodb://localhost:27017/deployboard';
const SITES_DIR    = process.env.SITES_DIR   || '/var/www/user-sites';
const TMP_DIR      = process.env.TMP_DIR     || '/tmp/deployboard-builds';
const RUNNER_MODE  = process.env.RUNNER      || 'local'; // 'local' | 'docker'
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// ── Ensure directories exist ─────────────────────────────────────────────────
[SITES_DIR, TMP_DIR].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));  // serve the frontend
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── MongoDB Models ───────────────────────────────────────────────────────────
const projectSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  subdomain:  { type: String, required: true, unique: true },
  repoUrl:    { type: String, required: true },
  branch:     { type: String, default: 'main' },
  installCmd: { type: String, default: 'npm install' },
  buildCmd:   { type: String, default: 'npm run build' },
  outputDir:  { type: String, default: 'dist' },
  nodeVer:    { type: String, default: '18' },
  envVars:    { type: Map, of: String, default: {} },
  createdAt:  { type: Date, default: Date.now },
  updatedAt:  { type: Date, default: Date.now }
});

const deploymentSchema = new mongoose.Schema({
  projectId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
  projectName:{ type: String },
  branch:     { type: String, default: 'main' },
  status:     { type: String, enum: ['pending','building','success','failed'], default: 'pending' },
  logs:       [String],
  duration:   Number,   // seconds
  startedAt:  { type: Date, default: Date.now },
  endedAt:    Date
});

const Project    = mongoose.model('Project',    projectSchema);
const Deployment = mongoose.model('Deployment', deploymentSchema);

// ── Connect MongoDB ──────────────────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('[DB] MongoDB connected:', MONGODB_URI))
  .catch(err => console.warn('[DB] MongoDB not available, running without persistence:', err.message));

// ── Build Runner import ──────────────────────────────────────────────────────
const { runBuild } = require('./buildRunner');

// ════════════════════════════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════════════════════════════

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok:      true,
    mode:    RUNNER_MODE,
    db:      mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime:  Math.round(process.uptime()) + 's',
    version: '1.0.0'
  });
});

// ── Projects ─────────────────────────────────────────────────────────────────
app.get('/api/projects', async (req, res) => {
  try {
    const projects = await Project.find().sort({ createdAt: -1 });
    res.json(projects);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id', async (req, res) => {
  try {
    const p = await Project.findById(req.params.id);
    if (!p) return res.status(404).json({ error: 'Project not found' });
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const p = new Project(req.body);
    await p.save();
    res.status(201).json(p);
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/projects/:id', async (req, res) => {
  try {
    req.body.updatedAt = new Date();
    const p = await Project.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    await Project.findByIdAndDelete(req.params.id);
    await Deployment.deleteMany({ projectId: req.params.id });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Deployments ───────────────────────────────────────────────────────────────
app.get('/api/deployments', async (req, res) => {
  try {
    const filter = req.query.projectId ? { projectId: req.query.projectId } : {};
    const deps = await Deployment.find(filter).sort({ startedAt: -1 }).limit(100);
    res.json(deps);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/deployments/:id', async (req, res) => {
  try {
    const d = await Deployment.findById(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DEPLOY — main trigger endpoint ───────────────────────────────────────────
app.post('/api/deploy', async (req, res) => {
  const { name, subdomain, repoUrl, branch, installCmd, buildCmd, outputDir, nodeVer, envVars, projectId } = req.body;

  if (!name || !subdomain || !repoUrl) {
    return res.status(400).json({ error: 'name, subdomain and repoUrl are required' });
  }

  // Upsert project in DB
  let project;
  try {
    project = await Project.findOneAndUpdate(
      { subdomain },
      { name, subdomain, repoUrl, branch: branch||'main', installCmd: installCmd||'npm install',
        buildCmd: buildCmd||'npm run build', outputDir: outputDir||'dist',
        nodeVer: nodeVer||'18', envVars: envVars||{}, updatedAt: new Date() },
      { upsert: true, new: true }
    );
  } catch(dbErr) {
    // If DB not available, create an in-memory stub
    project = { _id: projectId || ('local_' + Date.now()), name, subdomain, repoUrl,
                branch: branch||'main', installCmd: installCmd||'npm install',
                buildCmd: buildCmd||'npm run build', outputDir: outputDir||'dist',
                nodeVer: nodeVer||'18', envVars: envVars||{} };
  }

  // Create deployment record
  let deployment;
  try {
    deployment = new Deployment({
      projectId: project._id, projectName: name,
      branch: branch||'main', status: 'pending'
    });
    await deployment.save();
  } catch(dbErr) {
    deployment = { _id: 'local_' + Date.now(), projectId: project._id, projectName: name,
                   branch: branch||'main', status: 'pending', logs: [],
                   save: async () => {}, startedAt: new Date() };
  }

  const deployId = deployment._id.toString();

  // Respond immediately — build runs asynchronously
  res.json({ ok: true, deployId, message: 'Build started' });

  // ── Run build asynchronously ─────────────────────────────────────
  const buildStart = Date.now();
  deployment.status = 'building';
  try { await deployment.save(); } catch(e) {}

  const emit = (event, data) => io.emit(event, { deployId, ...data });

  try {
    emit('build:log', { line: `\x1b[36m[DeployBoard]\x1b[0m Starting ${RUNNER_MODE} build for \x1b[1m${name}\x1b[0m` });
    emit('build:log', { line: `\x1b[90mRepo: ${repoUrl}  Branch: ${branch||'main'}\x1b[0m` });
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

    const duration = Math.round((Date.now() - buildStart) / 1000);
    deployment.status   = 'success';
    deployment.duration = duration;
    deployment.endedAt  = new Date();
    try { await deployment.save(); } catch(e) {}

    emit('build:log',  { line: `\x1b[32m[DeployBoard]\x1b[0m Build succeeded in ${duration}s` });
    emit('build:done', { status: 'success', duration });
    console.log(`[Deploy] SUCCESS ${name} (${deployId}) in ${duration}s`);

  } catch(buildErr) {
    const duration = Math.round((Date.now() - buildStart) / 1000);
    deployment.status   = 'failed';
    deployment.duration = duration;
    deployment.endedAt  = new Date();
    try { await deployment.save(); } catch(e) {}

    emit('build:log',  { line: `\x1b[31m[DeployBoard]\x1b[0m Build failed: ${buildErr.message}` });
    emit('build:done', { status: 'failed', duration });
    console.error(`[Deploy] FAILED ${name} (${deployId}):`, buildErr.message);

    // Cleanup on failure
    const buildDir = path.join(TMP_DIR, deployId);
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}
  }
});

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket.io] Client connected:', socket.id);
  socket.on('disconnect', () => console.log('[Socket.io] Client disconnected:', socket.id));
});

// ── Catch-all → serve frontend ───────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[DeployBoard] Server running on http://localhost:${PORT}`);
  console.log(`[DeployBoard] Runner mode: ${RUNNER_MODE}`);
  console.log(`[DeployBoard] Sites dir:   ${SITES_DIR}`);
  console.log(`[DeployBoard] Temp dir:    ${TMP_DIR}`);
});
