import { useEffect,useRef,useState } from "react";
import { Keyboard,X } from "lucide-react";
import { SHORTCUT_GROUPS } from "../engine/shortcuts";

export function ShortcutGuide() {
  const [open,setOpen]=useState(false),[tab,setTab]=useState(0);
  const root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    if(!open) return;
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setOpen(false);button.current?.focus();}};
    const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node)) setOpen(false);};
    window.addEventListener("keydown",key,true);window.addEventListener("pointerdown",outside);
    return ()=>{window.removeEventListener("keydown",key,true);window.removeEventListener("pointerdown",outside);};
  },[open]);
  return <div className="shortcut-guide" ref={root}>
    <button ref={button} title="Клавиши и сочетания" aria-label="Клавиши и сочетания" aria-expanded={open} onClick={()=>setOpen(!open)}><Keyboard size={17}/></button>
    {open&&<section className="shortcut-guide-popup" aria-label="Справочник клавиш" onKeyDown={event=>event.stopPropagation()}>
      <header><b>Клавиши и сочетания</b><button aria-label="Закрыть справочник" onClick={()=>setOpen(false)}><X size={16}/></button></header>
      <div role="tablist">{SHORTCUT_GROUPS.map((group,i)=><button key={group.title} role="tab" aria-selected={tab===i} onClick={()=>setTab(i)}>{group.title}</button>)}</div>
      <div role="tabpanel">{SHORTCUT_GROUPS[tab].items.map(([keys,label])=><div className="shortcut-guide-row" key={keys}><kbd>{keys}</kbd><span>{label}</span></div>)}</div>
      <small>Клавиши инструментов работают по физической раскладке. В полях ввода действуют команды поля.</small>
    </section>}
  </div>;
}
