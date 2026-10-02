const path = require('path');
const { app } = require('electron');
const json = require('./jsonFile');
let jobs;
let active = null;
let lastProgressSave = 0;
const file = () => path.join(app.getPath('userData'), 'librarian-download-queue.json');
const clone = json.clone;
function load() {
  if (jobs) return jobs;
  const saved = json.read(file(), [], Array.isArray);
  jobs = saved.map(job => ['processing', 'preparing', 'paused'].includes(job.status)
    ? { ...job, status: 'interrupted', error: 'Librarian closed during this job. Resume when ready.' } : job);
  return jobs;
}
function commit(next) { json.write(file(), next); jobs = next; }
function snapshot() { return { jobs: clone(load()), active: clone(active) }; }
function add(job) {
  if (!job || !Number.isFinite(job.id) || typeof job.name !== 'string' || job.name.length > 512) throw new Error('Invalid queue job');
  if (load().length >= 500) throw new Error('The queue is full (500 jobs).');
  if (load().some(j => j.id === job.id)) throw new Error('Duplicate queue job');
  const next = { ...clone(job), status: 'queued', percent: 0, createdAt: Date.now() };
  commit([...load(), next]);
  return clone(next);
}
function patch(id, updates) {
  const existing = load().find(j => j.id === id);
  if (!existing) throw new Error('Queue job no longer exists');
  for (const field of ['appid', 'path', 'jobType', 'customGameId', 'installPath']) {
    if (existing[field] != null && Object.hasOwn(updates, field) && updates[field] !== existing[field]) throw new Error(`Cannot change a queued game's ${field}. Remove the job and start it again.`);
  }
  if (['update', 'repair'].includes(existing.jobType)) {
    for (const field of ['destPath', 'installDir']) {
      if (existing[field] != null && Object.hasOwn(updates, field) && updates[field] !== existing[field]) throw new Error('Cannot redirect an update to another installation. Remove the job and start it again.');
    }
  }
  const next = { ...existing, ...clone(updates), id: existing.id };
  commit(load().map(j => j.id === id ? next : j));
  return clone(next);
}
function remove(id) {
  if (active?.jobId === id) throw new Error('Cancel the active download before removing it.');
  commit(load().filter(j => j.id !== id));
  return true;
}
function begin(jobId, details) {
  if (active) throw new Error('A download is already active');
  if (jobId != null) patch(jobId, { status: 'processing', error: '', destPath: details.destPath, selectedDepots: details.selectedDepots });
  active = { ...clone(details), jobId, startedAt: Date.now(), percent: 0, paused: false, logs: [] };
}
function progress(field, value) {
  if (!active) return;
  if (field === 'log') { active.logs.push(String(value)); active.logs = active.logs.slice(-100); }
  else active[field] = clone(value);
  // Progress is expendable; intent and transitions are saved synchronously.
  if (field === 'percent' && active.jobId != null && Date.now() - lastProgressSave > 3000) {
    lastProgressSave = Date.now();
    try { patch(active.jobId, { percent: active.percent }); }
    catch (error) { console.error('Could not save download progress:', error.message); }
  }
}
function pause(paused) {
  if (active?.jobId != null) patch(active.jobId, { status: paused ? 'paused' : 'processing' });
  if (active) active.paused = paused;
}
function finish(status, error = '') {
  const current = active;
  // Persist before releasing ownership. On failure the caller reports it.
  try {
    if (current?.jobId != null) patch(current.jobId, { status, error: String(error), percent: status === 'complete' ? 100 : current.percent });
  } finally { active = null; }
}
module.exports = { snapshot, add, patch, remove, begin, progress, pause, finish };
