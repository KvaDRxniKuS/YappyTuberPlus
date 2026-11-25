/** Small owning LRU. Oversized entries stay caller-owned, never enter cache. */
export class TextureCache<K,V> {
  private entries=new Map<K,{value:V;bytes:number}>();
  bytes=0;
  constructor(private release:(value:V)=>void,private maxEntries=4,private maxBytes=32*1024*1024){}
  get(key:K):V|undefined {
    const entry=this.entries.get(key);if(!entry)return undefined;
    this.entries.delete(key);this.entries.set(key,entry);return entry.value;
  }
  delete(key:K){const entry=this.entries.get(key);if(!entry)return;
    this.entries.delete(key);this.bytes-=entry.bytes;this.release(entry.value);
  }
  set(key:K,value:V,bytes:number):boolean {
    if(bytes>this.maxBytes||bytes<0||!Number.isFinite(bytes))return false;
    this.delete(key);
    while(this.entries.size&&(this.entries.size>=this.maxEntries||this.bytes+bytes>this.maxBytes))this.delete(this.entries.keys().next().value!);
    this.entries.set(key,{value,bytes});this.bytes+=bytes;return true;
  }
  get size(){return this.entries.size;}
  clear(){for(const key of this.entries.keys())this.delete(key);}
}
