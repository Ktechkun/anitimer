// State Management
let watchlist = JSON.parse(localStorage.getItem('anime_watchlist')) || [];
let cachedApiDetails = JSON.parse(localStorage.getItem('anime_metadata_cache')) || [];
let currentTab = 'watchlist'; // 'watchlist' or 'seasonal'
let watchlistAbortController = null;
let seasonalAbortController = null;
let watchlistCurrentPage = 1;
let watchlistItemsPerPage = parseInt(localStorage.getItem('watchlist_items_per_page'), 10) || 8;
if (watchlistItemsPerPage < 6) watchlistItemsPerPage = 8;
let isFetchingMetadata = false;

// Expose states to window context via getters/setters to support external script modules
Object.defineProperty(window, 'watchlist', {
  get: () => watchlist,
  set: (val) => { watchlist = val; },
  configurable: true
});
Object.defineProperty(window, 'cachedApiDetails', {
  get: () => cachedApiDetails,
  set: (val) => { cachedApiDetails = val; },
  configurable: true
});
Object.defineProperty(window, 'watchlistCurrentPage', {
  get: () => watchlistCurrentPage,
  set: (val) => { watchlistCurrentPage = val; },
  configurable: true
});


// Date equivalence helper comparing Unix timestamps, millisecond timestamps, and ISO strings
function isDateEqual(val1, val2) {
  if (!val1 && !val2) return true;
  if (!val1 || !val2) return false;
  
  const t1 = typeof val1 === 'number' ? val1 : new Date(val1).getTime();
  const t2 = typeof val2 === 'number' ? val2 : new Date(val2).getTime();
  
  const ms1 = t1 > 9999999999 ? t1 : t1 * 1000;
  const ms2 = t2 > 9999999999 ? t2 : t2 * 1000;
  
  return ms1 === ms2;
}


// Base API call to AniList GraphQL
async function fetchAniList(query, variables = {}, signal = null) {
  try {
    const response = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal
    });
    const json = await response.json();
    return json.data;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log("Fetch request aborted.");
    } else {
      console.error("API Fetch Error:", err);
    }
  }
}

// Search Anime Action
document.getElementById('searchBtn').addEventListener('click', async () => {
  const term = document.getElementById('searchInput').value;
  if (!term) return;

  const container = document.getElementById('searchResults');
  container.innerHTML = '<p class="text-gray-400 text-sm p-2 col-span-2">Searching...</p>';

  const query = `
    query ($search: String) {
      Page(perPage: 4) {
        media(search: $search, type: ANIME) {
          id
          title { romaji english }
          coverImage { medium }
          episodes
          status
          nextAiringEpisode { airingAt episode }
        }
      }
    }`;

  const data = await fetchAniList(query, { search: term });
  const results = (data && data.Page && data.Page.media) ? data.Page.media : [];
  renderSearchResults(results);
});

function renderSearchResults(results) {
  const container = document.getElementById('searchResults');
  container.innerHTML = '';

  if (!results || results.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm p-2 col-span-2">No results found.</p>';
    return;
  }

  results.forEach(anime => {
    const title = anime.title.english || anime.title.romaji;
    const div = document.createElement('div');
    div.className = "flex items-center justify-between bg-gray-900 p-3 rounded border border-gray-700";
    div.innerHTML = `
      <div class="flex items-center gap-3">
        <img src="${anime.coverImage.medium}" class="w-10 h-14 object-cover rounded">
        <div>
          <p class="font-semibold text-sm line-clamp-1">${title}</p>
          <p class="text-xs text-gray-400">Total Ep: ${anime.episodes || '?'}</p>
        </div>
      </div>
      <button onclick="addToWatchlist(${anime.id}, '${title.replace(/'/g, "\\'")}')" class="bg-emerald-600 hover:bg-emerald-500 text-xs px-3 py-1.5 rounded font-bold transition-colors">Add</button>
    `;
    container.innerHTML += div.outerHTML;
  });
}

async function addToWatchlist(id, title) {
  if (!window.currentUser) {
    // Save pending add task
    sessionStorage.setItem('pending_addition', JSON.stringify({ id, title, type: 'search' }));
    // Redirect to login
    window.location.href = 'login.html';
    return;
  }
  if (watchlist.some(item => item.id === id)) return alert("Already added!");
  const newItem = { id, title, progress: 0 };
  watchlist.push(newItem);

  // Direct insert to Supabase
  if (window.supabaseClient && window.currentUser) {
    const cols = computeWatchlistColumns(newItem);
    const { error } = await window.supabaseClient
      .from('watchlist')
      .insert({
        user_id: window.currentUser.id,
        anime_id: id,
        title: title,
        progress: 0,
        status: cols.status,
        next_airing_at: cols.next_airing_at,
        last_released_at: cols.last_released_at
      });
    if (error) console.error("Failed to insert item to Supabase:", error);
  }

  saveAndRefresh(true, false);
  document.getElementById('searchResults').innerHTML = '';
  document.getElementById('searchInput').value = '';
}

async function incrementProgress(id) {
  const item = watchlist.find(a => a.id === id);
  if (item) {
    const apiItem = (cachedApiDetails && cachedApiDetails.find(a => a.id === id)) || {};

    let limit = null;
    let limitMessage = "";

    if (apiItem.nextAiringEpisode) {
      const timeDiff = apiItem.nextAiringEpisode.airingAt - Math.floor(Date.now() / 1000);
      limit = timeDiff > 0 ? apiItem.nextAiringEpisode.episode - 1 : apiItem.nextAiringEpisode.episode;
      limitMessage = `cannot exceed the number of episodes aired so far (${limit})`;
    } else if (apiItem.episodes) {
      limit = apiItem.episodes;
      limitMessage = `cannot exceed the total episode count of ${limit}`;
    }

    if (limit !== null && item.progress >= limit) {
      alert(`Already completed! Progress ${limitMessage}.`);
      return;
    }
    item.progress++;

    // Direct update to Supabase
    if (window.supabaseClient && window.currentUser) {
      const cols = computeWatchlistColumns(item);
      const { error } = await window.supabaseClient
        .from('watchlist')
        .update({
          progress: item.progress,
          status: cols.status,
          next_airing_at: cols.next_airing_at,
          last_released_at: cols.last_released_at
        })
        .eq('user_id', window.currentUser.id)
        .eq('anime_id', id);
      if (error) console.error("Failed to update progress in Supabase:", error);
    }

    saveAndRefresh(false, true);
  }
}

async function updateProgressDirect(id, element) {
  let val = parseInt(element.innerText.trim(), 10);
  if (isNaN(val) || val < 0) {
    val = 0;
  }

  const item = watchlist.find(a => a.id === id);
  if (item) {
    const apiItem = (cachedApiDetails && cachedApiDetails.find(a => a.id === id)) || {};

    let limit = null;
    let limitMessage = "";

    if (apiItem.nextAiringEpisode) {
      const timeDiff = apiItem.nextAiringEpisode.airingAt - Math.floor(Date.now() / 1000);
      limit = timeDiff > 0 ? apiItem.nextAiringEpisode.episode - 1 : apiItem.nextAiringEpisode.episode;
      limitMessage = `cannot exceed the number of episodes aired so far (${limit})`;
    } else if (apiItem.episodes) {
      limit = apiItem.episodes;
      limitMessage = `cannot exceed the total episode count of ${limit}`;
    }

    if (limit !== null && val > limit) {
      alert(`Progress capped! It ${limitMessage}.`);
      val = limit;
    }

    if (item.progress !== val) {
      item.progress = val;

      // Direct update to Supabase
      if (window.supabaseClient && window.currentUser) {
        const cols = computeWatchlistColumns(item);
        const { error } = await window.supabaseClient
          .from('watchlist')
          .update({
            progress: item.progress,
            status: cols.status,
            next_airing_at: cols.next_airing_at,
            last_released_at: cols.last_released_at
          })
          .eq('user_id', window.currentUser.id)
          .eq('anime_id', id);
        if (error) console.error("Failed to update progress in Supabase:", error);
      }

      saveAndRefresh(false, true);
    } else {
      element.innerText = val;
    }
  }
}

function checkProgressKey(event, element) {
  if (event.key === 'Enter') {
    event.preventDefault();
    element.blur();
  }
}

async function deleteAnime(id) {
  watchlist = watchlist.filter(item => item.id !== id);

  // Direct delete from Supabase
  if (window.supabaseClient && window.currentUser) {
    const { error } = await window.supabaseClient
      .from('watchlist')
      .delete()
      .eq('user_id', window.currentUser.id)
      .eq('anime_id', id);
    if (error) console.error("Failed to delete item from Supabase:", error);
  }

  saveAndRefresh(false, true);
}

async function saveAndRefresh(forceRefresh = false, cacheOnly = false) {
  localStorage.setItem('anime_watchlist', JSON.stringify(watchlist));
  if (currentTab === 'watchlist') {
    loadWatchlistDetails(forceRefresh, cacheOnly);
  }
}

function getUnwatchedCount(localItem, apiItem) {
  if (!apiItem || !apiItem.id) return 0;
  let currentAiredGlobal = apiItem.episodes || 0;
  if (apiItem.nextAiringEpisode) {
    const timeDiff = apiItem.nextAiringEpisode.airingAt - Math.floor(Date.now() / 1000);
    if (timeDiff > 0) {
      currentAiredGlobal = apiItem.nextAiringEpisode.episode - 1;
    } else {
      currentAiredGlobal = apiItem.nextAiringEpisode.episode;
    }
  } else if (apiItem.status === 'RELEASING') {
    currentAiredGlobal = localItem.progress; // fallback
  }
  return Math.max(0, currentAiredGlobal - localItem.progress);
}

function getReleaseTimestamp(apiItem) {
  if (!apiItem || !apiItem.id) return 0;
  const date = (apiItem.endDate && apiItem.endDate.year) ? apiItem.endDate : apiItem.startDate;
  if (!date || !date.year) return 0;
  const month = (date.month || 1) - 1;
  const day = date.day || 1;
  return new Date(date.year, month, day).getTime();
}

function compareAnimeItems(a, b) {
  const aApi = cachedApiDetails.find(c => c.id === a.id) || {};
  const bApi = cachedApiDetails.find(c => c.id === b.id) || {};

  const aUnwatched = getUnwatchedCount(a, aApi);
  const bUnwatched = getUnwatchedCount(b, bApi);
  const aCanWatch = aUnwatched > 0;
  const bCanWatch = bUnwatched > 0;

  // 1. Can watch status (shows we can watch first)
  if (aCanWatch !== bCanWatch) {
    return aCanWatch ? -1 : 1;
  }

  // If both can watch, sort by unwatched count descending
  if (aCanWatch && bCanWatch) {
    if (aUnwatched !== bUnwatched) {
      return bUnwatched - aUnwatched;
    }
  }

  // 2. Upcoming countdowns ascending (soonest first)
  const getCountdownTime = (api) => {
    if (api.nextAiringEpisode && api.nextAiringEpisode.airingAt) {
      const timeDiff = api.nextAiringEpisode.airingAt - Math.floor(Date.now() / 1000);
      if (timeDiff > 0) return api.nextAiringEpisode.airingAt;
    }
    return Infinity;
  };

  const aCountdown = getCountdownTime(aApi);
  const bCountdown = getCountdownTime(bApi);

  if (aCountdown !== bCountdown) {
    return aCountdown - bCountdown;
  }

  // 3. Release date timestamp descending (most recent first)
  const aRelease = getReleaseTimestamp(aApi);
  const bRelease = getReleaseTimestamp(bApi);

  if (aRelease !== bRelease) {
    return bRelease - aRelease;
  }

  // 4. Alphabetical fallback
  return a.title.localeCompare(b.title);
}

function sortWatchlistByUnwatched(list) {
  return [...list].sort(compareAnimeItems);
}

// Hydrate data with airing statuses & calculate gaps
async function loadWatchlistDetails(forceRefresh = false, cacheOnly = false) {
  const readyToWatchGrid = document.getElementById('readyToWatchGrid');
  const upToDateGrid = document.getElementById('upToDateGrid');
  const readyToWatchSection = document.getElementById('readyToWatchSection');
  const upToDateSection = document.getElementById('upToDateSection');
  const emptyState = document.getElementById('watchlistEmptyState');
  const paginationContainer = document.getElementById('watchlistPagination');

  // We define containers to hold the items that will be rendered
  let canWatchList = [];
  let paginatedUpToDateList = [];
  let maxPage = 1;
  let upToDateListCount = 0;

  let dbItemsList = null;

  // Render logic partitions based on auth state
  if (window.supabaseClient && window.currentUser) {
    try {
      // Fetch all items for this user in a single request, sorted on database side
      const { data: dbItems, error: fetchErr } = await window.supabaseClient
        .from('watchlist')
        .select('anime_id, title, progress, status, next_airing_at, last_released_at')
        .eq('user_id', window.currentUser.id)
        .order('next_airing_at', { ascending: true, nullsFirst: false })
        .order('last_released_at', { ascending: false })
        .order('title', { ascending: true });

      if (fetchErr) throw fetchErr;
      dbItemsList = dbItems;

      const allItems = (dbItems || []).map(item => ({
        id: item.anime_id,
        title: item.title,
        progress: item.progress,
        status: item.status,
        next_airing_at: item.next_airing_at,
        last_released_at: item.last_released_at
      }));

      // Split into canWatch and caughtUp in memory (preserving database sort order)
      canWatchList = allItems.filter(item => item.status === 'can_watch');
      const caughtUpList = allItems.filter(item => item.status === 'caught_up');

      upToDateListCount = caughtUpList.length;
      maxPage = Math.ceil(upToDateListCount / watchlistItemsPerPage) || 1;

      if (watchlistCurrentPage > maxPage) {
        watchlistCurrentPage = maxPage;
      }

      const startIndex = (watchlistCurrentPage - 1) * watchlistItemsPerPage;
      paginatedUpToDateList = caughtUpList.slice(startIndex, startIndex + watchlistItemsPerPage);

      // We check the combined counts to see if the watchlist is empty overall
      const totalCount = canWatchList.length + upToDateListCount;
      if (totalCount === 0) {
        readyToWatchSection.classList.add('hidden');
        upToDateSection.classList.add('hidden');
        emptyState.classList.remove('hidden');
        if (paginationContainer) paginationContainer.classList.add('hidden');
        return;
      }
      emptyState.classList.add('hidden');

    } catch (dbErr) {
      console.error("Supabase paginated query failed, falling back to local storage:", dbErr);
      runLocalPartition();
    }
  } else {
    runLocalPartition();
  }

  function runLocalPartition() {
    if (watchlist.length === 0) {
      readyToWatchSection.classList.add('hidden');
      upToDateSection.classList.add('hidden');
      emptyState.classList.remove('hidden');
      if (paginationContainer) paginationContainer.classList.add('hidden');
      return;
    }
    emptyState.classList.add('hidden');

    // Sort entire watchlist
    const sortedWatchlist = sortWatchlistByUnwatched(watchlist);

    // Split into Can Watch vs Caught Up
    const fullCanWatchList = [];
    const fullUpToDateList = [];

    sortedWatchlist.forEach(localItem => {
      const apiItem = cachedApiDetails.find(c => c.id === localItem.id) || {};
      if (getUnwatchedCount(localItem, apiItem) > 0) {
        fullCanWatchList.push(localItem);
      } else {
        fullUpToDateList.push(localItem);
      }
    });

    canWatchList = fullCanWatchList;
    upToDateListCount = fullUpToDateList.length;
    maxPage = Math.ceil(upToDateListCount / watchlistItemsPerPage) || 1;
    if (watchlistCurrentPage > maxPage) {
      watchlistCurrentPage = maxPage;
    }

    const startIndex = (watchlistCurrentPage - 1) * watchlistItemsPerPage;
    const endIndex = startIndex + watchlistItemsPerPage;
    paginatedUpToDateList = fullUpToDateList.slice(startIndex, endIndex);
  }

  // Render Can Watch shows (no pagination, always show all)
  if (canWatchList.length > 0) {
    readyToWatchSection.classList.remove('hidden');
    document.getElementById('readyToWatchCount').innerText = canWatchList.length;
    renderWatchlistSection(canWatchList, 'readyToWatchGrid');
  } else {
    readyToWatchSection.classList.add('hidden');
  }

  // Render Caught Up shows
  if (paginatedUpToDateList.length > 0) {
    upToDateSection.classList.remove('hidden');
    document.getElementById('upToDateCount').innerText = upToDateListCount;
    renderWatchlistSection(paginatedUpToDateList, 'upToDateGrid');
  } else {
    upToDateSection.classList.add('hidden');
  }

  // Update pagination controls
  if (paginationContainer) {
    if (upToDateListCount > 0) {
      paginationContainer.classList.remove('hidden');
      document.getElementById('watchlistPageNum').innerText = `Page ${watchlistCurrentPage} of ${maxPage}`;
      document.getElementById('prevWatchlistPage').disabled = watchlistCurrentPage === 1;
      document.getElementById('nextWatchlistPage').disabled = watchlistCurrentPage === maxPage;
      
      const itemsPerPageSelect = document.getElementById('itemsPerPageSelect');
      if (itemsPerPageSelect) {
        itemsPerPageSelect.value = watchlistItemsPerPage;
      }
    } else {
      paginationContainer.classList.add('hidden');
    }
  }

  if (cacheOnly || isFetchingMetadata) {
    return;
  }

  // Pre-fetching targets calculation
  const targetIds = [
    ...canWatchList.map(a => a.id),
    ...paginatedUpToDateList.map(a => a.id)
  ];

  // Compute which shows need to be fetched in the background
  let idsToFetch = targetIds;
  if (!forceRefresh) {
    idsToFetch = targetIds.filter(id => {
      const cached = cachedApiDetails.find(c => c.id === id);
      if (!cached) return true;
      if (cached.status === 'FINISHED') return false;

      // Optimization: Skip fetching if next airing episode is scheduled in the future
      if (cached.nextAiringEpisode && cached.nextAiringEpisode.airingAt) {
        const timeNow = Math.floor(Date.now() / 1000);
        if (cached.nextAiringEpisode.airingAt > timeNow) {
          return false;
        }
      }
      return true;
    });
  }

  if (idsToFetch.length === 0) {
    return;
  }

  if (watchlistAbortController) {
    watchlistAbortController.abort();
  }
  watchlistAbortController = new AbortController();

  const query = `
    query ($ids: [Int]) {
      Page {
        media(id_in: $ids) {
          id
          status
          episodes
          coverImage { large }
          nextAiringEpisode { airingAt episode }
          startDate { year month day }
          endDate { year month day }
        }
      }
    }`;

  try {
    isFetchingMetadata = true;
    const data = await fetchAniList(query, { ids: idsToFetch }, watchlistAbortController.signal);
    if (data && data.Page && data.Page.media) {
      const newMedia = data.Page.media;

      // Merge new media details into the cache
      newMedia.forEach(item => {
        const index = cachedApiDetails.findIndex(c => c.id === item.id);
        if (index > -1) {
          cachedApiDetails[index] = item;
        } else {
          cachedApiDetails.push(item);
        }
      });

      // Persist the updated cache in localStorage
      localStorage.setItem('anime_metadata_cache', JSON.stringify(cachedApiDetails));

      // Propagate new scheduling metadata to database in the background if logged in
      if (window.supabaseClient && window.currentUser && typeof computeWatchlistColumns === 'function') {
        newMedia.forEach(item => {
          const localItem = watchlist.find(w => w.id === item.id);
          if (localItem) {
            const cols = computeWatchlistColumns(localItem);
            
            // Compare against dbItemsList (if fetched) or fallback to localItem properties
            const dbMatch = dbItemsList ? dbItemsList.find(db => db.anime_id === item.id) : null;
            const currentStatus = dbMatch ? dbMatch.status : localItem.status;
            const currentNextAiring = dbMatch ? dbMatch.next_airing_at : localItem.next_airing_at;
            const currentLastReleased = dbMatch ? dbMatch.last_released_at : localItem.last_released_at;
            
            const needsUpdate = currentStatus !== cols.status ||
                                currentNextAiring !== cols.next_airing_at ||
                                currentLastReleased !== cols.last_released_at;
                                
            if (needsUpdate) {
              // Update local memory and cache
              localItem.status = cols.status;
              localItem.next_airing_at = cols.next_airing_at;
              localItem.last_released_at = cols.last_released_at;
              localStorage.setItem('anime_watchlist', JSON.stringify(watchlist));
              
              window.supabaseClient
                .from('watchlist')
                .update({
                  status: cols.status,
                  next_airing_at: cols.next_airing_at,
                  last_released_at: cols.last_released_at
                })
                .eq('user_id', window.currentUser.id)
                .eq('anime_id', item.id)
                .then(({ error }) => {
                  if (error) console.error("Failed to propagate scheduling metadata to Supabase:", error);
                });
            }
          }
        });
      }

      // If the user has not switched away from the watchlist tab, re-render to apply the loaded details
      if (currentTab === 'watchlist') {
        loadWatchlistDetails(false, true);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error("Failed to fetch updated metadata from AniList:", err);
    }
  } finally {
    isFetchingMetadata = false;
  }
}

function renderWatchlistSection(pageItems, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  pageItems.forEach(localItem => {
    const apiItem = cachedApiDetails.find(a => a.id === localItem.id) || {};
    const isNewLoading = !apiItem.id;

    const coverHtml = apiItem.coverImage?.large
      ? `<img src="${apiItem.coverImage.large}" class="w-20 h-28 object-cover rounded shadow-lg shrink-0">`
      : `<div class="w-20 h-28 rounded shimmer-subtle shrink-0"></div>`;

    // Calculate total episodes available globally right now
    let currentAiredGlobal = apiItem.episodes || 0;
    let countdownHtml = "";

    if (apiItem.nextAiringEpisode) {
      const timeDiff = apiItem.nextAiringEpisode.airingAt - Math.floor(Date.now() / 1000);
      if (timeDiff > 0) {
        currentAiredGlobal = apiItem.nextAiringEpisode.episode - 1;
        const formatted = formatCountdownText(apiItem.nextAiringEpisode.airingAt, apiItem.nextAiringEpisode.episode);
        countdownHtml = `
          <span class="countdown-ticker text-xs text-indigo-400 font-medium bg-indigo-950/40 px-2 py-0.5 rounded"
                data-airing-at="${apiItem.nextAiringEpisode.airingAt}"
                data-episode="${apiItem.nextAiringEpisode.episode}"
                data-anime-id="${localItem.id}">
            ${formatted}
          </span>
        `;
      } else {
        currentAiredGlobal = apiItem.nextAiringEpisode.episode;
      }
    } else if (apiItem.status === 'RELEASING') {
      currentAiredGlobal = localItem.progress; // fallback if dynamic air data missing
    }

    // Catch up metric calculations
    const unwatchedCount = currentAiredGlobal - localItem.progress;
    const canWatchBadge = unwatchedCount > 0
      ? `<span class="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-xs px-2 py-0.5 rounded-full font-bold animate-pulse">${unwatchedCount} Can Watch</span>`
      : `<span class="bg-gray-800 text-gray-500 text-xs px-2 py-0.5 rounded-full">Caught Up</span>`;

    let badgeAreaHtml = `
      ${canWatchBadge}
      ${countdownHtml}
    `;

    if (isNewLoading) {
      badgeAreaHtml = `<div class="h-5 w-20 rounded-full shimmer-subtle"></div>`;
    }

    const isCaughtUp = localItem.progress >= currentAiredGlobal;
    const buttonDisabledAttr = (isCaughtUp || isNewLoading) ? "disabled" : "";
    const buttonClass = (isCaughtUp || isNewLoading)
      ? "bg-gray-800/40 text-gray-600 border border-gray-700/50 text-xs px-3 py-1.5 rounded-lg font-medium cursor-not-allowed transition-all"
      : "bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs px-3 py-1.5 rounded-lg flex items-center gap-1 transition-all";

    const totalEpisodesHtml = isNewLoading
      ? `<span class="inline-block w-8 h-4 rounded shimmer-subtle align-middle"></span>`
      : (apiItem.episodes || '?');

    const card = document.createElement('div');
    card.className = "bg-gray-800 p-4 rounded-xl border border-gray-700 flex gap-4 relative overflow-hidden";
    card.innerHTML = `
      <a href="details.html?id=${localItem.id}" class="shrink-0">
        ${coverHtml}
      </a>
      <div class="flex flex-col justify-between flex-1 min-w-0">
        <div>
          <div class="flex items-start justify-between gap-2 mb-1">
            <a href="details.html?id=${localItem.id}" class="min-w-0 flex-1 hover:underline">
              <h3 class="font-bold text-sm md:text-base line-clamp-1 text-white">${localItem.title}</h3>
            </a>
            <button onclick="deleteAnime(${localItem.id})" class="text-gray-500 hover:text-red-400 text-xs transition-colors shrink-0">✕</button>
          </div>
          <div class="flex gap-2 items-center mt-1">
            ${badgeAreaHtml}
          </div>
        </div>

        <div class="flex items-center justify-between border-t border-gray-700/60 pt-2 mt-2">
          <span class="text-sm font-medium text-gray-300">
            My Progress: <strong contenteditable="true" inputmode="numeric" class="text-indigo-400 text-base focus:bg-gray-700/60 focus:outline-none px-1 py-0.5 rounded cursor-text select-all transition-all" onblur="updateProgressDirect(${localItem.id}, this)" onkeydown="checkProgressKey(event, this)">${localItem.progress}</strong> / ${totalEpisodesHtml}
          </span>
          <button onclick="incrementProgress(${localItem.id})" ${buttonDisabledAttr} class="${buttonClass}">
            +1 Ep
          </button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function changeWatchlistPage(dir) {
  // Calculate upToDateList size
  const upToDateList = watchlist.filter(localItem => {
    const apiItem = cachedApiDetails.find(c => c.id === localItem.id) || {};
    return getUnwatchedCount(localItem, apiItem) === 0;
  });

  const maxPage = Math.ceil(upToDateList.length / watchlistItemsPerPage) || 1;
  watchlistCurrentPage += dir;
  if (watchlistCurrentPage < 1) watchlistCurrentPage = 1;
  if (watchlistCurrentPage > maxPage) watchlistCurrentPage = maxPage;
  loadWatchlistDetails();
}

function checkSyncPrompt() {
  const banner = document.getElementById('syncPromptBanner');
  if (!banner) return;

  const dismissed = localStorage.getItem('sync_banner_dismissed') === 'true';
  const connected = !!window.accessToken;

  if (!dismissed && !connected) {
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function dismissSyncPrompt() {
  localStorage.setItem('sync_banner_dismissed', 'true');
  checkSyncPrompt();
}

function acceptSyncPrompt() {
  dismissSyncPrompt();
  if (typeof handleAuthClick === 'function') {
    handleAuthClick();
  }
}

// Call check sync prompt on load
checkSyncPrompt();

// Tab switching and Seasonal Shows logic
function switchTab(tab) {
  currentTab = tab;
  const tabWatchlist = document.getElementById('tabWatchlist');
  const tabSeasonal = document.getElementById('tabSeasonal');
  const seasonSelectContainer = document.getElementById('seasonSelectContainer');
  const watchlistSections = document.getElementById('watchlistSections');
  const seasonalGrid = document.getElementById('seasonalGrid');
  const paginationContainer = document.getElementById('watchlistPagination');
  
  if (tab === 'watchlist') {
    if (seasonalAbortController) {
      seasonalAbortController.abort();
      seasonalAbortController = null;
    }
    tabWatchlist.className = "px-4 py-2 text-xs md:text-sm font-bold rounded-lg transition-all bg-indigo-600 text-white cursor-pointer";
    tabSeasonal.className = "px-4 py-2 text-xs md:text-sm font-bold rounded-lg transition-all text-gray-400 hover:text-white cursor-pointer";
    seasonSelectContainer.classList.add('hidden');
    
    watchlistSections.classList.remove('hidden');
    seasonalGrid.classList.add('hidden');
    loadWatchlistDetails(); // Render watchlist
  } else {
    if (watchlistAbortController) {
      watchlistAbortController.abort();
      watchlistAbortController = null;
    }
    tabWatchlist.className = "px-4 py-2 text-xs md:text-sm font-bold rounded-lg transition-all text-gray-400 hover:text-white cursor-pointer";
    tabSeasonal.className = "px-4 py-2 text-xs md:text-sm font-bold rounded-lg transition-all bg-indigo-600 text-white cursor-pointer";
    seasonSelectContainer.classList.remove('hidden');
    
    watchlistSections.classList.add('hidden');
    seasonalGrid.classList.remove('hidden');
    if (paginationContainer) paginationContainer.classList.add('hidden');
    loadSeasonalAnime(); // Render seasonal list
  }
}

function getCurrentSeasonAndYear() {
  const date = new Date();
  const month = date.getMonth(); // 0-indexed: 0 = Jan, 11 = Dec
  const year = date.getFullYear();
  
  let season = "WINTER";
  if (month >= 2 && month <= 4) {
    season = "SPRING";
  } else if (month >= 5 && month <= 7) {
    season = "SUMMER";
  } else if (month >= 8 && month <= 10) {
    season = "FALL";
  }
  return { season, year };
}

function getSeasonList() {
  const seasons = ["WINTER", "SPRING", "SUMMER", "FALL"];
  const current = getCurrentSeasonAndYear();
  const list = [];
  
  let currentSeasonIndex = seasons.indexOf(current.season);
  let currentYear = current.year;
  
  for (let i = 0; i < 40; i++) {
    list.push({
      season: seasons[currentSeasonIndex],
      year: currentYear,
      label: `${seasons[currentSeasonIndex].charAt(0) + seasons[currentSeasonIndex].slice(1).toLowerCase()} ${currentYear}`
    });
    
    currentSeasonIndex--;
    if (currentSeasonIndex < 0) {
      currentSeasonIndex = 3;
      currentYear--;
    }
  }
  return list;
}

function initSeasonSelector() {
  const select = document.getElementById('seasonSelect');
  if (!select) return;
  
  const seasons = getSeasonList();
  select.innerHTML = '';
  seasons.forEach(s => {
    const option = document.createElement('option');
    option.value = `${s.season}:${s.year}`;
    option.innerText = s.label;
    select.appendChild(option);
  });
}

async function loadSeasonalAnime() {
  const container = document.getElementById('seasonalGrid');
  if (!container) return;
  
  container.innerHTML = '<p class="text-gray-400 text-sm py-4 col-span-2">Loading seasonal shows...</p>';
  
  const select = document.getElementById('seasonSelect');
  if (!select) return;
  const [season, yearStr] = select.value.split(':');
  const year = parseInt(yearStr, 10);
  
  if (seasonalAbortController) {
    seasonalAbortController.abort();
  }
  seasonalAbortController = new AbortController();

  const query = `
    query ($season: MediaSeason, $seasonYear: Int) {
      Page(page: 1, perPage: 20) {
        media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
          id
          status
          episodes
          coverImage { large }
          title { romaji english }
        }
      }
    }`;
  
  const data = await fetchAniList(query, { season, seasonYear: year }, seasonalAbortController.signal);
  if (data && data.Page && data.Page.media) {
    renderSeasonalList(data.Page.media);
  } else {
    if (seasonalAbortController && !seasonalAbortController.signal.aborted) {
      container.innerHTML = '<p class="text-red-400 text-sm col-span-2">Failed to load seasonal anime.</p>';
    }
  }
}

function renderSeasonalList(mediaList) {
  const container = document.getElementById('seasonalGrid');
  if (!container) return;
  container.innerHTML = '';
  
  if (mediaList.length === 0) {
    container.innerHTML = '<p class="text-gray-500 text-sm col-span-2">No shows found for this season.</p>';
    return;
  }
  
  mediaList.forEach(anime => {
    const title = anime.title.english || anime.title.romaji;
    const isAdded = watchlist.some(item => item.id === anime.id);
    
    const addBtnHtml = isAdded
      ? `<button disabled class="bg-gray-800 text-gray-500 border border-gray-700/60 text-xs px-3 py-1.5 rounded-lg font-bold cursor-not-allowed">In Watchlist</button>`
      : `<button onclick="addToWatchlistFromSeasonal(${anime.id}, '${title.replace(/'/g, "\\'")}', '${anime.coverImage.large}')" class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3 py-1.5 rounded-lg font-bold transition-all cursor-pointer">Add</button>`;

    const card = document.createElement('div');
    card.className = "bg-gray-800 p-4 rounded-xl border border-gray-700 flex gap-4 relative overflow-hidden";
    card.innerHTML = `
      <a href="details.html?id=${anime.id}" class="shrink-0">
        <img src="${anime.coverImage.large}" class="w-20 h-28 object-cover rounded shadow-lg">
      </a>
      <div class="flex flex-col justify-between flex-1 min-w-0">
        <div>
          <div class="flex items-start justify-between gap-2 mb-1">
            <a href="details.html?id=${anime.id}" class="min-w-0 flex-1 hover:underline">
              <h3 class="font-bold text-sm md:text-base line-clamp-2 text-white">${title}</h3>
            </a>
          </div>
          <div class="flex gap-2 items-center mt-1">
            <span class="text-xs text-gray-400">Total Ep: ${anime.episodes || '?'}</span>
            <span class="text-xs bg-indigo-950/40 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 rounded-full font-semibold capitalize">${anime.status ? anime.status.toLowerCase() : '?'}</span>
          </div>
        </div>

        <div class="flex items-center justify-end border-t border-gray-700/60 pt-2 mt-2">
          ${addBtnHtml}
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

async function addToWatchlistFromSeasonal(id, title, coverImage) {
  if (!window.currentUser) {
    // Save pending add task
    sessionStorage.setItem('pending_addition', JSON.stringify({ id, title, coverImage, type: 'seasonal' }));
    // Redirect to login
    window.location.href = 'login.html';
    return;
  }
  if (watchlist.some(item => item.id === id)) return alert("Already added!");
  const newItem = { id, title, progress: 0 };
  watchlist.push(newItem);
  
  // Update cache manually so we don't have to query AniList for the metadata of the newly added show
  const existingInCache = cachedApiDetails.find(c => c.id === id);
  if (!existingInCache) {
    cachedApiDetails.push({
      id: id,
      title: { romaji: title, english: title },
      coverImage: { large: coverImage },
      status: 'RELEASING', // fallback
      episodes: null,
      nextAiringEpisode: null
    });
    localStorage.setItem('anime_metadata_cache', JSON.stringify(cachedApiDetails));
  }

  // Direct insert to Supabase
  if (window.supabaseClient && window.currentUser) {
    const cols = computeWatchlistColumns(newItem);
    const { error } = await window.supabaseClient
      .from('watchlist')
      .insert({
        user_id: window.currentUser.id,
        anime_id: id,
        title: title,
        progress: 0,
        status: cols.status,
        next_airing_at: cols.next_airing_at,
        last_released_at: cols.last_released_at
      });
    if (error) console.error("Failed to insert seasonal item to Supabase:", error);
  }
  
  saveAndRefresh(false, true); // save watchlist
  
  // Re-render seasonal list to reflect "In Watchlist" state
  loadSeasonalAnime();
}

function formatCountdownText(airingAt, episode) {
  const timeNow = Math.floor(Date.now() / 1000);
  const timeDiff = airingAt - timeNow;
  if (timeDiff <= 0) {
    return "Aired recently";
  }

  const days = Math.floor(timeDiff / (3600 * 24));
  const hours = Math.floor((timeDiff % (3600 * 24)) / 3600);
  const minutes = Math.floor((timeDiff % 3600) / 60);
  const seconds = timeDiff % 60;

  if (days > 0) {
    return `Ep ${episode} in ${days}d ${hours}h ${minutes}m`;
  } else {
    return `Ep ${episode} in ${hours}h ${minutes}m ${seconds}s`;
  }
}

function startCountdownTicker() {
  setInterval(() => {
    const tickers = document.querySelectorAll('.countdown-ticker');
    let needsRefresh = false;

    tickers.forEach(el => {
      const airingAt = parseInt(el.getAttribute('data-airing-at'), 10);
      const episode = parseInt(el.getAttribute('data-episode'), 10);

      if (isNaN(airingAt) || isNaN(episode)) return;

      const newText = formatCountdownText(airingAt, episode);
      if (el.innerText !== newText) {
        el.innerText = newText;
      }

      if (airingAt <= Math.floor(Date.now() / 1000)) {
        if (!el.dataset.expired) {
          el.dataset.expired = "true";
          needsRefresh = true;
        }
      }
    });

    if (needsRefresh) {
      console.log("Countdown reached 0. Refreshing metadata...");
      loadWatchlistDetails(true);
    }
  }, 1000);
}

// Initialize the season selection dropdown list
initSeasonSelector();

// Initial Dashboard execution on structural load
loadWatchlistDetails();

// Start live countdown tickers
startCountdownTicker();

function changeItemsPerPage(val) {
  const newVal = parseInt(val, 10);
  if (isNaN(newVal) || newVal < 6) return;
  
  watchlistItemsPerPage = newVal;
  localStorage.setItem('watchlist_items_per_page', watchlistItemsPerPage);
  
  // Reset page to 1
  watchlistCurrentPage = 1;
  
  // Re-load details
  loadWatchlistDetails();
}
