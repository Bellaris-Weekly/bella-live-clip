import {useState} from 'preact/hooks';
import {Icon} from './icon.jsx';
import {BELLA_PRESET, sameStyle, textStyle} from '../preview/cover-presets.js';
import {layerOf, OUTPUTS} from '../preview/cover.js';

export function TextTools({cover, state, active, disabled}) {
  const [selected, setSelected] = useState(null),
    [menu, setMenu] = useState(null),
    [name, setName] = useState('');
  const text = state.text,
    presets = cover.presets.value;
  const matching = presets.find(preset => sameStyle(preset.style, text));
  const current = presets.find(preset => preset.id === selected) || matching;
  const canSave = name.trim() && (menu === 'manage' || (!matching && presets.length < 21));
  function persist(next, id = current?.id) {
    try {
      cover.savePresets(next);
      setSelected(id);
      setMenu(null);
    } catch {
      cover.notice.value = '无法保存预设，请检查脚本管理器的存储设置';
    }
  }
  function save() {
    if (!canSave) return;
    if (menu === 'save') {
      const preset = {id: crypto.randomUUID(), name: name.trim(), style: textStyle(text)};
      persist([...presets, preset], preset.id);
    } else if (current && current.id !== BELLA_PRESET.id) {
      persist(presets.map(preset => (preset.id === current.id ? {...preset, name: name.trim()} : preset)));
    }
  }
  const number =
    (key, low, high, divisor = 1) =>
    event => {
      const value = event.currentTarget.valueAsNumber;
      if (Number.isFinite(value)) cover.setText({[key]: Math.min(high, Math.max(low, value / divisor))});
    };
  return (
    <fieldset
      class="cover-text"
      disabled={disabled}
      onKeyDown={event => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.preventDefault();
      }}
    >
      <textarea
        data-cover-text
        aria-label="封面文字"
        rows={2}
        maxLength={120}
        placeholder="封面文字（可选），回车换行"
        value={text.value}
        onInput={event => cover.setText({value: event.currentTarget.value})}
      />
      <div class="cover-presets" role="group" aria-label="文字预设">
        <div class="cover-preset-dots">
          {presets.map(preset => (
            <button
              type="button"
              key={preset.id}
              class="cover-preset-dot"
              style={{backgroundColor: preset.style.color, borderColor: preset.style.stroke}}
              aria-label={preset.name}
              title={preset.name}
              aria-pressed={String(current?.id === preset.id && sameStyle(preset.style, text))}
              onClick={() => {
                cover.setText(preset.style);
                setSelected(preset.id);
                setMenu(null);
              }}
            />
          ))}
        </div>
        <button
          type="button"
          class="icon small"
          aria-label="保存文字预设"
          title={matching ? '已有相同参数的预设' : '保存为预设'}
          disabled={Boolean(matching) || presets.length >= 21}
          onClick={() => {
            setMenu(menu === 'save' ? null : 'save');
            setName(`预设 ${presets.length}`);
          }}
        >
          <Icon name="plus" />
        </button>
        {current && current.id !== BELLA_PRESET.id && (
          <button
            type="button"
            class="icon small"
            aria-label="管理文字预设"
            title="管理预设"
            onClick={() => {
              setMenu(menu === 'manage' ? null : 'manage');
              setName(current.name);
            }}
          >
            <Icon name="more" />
          </button>
        )}
      </div>
      {menu && (
        <div class="cover-preset-editor">
          <input
            aria-label="预设名称"
            maxLength={24}
            value={name}
            autoFocus
            onInput={event => setName(event.currentTarget.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.isComposing) {
                event.preventDefault();
                save();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setMenu(null);
              }
            }}
          />
          <div class="row">
            {menu === 'manage' && current && (
              <button
                type="button"
                class="icon small"
                aria-label="删除文字预设"
                title="删除预设"
                onClick={() =>
                  persist(
                    presets.filter(preset => preset.id !== current.id),
                    null,
                  )
                }
              >
                <Icon name="trash" />
              </button>
            )}
            <button type="button" class="link small" onClick={() => setMenu(null)}>
              取消
            </button>
            <button type="button" class="small" disabled={!canSave} onClick={save}>
              保存
            </button>
          </div>
        </div>
      )}
      <details class="cover-text-details">
        <summary>样式</summary>
        <div class="cover-style-fields">
          <label>
            字色
            <input
              type="color"
              aria-label="文字颜色"
              value={text.color}
              onInput={event => cover.setText({color: event.currentTarget.value})}
            />
          </label>
          <label>
            字号
            <input
              type="number"
              aria-label="文字字号"
              min={32}
              max={324}
              value={Math.round(text.size * 1080)}
              onInput={number('size', 0.03, 0.3, 1080)}
            />
          </label>
          <label class="cover-style-effect">
            效果
            <select
              aria-label="文字效果"
              value={text.effect}
              onChange={event => cover.setText({effect: event.currentTarget.value})}
            >
              <option value="outline">描边</option>
              <option value="band">底条</option>
              <option value="shadow">阴影</option>
            </select>
          </label>
          {text.effect === 'outline' && (
            <>
              <label>
                描边
                <input
                  type="color"
                  aria-label="描边颜色"
                  value={text.stroke}
                  onInput={event => cover.setText({stroke: event.currentTarget.value})}
                />
              </label>
              <label>
                粗细
                <input
                  type="number"
                  aria-label="描边粗细"
                  min={0}
                  max={30}
                  value={Math.round(text.strokeWidth * 100)}
                  onInput={number('strokeWidth', 0, 0.3, 100)}
                />
              </label>
            </>
          )}
        </div>
      </details>
      <label class="switch">
        <input
          type="checkbox"
          role="switch"
          checked={layerOf(state, active).showText}
          onChange={event => cover.showText(active, event.currentTarget.checked)}
        />
        在 {OUTPUTS[active].label} 封面上显示文字
      </label>
    </fieldset>
  );
}
