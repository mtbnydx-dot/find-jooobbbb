import { useState } from 'react';
import { Link } from 'react-router-dom';
import { workspaceApi } from '../lib/workspace-api';
import '../styles/workspace.css';
export function SaveSearch({filters}) {
  const [open,setOpen]=useState(false),[name,setName]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  return <div className="saved-search-control"><button className="button secondary" type="button" onClick={()=>{setOpen(!open);setName([filters.location,filters.q,filters.major].filter(Boolean).join(' · ')||'我的岗位搜索');setMessage('');setError('');}}>保存当前搜索</button><Link to="/workspace">我的搜索与求职工具</Link>{open&&<form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await workspaceApi.saveSearch({name,filters});setMessage('搜索已保存，可在求职工具中随时使用');setOpen(false);}catch(error){setError(error.message);}finally{setBusy(false);}}}><input aria-label="搜索名称" value={name} onChange={e=>setName(e.target.value)} maxLength={100} required/><button className="button primary" disabled={busy}>{busy?'保存中…':'确认保存'}</button></form>}{message&&<span role="status">{message}</span>}{error&&<span className="form-error" role="alert">{error}</span>}</div>;
}
