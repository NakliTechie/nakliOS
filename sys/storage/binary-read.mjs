// Folder snapshots support whole-file caps and explicit bounded byte ranges.
// Offset is opt-in: a maxBytes-only request retains its whole-file size guard.
export const MAX_BINARY_RANGE_BYTES = 16 * 1024 * 1024;
function fail(code,message){throw Object.assign(new Error(code+': '+message),{code})}
export function checkBinaryRead({maxBytes,offset}={}){
  if(maxBytes!==undefined&&(!Number.isSafeInteger(maxBytes)||maxBytes<0))fail('EINVAL','maxBytes must be a non-negative safe integer');
  if(offset===undefined)return;
  if(!Number.isSafeInteger(offset)||offset<0)fail('EINVAL','offset must be a non-negative safe integer');
  if(maxBytes===undefined)fail('EINVAL','offset requires an explicit maxBytes');
  if(maxBytes>MAX_BINARY_RANGE_BYTES)fail('EFBIG','range read exceeds the 16 MiB limit');
}
export async function readFileBytes(file,options={}){
  checkBinaryRead(options);
  const {maxBytes,offset}=options;
  if(offset===undefined){
    if(maxBytes!==undefined&&(!Number.isSafeInteger(file.size)||file.size<0))fail('ENOTSUP','bounded read requires a reliable byte size');
    if(maxBytes!==undefined&&file.size>maxBytes)fail('EFBIG','file exceeds bounded read limit');
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(maxBytes!==undefined&&bytes.length>maxBytes)fail('EFBIG','file exceeds bounded read limit');
    return bytes;
  }
  if(!Number.isSafeInteger(file.size)||file.size<0)fail('ENOTSUP','range read requires a reliable byte size');
  if(typeof file.slice!=='function')fail('ENOTSUP','provider lacks bounded file slices');
  if(maxBytes===0||offset>=file.size)return new Uint8Array();
  const length=Math.min(maxBytes,file.size-offset),part=file.slice(offset,offset+length);
  if(!part||part.size!==length||typeof part.arrayBuffer!=='function')fail('ENOTSUP','provider returned an invalid bounded slice');
  const bytes=new Uint8Array(await part.arrayBuffer());
  if(bytes.byteLength!==length)fail('EIO','bounded slice returned unexpected bytes');
  return bytes;
}
