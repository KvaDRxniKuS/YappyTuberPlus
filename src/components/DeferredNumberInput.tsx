import {useEffect,useRef,useState,type InputHTMLAttributes} from "react";

/** Text stays local while typing; expensive consumers see only committed values. */
export function DeferredNumberInput({value,onCommit,...props}:Omit<InputHTMLAttributes<HTMLInputElement>,"value"|"onChange"|"type">&{value:number;onCommit:(value:number)=>void}){
 const [draft,setDraft]=useState(String(value));
 const draftRef=useRef(draft),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const commitRef=useRef(onCommit);commitRef.current=onCommit;
 const valueRef=useRef(value);valueRef.current=value;
 const clear=()=>{clearTimeout(timer.current);timer.current=undefined;};
 const commit=()=>{
  clear();const text=draftRef.current.trim(),number=Number(text);
  if(!text||!Number.isFinite(number)){draftRef.current=String(valueRef.current);setDraft(draftRef.current);return;}
  if(number!==valueRef.current)commitRef.current(number);
 };
 useEffect(()=>{draftRef.current=String(value);setDraft(String(value));},[value]);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 return <input {...props} type="number" step={props.step??1} value={draft} onChange={event=>{
  const text=event.target.value;draftRef.current=text;setDraft(text);clear();timer.current=setTimeout(commit,5000);
 }} onBlur={event=>{commit();props.onBlur?.(event);}} onKeyDown={event=>{
  if(event.key==="Enter"){event.preventDefault();commit();}props.onKeyDown?.(event);
 }}/>;
}
