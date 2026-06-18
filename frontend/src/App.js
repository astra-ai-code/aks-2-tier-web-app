import React, { useState, useEffect, useCallback } from 'react';
import './App.css';

// ── Constants ─────────────────────────────────────────────────────────────────
const SEVERITY_ORDER  = { P1: 0, P2: 1, P3: 2, P4: 3 };
const SERVICE_TYPES   = ['API', 'Database', 'Cache', 'Queue', 'Frontend', 'Worker', 'Storage'];
const ENVIRONMENTS    = ['production', 'staging', 'development'];
const AUTO_REFRESH_MS = 30000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const api = async (path, opts = {}) => {
  const reqId = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': reqId },
    ...opts,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const err = new Error(e.error || res.statusText);
    err.reqId = e.req_id || res.headers.get('X-Request-ID') || reqId;
    throw err;
  }
  return res.json();
};

const fmtDate = (d) => d ? new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

// ── Small UI atoms ────────────────────────────────────────────────────────────
function Badge({ type, value }) {
  return <span className={`badge badge-${type}-${value?.toLowerCase().replace(/\s/g,'-')}`}>{value}</span>;
}

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function Toast({ message, type, onClose }) {
  useEffect(() => { const t = setTimeout(onClose, 3500); return () => clearTimeout(t); }, [onClose]);
  return <div className={`toast toast-${type}`}>{message}</div>;
}

function ConfirmDialog({ message, onConfirm, onCancel }) {
  return (
    <div className="modal-backdrop">
      <div className="modal modal-sm">
        <div className="modal-body confirm-body">
          <p>{message}</p>
          <div className="confirm-actions">
            <button className="btn btn-danger" onClick={onConfirm}>Delete</button>
            <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Service Form ──────────────────────────────────────────────────────────────
const BLANK_SVC = { name: '', type: 'API', environment: 'production', status: 'healthy', owner_team: '', endpoint_url: '' };

function ServiceForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm] = useState(initial || BLANK_SVC);
  const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <form className="crud-form" onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <div className="form-grid">
        <div className="form-group">
          <label>Name <span className="req">*</span></label>
          <input value={form.name} onChange={set('name')} placeholder="e.g. Payment Service" required />
        </div>
        <div className="form-group">
          <label>Type <span className="req">*</span></label>
          <select value={form.type} onChange={set('type')}>
            {SERVICE_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Environment</label>
          <select value={form.environment} onChange={set('environment')}>
            {ENVIRONMENTS.map(e => <option key={e}>{e}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Status</label>
          <select value={form.status} onChange={set('status')}>
            {['healthy','degraded','down'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Owner Team</label>
          <input value={form.owner_team} onChange={set('owner_team')} placeholder="e.g. Platform" />
        </div>
        <div className="form-group form-group-full">
          <label>Endpoint URL</label>
          <input value={form.endpoint_url} onChange={set('endpoint_url')} placeholder="https://..." />
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Saving…' : 'Save Service'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Incident Form ─────────────────────────────────────────────────────────────
const BLANK_INC = { service_id: '', title: '', severity: 'P3', status: 'open', description: '' };

function IncidentForm({ initial, services, onSave, onCancel, loading }) {
  const [form, setForm] = useState(initial ? { ...initial, service_id: initial.service_id || '' } : BLANK_INC);
  const set = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));
  return (
    <form className="crud-form" onSubmit={e => { e.preventDefault(); onSave(form); }}>
      <div className="form-grid">
        <div className="form-group form-group-full">
          <label>Title <span className="req">*</span></label>
          <input value={form.title} onChange={set('title')} placeholder="Brief incident description" required />
        </div>
        <div className="form-group">
          <label>Severity <span className="req">*</span></label>
          <select value={form.severity} onChange={set('severity')}>
            {['P1','P2','P3','P4'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Status</label>
          <select value={form.status} onChange={set('status')}>
            {['open','investigating','resolved'].map(s => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Affected Service</label>
          <select value={form.service_id} onChange={set('service_id')}>
            <option value="">— None —</option>
            {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="form-group form-group-full">
          <label>Description</label>
          <textarea value={form.description} onChange={set('description')} rows={4} placeholder="Root cause, impact, mitigation steps…" />
        </div>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Saving…' : 'Save Incident'}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]             = useState('dashboard');
  const [dashboard, setDashboard] = useState(null);
  const [services, setServices]   = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [toast, setToast]         = useState(null);
  const [platform, setPlatform]   = useState(null);

  // Modal state
  const [svcModal,  setSvcModal]  = useState(null);  // null | 'create' | service-obj
  const [incModal,  setIncModal]  = useState(null);
  const [confirm,   setConfirm]   = useState(null);  // { msg, onConfirm }
  const [saving,    setSaving]    = useState(false);

  // Filters
  const [incFilter, setIncFilter] = useState({ status: '', severity: '' });

  const notify = (message, type = 'success') => setToast({ message, type });

  const loadAll = useCallback(async () => {
    try {
      setError(null);
      const [dash, svcs, incs, health] = await Promise.all([
        api('/api/dashboard'),
        api('/api/services'),
        api('/api/incidents'),
        fetch('/health').then(r => r.json()).catch(() => ({})),
      ]);
      setDashboard(dash);
      setServices(svcs);
      setIncidents(incs);
      if (health.platform) setPlatform(health.platform);
    } catch (e) {
      const msg = e.reqId ? `${e.message} (req: ${e.reqId.slice(0,8)})` : e.message;
      setError({ message: e.message, reqId: e.reqId || 'unknown', timestamp: new Date().toISOString() });
      notify(msg, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-refresh every 30 s
  useEffect(() => {
    const t = setInterval(loadAll, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadAll]);

  // ── Service handlers ────────────────────────────────────────────────────────
  const saveService = async (form) => {
    setSaving(true);
    try {
      if (form.id) {
        await api(`/api/services/${form.id}`, { method: 'PUT', body: JSON.stringify(form) });
        notify('Service updated');
      } else {
        await api('/api/services', { method: 'POST', body: JSON.stringify(form) });
        notify('Service created');
      }
      setSvcModal(null);
      loadAll();
    } catch (e) { notify(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const deleteService = (id, name) => setConfirm({
    msg: `Delete service "${name}"? Related incidents will lose their service link.`,
    onConfirm: async () => {
      setConfirm(null);
      try { await api(`/api/services/${id}`, { method: 'DELETE' }); notify('Service deleted'); loadAll(); }
      catch (e) { notify(e.message, 'error'); }
    }
  });

  // ── Incident handlers ───────────────────────────────────────────────────────
  const saveIncident = async (form) => {
    setSaving(true);
    try {
      if (form.id) {
        await api(`/api/incidents/${form.id}`, { method: 'PUT', body: JSON.stringify(form) });
        notify('Incident updated');
      } else {
        await api('/api/incidents', { method: 'POST', body: JSON.stringify(form) });
        notify('Incident created');
      }
      setIncModal(null);
      loadAll();
    } catch (e) { notify(e.message, 'error'); }
    finally { setSaving(false); }
  };

  const deleteIncident = (id, title) => setConfirm({
    msg: `Delete incident "${title}"?`,
    onConfirm: async () => {
      setConfirm(null);
      try { await api(`/api/incidents/${id}`, { method: 'DELETE' }); notify('Incident deleted'); loadAll(); }
      catch (e) { notify(e.message, 'error'); }
    }
  });

  // ── Filtered incidents ──────────────────────────────────────────────────────
  const filteredInc = incidents
    .filter(i => (!incFilter.status   || i.status   === incFilter.status))
    .filter(i => (!incFilter.severity || i.severity === incFilter.severity))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* ── Top Bar ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <span className="brand-icon">⚡</span>
          <span className="brand-name">SRE Platform</span>
          <span className="brand-env">PRODUCTION</span>
          {platform && (
            <span className={`brand-platform platform-${platform.toLowerCase()}`}>
              {platform === 'EKS' ? '☸' : '📦'} {platform}
            </span>
          )}
        </div>
        <nav className="topbar-nav">
          {['dashboard','services','incidents'].map(t => (
            <button key={t} className={`nav-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <span className="auto-refresh-badge">auto ↻ 30s</span>
          <button className="btn btn-sm btn-ghost" onClick={loadAll}>↻ Refresh</button>
        </div>
      </header>

      <main className="main">
        {loading ? (
          <div className="loading-state">
            <div className="spinner" />
            <p>Connecting to services…</p>
          </div>
        ) : (
          <>
            {/* ── Error Banner ── */}
            {error && (
              <div className="error-banner">
                <div className="error-banner-icon">&#9888;</div>
                <div className="error-banner-content">
                  <h3>Application Error</h3>
                  <p className="error-banner-msg">{error.message}</p>
                  <div className="error-banner-meta">
                    <span>Request ID: <code>{error.reqId}</code></span>
                    <span>Time: {error.timestamp}</span>
                  </div>
                  <p className="error-banner-hint">Check backend logs and New Relic for full stack trace. This error is blocking data loading.</p>
                </div>
                <button className="btn btn-sm btn-ghost" onClick={loadAll}>Retry</button>
              </div>
            )}

            {/* ── Dashboard ── */}
            {tab === 'dashboard' && dashboard && (
              <div className="page">
                <div className="page-header">
                  <h1>Operations Dashboard</h1>
                  <p className="page-sub">Real-time overview of service health and active incidents</p>
                </div>

                <div className="stat-row">
                  <div className="stat-card stat-healthy"><div className="stat-val">{dashboard.services.healthy}</div><div className="stat-lbl">Healthy Services</div></div>
                  <div className="stat-card stat-degraded"><div className="stat-val">{dashboard.services.degraded}</div><div className="stat-lbl">Degraded</div></div>
                  <div className="stat-card stat-down"><div className="stat-val">{dashboard.services.down}</div><div className="stat-lbl">Down</div></div>
                  <div className="stat-card stat-p1"><div className="stat-val">{dashboard.incidents.p1 + dashboard.incidents.p2}</div><div className="stat-lbl">P1/P2 Incidents</div></div>
                  <div className="stat-card stat-open"><div className="stat-val">{dashboard.incidents.open + dashboard.incidents.investigating}</div><div className="stat-lbl">Active Incidents</div></div>
                  <div className="stat-card stat-resolved"><div className="stat-val">{dashboard.incidents.resolved}</div><div className="stat-lbl">Resolved</div></div>
                </div>

                <div className="dash-grid">
                  <div className="panel">
                    <div className="panel-header">
                      <h2>Service Status</h2>
                      <button className="btn btn-sm btn-primary" onClick={() => { setTab('services'); setSvcModal('create'); }}>+ New Service</button>
                    </div>
                    <div className="svc-list">
                      {services.slice(0,6).map(s => (
                        <div key={s.id} className="svc-row">
                          <div className={`svc-dot dot-${s.status}`} />
                          <div className="svc-info">
                            <span className="svc-name">{s.name}</span>
                            <span className="svc-meta">{s.type} · {s.environment}</span>
                          </div>
                          <Badge type="status" value={s.status} />
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2>Recent Incidents</h2>
                      <button className="btn btn-sm btn-danger" onClick={() => { setTab('incidents'); setIncModal('create'); }}>+ New Incident</button>
                    </div>
                    <div className="inc-list">
                      {dashboard.recent_incidents.length === 0 && <p className="empty-state">No incidents — all clear 🎉</p>}
                      {dashboard.recent_incidents.map(i => (
                        <div key={i.id} className="inc-row">
                          <div className="inc-top">
                            <Badge type="sev" value={i.severity} />
                            <Badge type="inc" value={i.status} />
                            <span className="inc-time">{fmtDate(i.created_at)}</span>
                          </div>
                          <p className="inc-title">{i.title}</p>
                          {i.service_name && <span className="inc-svc">↳ {i.service_name}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Services ── */}
            {tab === 'services' && (
              <div className="page">
                <div className="page-header">
                  <div>
                    <h1>Services</h1>
                    <p className="page-sub">{services.length} registered services</p>
                  </div>
                  <button className="btn btn-primary" onClick={() => setSvcModal('create')}>+ Add Service</button>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr><th>Name</th><th>Type</th><th>Environment</th><th>Status</th><th>Owner Team</th><th>Endpoint</th><th>Created</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                      {services.length === 0 && <tr><td colSpan={8} className="empty-td">No services yet</td></tr>}
                      {services.map(s => (
                        <tr key={s.id}>
                          <td className="td-name">{s.name}</td>
                          <td><Badge type="type" value={s.type} /></td>
                          <td>{s.environment}</td>
                          <td><Badge type="status" value={s.status} /></td>
                          <td>{s.owner_team || '—'}</td>
                          <td className="td-url">{s.endpoint_url ? <a href={s.endpoint_url} target="_blank" rel="noreferrer">link</a> : '—'}</td>
                          <td>{fmtDate(s.created_at)}</td>
                          <td>
                            <div className="row-actions">
                              <button className="btn btn-xs btn-ghost" onClick={() => setSvcModal(s)}>Edit</button>
                              <button className="btn btn-xs btn-danger-ghost" onClick={() => deleteService(s.id, s.name)}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Incidents ── */}
            {tab === 'incidents' && (
              <div className="page">
                <div className="page-header">
                  <div>
                    <h1>Incidents</h1>
                    <p className="page-sub">{filteredInc.length} incidents</p>
                  </div>
                  <button className="btn btn-danger" onClick={() => setIncModal('create')}>+ New Incident</button>
                </div>
                <div className="filters">
                  <select value={incFilter.status} onChange={e => setIncFilter(p => ({ ...p, status: e.target.value }))}>
                    <option value="">All Statuses</option>
                    {['open','investigating','resolved'].map(s => <option key={s}>{s}</option>)}
                  </select>
                  <select value={incFilter.severity} onChange={e => setIncFilter(p => ({ ...p, severity: e.target.value }))}>
                    <option value="">All Severities</option>
                    {['P1','P2','P3','P4'].map(s => <option key={s}>{s}</option>)}
                  </select>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr><th>Severity</th><th>Title</th><th>Service</th><th>Status</th><th>Created</th><th>Resolved</th><th>Actions</th></tr>
                    </thead>
                    <tbody>
                      {filteredInc.length === 0 && <tr><td colSpan={7} className="empty-td">No incidents match filters</td></tr>}
                      {filteredInc.map(i => (
                        <tr key={i.id} className={i.severity === 'P1' ? 'row-p1' : ''}>
                          <td><Badge type="sev" value={i.severity} /></td>
                          <td className="td-name">{i.title}</td>
                          <td>{i.service_name || '—'}</td>
                          <td><Badge type="inc" value={i.status} /></td>
                          <td>{fmtDate(i.created_at)}</td>
                          <td>{fmtDate(i.resolved_at)}</td>
                          <td>
                            <div className="row-actions">
                              <button className="btn btn-xs btn-ghost" onClick={() => setIncModal(i)}>Edit</button>
                              <button className="btn btn-xs btn-danger-ghost" onClick={() => deleteIncident(i.id, i.title)}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Modals ── */}
      {svcModal && (
        <Modal title={svcModal === 'create' ? 'Add Service' : `Edit — ${svcModal.name}`} onClose={() => setSvcModal(null)}>
          <ServiceForm initial={svcModal === 'create' ? null : svcModal} onSave={saveService} onCancel={() => setSvcModal(null)} loading={saving} />
        </Modal>
      )}
      {incModal && (
        <Modal title={incModal === 'create' ? 'Create Incident' : `Edit Incident #${incModal.id}`} onClose={() => setIncModal(null)}>
          <IncidentForm initial={incModal === 'create' ? null : incModal} services={services} onSave={saveIncident} onCancel={() => setIncModal(null)} loading={saving} />
        </Modal>
      )}
      {confirm && <ConfirmDialog message={confirm.msg} onConfirm={confirm.onConfirm} onCancel={() => setConfirm(null)} />}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
