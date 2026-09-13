const paths={
 person:'<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 play:'<path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none"/>',
 pause:'<path d="M8 5v14M16 5v14" stroke-width="3"/>',
 close:'<path d="m6 6 12 12M18 6 6 18"/>',
 refresh:'<path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1.2L20 9M4 15l2.4 3.2A7 7 0 0 0 17.9 17"/>',
 back:'<path d="m10 5-7 7 7 7M3 12h18"/>',
 download:'<path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/>',
 scissors:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.2 8.2 12.3 12.3M8.2 15.8 12 12m3-3 5.5-5.5"/>',
};
export function icon(name){return `<svg class="glyph glyph-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]}</svg>`;}
