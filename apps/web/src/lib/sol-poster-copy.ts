// A quoted ban is a constraint, never a line of poster copy.
export function posterCopyPolicy(notes:string, approved:string) {
  const excluded=new Set<string>();
  const designNotes=notes.replace(/(?:不要(?:使用|用|写|出现|保留)?|不得(?:使用|出现)?|禁用|别(?:用|写)|去掉|排除)\s*(?:旧(?:的)?(?:口号|文案))?\s*[：:]?\s*[「“"]([^」”"\n]{1,120})[」”"]/gu, (_match,value:string)=>{
    excluded.add(value.trim());
    return "排除已指明的旧文案";
  });
  const copy=approved.split(/\r?\n/).filter(line=>![...excluded].some(term=>term&&line.includes(term))).join("\n");
  return {designNotes,copy,excluded:[...excluded]};
}
