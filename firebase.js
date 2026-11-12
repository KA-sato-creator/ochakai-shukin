// Firebase（Authentication と Firestore）を app.js につなぐ。
// SDK は Google の配信元から読み込む。設定値は firebase-config.js。
import { firebaseConfig } from "./firebase-config.js";

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const App = window.ShukinApp;

const norm = e => ({ code: String((e && e.code) || "unknown").replace(/^firestore\//, ""), message: e && e.message });

if (!firebaseConfig || !firebaseConfig.apiKey || !firebaseConfig.projectId) {
  App.notConfigured();
} else {
  try {
    const [appM, authM, fsM] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-firestore.js`)
    ]);
    const app = appM.initializeApp(firebaseConfig);
    const auth = authM.getAuth(app);
    auth.languageCode = "ja";
    const provider = new authM.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const db = fsM.getFirestore(app);

    const wrap = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), pending: s.metadata.hasPendingWrites });
    const opts = { includeMetadataChanges: true };

    App.start({
      onAuth: cb => authM.onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, name: u.displayName || "", email: u.email || "" } : null)),
      // クリックの中でそのまま呼ぶ（ポップアップを止められないように）
      signIn: () => authM.signInWithPopup(auth, provider),
      signOut: () => authM.signOut(auth),
      watchDoc: (path, next, err) => fsM.onSnapshot(fsM.doc(db, path), opts,
        s => next(wrap(s), { fromCache: s.metadata.fromCache }), e => err(norm(e))),
      watchCol: (path, where, next, err) => {
        const ref = fsM.collection(db, path);
        const q = where ? fsM.query(ref, fsM.where(where[0], where[1], where[2])) : ref;
        return fsM.onSnapshot(q, opts, qs => next(qs.docs.map(wrap), { fromCache: qs.metadata.fromCache }), e => err(norm(e)));
      },
      update: (path, data) => fsM.updateDoc(fsM.doc(db, path), data).catch(e => { throw norm(e); }),
      add: (path, data) => fsM.addDoc(fsM.collection(db, path), data).catch(e => { throw norm(e); }),
      // ルールの確認回数の上限（まとめ書きは 1 回あたり 20 件まで）に当たらないよう、5 件ずつ送る
      importDocs: async (docs, onProgress) => {
        for (let i = 0; i < docs.length; i += 5) {
          const b = fsM.writeBatch(db);
          for (const d of docs.slice(i, i + 5)) b.set(fsM.doc(db, d.path), d.data);
          try { await b.commit(); } catch (e) { throw norm(e); }
          if (onProgress) onProgress(Math.min(i + 5, docs.length), docs.length);
        }
      }
    });
  } catch (e) {
    console.error(e);
    App.loadFailed("Firebase の部品を読み込めませんでした。");
  }
}
