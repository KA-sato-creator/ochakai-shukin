// Firebase コンソール →（歯車）プロジェクトの設定 → マイアプリ の「firebaseConfig」の値です。
// これらは公開されても問題ない設定値です。記録データはサインインと Firestore のルール（firestore.rules）で守ります。
// 共通で使うアカウントのメールアドレスとパスワードは、ここには書きません（ソースが公開されるため）。
export const firebaseConfig = {
  apiKey: "AIzaSyBaHHbEEiXsqjAj1OEWRMB-VaANKdc2-BY",
  authDomain: "otyakai-kaikei.firebaseapp.com",
  projectId: "otyakai-kaikei",
  storageBucket: "otyakai-kaikei.firebasestorage.app",
  messagingSenderId: "247903164303",
  appId: "1:247903164303:web:905b885eb31ef4ba421dfa"
};
