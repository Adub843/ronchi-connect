'use strict';
/** Entry point: `npm start`. */
const { loadConfig } = require('./config');
const { createServer } = require('./app');

const config = loadConfig();
const { server } = createServer(config);
server.listen(config.port, () => {
  console.log(`Ronchi Connect server listening on port ${config.port}`);
  if (!config.turnHost) console.log('TURN relay not configured: connections that cannot go direct will fail. See deploy/README.md.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
