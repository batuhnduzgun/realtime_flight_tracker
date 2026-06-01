import { useEffect, useState, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Polyline } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

// Rota izinde tutulacak maksimum konum sayısı
const MAX_TRAIL = 14;
// Trail noktası eklemek için minimum süre (ms) — interpolasyon frame'lerini filtreler
const TRAIL_MIN_INTERVAL = 9000;

const getAltColor = (alt, onGround) => {
  if (onGround) return '#64748b';
  if (!alt)      return '#64748b';
  if (alt < 3000) return '#16a34a';
  if (alt < 8000) return '#d97706';
  return '#2563eb';
};

const createPlaneIcon = (heading, alt, onGround, isSelected) => {
  const color = getAltColor(alt, onGround);
  const cls = isSelected ? 'plane-marker selected' : 'plane-marker';
  return L.divIcon({
    html: `<div class="${cls}" style="transform:rotate(${heading || 0}deg)">
      <div class="plane-inner">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.o 
      </div>
    </div>`,
    className: '',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
};

const LEGEND = [
  { color: '#2563eb', label: 'Yüksek irtifa  > 8.000 m' },
  { color: '#d97706', label: 'Orta irtifa  3.000 – 8.000 m' },
  { color: '#16a34a', label: 'Alçak irtifa  < 3.000 m' },
  { color: '#64748b', label: 'Yerde / bilinmiyor' },
];

function App() {
  const [flights, setFlights]   = useState([]);
  const [status,  setStatus]    = useState('Bağlanıyor...');
  const [selected, setSelected] = useState(null);
  const [trails,   setTrails]   = useState({});   // icao24 → [[lat,lon], ...]
  const [searchQuery, setSearchQuery] = useState('');
  const [altRange,    setAltRange]    = useState([0, 13000]);
  const [spdRange,    setSpdRange]    = useState([0, 1200]);
  const [filterOpen,  setFilterOpen]  = useState(false);
  const wsRef           = useRef(null);
  const trailRef        = useRef({});             // mutable, render'ı tetiklemiyor
  const trailTimeRef    = useRef({});             // icao24 → son ekleme zamanı (ms)

  useEffect(() => {
    let reconnectTimeout;
    let isMounted = true;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
      wsRef.current = ws;

      ws.onopen    = () => {
        console.log('%c✅ WebSocket bağlantısı kuruldu → ' + ws.url, 'color: #16a34a; font-weight: bold;');
        setStatus('Bağlandı');
      };
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (!data?.length) return;

          console.log(`%c✈️  WebSocket mesajı alındı — ${data.length} uçuş`, 'color: #2563eb;');
          setFlights(data);
          setStatus('Bağlandı');

          // Her uçuş için timestamp güncelle (stale cleanup için)
          const ts = Date.now();
          data.forEach(f => { if (f[0]) flightTimestamps.current[f[0]] = ts; });

          // Rota izi güncelle (10 saniyede bir yeni nokta ekle)
          const now = Date.now();
          let changed = false;
          data.forEach(f => {
            const icao = f[0];
            const lat = f[6], lon = f[5];
            if (!icao || lat === null || lon === null) return;
            const lastTime = trailTimeRef.current[icao] || 0;
            if (now - lastTime >= TRAIL_MIN_INTERVAL) {
              trailTimeRef.current[icao] = now;
              const prev = trailRef.current[icao] || [];
              trailRef.current[icao] = [...prev.slice(-(MAX_TRAIL - 1)), [lat, lon]];
              changed = true;
            }
          });

          if (changed) setTrails({ ...trailRef.current });
        } catch (err) {
          // Geçersiz JSON veya beklenmeyen mesaj formatı — sessizce geç
          console.warn('WebSocket mesaj ayrıştırma hatası:', err);
        }
      };
      ws.onerror  = () => setStatus('Bağlantı hatası');
      ws.onclose  = () => {
        if (isMounted) {
          setStatus('Yeniden bağlanılıyor...');
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };
    };

    connect();
    return () => { isMounted = false; clearTimeout(reconnectTimeout); wsRef.current?.close(); };
  }, []);

  // Stale uçuş temizleme: 60 saniyedir güncelleme gelmemiş uçakları haritadan kaldır
  const STALE_THRESHOLD_MS = 60_000;
  const flightTimestamps = useRef({});  // icao24 → son güncelleme zamanı (ms)

  useEffect(() => {
    const cleanup = setInterval(() => {
      const now = Date.now();
      setFlights(prev => {
        const filtered = prev.filter(f => {
          const icao = f[0];
          const lastSeen = flightTimestamps.current[icao] || 0;
          const isStale = now - lastSeen > STALE_THRESHOLD_MS;
          if (isStale) console.log(`%c🗑️  Stale uçuş temizlendi: ${icao}`, 'color: #dc2626;');
          return !isStale;
        });
        return filtered;
      });
    }, 15_000); // her 15 saniyede bir kontrol et

    return () => clearInterval(cleanup);
  }, []);

  // Arama ve filtre uygulanmış uçuş listesi — sadece bağımlılıklar değişince yeniden hesaplanır
  const filteredFlights = useMemo(() => {
    return flights.filter(f => {
      if (searchQuery) {
        const cs = (f[1] || '').trim().toLowerCase();
        if (!cs.includes(searchQuery.toLowerCase())) return false;
      }
      const alt = f[7] || 0;
      if (alt < altRange[0] || alt > altRange[1]) return false;
      const spd = f[9] ? Math.round(f[9] * 3.6) : 0;
      if (spd < spdRange[0] || spd > spdRange[1]) return false;
      return true;
    });
  }, [flights, searchQuery, altRange, spdRange]);

  const stats = useMemo(() => {
    if (!flights.length) return { count: 0, airborne: 0, avgSpeed: 0, maxAlt: 0 };
    const airborne = flights.filter(f => !f[8]).length;
    const speeds   = flights.filter(f => f[9]).map(f => f[9] * 3.6);
    const alts     = flights.filter(f => f[7]).map(f => f[7]);
    return {
      count:    flights.length,
      airborne,
      avgSpeed: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : 0,
      maxAlt:   alts.length   ? Math.round(Math.max(...alts)) : 0,
    };
  }, [flights]);

  const statusColor = status.startsWith('Bağlandı') ? '#16a34a'
                    : status === 'Bağlantı hatası'  ? '#dc2626'
                    : '#d97706';

  return (
    <div style={{ height: '100vh', width: '100vw', position: 'relative', background: '#e2e8f0' }}>

      {/* ── Başlık ── */}
      <div className="glass-panel header-bar">
        <span className="header-title">✈ CANLI UÇUŞ TAKİP</span>
        <div className="divider" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="status-dot" style={{ background: statusColor }} />
          <span className="muted-text">{status}</span>
        </div>
        <div className="divider" />
        <span style={{ fontSize: 22, fontWeight: 700, color: '#2563eb', lineHeight: 1 }}>{stats.count}</span>
        <span className="muted-text">uçuş</span>
      </div>

      {/* ── Filtre Paneli ── */}
      <div className="glass-panel filter-panel">
        <button className="filter-toggle" onClick={() => setFilterOpen(o => !o)}>
          <span>🔍 Filtrele</span>
          <span className="filter-count">{filteredFlights.length}/{flights.length}</span>
          <span style={{ marginLeft: 4, fontSize: 11 }}>{filterOpen ? '▲' : '▼'}</span>
        </button>
        {filterOpen && (
          <div className="filter-body">
            <div className="filter-group">
              <label className="filter-label">Çağrı Kodu (Callsign)</label>
              <input
                className="filter-input"
                type="text"
                placeholder="ör. TK123"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="filter-group">
              <label className="filter-label">İrtifa: {altRange[0].toLocaleString('tr')} – {altRange[1].toLocaleString('tr')} m</label>
              <div className="range-row">
                <input type="range" min={0} max={13000} step={500}
                  value={altRange[0]}
                  onChange={e => setAltRange([+e.target.value, altRange[1]])}
                />
                <input type="range" min={0} max={13000} step={500}
                  value={altRange[1]}
                  onChange={e => setAltRange([altRange[0], +e.target.value])}
                />
              </div>
            </div>
            <div className="filter-group">
              <label className="filter-label">Hız: {spdRange[0]} – {spdRange[1]} km/h</label>
              <div className="range-row">
                <input type="range" min={0} max={1200} step={50}
                  value={spdRange[0]}
                  onChange={e => setSpdRange([+e.target.value, spdRange[1]])}
                />
                <input type="range" min={0} max={1200} step={50}
                  value={spdRange[1]}
                  onChange={e => setSpdRange([spdRange[0], +e.target.value])}
                />
              </div>
            </div>
            <button className="filter-reset" onClick={() => { setSearchQuery(''); setAltRange([0, 13000]); setSpdRange([0, 1200]); }}>
              Filtreleri Sıfırla
            </button>
          </div>
        )}
      </div>

      {/* ── İstatistik Paneli ── */}
      <div className="glass-panel stats-panel">
        <div className="panel-section-title">İstatistikler</div>
        {[
          { label: 'Havada',       value: stats.airborne,               unit: 'uçak' },
          { label: 'Ort. Hız',     value: stats.avgSpeed,               unit: 'km/h' },
          { label: 'Maks. İrtifa', value: stats.maxAlt ? stats.maxAlt.toLocaleString('tr') : '—', unit: 'm' },
        ].map(({ label, value, unit }) => (
          <div key={label} className="stat-item">
            <span className="stat-label">{label}</span>
            <span className="stat-value">
              {value}{' '}
              <span className="stat-unit">{unit}</span>
            </span>
          </div>
        ))}

        <div className="panel-section-title" style={{ marginTop: 16 }}>İrtifa</div>
        {LEGEND.map(({ color, label }) => (
          <div key={label} className="legend-item">
            <div className="legend-dot" style={{ background: color }} />
            <span>{label}</span>
          </div>
        ))}
      </div>

      {/* ── Uçuş Detay Paneli ── */}
      <div className={`glass-panel detail-panel ${selected ? 'open' : ''}`}>
        <button className="close-btn" onClick={() => setSelected(null)}>✕</button>
        {selected && (() => {
          const f   = selected;
          const alt = f[7] ? Math.round(f[7]) : null;
          const altColor = getAltColor(alt, f[8]);
          const altPct   = alt ? Math.min((alt / 13000) * 100, 100) : 0;
          return (
            <>
              <div className="detail-callsign">{(f[1] || 'Bilinmiyor').trim()}</div>
              <div className="detail-country">{f[2] || ''}</div>
              <div className="detail-rows">
                {[
                  ['ICAO24',    f[0] || '—'],
                  ['Hız',       f[9]  ? `${Math.round(f[9] * 3.6)} km/h` : '—'],
                  ['İrtifa',    alt   ? `${alt.toLocaleString('tr')} m`   : '—'],
                  ['Dikey Hız', f[11] ? `${f[11] > 0 ? '▲' : '▼'} ${Math.abs(Math.round(f[11]))} m/s` : '—'],
                  ['Yön',       f[10] ? `${Math.round(f[10])}°`           : '—'],
                  ['Durum',     f[8]  ? '🛬 Yerde' : '✈ Havada'],
                ].map(([k, v]) => (
                  <div key={k} className="detail-row">
                    <span className="detail-key">{k}</span>
                    <span className="detail-val">{v}</span>
                  </div>
                ))}
              </div>
              {alt && (
                <div style={{ marginTop: 14 }}>
                  <div className="stat-label" style={{ marginBottom: 5 }}>
                    İrtifa göstergesi
                  </div>
                  <div className="alt-bar-bg">
                    <div className="alt-bar-fill" style={{ width: `${altPct}%`, background: altColor }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                    <span className="muted-text" style={{ fontSize: 10 }}>0 m</span>
                    <span className="muted-text" style={{ fontSize: 10 }}>13.000 m</span>
                  </div>
                </div>
              )}
              {/* Rota bilgisi */}
              {trails[f[0]] && trails[f[0]].length > 1 && (
                <div style={{ marginTop: 14 }}>
                  <div className="stat-label" style={{ marginBottom: 5 }}>Rota İzi</div>
                  <div className="route-info">
                    <span className="route-dot" style={{ background: altColor }} />
                    <span className="muted-text">{trails[f[0]].length} konum kaydedildi</span>
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* ── Harita ── */}
      <MapContainer
        center={[39.0, 35.0]}
        zoom={6}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>'
          subdomains="abcd"
          maxZoom={19}
        />

        {/* ── Rota İzleri ── */}
        {filteredFlights.map(flight => {
          const icao  = flight[0];
          const trail = trails[icao];
          if (!trail || trail.length < 2) return null;
          const color = getAltColor(flight[7], flight[8]);
          return (
            <Polyline
              key={`trail-${icao}`}
              positions={trail}
              pathOptions={{ color, weight: 2.5, opacity: 0.55, dashArray: '5 7' }}
            />
          );
        })}

        {/* ── Uçak İkonları ── */}
        {filteredFlights.map((flight, index) => {
          const lat = flight[6];
          const lon = flight[5];
          if (lat === null || lon === null) return null;
          const isSelected = selected && selected[0] === flight[0];
          return (
            <Marker
              key={`${flight[0]}-${index}`}
              position={[lat, lon]}
              icon={createPlaneIcon(flight[10], flight[7], flight[8], isSelected)}
              eventHandlers={{ click: () => setSelected(flight) }}
            />
          );
        })}
      </MapContainer>
    </div>
  );
}

export default App;
