import type { RigFrame } from "../types";

/** Compare numeric/string channels without serializing whole frames. Time, sequence,
 * diagnostics and execution order don't change pixels; object.layer does.
 * Frames are immutable engine snapshots, never mutate them after delivery. */
function sameRecord(a: object | undefined, b: object | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(right,key) && Object.is(left[key],right[key]));
}

function sameChannels(a: Record<string,object>|undefined,b:Record<string,object>|undefined):boolean {
  if(a===b) return true;
  if(!a||!b) return false;
  const ids=Object.keys(a);
  return ids.length===Object.keys(b).length && ids.every(id=>sameRecord(a[id],b[id]));
}

export function sameVisualFrame(a: RigFrame | null, b: RigFrame | null): boolean {
  if (a === b) return true;
  if (!a || !b || !sameRecord(a.globals,b.globals) || !sameRecord(a.texts,b.texts)
    || !sameChannels(a.vars,b.vars) || !sameChannels(a.media,b.media)) return false;
  const ids = Object.keys(a.objects);
  return ids.length === Object.keys(b.objects).length && ids.every(id => sameRecord(a.objects[id],b.objects[id]));
}
