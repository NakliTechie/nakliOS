# lcms-wasm 1.0.5 (LittleCMS 2.16 compiled to WebAssembly)

- Source: npm `lcms-wasm@1.0.5` (https://github.com/mattdesl/lcms-wasm), files `dist/lcms.js` (67,586 bytes,
  sha256 1a5c8f81186211856ba7c5d6841e35fe3fa901b857a247f72318e1652c5e1cec) and `dist/lcms.wasm` (315,910 bytes, sha256 dbcbee3fb3a49459a60bb6b29d6ab25fe7c219b0cc0c2b9579c0cc78f7390ddd), unmodified.
- Licences: the wrapper is MIT, Copyright (c) 2024 Matt DesLauriers (LICENSE.md in this folder). LittleCMS
  (https://github.com/mm2/Little-CMS) is MIT, Copyright (c) 1998-2023 Marti Maria Saguer:

  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  > documentation files (the "Software"), to deal in the Software without restriction, including without limitation
  > the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
  > permit persons to whom the Software is furnished to do so, subject to the following conditions:
  > The above copyright notice and this permission notice shall be included in all copies or substantial portions of
  > the Software.
  > THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
  > THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  > AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
  > CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
  > IN THE SOFTWARE.
- Size: 383 KB together, loaded lazily by `src/files/cms.js` the first time a person's ICC profile is used (soft
  proof and CMYK TIFF export through a profile). Atelier ships no ICC profiles; the person supplies them.
- Update: `npm pack lcms-wasm@<version>`, copy `package/dist/lcms.js`, `package/dist/lcms.wasm` and
  `package/LICENSE.md` here, update the hashes above, rerun `npm test`.
