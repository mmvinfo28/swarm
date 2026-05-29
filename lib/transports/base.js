'use strict';

/**
 * Base Transport Interface
 *
 * All transports implement these methods to provide a unified
 * storage/communication layer for .swarm/ state files.
 *
 * Files are addressed by relative path within the swarm namespace:
 *   "agents/agent-abc123.yaml"
 *   "tasks/task-def456.yaml"
 *   "messages/2024-01-15T10-30-00-abc123.yaml"
 */
class BaseTransport {
  /**
   * @param {object} opts - Transport-specific config
   * @param {string} opts.swarmRoot - Root path (git repo root, server URL, etc.)
   */
  constructor(opts) {
    if (new.target === BaseTransport) {
      throw new Error('BaseTransport is abstract — use a concrete transport');
    }
    this.swarmRoot = opts.swarmRoot;
    this._watchers = new Map();
  }

  // --- Core CRUD ---

  /** Read a file's content. Returns string or null if not found. */
  async read(relativePath) {
    throw new Error('Not implemented: read()');
  }

  /** Write content to a file. Creates parent dirs if needed. */
  async write(relativePath, content) {
    throw new Error('Not implemented: write()');
  }

  /** Delete a file. Returns true if deleted, false if not found. */
  async remove(relativePath) {
    throw new Error('Not implemented: remove()');
  }

  /** List files in a directory. Returns array of relative paths. */
  async list(relativeDir) {
    throw new Error('Not implemented: list()');
  }

  /** Check if a file exists. */
  async exists(relativePath) {
    throw new Error('Not implemented: exists()');
  }

  // --- Sync ---

  /** Pull latest state from remote. Noop for local transports. */
  async pull() {
    return { ok: true };
  }

  /** Push local changes to remote. Noop for local transports. */
  async push(message) {
    return { ok: true };
  }

  /** Pull + commit + push in one atomic operation. */
  async sync(message) {
    const pullResult = await this.pull();
    if (!pullResult.ok) return pullResult;
    const pushResult = await this.push(message || 'swarm sync');
    return pushResult;
  }

  // --- Watch (real-time notifications) ---

  /**
   * Watch a path for changes. Calls callback(event) when files change.
   * event: { type: 'create'|'update'|'delete', path: string, content?: string }
   *
   * Returns an unwatch function.
   */
  watch(relativePath, callback) {
    if (!this._watchers.has(relativePath)) {
      this._watchers.set(relativePath, []);
    }
    this._watchers.get(relativePath).push(callback);

    return () => {
      const cbs = this._watchers.get(relativePath) || [];
      this._watchers.set(relativePath, cbs.filter(cb => cb !== callback));
    };
  }

  /** Emit a change event to watchers. Used internally by transports. */
  _notify(relativePath, event) {
    for (const [pattern, callbacks] of this._watchers.entries()) {
      if (relativePath.startsWith(pattern) || pattern === '*') {
        for (const cb of callbacks) {
          try { cb(event); } catch (_) {}
        }
      }
    }
  }

  // --- Lifecycle ---

  /** Initialize the transport (create dirs, connect, etc.) */
  async init() {
    return { ok: true };
  }

  /** Cleanup resources (close connections, stop watchers) */
  async destroy() {
    this._watchers.clear();
    return { ok: true };
  }

  /** Transport name for display */
  get name() {
    return 'base';
  }

  /** Transport capabilities */
  get capabilities() {
    return {
      realtime: false,
      offline: false,
      distributed: false,
      conflictFree: false,
    };
  }
}

// --- Synchronous wrapper for transports that support it ---

class SyncTransportMixin {
  readSync(relativePath) { throw new Error('Not implemented'); }
  writeSync(relativePath, content) { throw new Error('Not implemented'); }
  removeSync(relativePath) { throw new Error('Not implemented'); }
  listSync(relativeDir) { throw new Error('Not implemented'); }
  existsSync(relativePath) { throw new Error('Not implemented'); }
  pullSync() { return { ok: true }; }
  pushSync(message) { return { ok: true }; }
  syncSync(message) {
    const pullResult = this.pullSync();
    if (!pullResult.ok) return pullResult;
    return this.pushSync(message || 'swarm sync');
  }
}

module.exports = { BaseTransport, SyncTransportMixin };
