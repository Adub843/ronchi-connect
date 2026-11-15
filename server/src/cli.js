'use strict';
/**
 * Command-line account management, for use on the server itself.
 *
 *   node src/cli.js add-user <username> "<Full Name>" <password> [admin]
 *   node src/cli.js set-password <username> <password>
 *   node src/cli.js list-users
 */
const { loadConfig } = require('./config');
const { Store } = require('./store');
const { Auth } = require('./auth');

const config = loadConfig();
const store = new Store(config.dataDir);
const auth = new Auth(store, config);
const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'add-user') {
    const [username, name, password, role] = args;
    const user = auth.createUser({ username, name, password, role });
    console.log(`Created ${user.role} "${user.username}".`);
  } else if (command === 'set-password') {
    const user = store.findUserByUsername(args[0]);
    if (!user) throw new Error('User not found.');
    auth.setPassword(user.id, args[1]);
    console.log('Password updated.');
  } else if (command === 'list-users') {
    for (const u of store.listUsers()) console.log(`${u.username}\t${u.role}\t${u.name}`);
  } else {
    console.log('Usage: add-user <username> "<Full Name>" <password> [admin] | set-password <username> <password> | list-users');
    process.exit(1);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
