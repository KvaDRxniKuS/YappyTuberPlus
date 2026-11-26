import {ChevronDown} from "lucide-react";
import type {ReactNode} from "react";
export function SceneToolOptions({label,active,onClick,icon,children}:{label:string;active:boolean;onClick:()=>void;icon:ReactNode;children:ReactNode}){
 return <div className="scene-tool-options"><button aria-label={label} title={label} className={active?"active":""} onClick={onClick}>{icon}<ChevronDown size={9}/></button><div className="scene-tool-popover" role="group" aria-label={`Настройки: ${label}`}>{children}</div></div>;
}
