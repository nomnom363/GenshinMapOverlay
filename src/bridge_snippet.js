(async () => {
  try {
    const foundIds = new Set();
    console.log('Scanning AppSample for found markers...');

    // 1. Dynamic Webpack module evaluation (target module 4787 & 9302)
    let wreq = null;
    if (window.webpackChunk_N_E) {
      window.webpackChunk_N_E.push([['__sync_' + Date.now()], {}, (r) => { wreq = r; }]);
    }

    if (wreq) {
      try {
        const mod4787 = wreq(4787);
        if (mod4787 && typeof mod4787.r0 === 'function') {
          for (const k in wreq.c) {
            const exp = wreq.c[k]?.exports;
            if (exp?.gz && typeof exp.gz === 'object') {
              for (const g in exp.gz) {
                for (const c in exp.gz[g]) {
                  const list = exp.gz[g][c];
                  if (Array.isArray(list)) {
                    list.forEach(m => {
                      if (m && m.id && mod4787.r0(m.id)) {
                        foundIds.add(Number(m.id));
                      }
                    });
                  }
                }
              }
            }
          }
        }
      } catch (e) {}

      try {
        const mod9302 = wreq(9302)?.Z;
        const uid = mod9302?.uid || window._store?.getState()?.user?.user?.uid;
        if (uid && typeof mod9302?.get === 'function') {
          const doc = await mod9302.get('users', uid);
          if (doc && Array.isArray(doc.markerIds)) {
            doc.markerIds.forEach(id => foundIds.add(Number(id)));
          }
        }
      } catch (e) {}
    }

    // 2. Scan LocalStorage
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      if (!v) continue;
      try {
        const p = JSON.parse(v);
        if (Array.isArray(p?.markerIds)) {
          p.markerIds.forEach(id => foundIds.add(Number(id)));
        }
        if (Array.isArray(p)) {
          p.forEach(id => {
            const n = Number(id);
            if (Number.isFinite(n) && n > 0 && n < 2000000) foundIds.add(n);
          });
        }
      } catch (e) {}
    }

    // 3. Scan IndexedDB
    if (window.indexedDB && indexedDB.databases) {
      try {
        const dbs = await indexedDB.databases();
        for (const d of dbs) {
          if (!d.name) continue;
          await new Promise(res => {
            const req = indexedDB.open(d.name);
            req.onerror = () => res();
            req.onsuccess = () => {
              const db = req.result;
              const sNames = Array.from(db.objectStoreNames);
              if (!sNames.length) { db.close(); return res(); }
              let count = sNames.length;
              const done = () => { if (--count === 0) { db.close(); res(); } };
              for (const s of sNames) {
                try {
                  const tx = db.transaction(s, 'readonly');
                  const g = tx.objectStore(s).getAll();
                  g.onsuccess = () => {
                    for (const row of g.result || []) {
                      if (!row) continue;
                      if (Array.isArray(row.markerIds)) {
                        row.markerIds.forEach(x => { const n = Number(x); if (Number.isFinite(n) && n > 0) foundIds.add(n); });
                      }
                      const str = JSON.stringify(row);
                      const m = str.match(/"markerIds"\s*:\s*\[([^\]]+)\]/);
                      if (m) {
                        try {
                          JSON.parse('[' + m[1] + ']').forEach(x => { const n = Number(x); if (Number.isFinite(n) && n > 0) foundIds.add(n); });
                        } catch (e) {}
                      }
                    }
                    done();
                  };
                  g.onerror = () => done();
                } catch (e) { done(); }
              }
            };
          });
        }
      } catch (e) {}
    }

    const ids = Array.from(foundIds);
    if (!ids.length) {
      alert('No markers found in browser storage or cloud. Ensure you are logged into genshin-impact-map.appsample.com and have markers on your map.');
      return;
    }

    console.log('Sending ' + ids.length + ' markers to Genshin Map Overlay...');
    const res = await fetch('http://127.0.0.1:48762/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const result = await res.json();
    alert('✓ Successfully synced ' + result.count + ' markers (' + result.added + ' new) to Genshin Map Overlay!');
  } catch (err) {
    alert('Sync error: ' + err.message);
  }
})();