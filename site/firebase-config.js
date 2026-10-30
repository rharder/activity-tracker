// Public web configuration, shared with the money and permit apps.
// Access is enforced by Firestore rules, NOT by keeping this configuration secret.
export const firebaseConfig = {
  apiKey: 'AIzaSyDhJVLylH40lUgfIJL9nSQfqbBJpEbbdaM',
  authDomain: 'kids-money-tracker-f24be.firebaseapp.com',
  projectId: 'kids-money-tracker-f24be',
  storageBucket: 'kids-money-tracker-f24be.firebasestorage.app',
  messagingSenderId: '148984236841',
  appId: '1:148984236841:web:6c03e95dc169891dc54538'
};

export const trackerCollection = 'activityTrackers';
