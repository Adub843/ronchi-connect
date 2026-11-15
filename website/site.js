'use strict';
/*
 * Website behaviour: apply branding from /brand/brand.json and list the
 * installers the server has in its downloads folder. The page works without
 * JavaScript too; it just shows the text wordmark and no direct download links.
 */
(async function () {
  const $ = (id) => document.getElementById(id);

  // ---- branding
  try {
    const brand = await (await fetch('/brand/brand.json')).json();
    if (/^#[0-9a-f]{6}$/i.test(brand.accentColor || '')) document.documentElement.style.setProperty('--accent', brand.accentColor);
    if (brand.logoFile) {
      $('logo').src = '/brand/' + brand.logoFile;
      $('logo').hidden = false;
      $('wordmark').hidden = true;
    }
    if (brand.backgrounds && brand.backgrounds.length) {
      $('hero-photo').style.backgroundImage = 'url("/brand/backgrounds/' + encodeURIComponent(brand.backgrounds[0]) + '")';
      $('hero').classList.add('has-photo');
    }
    if (brand.company) $('company').textContent = brand.company;
  } catch (err) { /* keep defaults */ }

  // ---- downloads
  const platform = /Win/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'mac' : /Linux|X11/i.test(navigator.userAgent) ? 'linux' : null;
  const names = { windows: 'Windows', mac: 'macOS', linux: 'Linux' };
  const megabytes = (bytes) => Math.round(bytes / 1048576) + ' MB';
  let files = [];
  try { files = (await (await fetch('/api/downloads')).json()).files; } catch (err) { /* none */ }

  const list = $('downloads');
  list.textContent = '';
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'fine';
    empty.textContent = 'Installers are being prepared. Please ask your Ronchi technician for the download link.';
    list.append(empty);
    $('download-note').textContent = 'Installers are being prepared.';
    return;
  }
  for (const file of files) {
    const link = document.createElement('a');
    link.className = 'download-card';
    link.href = file.url;
    link.download = '';
    const title = document.createElement('strong');
    title.textContent = names[file.platform];
    const detail = document.createElement('span');
    detail.textContent = file.name + ' · ' + megabytes(file.size);
    link.append(title, detail);
    list.append(link);
  }
  const mine = files.find((file) => file.platform === platform);
  if (mine) {
    $('download-button').href = mine.url;
    $('download-button').setAttribute('download', '');
    $('download-label').textContent = 'Download for ' + names[platform];
    $('download-note').textContent = mine.name + ' · ' + megabytes(mine.size) + ' · Free for Ronchi customers. No account needed.';
  }
})();
