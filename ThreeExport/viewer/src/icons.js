// Line icons (24 × 24, drawn with the current text colour). Elements with data-icon="name"
// get the icon put in front of their content by placeIcons(); code uses ICONS directly.
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICONS = {
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  colour: svg('<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-1.4-1.2-1.8-1.2-3 0-1.1.9-2 2-2H17a4 4 0 0 0 4-4c0-3.9-4-7-9-7z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>'),
  filter: svg('<path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8z"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  hide: svg('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/><path d="M4 20 20 4"/>'),
  cut: svg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 19M8.1 15.9 20 5"/>'),
  isolate: svg('<rect x="8.5" y="8.5" width="7" height="7" rx="1"/><path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M17 3h2.5A1.5 1.5 0 0 1 21 4.5V7M21 17v2.5a1.5 1.5 0 0 1-1.5 1.5H17M7 21H4.5A1.5 1.5 0 0 1 3 19.5V17" stroke-dasharray="2 2.2"/>'),
  // a block with four arrows pointing away from it
  explode: svg('<rect x="9" y="9" width="6" height="6" rx="1"/><path d="M7 7 3.5 3.5m0 0v3.2m0-3.2h3.2M17 7l3.5-3.5m0 0v3.2m0-3.2h-3.2M7 17l-3.5 3.5m0 0v-3.2m0 3.2h3.2M17 17l3.5 3.5m0 0v-3.2m0 3.2h-3.2"/>'),
  // a ruler with ticks
  measure: svg('<path d="m3.5 15.8 12.3-12.3 4.7 4.7L8.2 20.5z"/><path d="m7.3 12 1.9 1.9M10.1 9.2l1.4 1.4M12.9 6.4l1.9 1.9"/>'),
  // a table with a header row
  table: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>'),
  download: svg('<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>'),
  // corners of a frame: fit to view
  fit: svg('<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="2.2"/>'),
  zoom: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m20 20-5.2-5.2M10.5 8v5M8 10.5h5"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  eye: svg('<path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/>'),
};

/** Puts the icon named by data-icon in front of each element's content (once). */
export function placeIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.firstElementChild?.tagName.toLowerCase() === 'svg') continue;
    const icon = ICONS[el.dataset.icon];
    if (icon) el.insertAdjacentHTML('afterbegin', icon);
  }
}
