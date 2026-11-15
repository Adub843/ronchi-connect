'use strict';
/**
 * Team administration: only users with role "admin" can manage accounts.
 */
const { ProtocolError } = require('./errors');
const { publicUser } = require('./auth');

function registerAdminHandlers(hub) {
  const { auth, store } = hub;
  const asProtocolError = (fn) => {
    try { return fn(); } catch (err) { throw new ProtocolError('invalid', err.message); }
  };

  hub.on('admin.users.list', 'admin', () => ({
    users: store.listUsers().map((u) => ({ ...publicUser(u), createdAt: u.createdAt })),
  }));

  hub.on('admin.users.create', 'admin', (client, msg) => {
    const user = asProtocolError(() => auth.createUser(msg));
    hub.broadcastPresence();
    return { user: publicUser(user) };
  });

  hub.on('admin.users.setPassword', 'admin', (client, msg) => {
    asProtocolError(() => auth.setPassword(msg.id, msg.password));
  });

  hub.on('admin.users.remove', 'admin', (client, msg) => {
    if (msg.id === client.user.id) throw new ProtocolError('invalid', 'You cannot remove your own account.');
    if (!store.findUserById(msg.id)) throw new ProtocolError('not_found', 'User not found.');
    store.removeUser(msg.id);
    // Disconnect the removed user everywhere.
    for (const connection of [...(hub.techsByUser.get(msg.id) || [])]) connection.ws.close();
    hub.broadcastPresence();
  });
}

module.exports = { registerAdminHandlers };
