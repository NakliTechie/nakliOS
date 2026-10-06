// Controlled native WASM trap tests the owning runtime's Worker error path.
self.onmessage=()=>{
 const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,7,8,1,4,116,114,97,112,0,0,10,5,1,3,0,0,11]);
 new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.trap();
};
