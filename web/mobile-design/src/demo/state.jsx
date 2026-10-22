import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { demoDefaults } from './data';
const DemoContext = createContext(null);
const KEY = 'zhilu-mobile-design:demo:v1';
function readDemo(){ try { const data=JSON.parse(sessionStorage.getItem(KEY)); return data?.version===1 ? {...demoDefaults(),...data} : demoDefaults(); } catch { return demoDefaults(); } }
export function DemoProvider({children}) {
  const [state,setState]=useState(readDemo);
  const [toast,setToast]=useState('');
  const timer=useRef();
  useEffect(()=>{try{sessionStorage.setItem(KEY,JSON.stringify(state));}catch{}},[state]);
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  const notify=message=>{setToast(message);clearTimeout(timer.current);timer.current=setTimeout(()=>setToast(''),3200);};
  const patch=changes=>setState(current=>({...current,...(typeof changes==='function'?changes(current):changes)}));
  const toggleSaved=id=>patch(current=>({saved:current.saved.includes(id)?current.saved.filter(x=>x!==id):[...current.saved,id]}));
  const reset=()=>{setState(demoDefaults());notify('已重置全部演示数据');};
  return <DemoContext.Provider value={{state,patch,notify,toggleSaved,reset}}>{children}<div className={`toast ${toast?'show':''}`} role="status" aria-live="polite">{toast}</div></DemoContext.Provider>;
}
export const useDemo=()=>useContext(DemoContext);
