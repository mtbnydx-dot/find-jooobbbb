import React, { useEffect, useRef, useState } from 'react';
import { Button, Notice } from '../components/UI';
import { useMobile } from '../lib/runtime';
export const listOf = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
export const dateLabel = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供';
export const moneyLabel = (amount, currency = 'CNY') => { try { return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(Number(amount || 0) / 100); } catch { return `${currency} ${(Number(amount || 0) / 100).toFixed(2)}`; } };
export const csv = value => Array.isArray(value) ? value.join('，') : String(value || '');
export const splitCsv = value => [...new Set(String(value || '').split(/[,，、;；\n]/).map(item => item.trim()).filter(Boolean))];
export function safeMobileReturnTo(value, fallback = '/account') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n\0]/.test(value)) return fallback;
  try { const decoded = decodeURIComponent(value); if (/^\/\/|[\\\r\n\0]/.test(decoded)) return fallback;
    const url = new URL(value, 'https://mobile.invalid');
    if (url.origin !== 'https://mobile.invalid' || url.hash || !/^\/(?:discover|jobs\/[^/]+(?:\/source)?|pipeline|account|membership|attachments|messages|settings|support|saved-searches|prep(?:\/sections)?|practice(?:\/result)?|onboarding|ai|wrongbook|bookmarks|exam(?:\/(?:session|result))?)$/.test(url.pathname)) return fallback;
    return `${url.pathname}${url.search}`;
  } catch { return fallback; }
}
export const notificationDestination = link => typeof link === 'string' ? safeMobileReturnTo(link.replace(/^\/jobs(?=\?|$)/, '/discover'), '') : '';
export function ResourceState({ resource, label = '正在读取账户资料' }) {
  return resource.error ? <div className="account-resource" role="alert"><Notice>{resource.error.message || String(resource.error)}</Notice><Button variant="outline" onClick={() => resource.reload()}>重新加载</Button></div> : <div className="account-resource" role="status" aria-live="polite">{label}…</div>;
}
export const ActionError = ({ error }) => error ? <p className="account-error" role="alert">{error}</p> : null;
export function useAccountAction() {
  const { user, notify } = useMobile(); const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), lock = useRef(false), owner = useRef(user?.id); owner.current = user?.id;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (operation, success, after) => {
    if (lock.current) return null; lock.current = true; setBusy(true); setError(''); const userId = owner.current;
    try { const result = await operation(); if (!active.current || userId !== owner.current) return null; if (after) await after(result); if (success && active.current) notify(success); return result ?? true; }
    catch (cause) { if (active.current && userId === owner.current && cause.name !== 'AbortError') setError(cause.message || '操作未完成，请重试'); return null; }
    finally { lock.current = false; if (active.current) setBusy(false); }
  };
  return { busy, error, setError, run };
}
export function downloadBlob(blob, name) { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
