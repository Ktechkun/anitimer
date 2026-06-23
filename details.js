// Page State
let animeId = null;
let mediaDetails = null;
let watchlistRecord = null; // null if not in watchlist, else contains { progress }
let isUserLoggedIn = false;
let supabaseClient = null;
let currentUser = null;
let localWatchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];

// Page State for Episode Pagination
let episodesCurrentPage = null;
const episodesPerPage = 24;


// Helper to compare dates/timestamps of different types (Unix, milliseconds, ISO strings)
function isDateEqual(val1, val2) {
  if (!val1 && !val2) return true;
  if (!val1 || !val2) return false;
  
  const t1 = typeof val1 === 'number' ? val1 : new Date(val1).getTime();
  const t2 = typeof val2 === 'number' ? val2 : new Date(val2).getTime();
  
  const ms1 = t1 > 9999999999 ? t1 : t1 * 1000;
  const ms2 = t2 > 9999999999 ? t2 : t2 * 1000;
  
  return ms1 === ms2;
}

// Extract Anime ID from URL Query String
function parseQueryId() {
  const params = new URLSearchParams(window.location.search);
  const idStr = params.get('id');
  if (idStr) {
    animeId = parseInt(idStr, 10);
  }
}

// GraphQL Query to fetch Anime details from AniList
async function fetchAniListDetails(id) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title {
          romaji
          english
          native
        }
        description
        bannerImage
        coverImage {
          large
        }
        episodes
        status
        genres
        averageScore
        startDate {
          year
          month
          day
        }
        endDate {
          year
          month
          day
        }
      }
    }
  `;

  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { id } })
    });
    const json = await response.json();
    return json.data ? json.data.Media : null;
  } catch (err) {
    console.error("AniList Details Fetch Error:", err);
    return null;
  }
}

// Compute Watchlist Columns for Database updates
function computeWatchlistColumns(localProgress, apiItem) {
  if (!apiItem) return { status: 'caught_up', next_airing_at: null, last_released_at: null };
  
  let currentAiredGlobal = apiItem.episodes || 0;
  if (apiItem.status === 'RELEASING') {
    // fallback or dynamic calculations could be performed here
    currentAiredGlobal = localProgress; 
  }
  const unwatchedCount = Math.max(0, currentAiredGlobal - localProgress);
  const status = unwatchedCount > 0 ? 'can_watch' : 'caught_up';

  let next_airing_at = null;
  // If next airing details existed, we could parse them

  let last_released_at = null;
  const date = (apiItem.endDate && apiItem.endDate.year) ? apiItem.endDate : apiItem.startDate;
  if (date && date.year) {
    const month = (date.month || 1) - 1;
    const day = date.day || 1;
    last_released_at = new Date(date.year, month, day).getTime();
  }

  return { status, next_airing_at, last_released_at };
}

// Initialize Supabase Client
async function initSupabase() {
  const syncStatusEl = document.getElementById('syncStatus');
  try {
    const res = await fetch('config.json');
    if (!res.ok) throw new Error("Failed to load config.json");
    const config = await res.json();
    
    const url = config.supabaseUrl;
    const key = config.supabasePublishableKey || config.supabaseAnonKey;
    
    if (url && key) {
      supabaseClient = supabase.createClient(url, key);
      
      // Get current auth session
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session) {
        currentUser = session.user;
        isUserLoggedIn = true;
        if (syncStatusEl) {
          syncStatusEl.innerText = `☁️ Supabase: Logged in (${session.user.email})`;
          syncStatusEl.className = "text-center text-[10px] text-emerald-400 font-medium";
        }
      } else {
        isUserLoggedIn = false;
        if (syncStatusEl) {
          syncStatusEl.innerText = "☁️ Supabase: Local Mode (Not Logged In)";
          syncStatusEl.className = "text-center text-[10px] text-gray-400 font-medium";
        }
      }
    } else {
      isUserLoggedIn = false;
      if (syncStatusEl) syncStatusEl.innerText = "☁️ Supabase: Credentials missing (Local-only)";
    }
  } catch (err) {
    console.error("Error loading Supabase config:", err);
    isUserLoggedIn = false;
    if (syncStatusEl) syncStatusEl.innerText = "☁️ Supabase: Config load failed (Local-only)";
  }
}

// Fetch user progress for this specific show
async function loadUserProgress() {
  localWatchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
  const localMatch = localWatchlist.find(w => w.id === animeId);
  
  if (isUserLoggedIn && supabaseClient && currentUser) {
    try {
      const { data, error } = await supabaseClient
        .from('watchlist')
        .select('progress')
        .eq('user_id', currentUser.id)
        .eq('anime_id', animeId)
        .maybeSingle();
      
      if (error) throw error;
      
      if (data) {
        watchlistRecord = { progress: data.progress };
      } else {
        watchlistRecord = null; // not in database
      }
    } catch (err) {
      console.error("Failed to load progress from Supabase, falling back to local:", err);
      // Fallback to local storage
      if (localMatch) {
        watchlistRecord = { progress: localMatch.progress };
      } else {
        watchlistRecord = null;
      }
    }
  } else {
    // Local Mode
    if (localMatch) {
      watchlistRecord = { progress: localMatch.progress };
    } else {
      watchlistRecord = null;
    }
  }
}

// Update Watchlist UI Action Button
function renderWatchlistButton() {
  const btn = document.getElementById('watchlistActionBtn');
  if (!btn) return;

  if (watchlistRecord !== null) {
    // Added: show option to remove
    btn.innerText = "✕ Remove from Watchlist";
    btn.className = "w-full py-3 rounded-xl text-xs md:text-sm font-bold bg-red-950/40 text-red-400 border border-red-500/20 hover:bg-red-900/20 transition-all cursor-pointer shadow-lg";
    btn.onclick = removeShow;
  } else {
    // Not added: show option to add
    btn.innerText = "＋ Add to Watchlist";
    btn.className = "w-full py-3 rounded-xl text-xs md:text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white transition-all cursor-pointer shadow-lg shadow-indigo-600/20";
    btn.onclick = addShow;
  }
}

// Add show to Watchlist
async function addShow() {
  if (!mediaDetails) return;
  
  const title = mediaDetails.title.english || mediaDetails.title.romaji;
  
  // Update local memory & storage
  localWatchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
  if (!localWatchlist.some(item => item.id === animeId)) {
    localWatchlist.push({ id: animeId, title: title, progress: 0 });
    localStorage.setItem('anime_watchlist', JSON.stringify(localWatchlist));
  }
  
  watchlistRecord = { progress: 0 };
  
  // Sync to database if logged in
  if (isUserLoggedIn && supabaseClient && currentUser) {
    const cols = computeWatchlistColumns(0, mediaDetails);
    try {
      const { error } = await supabaseClient
        .from('watchlist')
        .insert({
          user_id: currentUser.id,
          anime_id: animeId,
          title: title,
          progress: 0,
          status: cols.status,
          next_airing_at: cols.next_airing_at,
          last_released_at: cols.last_released_at
        });
      if (error) throw error;
    } catch (err) {
      console.error("Failed to insert show to Supabase:", err);
    }
  }
  
  renderWatchlistButton();
  renderEpisodesList();
}

// Remove show from Watchlist
async function removeShow() {
  if (!confirm("Are you sure you want to remove this anime from your watchlist?")) return;

  // Update local storage
  localWatchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
  localWatchlist = localWatchlist.filter(item => item.id !== animeId);
  localStorage.setItem('anime_watchlist', JSON.stringify(localWatchlist));
  
  watchlistRecord = null;
  
  // Delete from database if logged in
  if (isUserLoggedIn && supabaseClient && currentUser) {
    try {
      const { error } = await supabaseClient
        .from('watchlist')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('anime_id', animeId);
      if (error) throw error;
    } catch (err) {
      console.error("Failed to delete show from Supabase:", err);
    }
  }
  
  renderWatchlistButton();
  renderEpisodesList();
}

// Update user progress to a specific episode count
async function updateWatchlistProgress(epCount) {
  if (watchlistRecord === null) return;
  
  watchlistRecord.progress = epCount;
  
  // Update local storage
  localWatchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
  const localMatch = localWatchlist.find(w => w.id === animeId);
  if (localMatch) {
    localMatch.progress = epCount;
    localStorage.setItem('anime_watchlist', JSON.stringify(localWatchlist));
  }
  
  // Update database
  if (isUserLoggedIn && supabaseClient && currentUser) {
    const cols = computeWatchlistColumns(epCount, mediaDetails);
    try {
      const { error } = await supabaseClient
        .from('watchlist')
        .update({
          progress: epCount,
          status: cols.status,
          next_airing_at: cols.next_airing_at,
          last_released_at: cols.last_released_at
        })
        .eq('user_id', currentUser.id)
        .eq('anime_id', animeId);
      if (error) throw error;
    } catch (err) {
      console.error("Failed to update progress in Supabase:", err);
    }
  }
  
  // Refresh display
  document.getElementById('progressDisplay').innerText = `${epCount} / ${mediaDetails.episodes || '?'}`;
  renderEpisodesList(true);
}

// Render the general metadata of the page
function renderMetadata() {
  if (!mediaDetails) return;
  
  // Banner Image
  const bannerImg = document.getElementById('bannerImg');
  const bannerShimmer = document.getElementById('bannerShimmer');
  if (mediaDetails.bannerImage) {
    if (bannerImg) {
      bannerImg.src = mediaDetails.bannerImage;
      bannerImg.classList.remove('hidden');
    }
    if (bannerShimmer) bannerShimmer.classList.add('hidden');
  } else {
    // Keep cover image blur fallback or dark color if banner doesn't exist
    if (bannerShimmer) bannerShimmer.classList.add('hidden');
  }

  // Cover Image
  const coverImg = document.getElementById('coverImg');
  if (coverImg) coverImg.src = mediaDetails.coverImage.large;

  // Titles
  const title = mediaDetails.title.english || mediaDetails.title.romaji;
  document.getElementById('animeTitle').innerText = title;
  document.getElementById('animeNativeTitle').innerText = mediaDetails.title.native || "";

  // Details Meta
  document.getElementById('animeStatus').innerText = mediaDetails.status ? mediaDetails.status.toLowerCase().replace(/_/g, " ") : "?";
  document.getElementById('animeTotalEpisodes').innerText = mediaDetails.episodes || "?";
  document.getElementById('animeScore').innerText = mediaDetails.averageScore ? `${mediaDetails.averageScore}%` : "N/A";

  // Genres
  const genresContainer = document.getElementById('genresContainer');
  if (genresContainer) {
    genresContainer.innerHTML = '';
    if (mediaDetails.genres && mediaDetails.genres.length > 0) {
      mediaDetails.genres.forEach(genre => {
        const span = document.createElement('span');
        span.className = "text-xs bg-indigo-950/40 text-indigo-400 border border-indigo-500/20 px-2.5 py-1 rounded-full font-semibold";
        span.innerText = genre;
        genresContainer.appendChild(span);
      });
    } else {
      genresContainer.innerHTML = '<span class="text-xs text-gray-500">No genres available</span>';
    }
  }

  // Synopsis
  const descEl = document.getElementById('animeDescription');
  if (descEl) descEl.innerHTML = mediaDetails.description || "<p class='text-gray-500'>No description available.</p>";
}

// Render the Episode Checklist grid with pagination
function renderEpisodesList(preservePage = false) {
  const loadingEl = document.getElementById('episodesLoading');
  const notAddedEl = document.getElementById('episodesNotAdded');
  const gridEl = document.getElementById('episodesGrid');
  const paginationEl = document.getElementById('episodesPagination');

  if (loadingEl) loadingEl.classList.add('hidden');

  if (watchlistRecord === null) {
    // Show is not added: disable checklisting
    if (notAddedEl) notAddedEl.classList.remove('hidden');
    if (gridEl) gridEl.classList.add('hidden');
    if (paginationEl) paginationEl.classList.add('hidden');
    document.getElementById('progressDisplay').innerText = `0 / ${mediaDetails.episodes || '?'}`;
    return;
  }

  if (notAddedEl) notAddedEl.classList.add('hidden');
  if (gridEl) gridEl.classList.remove('hidden');

  const progress = watchlistRecord.progress;
  const totalEpisodes = mediaDetails.episodes || Math.max(12, progress);
  document.getElementById('progressDisplay').innerText = `${progress} / ${mediaDetails.episodes || '?'}`;

  // Determine current page
  const totalPages = Math.ceil(totalEpisodes / episodesPerPage) || 1;
  if (preservePage && episodesCurrentPage !== null) {
    episodesCurrentPage = Math.min(episodesCurrentPage, totalPages);
  } else {
    episodesCurrentPage = Math.ceil(progress / episodesPerPage) || 1;
  }

  // Render pagination tabs
  if (paginationEl) {
    if (totalPages > 1) {
      paginationEl.classList.remove('hidden');
      paginationEl.innerHTML = '';
      
      for (let p = 1; p <= totalPages; p++) {
        const startEp = (p - 1) * episodesPerPage + 1;
        const endEp = Math.min(totalEpisodes, p * episodesPerPage);
        
        const tabBtn = document.createElement('button');
        tabBtn.innerText = `${startEp}-${endEp}`;
        
        if (p === episodesCurrentPage) {
          tabBtn.className = "bg-indigo-600 text-white font-bold text-xs px-3 py-1.5 rounded-xl transition-all cursor-pointer border border-indigo-500 shadow-md shadow-indigo-600/20";
        } else {
          tabBtn.className = "bg-gray-800 border border-gray-700/60 hover:border-gray-600 hover:bg-gray-750 text-gray-300 text-xs px-3 py-1.5 rounded-xl transition-all cursor-pointer";
        }
        
        tabBtn.onclick = () => {
          episodesCurrentPage = p;
          renderEpisodesList(true);
        };
        
        paginationEl.appendChild(tabBtn);
      }
    } else {
      paginationEl.classList.add('hidden');
    }
  }

  // Clear episode grid and render episodes for current page
  gridEl.innerHTML = '';
  gridEl.onscroll = null; // Remove dynamic scroll listener

  const start = (episodesCurrentPage - 1) * episodesPerPage + 1;
  const end = Math.min(totalEpisodes, episodesCurrentPage * episodesPerPage);

  renderEpisodeRange(start, end);
}

// Helper to append a range of episodes [start, end] inclusive
function renderEpisodeRange(start, end) {
  const gridEl = document.getElementById('episodesGrid');
  if (!gridEl || !mediaDetails || watchlistRecord === null) return;

  const progress = watchlistRecord.progress;

  for (let i = start; i <= end; i++) {
    const isWatched = i <= progress;
    
    const epCard = document.createElement('div');
    epCard.className = `flex items-center justify-between p-3 rounded-2xl border transition-all cursor-pointer ${
      isWatched 
        ? 'bg-indigo-950/30 border-indigo-500/30 hover:border-indigo-500/50' 
        : 'bg-gray-900/60 border-gray-700/60 hover:border-gray-600'
    }`;
    
    epCard.onclick = () => {
      if (progress === i) {
        updateWatchlistProgress(i - 1);
      } else {
        updateWatchlistProgress(i);
      }
    };

    let thumbnailHtml = `<div class="w-16 h-10 bg-gray-800 rounded-lg flex items-center justify-center shrink-0"><span class="text-xs font-semibold text-gray-500">Ep ${i}</span></div>`;
    let titleHtml = `<p class="font-bold text-sm text-white line-clamp-1">Episode ${i}</p>`;

    epCard.innerHTML = `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="w-5 h-5 rounded-full flex items-center justify-center shrink-0 border ${
          isWatched ? 'bg-indigo-600 border-indigo-500 text-white' : 'border-gray-600 bg-gray-950/40'
        }">
          ${isWatched ? '✓' : ''}
        </div>
        ${thumbnailHtml}
        <div class="min-w-0 flex-1">
          ${titleHtml}
        </div>
      </div>
    `;

    gridEl.appendChild(epCard);
  }
}


// Initial script execution entrypoint
async function main() {
  parseQueryId();
  if (!animeId) {
    document.getElementById('detailsLoading').innerText = "Invalid anime ID. Redirecting to home...";
    setTimeout(() => { window.location.href = 'index.html'; }, 2000);
    return;
  }

  // Load AniList metadata and Supabase Client in parallel
  const [_, media] = await Promise.all([
    initSupabase(),
    fetchAniListDetails(animeId)
  ]);

  mediaDetails = media;
  if (!mediaDetails) {
    document.getElementById('detailsLoading').innerText = "Failed to load show metadata from AniList.";
    return;
  }

  // Hide loading spinner and show page structure
  document.getElementById('detailsLoading').classList.add('hidden');
  document.getElementById('detailsContent').classList.remove('hidden');

  // Load watchlist status and progress
  await loadUserProgress();

  // Render metadata page structure
  renderMetadata();

  // Render watchlist actions
  renderWatchlistButton();

  // Render episodes grid list checklist
  renderEpisodesList();
}

main();
