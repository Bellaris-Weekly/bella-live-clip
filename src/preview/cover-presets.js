// Same style fields and built-in preset as the studio; custom presets live in userscript storage.
export const BELLA_PRESET = {
  id: 'bella',
  name: '贝拉应援色',
  style: {size: 0.1, color: '#DB7D74', stroke: '#ffffff', strokeWidth: 0.25, effect: 'outline'},
};
export const PRESETS_KEY = 'coverTextPresets.v1';
const color = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
export function validStyle(style) {
  return (
    style &&
    ['outline', 'band', 'shadow'].includes(style.effect) &&
    color(style.color) &&
    color(style.stroke) &&
    Number.isFinite(style.size) &&
    style.size >= 0.03 &&
    style.size <= 0.3 &&
    Number.isFinite(style.strokeWidth) &&
    style.strokeWidth >= 0 &&
    style.strokeWidth <= 0.3
  );
}
export function textStyle(text) {
  const {size, color, stroke, strokeWidth, effect} = text;
  return {size, color, stroke, strokeWidth, effect};
}
export function sameStyle(a, b) {
  return (
    a.size === b.size &&
    a.color.toLowerCase() === b.color.toLowerCase() &&
    a.stroke.toLowerCase() === b.stroke.toLowerCase() &&
    a.strokeWidth === b.strokeWidth &&
    a.effect === b.effect
  );
}
export function readPresets(get) {
  try {
    const stored = get(PRESETS_KEY, []),
      seen = new Set(['bella']);
    const custom = (Array.isArray(stored) ? stored : [])
      .filter(preset => {
        if (
          !preset ||
          typeof preset.id !== 'string' ||
          !preset.id ||
          seen.has(preset.id) ||
          typeof preset.name !== 'string' ||
          !preset.name.trim() ||
          preset.name.length > 24 ||
          !validStyle(preset.style)
        )
          return false;
        seen.add(preset.id);
        return true;
      })
      .slice(0, 20);
    return [
      {...BELLA_PRESET, style: {...BELLA_PRESET.style}},
      ...custom.map(preset => ({id: preset.id, name: preset.name, style: textStyle(preset.style)})),
    ];
  } catch {
    return [{...BELLA_PRESET, style: {...BELLA_PRESET.style}}];
  }
}
