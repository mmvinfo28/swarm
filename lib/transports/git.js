'use strict';

const fs = require('fs');
const path = require('path');
const { BaseTransport, SyncTransportMixin } = require('./base');
const gitSync = require('../git-sync');

/**
 * Git Transport
 *
 * Uses a git repository as the communication layer.
 * Files stored in .swarm/ directory, synced via git push/pull.
 *
 * Pros: Zero infra, audit trail, works offline, free
 * Cons: 5-30s latency, merge conflicts possible
 */
class GitTransport extends BaseTransport {
  constructor(opts) {
    super(opts);
    this._swarmDir = path.join(this.swarmRoot, '.swarm');
    this._pollInterval = opts.pollInterval || 15000;
    this._pollTimer = null;
    this._lastHash = null;
  }

  _fullPath(relativePath) {
    return path.join(this._swarmDir, relativePath);
  }

  _ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // --- Sync CRUD (used by existing lib modules) ---

  readSync(relativePath) {
    const fp = this._fullPath(relativePath);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp, 'utf-8');
  }

  writeSync(relativePath, content) {
    const fp = this._fullPath(relativePath);
    this._ensureDir(fp);
    fs.writeFileSync(fp, content, 'utf-8');
    this._notify(relativePath, { type: 'update', path: relativePath });
  }

  removeSync(relativePath) {
    const fp = this._fullPath(relativePath);
    if (!fs.existsSync(fp)) return false;
    fs.unlinkSync(fp);
    this._notify(relativePath, { type: 'delete', path: relativePath });
    return true;
  }

  listSync(relativeDir) {
    const dir = this._fullPath(relativeDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  }

  existsSync(relativePath) {
    return fs.existsSync(this._fullPath(relativePath));
  }

  pullSync() {
    return gitSync.pull(this.swarmRoot);
  }

  pushSync(message) {
    return gitSync.syncAndCommit(message || 'swarm sync', this.swarmRoot);
  }

  syncSync(message) {
    return gitSync.syncAndCommit(message || 'swarm sync', this.swarmRoot);
  }

  // --- Async CRUD (standard interface) ---

  async read(relativePath) {
    return this.readSync(relativePath);
  }

  async write(relativePath, content) {
    return this.writeSync(relativePath, content);
  }

  async remove(relativePath) {
    return this.removeSync(relativePath);
  }

  async list(relativeDir) {
    return this.listSync(relativeDir);
  }

  async exists(relativePath) {
    return this.existsSync(relativePath);
  }

  async pull() {
    return this.pullSync();
  }

  async push(message) {
    return this.pushSync(message);
  }

  async sync(message) {
    return this.syncSync(message);
  }

  // --- Watch via polling ---

  watch(relativePath, callback) {
    const unwatch = super.watch(relativePath, callback);

    if (!this._pollTimer) {
      this._startPolling();
    }

    return unwatch;
  }

  _startPolling() {
    this._pollTimer = setInterval(() => {
      try {
        this.pullSync();
        const newHash = gitSync.getLastCommitHash(this.swarmRoot);
        if (newHash && newHash !== this._lastHash) {
          this._lastHash = newHash;
          this._notify('*', { type: 'update', path: '*', source: 'git-poll' });
        }
      } catch (_) {}
    }, this._pollInterval);
  }

  // --- Lifecycle ---

  async init() {
    if (!fs.existsSync(this._swarmDir)) {
      fs.mkdirSync(this._swarmDir, { recursive: true });
    }
    if (!gitSync.isGitRepo(this.swarmRoot)) {
      return { ok: false, error: 'Not a git repository' };
    }
    this._lastHash = gitSync.getLastCommitHash(this.swarmRoot);
    return { ok: true };
  }

  async destroy() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    return super.destroy();
  }

  get name() {
    return 'git';
  }

  get capabilities() {
    return {
      realtime: false,
      offline: true,
      distributed: true,
      conflictFree: false,
    };
  }
}

module.exports = { GitTransport };
