// fetch JSON with a couple of retries: on the build machine a freshly written
// file can stall on its first read while it is virus-scanned
export async function fetchJSON(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise(res => setTimeout(res, 400 * i));
    }
  }
}
