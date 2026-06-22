let CLIENT_ID = '109313795001-rrs5loo9edglps6f1guqgeid0n95s58h.apps.googleusercontent.com';
let API_KEY = 'AIzaSyC6Aq1d1MA5n_7kpiShetr4ngvAcr9GK6A';
let SCOPES = 'https://www.googleapis.com/auth/drive.appdata';

let tokenClient = null;
let accessToken = null;
let driveFileId = null; // Stores our tracking file's ID on Google Drive

window.accessToken = null;
window.driveFileId = null;

// Ensure scripts are loaded before initializing
function startGapiOrGsi() {
  if (typeof gapi !== 'undefined' && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
    initDriveSync();
  } else {
    setTimeout(startGapiOrGsi, 100);
  }
}

// Initialize Google API client libraries and credentials dynamically
async function initDriveSync() {
  try {
    const res = await fetch('config.json');
    if (res.ok) {
      const config = await res.json();
      CLIENT_ID = config.clientId || CLIENT_ID;
      API_KEY = config.apiKey || API_KEY;
      SCOPES = config.scopes || SCOPES;
      console.log("Credentials loaded from config.json successfully.");
    } else {
      console.warn("config.json could not be loaded. Falling back to default credentials.");
    }
  } catch (err) {
    console.warn("Could not load config.json (expected if running via file:// protocol). Using default credentials.", err);
  }

  // 1. Initialize OAuth token client immediately so popup is ready to open
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: async (resp) => {
        if (resp.error) return console.error(resp);
        accessToken = resp.access_token;
        window.accessToken = accessToken;
        
        if (typeof checkSyncPrompt === 'function') {
          checkSyncPrompt();
        }
        
        // Update UI status state to synced
        const statusEl = document.getElementById('syncStatus');
        if (statusEl) {
          statusEl.innerText = "☁️ Drive Sync: Synced";
          statusEl.className = "text-xs bg-emerald-950 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded font-semibold";
        }
        
        // Sync loop initialization
        await findOrCreateSyncFile();
      }
    });
    console.log("OAuth token client initialized successfully.");
    
    // Update the sync banner state
    if (typeof checkSyncPrompt === 'function') {
      checkSyncPrompt();
    }
  } catch (err) {
    console.error("Error initializing Google Identity Services token client:", err);
  }

  // 2. Initialize legacy Google API Client (gapi) for fallback discovery, if loaded
  if (typeof gapi !== 'undefined') {
    gapi.load('client', () => {
      gapi.client.init({
        apiKey: API_KEY,
        discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"]
      }).then(() => {
        console.log("GAPI client initialized successfully.");
      }).catch(err => {
        console.error("Error initializing legacy gapi client (using fetch fallbacks):", err);
      });
    });
  }
}

// Start checking for GAPI/GSI scripts
startGapiOrGsi();

function handleAuthClick() {
  if (!tokenClient) {
    console.warn("Google Drive Sync client is still initializing. Please try again in a moment.");
    return;
  }
  if (accessToken === null) {
    tokenClient.requestAccessToken({ prompt: 'consent' });
  } else {
    syncDataToDrive();
  }
}

// Search for existing file in the hidden appDataFolder, create one if missing
async function findOrCreateSyncFile() {
  try {
    let files = [];
    
    // Attempt using GAPI if it initialized successfully
    if (typeof gapi !== 'undefined' && gapi.client && gapi.client.drive) {
      const response = await gapi.client.drive.files.list({
        spaces: 'appDataFolder',
        fields: 'files(id, name)',
        pageSize: 1
      });
      files = response.result.files || [];
    } else {
      // Direct fetch fallback if GAPI/Discovery failed (e.g. file:// protocol CORS issues)
      console.log("GAPI client not available. Querying files via direct fetch API.");
      const response = await fetch('https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&pageSize=1', {
        headers: {
          'Authorization': 'Bearer ' + accessToken
        }
      });
      if (response.ok) {
        const result = await response.json();
        files = result.files || [];
      } else {
        throw new Error("Direct list fetch failed with status: " + response.status);
      }
    }
    
    if (files && files.length > 0) {
      driveFileId = files[0].id;
      window.driveFileId = driveFileId;
      // Download the data and merge it with localStorage progress
      await pullDataFromDrive();
    } else {
      // Brand new user, upload current local list to cloud
      await syncDataToDrive();
    }
  } catch (err) {
    console.error("Error finding/creating sync file:", err);
  }
}

// Upload local JSON watchlist configuration to Google Drive
async function syncDataToDrive() {
  if (!accessToken) return;
  
  const metadata = {
    name: 'watchlist.json'
  };
  if (!driveFileId) {
    metadata.parents = ['appDataFolder'];
  }

  const localData = localStorage.getItem('anime_watchlist') || '[]';
  const file = new Blob([localData], { type: 'application/json' });
  const formData = new FormData();
  
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('file', file);

  let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  if (driveFileId) {
    url = `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=multipart`;
  }

  try {
    const response = await fetch(url, {
      method: driveFileId ? 'PATCH' : 'POST',
      headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
      body: formData
    });
    
    if (response.ok) {
      const data = await response.json();
      if (!driveFileId && data && data.id) {
        driveFileId = data.id;
        window.driveFileId = driveFileId;
      }
      
      // Update UI status state to synced
      const statusEl = document.getElementById('syncStatus');
      if (statusEl) {
        statusEl.innerText = "☁️ Drive Sync: Synced";
        statusEl.className = "text-xs bg-emerald-950 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded font-semibold";
      }
    } else {
      console.error("Sync response not OK:", response.statusText);
    }
  } catch (err) {
    console.error("Error syncing data to Drive:", err);
  }
}

// Pull cloud data down to sync progress
async function pullDataFromDrive() {
  if (!driveFileId) return;
  try {
    let parsedData = null;
    
    // Attempt using GAPI if it initialized successfully
    if (typeof gapi !== 'undefined' && gapi.client && gapi.client.drive) {
      const response = await gapi.client.drive.files.get({
        fileId: driveFileId,
        alt: 'media'
      });
      
      if (response.result) {
        parsedData = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
      } else if (response.body) {
        parsedData = JSON.parse(response.body);
      }
    } else {
      // Direct fetch fallback if GAPI/Discovery failed
      console.log("GAPI client not available. Downloading file content via direct fetch API.");
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
        headers: {
          'Authorization': 'Bearer ' + accessToken
        }
      });
      if (response.ok) {
        parsedData = await response.json();
      } else {
        throw new Error("Direct download fetch failed with status: " + response.status);
      }
    }

    if (parsedData && Array.isArray(parsedData)) {
      // Merge local and cloud watchlist:
      // Keep all items. If an item exists in both, keep the one with higher progress.
      const localWatchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
      const mergedMap = new Map();

      // Add cloud items first
      parsedData.forEach(item => {
        mergedMap.set(item.id, item);
      });

      // Merge local items
      localWatchlist.forEach(item => {
        if (mergedMap.has(item.id)) {
          const cloudItem = mergedMap.get(item.id);
          // Keep the item with the higher progress
          if (item.progress > cloudItem.progress) {
            mergedMap.set(item.id, { ...cloudItem, progress: item.progress });
          }
        } else {
          mergedMap.set(item.id, item);
        }
      });

      const mergedList = Array.from(mergedMap.values());
      localStorage.setItem('anime_watchlist', JSON.stringify(mergedList));
      watchlist = mergedList;
      loadWatchlistDetails(); // Re-trigger UI layout rendering
      
      // Update the cloud with the merged progress
      await syncDataToDrive();
    }
  } catch (err) {
    console.error("Error pulling data from Drive:", err);
  }
}