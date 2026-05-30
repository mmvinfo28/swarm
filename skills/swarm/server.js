#!/usr/bin/env node
// Entry point wrapper — skillDir resolves to skills/swarm/, plugin root is ../../
require(require('path').join(__dirname, '../../lib/server.js'));
