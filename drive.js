const CLIENT_ID = '109313795001-rrs5loo9edglps6f1guqgeid0n95s58h.apps.googleusercontent.com';
const API_KEY = 'AIzaSyC6Aq1d1MA5n_7kpiShetr4ngvAcr9GK6A';
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';

let tokenClient;
let accessToken = null;
let driveFileId = null; // Stores our tracking file's ID on Google Drive

// Initialize Google API client libraries
function gapiStart() {
  gapi.client.init({ apiKey: API_KEY, discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] });
}
gapi.load('client', gapiStart);

// Initialize OAuth token client
tokenClient = google.accounts.oauth2.initTokenClient({
  client_id: CLIENT_ID,
  scope: SCOPES,
  callback: async (resp) => {
    if (resp.error) return console.error(resp);
    accessToken = resp.access_token;
    document.getElementById('syncDriveBtn').innerText = "☁️ Synced to Cloud";
    document.getElementById('syncDriveBtn').className = "bg-emerald-950 text-emerald-400 border border-emerald-500/30 text-xs px-4 py-2 rounded-lg font-bold";
    
    // Sync loop initialization
    await findOrCreateSyncFile();
  }
});

function handleAuthClick() {
  if (accessToken === null) {
    tokenClient.requestAccessToken({ prompt: 'consent' });
  } else {
    syncDataToDrive();
  }
}

// Search for existing file in the hidden appDataFolder, create one if missing
async function findOrCreateSyncFile() {
  const response = await gapi.client.drive.files.list({
    spaces: 'appDataFolder',
    fields: 'files(id, name)',
    pageSize: 1
  });
  
  const files = response.result.files;
  if (files && files.length > 0) {
    driveFileId = files[0].id;
    // Download the data and merge it with localStorage progress
    await pullDataFromDrive();
  } else {
    // Brand new user, upload current local list to cloud
    await syncDataToDrive();
  }
}

// Upload local JSON watchlist configuration to Google Drive
async function syncDataToDrive() {
  if (!accessToken) return;
  
  const metadata = {
    name: 'watchlist.json',
    parents: ['appDataFolder']
  };

  const localData = localStorage.getItem('anime_watchlist') || '[]';
  const file = new Blob([localData], { type: 'application/json' });
  const formData = new FormData();
  
  formData.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  formData.append('file', file);

  let url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  if (driveFileId) {
    url = `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=multipart`;
  }

  await fetch(url, {
    method: driveFileId ? 'PATCH' : 'POST',
    headers: new Headers({ 'Authorization': 'Bearer ' + accessToken }),
    body: formData
  });
}

// Pull cloud data down to sync progress
async function pullDataFromDrive() {
  if (!driveFileId) return;
  const response = await gapi.client.drive.files.get({
    fileId: driveFileId,
    alt: 'media'
  });
  if (response.result) {
    localStorage.setItem('anime_watchlist', JSON.stringify(response.result));
    watchlist = response.result;
    loadWatchlistDetails(); // Re-trigger UI layout rendering
  }
}