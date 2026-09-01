import { useId, useState } from 'react';
import { Icon } from './Icon';
import { fromCsv } from '../lib/format';

function uniqueTags(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = String(value).trim().toLocaleLowerCase('zh-CN');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function TagInput({
  label,
  items = [],
  onChange,
  placeholder,
  required = false,
  limit,
}) {
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const finiteLimit = limit !== undefined && limit !== null && Number.isFinite(Number(limit)) && Number(limit) >= 0 ? Number(limit) : null;

  const commit = value => {
    const additions = fromCsv(value);
    if (!additions.length) return;
    const next = uniqueTags([...items, ...additions]);
    if (finiteLimit !== null && next.length > finiteLimit) {
      setNotice(`当前套餐最多保存 ${finiteLimit} 个专业`);
      onChange(next.slice(0, Math.max(finiteLimit, items.length)));
    } else {
      setNotice('');
      onChange(next);
    }
    setDraft('');
  };

  const remove = target => {
    setNotice('');
    onChange(items.filter(item => item !== target));
  };

  const onKeyDown = event => {
    if (!['Enter', ',', '，'].includes(event.key)) return;
    event.preventDefault();
    commit(draft);
  };

  return (
    <div className="field tag-field">
      <div className="tag-field-heading">
        <label htmlFor={inputId}>{label}{required ? ' *' : ''}</label>
        <span>{items.length}{finiteLimit !== null ? `/${finiteLimit}` : ''} 个</span>
      </div>
      <div className="tag-input-shell">
        {items.map(item => (
          <span className="tag-item" key={item}>
            {item}
            <button type="button" onClick={() => remove(item)} aria-label={`删除专业 ${item}`}>
              <Icon name="close" size={13} />
            </button>
          </span>
        ))}
        <input
          id={inputId}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          placeholder={items.length ? '继续添加专业' : placeholder}
          aria-describedby={`${inputId}-hint`}
        />
      </div>
      <small id={`${inputId}-hint`} className={notice ? 'tag-field-hint error' : 'tag-field-hint'}>
        {notice || '输入一个或多个专业，按 Enter 或逗号添加为标签'}
      </small>
    </div>
  );
}
