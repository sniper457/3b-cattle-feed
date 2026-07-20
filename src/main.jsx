import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App.jsx'

// Register service worker — auto-updates when new version deployed.
// This app is used as an installed home-screen PWA that people rarely fully
// close, so the browser's normal "check for a new SW on page load" almost
// never fires. Without polling, a phone can keep running a build from days
// ago even though Vercel/GitHub show the latest commit as live — code fixes
// silently never reach the device. We poll the registered SW for updates
// every 60s while the app is open, and force-activate + reload the instant
// a new one is found so fixes actually land on real devices.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    if (registration) {
      setInterval(() => { registration.update(); }, 60 * 1000);
    }
  },
  onNeedRefresh() { updateSW(true); },
  onOfflineReady() {},
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
