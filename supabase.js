// State Management
window.supabaseClient = null;
window.currentUser = null;

// Initialize Supabase Client
async function initSupabase() {
  try {
    const res = await fetch('config.json');
    if (!res.ok) throw new Error("Failed to load config.json");
    const config = await res.json();
    
    const url = config.supabaseUrl;
    const key = config.supabasePublishableKey || config.supabaseAnonKey;
    
    if (url && key) {
      window.supabaseClient = supabase.createClient(url, key);
      console.log("Supabase Client initialized successfully.");
      
      // Hook up Auth state change listener
      window.supabaseClient.auth.onAuthStateChange((event, session) => {
        if (session) {
          window.currentUser = session.user;
          updateAuthUI(true, session.user.email);
          syncWatchlistWithSupabase();
        } else {
          window.currentUser = null;
          updateAuthUI(false);
          // Restore local watchlist state
          watchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
          loadWatchlistDetails();
        }
      });
    } else {
      console.warn("Supabase credentials not found in config.json. Running in local-only mode.");
      updateAuthUI(false);
    }
  } catch (err) {
    console.error("Error loading Supabase config:", err);
    updateAuthUI(false);
  }
}

// Start Supabase Init
initSupabase();

// Sync Watchlist from Supabase on Login (Merge local changes)
async function syncWatchlistWithSupabase() {
  if (!window.supabaseClient || !window.currentUser) return;
  
  updateSyncStatus("Syncing...");
  try {
    // 1. Fetch items from database
    const { data: dbItems, error: fetchErr } = await window.supabaseClient
      .from('watchlist')
      .select('*');
      
    if (fetchErr) throw fetchErr;
    
    // 2. Read local items
    const localWatchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
    const mergedMap = new Map();
    
    // Add all db items first
    dbItems.forEach(item => {
      mergedMap.set(item.anime_id, {
        id: item.anime_id,
        title: item.title,
        progress: item.progress
      });
    });
    
    // Merge local items: keep highest progress or add new ones
    for (const localItem of localWatchlist) {
      if (mergedMap.has(localItem.id)) {
        const dbMatch = mergedMap.get(localItem.id);
        if (localItem.progress > dbMatch.progress) {
          // Local is ahead, update in map and also update in db
          dbMatch.progress = localItem.progress;
          await window.supabaseClient
            .from('watchlist')
            .update({ progress: localItem.progress })
            .eq('user_id', window.currentUser.id)
            .eq('anime_id', localItem.id);
        }
      } else {
        // Local item not in DB, insert to DB and add to map
        mergedMap.set(localItem.id, localItem);
        await window.supabaseClient
          .from('watchlist')
          .insert({
            user_id: window.currentUser.id,
            anime_id: localItem.id,
            title: localItem.title,
            progress: localItem.progress
          });
      }
    }
    
    // 3. Update state and localStorage
    watchlist = Array.from(mergedMap.values());
    localStorage.setItem('anime_watchlist', JSON.stringify(watchlist));
    
    // Check for pending additions
    const pendingAdd = sessionStorage.getItem('pending_addition');
    if (pendingAdd) {
      try {
        const { id, title, coverImage, type } = JSON.parse(pendingAdd);
        sessionStorage.removeItem('pending_addition'); // clear immediately

        // Conflict Prevention: Skip if the show is already in the watchlist
        if (!watchlist.some(item => item.id === id)) {
          watchlist.push({ id, title, progress: 0 });

          if (type === 'seasonal' && coverImage) {
            const existingInCache = cachedApiDetails.find(c => c.id === id);
            if (!existingInCache) {
              cachedApiDetails.push({
                id: id,
                title: { romaji: title, english: title },
                coverImage: { large: coverImage },
                status: 'RELEASING',
                episodes: null,
                nextAiringEpisode: null
              });
              localStorage.setItem('anime_metadata_cache', JSON.stringify(cachedApiDetails));
            }
          }

          // Insert into database and local storage
          await window.supabaseClient.from('watchlist').insert({
            user_id: window.currentUser.id,
            anime_id: id,
            title: title,
            progress: 0
          });
          localStorage.setItem('anime_watchlist', JSON.stringify(watchlist));
        }
      } catch (e) {
        console.error("Failed to execute pending addition:", e);
      }
    }
    
    // Re-render
    loadWatchlistDetails(true); // Force API fresh details if needed
    updateSyncStatus("Synced", "success");
  } catch (err) {
    console.error("Sync with Supabase failed:", err);
    updateSyncStatus("Sync Error", "error");
  }
}

// Upload local changes to Supabase in real-time
async function syncDataToSupabase() {
  if (!window.supabaseClient || !window.currentUser) return;
  
  updateSyncStatus("Saving...");
  try {
    const { data: dbItems, error: fetchErr } = await window.supabaseClient
      .from('watchlist')
      .select('anime_id');
      
    if (fetchErr) throw fetchErr;
    
    const dbIds = dbItems.map(d => d.anime_id);
    const currentIds = watchlist.map(w => w.id);
    
    // Upsert current items
    for (const item of watchlist) {
      if (dbIds.includes(item.id)) {
        // Update progress
        await window.supabaseClient
          .from('watchlist')
          .update({ progress: item.progress })
          .eq('user_id', window.currentUser.id)
          .eq('anime_id', item.id);
      } else {
        // Insert new entry
        await window.supabaseClient
          .from('watchlist')
          .insert({
            user_id: window.currentUser.id,
            anime_id: item.id,
            title: item.title,
            progress: item.progress
          });
      }
    }
    
    // Delete items that were removed
    const toDelete = dbIds.filter(id => !currentIds.includes(id));
    if (toDelete.length > 0) {
      await window.supabaseClient
        .from('watchlist')
        .delete()
        .eq('user_id', window.currentUser.id)
        .in('anime_id', toDelete);
    }
    
    updateSyncStatus("Synced", "success");
  } catch (err) {
    console.error("Sync data to Supabase error:", err);
    updateSyncStatus("Sync Error", "error");
  }
}

// UI Status Handlers
function updateSyncStatus(text, type = "info") {
  const statusEl = document.getElementById('syncStatus');
  if (!statusEl) return;
  
  statusEl.innerText = `☁️ Supabase: ${text}`;
  
  if (type === "success") {
    statusEl.className = "text-xs bg-emerald-950 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded font-semibold";
  } else if (type === "error") {
    statusEl.className = "text-xs bg-red-950 text-red-400 border border-red-500/30 px-3 py-1.5 rounded font-semibold";
  } else if (type === "pending") {
    statusEl.className = "text-xs bg-amber-950 text-amber-400 border border-amber-500/30 px-3 py-1.5 rounded font-semibold";
  } else {
    statusEl.className = "text-xs bg-gray-800 text-gray-500 px-3 py-1.5 rounded border border-gray-700/60 font-medium";
  }
}

function updateAuthUI(isLoggedIn, email = "") {
  const headerAuthBtn = document.getElementById('headerAuthBtn');
  const userDisplay = document.getElementById('userDisplay');
  
  if (isLoggedIn) {
    if (userDisplay) {
      userDisplay.innerText = email;
      userDisplay.classList.remove('hidden');
    }
    if (headerAuthBtn) {
      headerAuthBtn.innerText = "Logout";
      headerAuthBtn.onclick = handleLogout;
      headerAuthBtn.className = "bg-gray-850 hover:bg-gray-800 border border-gray-700 text-white text-xs px-3 py-1.5 rounded-lg font-medium cursor-pointer transition-all";
    }
  } else {
    updateSyncStatus("Not Logged In");
    if (userDisplay) userDisplay.classList.add('hidden');
    if (headerAuthBtn) {
      headerAuthBtn.innerText = "🔑 Sign In";
      headerAuthBtn.onclick = () => { window.location.href = 'login.html'; };
      headerAuthBtn.className = "bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg font-bold cursor-pointer transition-all";
    }
  }
}

async function handleLogout() {
  if (!window.supabaseClient) return;
  updateSyncStatus("Logging out...", "pending");
  const { error } = await window.supabaseClient.auth.signOut();
  if (error) {
    console.error("Logout failed:", error);
    updateSyncStatus("Logout Error", "error");
  } else {
    // Clear watchlist and metadata caches from localStorage
    localStorage.removeItem('anime_watchlist');
    localStorage.removeItem('anime_metadata_cache');
    
    // Reset global watchlist states in the window execution context
    watchlist = [];
    cachedApiDetails = [];
    watchlistCurrentPage = 1;
    
    // Trigger dashboard re-render to display the empty state
    loadWatchlistDetails();
  }
}
