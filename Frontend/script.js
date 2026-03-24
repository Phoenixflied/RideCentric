const API_BASE = "";
let map;

function getAuthToken() {
    return localStorage.getItem('ridecentric_token');
}

function requireAuth() {
    const token = getAuthToken();
    if (!token) {
        window.location.href = '/app/login.html';
        return null;
    }
    return token;
}

document.addEventListener("DOMContentLoaded", () => {
    if (!requireAuth()) return;
    initClock();
    initMap();
    setupEventListeners();
    fetchFlights("ALL");
});

function initClock() {
    setInterval(() => {
        const el = document.getElementById('clock');
        if (el) el.innerText = new Date().toLocaleTimeString('en-US', { hour12: false });
    }, 1000);
}

function initMap() {
    // Ensuring the map div exists before loading
    const mapDiv = document.getElementById('map');
    if (mapDiv) {
        map = L.map('map').setView([25.7617, -80.1918], 12); 
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap'
        }).addTo(map);
    }
}

function setupEventListeners() {
    // Manual Flight Form Submission
    const form = document.getElementById('manual-flight-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const payload = {
                id: `M-${Date.now()}`,
                flight: document.getElementById('m-flight').value,
                arrival_time: document.getElementById('m-arrival').value,
                date: document.getElementById('m-date').value,
                ride_no: `MAN-${Math.floor(Math.random() * 9000)}`,
                terminal: document.getElementById('m-term').value || "TBD",
                gate: document.getElementById('m-gate').value || "TBD",
                status: "SCHEDULED"
            };

            try {
                const token = getAuthToken();
                const res = await fetch(`${API_BASE}/api/add_manual?token=${token}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (!res.ok) {
                    let errText = res.statusText;
                    try {
                        const errJson = await res.json();
                        errText = errJson.detail || errText;
                    } catch (e) {
                        // If not JSON
                    }
                    throw new Error(errText);
                }
                document.getElementById('manual-modal-v3').style.display = 'none';
                form.reset();
                fetchFlights("ALL");
            } catch (err) {
                console.error("Submission failed", err);
                alert("Add flight failed: " + err.message);
            }
        });
    }

    // Date Picker
    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.addEventListener('change', () => {
            const selectedDate = datePicker.value;
            if (selectedDate) {
                fetchFlights(selectedDate);
            } else {
                fetchFlights("ALL");
            }
        });
    }
}

async function fetchFlights(date = "ALL") {
    const panel = document.getElementById('data-panel');
    if (panel) panel.classList.add('loading');
    try {
        const token = requireAuth();
        if (!token) return;
        const res = await fetch(`${API_BASE}/api/flights?date=${date}&token=${token}`);
        if (!res.ok) {
            let errText = res.statusText;
            try {
                const errJson = await res.json();
                errText = errJson.detail || errText;
            } catch (e) {
                // If not JSON, use statusText
            }
            throw new Error(errText);
        }
        const data = await res.json();
        renderDashboard(data);
    } catch (err) {
        console.error("Connection to API failed.", err);
        alert("Flight load failed: " + err.message);
    } finally {
        if (panel) panel.classList.remove('loading');
    }
}

function renderDashboard(rides) {
    const panel = document.getElementById('data-panel');
    if (!panel) return;
    panel.innerHTML = '';

    const grouped = {};
    rides.forEach(r => {
        if (!grouped[r.date]) grouped[r.date] = [];
        grouped[r.date].push(r);
    });

    for (const [date, list] of Object.entries(grouped)) {
        const block = document.createElement('div');
        block.className = 'station-block';
        block.innerHTML = `<div class="station-header">📅 ${date}</div><div class="flight-list"></div>`;
        
        list.forEach(ride => {
            const card = document.createElement('div');
            card.className = 'flight-card search-target';
            card.innerHTML = `
                <div style="padding:15px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="color:#10ffbe; font-weight:800; font-size:1.1rem;">✈️ ${ride.flight}</span>
                        <span style="color:#666; font-size:0.75rem;">#${ride.ride_no}</span>
                    </div>
                    <div style="margin:10px 0;">Arrival: ${ride.arrival_time}</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; font-size:0.7rem; color:#888; border-top:1px solid #222; padding-top:8px;">
                        <span>Term: ${ride.terminal}</span>
                        <span>Gate: ${ride.gate}</span>
                    </div>
                    <div style="margin-top:5px; color:#10ffbe; font-weight:bold; font-size:0.65rem;">STATUS: ${ride.status}</div>
                </div>`;
            card.addEventListener('click', () => showFlightDetails(ride));
            block.querySelector('.flight-list').appendChild(card);
        });
        panel.appendChild(block);
    }
}

async function forceScan() {
    const statusEl = document.getElementById('scan-status');
    const scanBtn = document.getElementById('scan-btn');
    
    if (!requireAuth()) return;
    
    // Disable button and show loading state
    scanBtn.disabled = true;
    scanBtn.innerText = "⏳ Scanning...";
    if (statusEl) statusEl.innerText = "Processing PDFs...";
    
    try {
        const token = getAuthToken();
        const response = await fetch(`${API_BASE}/api/scan_manifests?token=${token}`, { method: 'POST' });
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error(errorData.message || `HTTP ${response.status}`);
        }
        
        const result = await response.json();
        
        if (result.status === 'success') {
            const addedCount = result.added || 0;
            if (addedCount > 0) {
                if (statusEl) statusEl.innerText = `✅ Added ${addedCount} new flights`;
                fetchFlights("ALL"); // Refresh the flight list
            } else {
                if (statusEl) statusEl.innerText = `ℹ️ No new flights found`;
            }
        } else {
            if (statusEl) statusEl.innerText = `⚠️ ${result.message || 'Scan completed with issues'}`;
        }
        
    } catch (error) {
        console.error('Scan failed:', error);
        if (statusEl) statusEl.innerText = `❌ Scan failed: ${error.message}`;
        alert(`PDF scan failed: ${error.message}`);
    } finally {
        // Re-enable button and reset text
        scanBtn.disabled = false;
        scanBtn.innerText = "🔄 Scan PDF";
        
        // Clear status after 5 seconds
        setTimeout(() => {
            if (statusEl) statusEl.innerText = "";
        }, 5000);
    }
}

function filterSearch() {
    const q = document.getElementById('search-bar').value.toLowerCase();
    document.querySelectorAll('.search-target').forEach(c => {
        const text = c.innerText.toLowerCase();
        c.style.display = text.includes(q) ? 'block' : 'none';
    });
}

function logout() {
    localStorage.removeItem('ridecentric_token');
    window.location.href = '/app/login.html';
}

function showAllFlights() {
    const datePicker = document.getElementById('date-picker');
    if (datePicker) datePicker.value = '';
    fetchFlights("ALL");
}

function showFlightDetails(ride) {
    const modal = document.getElementById('flight-details-modal');
    if (!modal) return;
    
    // Populate basic flight details
    modal.querySelector('.detail-flight').innerText = ride.flight;
    modal.querySelector('.detail-ride').innerText = ride.ride_no;
    modal.querySelector('.detail-date').innerText = ride.date;
    modal.querySelector('.detail-arrival').innerText = ride.arrival_time;
    modal.querySelector('.detail-terminal').innerText = ride.terminal;
    modal.querySelector('.detail-gate').innerText = ride.gate;
    modal.querySelector('.detail-status').innerText = ride.status;
    modal.querySelector('.detail-passenger').innerText = ride.passenger || 'N/A';
    
    // Initialize live status and map link
    const liveStatusEl = modal.querySelector('.detail-live-status');
    const mapLinkEl = modal.querySelector('.detail-map-link');
    
    liveStatusEl.innerText = 'Loading...';
    mapLinkEl.innerText = 'Loading map...';
    mapLinkEl.href = '#';
    
    // Remove previous click handler and add new one for live tracking
    mapLinkEl.removeEventListener('click', handleMapLinkClick);
    mapLinkEl.addEventListener('click', (e) => handleMapLinkClick(e, ride));
    
    // Fetch live flight data from external API
    fetchLiveFlightData(ride.flight, ride.date)
        .then(data => {
            if (data) {
                // Apply status with appropriate styling
                liveStatusEl.innerText = data.status || 'Unknown';
                liveStatusEl.className = 'detail-live-status'; // Reset classes
                
                // Add status-specific class for styling
                const statusClass = data.status.toLowerCase()
                    .replace(/\s+/g, '-')
                    .replace(/[^a-z0-9-]/g, '');
                liveStatusEl.classList.add(statusClass);
                
                if (data.map_url) {
                    mapLinkEl.innerText = '🗺️ Track Live';
                    mapLinkEl.href = '#';
                    mapLinkEl.style.cursor = 'pointer';
                } else {
                    mapLinkEl.innerText = 'Map not available';
                    mapLinkEl.href = '#';
                    mapLinkEl.style.cursor = 'default';
                }
            } else {
                liveStatusEl.innerText = 'API unavailable';
                liveStatusEl.className = 'detail-live-status api-error';
                mapLinkEl.innerText = 'Map not available';
                mapLinkEl.href = '#';
                mapLinkEl.style.cursor = 'default';
            }
        })
        .catch(error => {
            console.error('Error fetching live flight data:', error);
            liveStatusEl.innerText = 'Error loading status';
            liveStatusEl.className = 'detail-live-status api-error';
            mapLinkEl.innerText = 'Map unavailable';
            mapLinkEl.href = '#';
            mapLinkEl.style.cursor = 'default';
        });
    
    modal.style.display = 'flex';
}

// =============================================================================
// AIRLINE API CONFIGURATION - UPDATE THESE VALUES FOR YOUR AIRLINE API
// =============================================================================
// Replace the values below with your actual airline API credentials and endpoints
// Common airline APIs: FlightAware, FlightStats, ADS-B Exchange, etc.

const AIRLINE_API_CONFIG = {
    baseUrl: 'https://api.flightaware.com/v3', // Your airline API base URL
    apiKey: 'YOUR_AIRLINE_API_KEY_HERE', // Your actual API key from the airline
    endpoints: {
        flightInfo: '/flights/{flightNumber}', // API endpoint pattern for flight info
        flightMap: '/flights/{flightNumber}/map' // API endpoint pattern for flight map (if separate)
    }
};

// =============================================================================

async function fetchLiveFlightData(flightNumber, date) {
    try {
        const { baseUrl, apiKey, endpoints } = AIRLINE_API_CONFIG;
        
        // Clean flight number (remove any prefixes/suffixes if needed)
        const cleanFlightNumber = flightNumber.replace(/[^A-Z0-9]/g, '');
        
        // Build API URL - adjust parameters based on your airline API
        const apiUrl = `${baseUrl}${endpoints.flightInfo.replace('{flightNumber}', cleanFlightNumber)}`;
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'x-apiKey': apiKey, // Common header for airline APIs
                'Content-Type': 'application/json'
                // Add other required headers here
            }
        });
        
        if (!response.ok) {
            if (response.status === 404) {
                return { status: 'Flight not found', map_url: null };
            }
            throw new Error(`API request failed: ${response.status}`);
        }
        
        const data = await response.json();
        
        // Parse airline API response - adjust these mappings based on your API's response structure
        let status = 'Unknown';
        let mapUrl = null;
        
        // Example mappings for common airline APIs:
        if (data.flights && data.flights.length > 0) {
            const flight = data.flights[0];
            
            // Status mapping (adjust based on your API's status values)
            if (flight.status) {
                switch (flight.status.toLowerCase()) {
                    case 'on_time':
                    case 'scheduled':
                        status = 'On Time';
                        break;
                    case 'delayed':
                        status = `Delayed ${flight.delay || ''}`.trim();
                        break;
                    case 'cancelled':
                        status = 'Cancelled';
                        break;
                    case 'landed':
                        status = 'Landed';
                        break;
                    case 'en_route':
                    case 'airborne':
                        status = 'In Air';
                        break;
                    default:
                        status = flight.status;
                }
            }
            
            // Map URL (adjust based on your API's map URL field)
            if (flight.flightMapUrl || flight.map_url) {
                mapUrl = flight.flightMapUrl || flight.map_url;
            } else if (endpoints.flightMap) {
                // If map is separate endpoint, construct URL
                mapUrl = `${baseUrl}${endpoints.flightMap.replace('{flightNumber}', cleanFlightNumber)}`;
            }
        }
        
        return {
            status: status,
            map_url: mapUrl
        };
        
    } catch (error) {
        console.error('Airline API error:', error);
        return {
            status: 'API Error',
            map_url: null
        };
    }
}

function closeFlightDetails() {
    const modal = document.getElementById('flight-details-modal');
    if (modal) modal.style.display = 'none';
}

// =============================================================================
// LIVE FLIGHT TRACKING ON DASHBOARD MAP
// =============================================================================

// Global variables for flight tracking
let currentFlightMarker = null;
let currentFlightPath = null;
let flightTrackingInterval = null;

// Handle map link click to show live tracking on dashboard map
function handleMapLinkClick(event, ride) {
    event.preventDefault();
    
    // Close the flight details modal
    closeFlightDetails();
    
    // Start live flight tracking on the main map
    startFlightTracking(ride);
}

// Start live flight tracking on the dashboard map
async function startFlightTracking(ride) {
    try {
        // Clear any existing flight tracking
        clearFlightTracking();
        
        // Fetch initial flight data
        const flightData = await fetchLiveFlightData(ride.flight, ride.date);
        
        if (!flightData || !flightData.map_url) {
            alert('Flight tracking data not available');
            return;
        }
        
        // For airline APIs, the map_url might be a direct tracking endpoint
        // Adjust this based on your specific airline API response
        const trackingResponse = await fetch(flightData.map_url);
        const trackingData = await trackingResponse.json();
        
        // Extract flight position (adjust based on your API response structure)
        const flightPosition = extractFlightPosition(trackingData);
        
        if (flightPosition) {
            // Add flight marker to map
            addFlightMarkerToMap(flightPosition, ride);
            
            // Optionally add flight path if available
            if (trackingData.flightPath || trackingData.path) {
                addFlightPathToMap(trackingData.flightPath || trackingData.path);
            }
            
            // Center map on flight
            map.setView([flightPosition.lat, flightPosition.lng], 8);
            
            // Start periodic updates (every 30 seconds)
            flightTrackingInterval = setInterval(async () => {
                try {
                    const updatedData = await fetch(flightData.map_url).then(r => r.json());
                    const newPosition = extractFlightPosition(updatedData);
                    if (newPosition) {
                        updateFlightMarker(newPosition, ride);
                    }
                } catch (error) {
                    console.error('Error updating flight position:', error);
                }
            }, 30000);
            
            // Show tracking info panel
            showTrackingInfoPanel(ride, flightData);
        } else {
            alert('Unable to locate flight position');
        }
        
    } catch (error) {
        console.error('Error starting flight tracking:', error);
        alert('Error loading flight tracking: ' + error.message);
    }
}

// Extract flight position from API response (customize based on your API)
function extractFlightPosition(trackingData) {
    // Adjust these paths based on your airline API response structure
    // Common patterns:
    if (trackingData.position) {
        return {
            lat: trackingData.position.latitude || trackingData.position.lat,
            lng: trackingData.position.longitude || trackingData.position.lng,
            altitude: trackingData.position.altitude,
            heading: trackingData.position.heading,
            speed: trackingData.position.speed
        };
    }
    
    if (trackingData.latitude && trackingData.longitude) {
        return {
            lat: trackingData.latitude,
            lng: trackingData.longitude,
            altitude: trackingData.altitude,
            heading: trackingData.heading,
            speed: trackingData.speed
        };
    }
    
    // If the API returns an array of positions, use the latest one
    if (Array.isArray(trackingData) && trackingData.length > 0) {
        const latest = trackingData[trackingData.length - 1];
        return {
            lat: latest.lat || latest.latitude,
            lng: latest.lng || latest.longitude,
            altitude: latest.altitude,
            heading: latest.heading,
            speed: latest.speed
        };
    }
    
    return null;
}

// Add flight marker to map
function addFlightMarkerToMap(position, ride) {
    // Create custom plane icon
    const planeIcon = L.divIcon({
        html: '✈️',
        className: 'flight-plane-icon',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
    });
    
    currentFlightMarker = L.marker([position.lat, position.lng], {
        icon: planeIcon,
        rotationAngle: position.heading || 0
    }).addTo(map);
    
    // Add popup with flight info
    currentFlightMarker.bindPopup(`
        <div style="font-family: 'JetBrains Mono', monospace; text-align: center;">
            <strong>${ride.flight}</strong><br>
            Alt: ${position.altitude || 'N/A'} ft<br>
            Speed: ${position.speed || 'N/A'} kts<br>
            Heading: ${position.heading || 'N/A'}°
        </div>
    `).openPopup();
}

// Add flight path to map
function addFlightPathToMap(pathData) {
    if (!pathData || !Array.isArray(pathData)) return;
    
    const pathCoords = pathData.map(point => [point.lat || point.latitude, point.lng || point.longitude]);
    
    currentFlightPath = L.polyline(pathCoords, {
        color: '#10ffbe',
        weight: 3,
        opacity: 0.8
    }).addTo(map);
}

// Update flight marker position
function updateFlightMarker(newPosition, ride) {
    if (currentFlightMarker) {
        currentFlightMarker.setLatLng([newPosition.lat, newPosition.lng]);
        if (newPosition.heading) {
            currentFlightMarker.setRotationAngle(newPosition.heading);
        }
        
        // Update popup content
        currentFlightMarker.setPopupContent(`
            <div style="font-family: 'JetBrains Mono', monospace; text-align: center;">
                <strong>${ride.flight}</strong><br>
                Alt: ${newPosition.altitude || 'N/A'} ft<br>
                Speed: ${newPosition.speed || 'N/A'} kts<br>
                Heading: ${newPosition.heading || 'N/A'}°
            </div>
        `);
    }
    
    // Update path if new segment available
    if (currentFlightPath && newPosition.path) {
        // Add new point to path
        const newCoords = [newPosition.lat, newPosition.lng];
        currentFlightPath.addLatLng(newCoords);
    }
}

// Clear flight tracking
function clearFlightTracking() {
    if (currentFlightMarker) {
        map.removeLayer(currentFlightMarker);
        currentFlightMarker = null;
    }
    
    if (currentFlightPath) {
        map.removeLayer(currentFlightPath);
        currentFlightPath = null;
    }
    
    if (flightTrackingInterval) {
        clearInterval(flightTrackingInterval);
        flightTrackingInterval = null;
    }
    
    // Hide tracking info panel if it exists
    const trackingPanel = document.getElementById('flight-tracking-panel');
    if (trackingPanel) {
        trackingPanel.style.display = 'none';
    }
}

// Show tracking info panel
function showTrackingInfoPanel(ride, flightData) {
    // Create or update tracking info panel
    let trackingPanel = document.getElementById('flight-tracking-panel');
    
    if (!trackingPanel) {
        trackingPanel = document.createElement('div');
        trackingPanel.id = 'flight-tracking-panel';
        trackingPanel.style.cssText = `
            position: absolute;
            top: 20px;
            right: 20px;
            background: rgba(15, 23, 42, 0.9);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            padding: 15px;
            z-index: 1000;
            font-family: 'JetBrains Mono', monospace;
            color: white;
            min-width: 200px;
        `;
        
        document.getElementById('map').appendChild(trackingPanel);
    }
    
    trackingPanel.innerHTML = `
        <button style="position: absolute; top: 5px; right: 10px; background: none; border: none; color: white; font-size: 20px; cursor: pointer; padding: 0;" onclick="clearFlightTracking()">×</button>
        <div style="margin-bottom: 10px;">
            <strong style="color: #10ffbe;">${ride.flight}</strong>
        </div>
        <div style="font-size: 0.8rem; color: #94a3b8;">
            ${ride.flight} • ${ride.date}<br>
            Status: <span style="color: #10ffbe;">${flightData.status || 'Tracking'}</span>
        </div>
        <div style="margin-top: 10px; font-size: 0.7rem; color: #666;">
            Click plane icon for details<br>
            Updates every 30 seconds
        </div>
    `;
    
    trackingPanel.style.display = 'block';
    
    // Also add a clear tracking button to the header
    addClearTrackingButton();
}

// Add a clear tracking button to the header when tracking is active
function addClearTrackingButton() {
    // Remove existing clear button if any
    const existingBtn = document.getElementById('clear-tracking-btn');
    if (existingBtn) existingBtn.remove();
    
    // Create new clear button
    const clearBtn = document.createElement('button');
    clearBtn.id = 'clear-tracking-btn';
    clearBtn.className = 'btn';
    clearBtn.innerText = '❌ Clear Tracking';
    clearBtn.onclick = clearFlightTracking;
    clearBtn.style.marginLeft = '10px';
    
    // Add to header actions
    const headerActions = document.querySelector('.header-actions');
    if (headerActions) {
        headerActions.appendChild(clearBtn);
    }
}

// Clear flight tracking
function clearFlightTracking() {
    if (currentFlightMarker) {
        map.removeLayer(currentFlightMarker);
        currentFlightMarker = null;
    }
    
    if (currentFlightPath) {
        map.removeLayer(currentFlightPath);
        currentFlightPath = null;
    }
    
    if (flightTrackingInterval) {
        clearInterval(flightTrackingInterval);
        flightTrackingInterval = null;
    }
    
    // Hide tracking info panel if it exists
    const trackingPanel = document.getElementById('flight-tracking-panel');
    if (trackingPanel) {
        trackingPanel.style.display = 'none';
    }
    
    // Remove clear tracking button
    const clearBtn = document.getElementById('clear-tracking-btn');
    if (clearBtn) {
        clearBtn.remove();
    }
    
    // Reset map view to default (Miami area)
    map.setView([25.7617, -80.1918], 12);
}