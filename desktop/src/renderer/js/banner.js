'use strict';
/* The always-on-top strip shown on the customer's screen for the whole session. */
const text = document.getElementById('text');
const controlButton = document.getElementById('control');

window.banner.onState((state) => {
  const who = state.technicians.length ? state.technicians.join(', ') : 'A Ronchi technician';
  text.textContent = `${who} can ${state.control ? 'see and control' : 'see'} this screen`;
  text.title = `Press ${state.shortcut} to end the session at any time`;
  controlButton.textContent = state.control ? 'Pause control' : 'Allow control';
});
controlButton.addEventListener('click', () => window.banner.toggleControl());
document.getElementById('end').addEventListener('click', () => window.banner.endSession());
