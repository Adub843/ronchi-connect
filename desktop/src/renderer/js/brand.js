/** Applies the brand (colours, logo, background photos) to the window. */
import { h } from './ui.js';

let brand = { productName: 'Ronchi Connect', company: 'Ronchi America', logoUrl: null, backgroundUrls: [] };

export function applyBrand(value) {
  brand = value;
  document.title = brand.productName;
  if (/^#[0-9a-f]{6}$/i.test(brand.accentColor || '')) {
    document.documentElement.style.setProperty('--accent', brand.accentColor);
  }
  const backdrop = document.getElementById('backdrop');
  if (brand.backgroundUrls.length) {
    // Cross-fade through the machine photos.
    const layers = brand.backgroundUrls.map((url, index) => {
      const layer = h('div', { class: `photo ${index === 0 ? 'show' : ''}` });
      layer.style.backgroundImage = `url("${url}")`;
      return layer;
    });
    backdrop.append(...layers);
    backdrop.classList.add('has-photos');
    if (layers.length > 1) {
      let current = 0;
      setInterval(() => {
        layers[current].classList.remove('show');
        current = (current + 1) % layers.length;
        layers[current].classList.add('show');
      }, 9000);
    }
  }
}

export function getBrand() { return brand; }

/** The logo image when one is configured, otherwise a text wordmark. */
export function brandMark(size = 'large') {
  const [first, ...rest] = brand.productName.split(' ');
  return h('div', { class: `brand-mark ${size}` },
    brand.logoUrl
      ? h('img', { src: brand.logoUrl, alt: brand.company })
      : h('span', { class: 'wordmark' }, first.toUpperCase()),
    h('span', { class: 'product' }, brand.logoUrl ? brand.productName.replace(/^Ronchi\s+/i, '') : rest.join(' ')),
  );
}
