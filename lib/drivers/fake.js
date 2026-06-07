'use strict';

// fake driver — deterministic, zero cost. For tests (SWARM_DRIVER=fake).
// Uses the context the runner passes to act sensibly without any LLM call.

module.exports = {
  name: 'fake',
  available() { return true; },
  async run(systemPrompt, userPrompt, ctx) {
    ctx = ctx || {};
    const tasks = ctx.assignedTasks || [];
    if (tasks.length) {
      const t = tasks[0];
      return { text: `[FAKE] Working assigned task.\n##SWARM:DONE:${t.id}:[fake] Completed "${t.title}" via SWARM_DRIVER=fake test mode.##\n##SWARM:ROOM:Done "${t.title}".##\n##SWARM:STATUS:idle##` };
    }
    if (ctx.bestOpen) {
      const t = ctx.bestOpen;
      return { text: `[FAKE] Claiming open board task.\n##SWARM:CLAIM:${t.id}##\n##SWARM:ROOM:Taking "${t.title}".##` };
    }
    const inbox = ctx.inbox || [];
    if (inbox.length) {
      return { text: `[FAKE] Acknowledged ${inbox.length} message(s).\n##SWARM:STATUS:idle##` };
    }
    const room = ctx.room || [];
    if (room.length) {
      return { text: `[FAKE] Saw ${room.length} room message(s).\n##SWARM:STATUS:idle##` };
    }
    return { text: '[FAKE] No work. Standing by.' };
  },
};
