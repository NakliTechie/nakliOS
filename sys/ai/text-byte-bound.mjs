// Count or trim UTF-8 text without allocating an encoded copy.
export function utf8ByteLengthWithin(text, limit) {
  if(typeof text!=='string' || text.length>limit)return null;
  let bytes=0;
  for(let i=0;i<text.length;i++){
    const c=text.charCodeAt(i);
    if(c<128)bytes++;
    else if(c<2048)bytes+=2;
    else if(c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}
    else bytes+=3;
    if(bytes>limit)return null;
  }
  return bytes;
}
export function utf8Prefix(text, limit) {
  let bytes=0,i=0;
  while(i<text.length){
    const c=text.charCodeAt(i),pair=c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff;
    const next=c<128?1:c<2048?2:pair?4:3;
    if(bytes+next>limit)break;
    bytes+=next;i+=pair?2:1;
  }
  return text.slice(0,i);
}
