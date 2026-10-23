import { getApps, initializeApp } from 'firebase-admin/app';
import { deploymentConfig } from './deployment.js';

// Existing web application configuration; Admin SDK credentials use ADC.
const firebaseConfig = {
  apiKey: "AIzaSyC3bIA4RfgUnx8Rsfjkxx3HwltPS6o51S0",
  authDomain: "urbanists-mixer-slides-helper.firebaseapp.com",
  projectId: "urbanists-mixer-slides-helper",
  storageBucket: "urbanists-mixer-slides-helper.firebasestorage.app",
  messagingSenderId: "143738155808",
  appId: "1:143738155808:web:385e87e73d547fdaf49d45"
};

/** Validates staging identity before reusing or initializing the shared Auth project app. */
export function firebaseApp() {
  deploymentConfig();
  return getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
}
