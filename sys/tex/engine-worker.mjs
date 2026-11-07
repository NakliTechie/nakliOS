// The AGPL engine stays behind this Worker: the host talks to it by messages only. The package spawns its own inner
// Worker, which ends with this one, so terminating this Worker cancels a compile.
let engine = null, runner = null;

async function loadPackage(base) {
  return engine ||= await import(`${base}/index.js`);
}

const handlers = {
  async start({ base, packs }) {
    const { BusyTexRunner } = await loadPackage(base);
    runner = new BusyTexRunner({
      busytexBasePath:base,
      preloadDataPackages:packs.map(pack => `${base}/${pack}.js`),
      onDownloadProgress:progress => postMessage({ type:'download', progress }),
    });
    await runner.initialize();
    return true;
  },
  async compile({ files, main, driver }) {
    const { pdf, synctex, log, exitCode } = await runner.compile(files, main, null, null, null, null, 'silent', driver, null, undefined, false, []);
    return { pdf, synctex, log, exitCode };
  },
  async cached({ base, packs }) {
    const { isPackageCached } = await loadPackage(base);
    return Promise.all(packs.map(pack => isPackageCached(`${base}/${pack}.js`)));
  },
  async clear({ base }) {
    await (await loadPackage(base)).clearAllPackageCache();
    return true;
  },
};

self.onmessage = async ({ data }) => {
  try {
    const result = await handlers[data.op](data);
    const buffers = [result?.pdf?.buffer, result?.synctex?.buffer].filter(Boolean);
    postMessage({ type:'reply', id:data.id, result }, buffers);
  } catch (error) {
    postMessage({ type:'reply', id:data.id, error:String(error?.message || error) });
  }
};
